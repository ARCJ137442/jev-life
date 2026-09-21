/**
 * 构建期检查：index.html 里的 id 与客户端代码的引用是否对得上。**双向**。
 *
 * 为什么需要它：
 * 曾经因为 HTML 里删掉了一个输入框、而 TS 里还在绑定它的事件，
 * `$("inpPace")` 返回 null，`null.addEventListener` 在**模块求值阶段**抛出，
 * 静默中断了整个启动流程 —— 表现为「棋盘空白、点一下直接判负」，
 * 与真正的原因（一个多余的字符串）毫无关联，排查成本极高。
 *
 * 直接跑 TypeScript，Node 22+ 原生支持：
 *   node tools/check-dom.ts
 *
 * ═══ 相对 jev-2048 的三处加固 ═══
 *
 * 1. **递归子目录**。源仓库用 `readdirSync(CLIENT_DIR)` 只看一层，
 *    生命棋的 `src/client/` 会有子目录（render / ui / …），目录一深就漏扫。
 *
 * 2. **反向检查**。源仓库只查「TS 引用了但 HTML 没有」，不查「HTML 定义了
 *    但 TS 从没引用」。后者会让孤儿元素长期潜伏 —— 没人敢删，也没人知道
 *    它是不是还有用。反向结果只作 **warning**（有些 id 是纯 CSS 钩子、
 *    或者是 UI 层用 `querySelector` 动态取的），不影响退出码。
 *
 * 3. **路径从 `import.meta.url` 推导**，不硬编码相对位置 ——
 *    这样从任何工作目录调用都是同一份语义。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const HTML = join(ROOT, "public", "index.html");
const CLIENT_DIR = join(ROOT, "src", "client");

const html = readFileSync(HTML, "utf8");
const htmlIds = new Set<string>();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

/** 从 TS 源码里收集所有「看起来是 DOM id」的字符串 */
function collectRefs(src: string): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  const lines = src.split("\n");

  /** 行号 = 该字符在全文中的位置属于第几行 */
  const lineAt = (offset: number): number => src.slice(0, offset).split("\n").length;

  // 只认形如 $("x") / $<T>("x") 的直接引用，以及数组字面量里的小驼峰标识符。
  // 前者靠语法上下文，后者靠命名约定 —— 我们的 id 一律是 lowerCamelCase。
  //
  // 两条直接引用的正则都必须**紧贴括号**：早先写成 /\$[<(][^>]*>?\(/ 时，
  // `[^>]*` 会跨过中间的括号一路回溯，把 `$("fb").classList.remove("on")`
  // 里的 "on" 也当成 id。
  const DIRECT_PLAIN = /\$\(\s*"([^"]+)"\s*\)/g;
  const DIRECT_TYPED = /\$<[^>]+>\(\s*"([^"]+)"\s*\)/g;
  const ARRAY = /\[\s*((?:"[^"]+"\s*,?\s*)+)\]/gs;
  const IDENT = /^[a-z][A-Za-z0-9]*$/;

  // 这些是常见的非 id 字符串，避免误报
  const NOT_ID = new Set([
    "on", "off", "up", "down", "left", "right", "true", "false",
    "game", "strategy", "api", "log", "all", "none", "ok", "incompatible",
    "show", "hide", "err", "warn", "busy", "running", "primary", "ghost",
    "click", "change", "input", "submit", "touchstart", "touchend", "touchmove",
    "button", "text", "json", "GET", "POST",
  ]);

  // 直接引用逐行扫即可
  lines.forEach((line, i) => {
    for (const m of line.matchAll(DIRECT_PLAIN)) out.push({ id: m[1], line: i + 1 });
    for (const m of line.matchAll(DIRECT_TYPED)) out.push({ id: m[1], line: i + 1 });
  });

  // 数组字面量必须在**全文**上匹配 —— 逐行匹配会漏掉跨行数组，
  // 而 assertDom([...]) 恰恰是跨行写的（漏掉它曾导致真实故障）。
  for (const m of src.matchAll(ARRAY)) {
    const at = lineAt(m.index ?? 0);
    for (const s of m[1].matchAll(/"([^"]+)"/g)) {
      const id = s[1];
      if (IDENT.test(id) && !NOT_ID.has(id)) out.push({ id, line: at });
    }
  }

  return out;
}

/** 递归收集 src/client 下的全部 .ts —— 目录一深，非递归的 readdir 就漏扫 */
function listClientSources(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;   // 目录还不存在（T2 时 src/client 是空的）
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listClientSources(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

const missing: { id: string; file: string; line: number }[] = [];
const referenced = new Set<string>();
let checked = 0;

for (const full of listClientSources(CLIENT_DIR)) {
  const file = relative(CLIENT_DIR, full);
  const src = readFileSync(full, "utf8");
  for (const ref of collectRefs(src)) {
    checked++;
    referenced.add(ref.id);
    if (!htmlIds.has(ref.id)) missing.push({ ...ref, file });
  }
}

console.log(`\n  DOM 检查：HTML 定义 ${htmlIds.size} 个 id，客户端引用 ${checked} 处`);

if (missing.length) {
  console.error(`\n  ✗ 有 ${missing.length} 处引用的 id 在 index.html 里不存在：\n`);
  for (const m of missing) {
    console.error(`      src/client/${m.file}:${m.line}   #${m.id}`);
  }
  console.error(
    `\n    这类不一致会在模块求值阶段抛出 TypeError，静默中断整个启动流程，\n` +
      `    表现为「棋盘空白、点击直接判负」。必须修掉。\n`,
  );
  process.exit(1);
}

console.log("  ✓ 全部引用都能在 HTML 里找到");

// 反向：HTML 里有、TS 从没引用。
// 刻意**不判失败** —— id 也可能被 CSS 选择器或 querySelector 动态用到，
// 判失败会逼着人为了绕过检查而删掉合法元素，比孤儿 id 本身更糟。
// 但一定要打印：孤儿 id 是靠人看见才会被清理的。
const unused = [...htmlIds].filter((id) => !referenced.has(id)).sort();
if (unused.length) {
  console.log(`\n  ⚠ HTML 里有 ${unused.length} 个 id 没有任何 TS 引用（可能已废弃）：`);
  for (const id of unused) console.log(`      #${id}`);
  console.log();
} else {
  console.log("  ✓ HTML 里的 id 全部有 TS 引用\n");
}
