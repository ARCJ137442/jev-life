/**
 * 构建期检查：core/ 不得 import client/。
 *
 * 为什么需要它：
 * 跑分工具（tools/bench-step.ts）要在 Node 里跑同一个 core/。一旦 core/ 里的
 * 某个模块（哪怕间接）import 了 i18n 或 render，无头环境立刻崩 —— 而且崩在
 * 运行时，离真正的原因很远。
 *
 * jev-2048 有先例：src/shared/types.ts:34-36 的注释写着「本模块被 client 与
 * server 共用，引 i18n 会把分层搞反」—— 那条纪律当时只写在注释里，没人守。
 * 本项目的跑分工具依赖它，所以做成构建期硬检查。
 *
 * 判据是**传递闭包**，不是逐文件看 import：core/a → shared/b → client/c
 * 同样会让无头环境崩，而单看 core/a 的源码完全看不出来。
 *
 * ═══ 一次真实的 fail-open，以及它的一般形态 ═══
 *
 * 这个检查的第一版是「先把 import 解析成磁盘上的 .ts，解析不到就跳过，
 * 解析到了再判路径」。于是：
 *
 *   src/core/x.ts 里 `import { t } from "../client/api.js"`
 *     client/api.ts 已存在 → 判违规 ✓
 *     client/api.ts 还没建 → 静默放行 ✗
 *
 * 同一个 import，两种结果 —— 差别只在「磁盘上此刻有没有这个文件」。
 * 开发中先写 import 再补实现是常态，所以这条路径**是可达的**，不是理论风险。
 *
 * 一般形态：**判据依赖了目标的呈现形式，而不是目标本身指向哪里。**
 * 于是前提一旦不满足，工具报的是「干净」而不是「没查」—— 这两者在输出上
 * 长得一模一样，这是它危险的原因。
 *
 * jev-2048 那次密钥泄漏就是同一个形态：扫描器用 `grep -I` 判「这个文件是不是
 * 二进制」，而真实密钥恰好混在带控制字节的文件里，于是它没被扫，工具却说
 * 「干净」。项目里已经提炼过这条原则 —— **「找不到」不等于「没有」**。
 *
 * 所以现在两件事一起做：
 *   1. 先按**路径**判分层（纯字符串运算，与目标是否存在无关）
 *   2. 解析不到的 import 全部打印出来，明说它们**没有参与判定** ——
 *      一条「没查」的检查必须说清自己在哪儿没查，否则「绿」就是假承诺
 *
 * 直接跑 TypeScript（Node 22+ 原生支持）：
 *   node tools/scan.ts
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** 被守卫的层 —— 它必须能在无 DOM、无网络的 Node 里独立跑 */
const CORE_DIR = join(ROOT, "src", "core");
/** 一旦闭包里出现这个目录下的文件，就是分层被破坏 */
const FORBIDDEN_DIR = join(ROOT, "src", "client");

