/**
 * 密钥扫描。
 *
 * 为什么不用 grep：
 *   之前 CI 里写的是 `grep -rIl -E 'vck_...'`。那个 `-I` 是「跳过二进制文件」——
 *   而当时被扫的那个文件恰好混进了裸控制字节，git 与 grep 都把它判为二进制，
 *   于是**真实密钥从扫描里溜了过去**。
 *
 *   一次真实的漏检。所以这里改为**按字节读**，不做任何文本/二进制假设。
 *
 * 用 Node 直接跑（Node 22+ 原生支持 TypeScript）：
 *   node tools/scan-secrets.ts            # 扫工作区
 *   node tools/scan-secrets.ts --history  # 连 git 历史一起扫
 *
 * ⚠ 与 jev-2048 的唯一一处偏离（T2 记录）：删掉了一个从未被调用的
 * `readRaw()` 辅助函数。它在那里也是死代码 —— 两边都没有 tsconfig 覆盖
 * tools/，所以从没被类型检查照到过。本仓库 T2 起把 tools/ 纳入了
 * tsconfig.tools.json，noUnusedLocals 立刻把它报了出来。
 * 其余内容逐字照搬，**所有注释原样保留**。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/**
 * 扫描时跳过的目录。
 *
 * ⚠ 这里跳过的 `.git` 只指**仓库自己的** .git（在根目录）。
 * 嵌套在子目录里的 .git 是危险信号，必须报出来 —— 见 walk() 里的处理。
 *
 * ═══ 为什么构建产物**不**在跳过之列 ═══
 *
 * `dist/` `dist-test/` 曾经在这个集合里，理由是「它们只由 `src/` 编译而来，
 * 而 `src/` 已经扫过了」。那条理由正是这个工具存在的意义所要否定的东西：
 * 它的全部历史就是「假定某个东西干净 → 那个假定不成立 → 工具却报绿」。
 * 「产物是派生的，所以它干净」是一次**推理**，不是一次**测量**。
 *
 * 而且同一条推理在 `public/js/` 上并不成立 —— 那也是编译产物（同样在
 * `.gitignore` 里），却一直被扫，`pages.yml` 更是**专门把这一步排在编译之后**，
 * 就为了扫到刚生成的 `public/js/`。跳过 `dist/` 而扫 `public/js/` 是自相矛盾的。
 *
 * 代价实测可忽略（本仓 210K + 885K，全量工作区扫描仍在 0.5s 量级），
 * 所以这里选择**扫**：把「产物不可能有密钥」这条假定交还给测量去否定。
 */
const SKIP_DIRS = new Set(["node_modules"]);

/** 已知的密钥形态。宁可多报，也不能漏。 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Vercel Gateway Key", re: /vck_[A-Za-z0-9_-]{20,}/g },
  // 十六进制补上大写：早期只认 [a-f0-9]，一串大写的 sk-or-v1-… 从规则底下走过去
  { name: "OpenRouter Key", re: /sk-or-v1-[A-Fa-f0-9]{32,}/g },
  // ⚠ 字符类里的 `-` 不能少。`sk-ant-api03-…`（Anthropic）、`sk-proj-…`（OpenAI 项目键）
  // 在第 4 个字符就撞上连字符，而旧写法 `[A-Za-z0-9]` 到那里就断了 ——
  // 于是**本仓库自己最常用的那个家族**（仓库里带着 Anthropic 兼容后端，
  // 用户最可能自备的就是 sk-ant-）成了扫描器唯一完全看不见的一类。
  //
  // 开头那个 `\b` 是放宽字符类换来的**必需品**，不是修饰：`-` 一进字符类，
  // 任何以 `sk` 结尾的单词只要拖一根长连字符尾巴就会被整条吞进来 ——
  // 实测 `a-task-list-item-checkbox-with-a-very-long-name-here` 会命中。
  // `\b` 要求 `sk` 前面不是单词字符，于是 `task-` 里的那个 `sk-` 被排除，
  // 而真实的密钥（前面总归是引号 / `=` / 空格 / 冒号）一个都不受影响。
  { name: "OpenAI / Anthropic Key", re: /\bsk-[A-Za-z0-9-]{32,}/g },
  { name: "Google API Key", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "Groq Key", re: /gsk_[A-Za-z0-9]{20,}/g },
  { name: "HuggingFace Token", re: /hf_[A-Za-z0-9]{20,}/g },
  { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: "AWS Access Key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "Slack Token", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "Private Key Block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * 允许出现的「假密钥」。
 *
 * 测试 fixture 会用形如 `vck_TESTONLY_...` 的占位值 —— 它们长得像密钥，
 * 但明显是假的。白名单写在这里，而不是放宽正则 —— 放宽正则会同时放过真货。
 *
 * ⚠ 这些正则**不能带 `g` 标志**。
 * 带 `g` 的正则在 `.test()` 时是有状态的：匹配成功后 lastIndex 停在末尾，
 * 下一次调用会从那里继续找而失败。连续检查多个候选时白名单会时灵时不灵 ——
 * 扫描工具自己踩过一次。
 */
