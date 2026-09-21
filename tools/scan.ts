/**
 * 构建期检查：core/ 不得 import client/。
 *
 * 为什么需要它：
 * 跑分工具（tools/bench.ts）要在 Node 里跑同一个 core/。一旦 core/ 里的
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
 * 把 import 说明符解析成磁盘上的 .ts 文件。
 *
 * 源码里写的是 `.js`（NodeNext 与浏览器原生 ESM 都要求），磁盘上是 `.ts` ——
 * 这个映射是 Node 的 type-stripping 约定，不是笔误。
 */
function resolveSpecifier(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ];
  for (const c of candidates) {
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
const violations: { chain: string[] }[] = [];

// 每个被访问的文件记下「它是从哪来的」，命中时才能打印完整 import 链 ——
// 只报「core/x.ts 引了 client」而不给路径，排查者还得自己走一遍闭包。
const origin = new Map<string, string | null>();
const queue: string[] = [];
for (const e of entries) {
  origin.set(e, null);
  queue.push(e);
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
    const target = resolveSpecifier(file, spec);
    if (!target) continue;   // 解析不到就交给 tsc 报，这里不重复报同一个错

    if (isForbidden(target)) {
      // 从 file 回溯到某个 core 入口，得到完整链路
      const chain: string[] = [target];
      let cur: string | null | undefined = file;
      while (cur) {
        chain.unshift(cur);
        cur = origin.get(cur) ?? null;
      }
      violations.push({ chain: chain.map((p) => relative(ROOT, p)) });
      continue;
    }

    if (origin.has(target)) continue;
    origin.set(target, file);
    queue.push(target);
  }
}

console.log(`\n  分层检查：core/ 入口 ${entries.length} 个，可达文件 ${origin.size} 个`);

if (violations.length) {
  console.error(`\n  ✗ 有 ${violations.length} 条路径从 core/ 通到了 client/：\n`);
  for (const v of violations) {
    // 箭头方向 = import 方向，链子读起来就是「谁引了谁」
    console.error(`      ${v.chain.join("\n        → ")}`);
    console.error("");
  }
  console.error(
    `\n    core/ 要在无 DOM、无网络的 Node 里跑（tools/bench.ts 依赖这一点）。\n` +
      `    引到 client/ 的模块会在运行时崩，而报错点离真正的原因很远。\n`,
  );
  process.exit(1);
}

console.log("  ✓ core/ 的传递闭包没有触及 client/\n");