/** 递归收集 .ts，顺带保证遍历顺序稳定（报错信息才可复现） */
function listSources(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listSources(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out.sort();
}

/**
 * 取出一个文件里所有**相对** import 的目标。
 *
 * 三种写法都要认：
 *   import ... from "x"  /  export ... from "x"   → 统一靠 `from` 抓
 *   import "x"                                     → 副作用导入
 *   import("x")                                    → 动态导入
 *
 * 刻意**不区分 `import type`**：类型导入在运行时会被擦除，本身不会让无头
 * 环境崩。但「core 的类型定义依赖 client」这件事本身就是分层被搞反的信号，
 * 而且区分它要写一个真正的解析器 —— 不值得为它放行一个坏味道。
 *
 * 裸模块（node:fs、第三方包）一律跳过：它们不可能是 client/ 下的文件。
 */
function relativeImports(src: string): string[] {
  const specs = new Set<string>();
  for (const re of [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]) {
    for (const m of src.matchAll(re)) {
      if (m[1].startsWith(".")) specs.add(m[1]);
    }
  }
  return [...specs];
}

/**
 * 说明符**本该落在**的路径候选 —— 纯路径运算，完全不看磁盘。
 *
 * 这是本次修掉的那个 fail-open 的关键：判分层只能用它，不能用「解析到的
 * 真实文件」。前者描述的是「这个 import 指向哪里」，与文件建没建无关。
 *
 * 三个候选对应三种解析约定：
 *   `./x.js` → 磁盘上的 `x.ts`（Node 的 type-stripping 约定，不是笔误）
 *   `./x`    → 磁盘上的 `x.ts`
 *   `./dir`  → 磁盘上的 `dir/index.ts`
 */
function intendedPaths(fromFile: string, spec: string): string[] {
  const base = resolve(dirname(fromFile), spec);
  return [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ];
}

/** 解析成磁盘上真实存在的 .ts；没有就返回 null（调用方必须处理这个 null） */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  for (const c of intendedPaths(fromFile, spec)) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

/** relative() 只在目标位于目录之外时才以 ".." 开头 —— 足够判「是不是在这棵子树里」 */
const isForbidden = (f: string): boolean => !relative(FORBIDDEN_DIR, f).startsWith("..");

/* ---------- 主流程 ---------- */

const entries = listSources(CORE_DIR);
const violations: { chain: string[]; exists: boolean }[] = [];
const unresolved: { from: string; spec: string }[] = [];

// 每个被访问的文件记下「它是从哪来的」，命中时才能打印完整 import 链 ——
// 只报「core/x.ts 引了 client」而不给路径，排查者还得自己走一遍闭包。
const origin = new Map<string, string | null>();
const queue: string[] = [];
for (const e of entries) {
  origin.set(e, null);
  queue.push(e);
}

/** 从某个文件回溯到 core 入口，得到「谁引了谁」的完整链 */
function chainTo(file: string): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = file;
  while (cur) {
    out.unshift(relative(ROOT, cur));
    cur = origin.get(cur) ?? null;
  }
  return out;
}

while (queue.length) {
  const file = queue.shift()!;
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const spec of relativeImports(src)) {
    // ① 先按路径判 —— 与目标文件建没建出来无关。
    //    这一步必须在解析之前：解析失败恰恰是最需要判违规的场景。
    const bad = intendedPaths(file, spec).find(isForbidden);
    if (bad) {
      violations.push({
        chain: [...chainTo(file), relative(ROOT, bad)],
        exists: resolveSpecifier(file, spec) !== null,
      });
      continue;
    }

    // ② 再解析。解析不到不判失败（可能引的是还没建的同层文件，或非 .ts 资源），
    //    但**必须记账** —— 这些 import 没有参与分层判定，报告里要说明白。
    const target = resolveSpecifier(file, spec);
    if (!target) {
      unresolved.push({ from: relative(ROOT, file), spec });
      continue;
    }

    if (origin.has(target)) continue;
    origin.set(target, file);
    queue.push(target);
  }
}

const reportUnresolved = (): void => {
  if (unresolved.length === 0) return;
  console.log(`\n  ⚠ 有 ${unresolved.length} 条 import 没有解析到文件，未参与分层判定：`);
  for (const u of unresolved) console.log(`      ${u.from} → "${u.spec}"`);
  console.log("    这些路径指向哪里无从确认，所以「绿」在这里不代表已经查过。");
};

console.log(`\n  分层检查：core/ 入口 ${entries.length} 个，可达文件 ${origin.size} 个`);

if (violations.length) {
  console.error(`\n  ✗ 有 ${violations.length} 条路径从 core/ 通到了 client/：\n`);
  for (const v of violations) {
    // 箭头方向 = import 方向，链子读起来就是「谁引了谁」
    const tail = v.exists ? "" : "   （该文件尚不存在，但 import 已经指向这里）";
    console.error(`      ${v.chain.join("\n        → ")}${tail}`);
    console.error("");
  }
  console.error(
    `\n    core/ 要在无 DOM、无网络的 Node 里跑（tools/bench-step.ts 依赖这一点）。\n` +
      `    引到 client/ 的模块会在运行时崩，而报错点离真正的原因很远。\n`,
  );
  reportUnresolved();
  process.exit(1);
}

console.log("  ✓ core/ 的传递闭包没有触及 client/");
reportUnresolved();
console.log("");