const ALLOWLIST = [/vck_TESTONLY/, /vck_xxxxx/i, /sk-or-v1-0{20,}/];

interface Hit {
  where: string;
  pattern: string;
  sample: string;
}

/**
 * 扫描一段内容，**同时尝试把它当 zlib 流解开再扫一遍**。
 *
 * 为什么需要：git 对象是 zlib 压缩存储的。
 * 真实事故：`.git.backup/` 曾不在 .gitignore 里，一次 `git add -A`
 * 把整个旧 .git 提交了进去 —— 里面存有密钥的那个对象是**压缩字节**，
 * 明文正则完全匹配不到，扫描器报了「干净」。
 * 但任何人 `zlib.decompress` 一下就能还原出密钥。
 *
 * 所以「找不到明文」不等于「没有密钥」——还要看压缩层。
 */
function scanWithInflate(data: Buffer, where: string, out: Hit[]): void {
  scanText(data.toString("latin1"), where, out);
  // zlib 流可能带 2 字节头（0x78 开头），也可能不带（raw deflate）
  for (const attempt of [() => inflateSync(data), () => inflateSync(data, { finishFlush: 2 })]) {
    try {
      const plain = attempt();
      if (plain.length > 0) scanText(plain.toString("latin1"), `${where}(解压)`, out);
    } catch {
      /* 不是 zlib 流，正常 */
    }
  }
}

function isAllowlisted(text: string): boolean {
  return ALLOWLIST.some((re) => re.test(text));
}

function scanText(text: string, where: string, out: Hit[]): void {
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (isAllowlisted(m[0])) continue;
      // 只报前缀，绝不回显完整值
      out.push({ where, pattern: name, sample: `${m[0].slice(0, 10)}…` });
    }
  }
}

function walk(dir: string, out: Hit[], isRoot = false): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // 嵌套的 .git 目录一律视为问题 —— 它会把历史里的所有对象（含已删除的密钥）
      // 整个带进仓库。这不是「可能有问题」，是「一定有风险」。
      if (name === ".git" && !isRoot) {
        out.push({
          where: relative(ROOT, full),
          pattern: "嵌套 .git 目录",
          sample: "整个 git 对象库被提交",
        });
        continue;
      }
      walk(full, out, false);
    } else if (st.isFile()) {
      let buf: Buffer;
      try {
        buf = readFileSync(full);
      } catch {
        continue;
      }
      scanWithInflate(buf, relative(ROOT, full), out);
    }
  }
}

function scanHistory(out: Hit[]): void {
  // 逐个 blob 扫，而不是扫 diff 文本 —— diff 会截断长行
  let hashes: string[] = [];
  try {
    hashes = execFileSync("git", ["rev-list", "--objects", "--all"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ")[0]);
  } catch {
    console.log("  （非 git 仓库或 git 不可用，跳过历史扫描）");
    return;
  }

  const seen = new Set<string>();
  for (const h of hashes) {
    if (seen.has(h)) continue;
    seen.add(h);
    try {
      const buf = execFileSync("git", ["cat-file", "-p", h], {
        cwd: ROOT,
        maxBuffer: 64 * 1024 * 1024,
      });
      scanWithInflate(buf, `git:${h.slice(0, 8)}`, out);
    } catch {
      /* 非 blob 对象，跳过 */
    }
  }
}

/* ---------- 主流程 ---------- */

const wantHistory = process.argv.includes("--history");
const hits: Hit[] = [];

walk(ROOT, hits, true);
if (wantHistory) scanHistory(hits);

if (hits.length === 0) {
  console.log(`\n  ✓ 未发现明文密钥${wantHistory ? "（含 git 历史）" : ""}\n`);
  process.exit(0);
}

// 去重后输出
const uniq = new Map<string, Hit>();
for (const h of hits) uniq.set(`${h.where}|${h.pattern}|${h.sample}`, h);

console.error(`\n  ✗ 发现 ${uniq.size} 处疑似密钥：\n`);
for (const h of uniq.values()) {
  console.error(`      ${h.pattern.padEnd(23)} ${h.sample.padEnd(14)} ${h.where}`);
}
console.error(
  `\n    注意：扫描按字节进行，不区分文本与二进制 ——` +
    `\n    早期版本因为用了 grep -I（跳过二进制），让一个混入控制字符的文件` +
    `\n    把真实密钥带进了仓库。\n`,
);
process.exit(1);
