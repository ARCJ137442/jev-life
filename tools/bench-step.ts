/**
 * 基准测试：朴素实现与位并行实现哪个更快，顺带记录生产的 `lifeStep` 有多快。
 *
 * 三个被测对象（T6 定案之后的关系）：
 *   referenceStep —— 测试基准，朴素
 *   lifeStep      —— **生产实现**，朴素但独立成文（见 src/core/life.ts 的说明）
 *   bitwiseStep   —— 位并行，被实测淘汰；现在的身份是**独立差分基准**
 *                    （位平面建模，唯一能抓住「两条朴素腿一起错」的那条腿）
 * 决策看的是「朴素 vs 位并行」两列，生产列是给这次决策的落地结果留一个
 * 可复测的锚点。
 *
 * 为什么要有这个工具：设计计划初稿直接断言「lifeStep 用位并行算法」，
 * 理由是拓扑清晰度 —— 但那条论据推不出「更快」。位并行把每步的算术
 * 从「256 次小整数运算」换成「约 750 次 BigInt 运算」，而 JS 的 BigInt
 * 比小整数慢一到两个数量级。**谁快谁慢读代码判断不了，只能实测。**
 * 所以两个实现都写出来、都用差分测试锁死正确性，然后由这里的数据决定
 * 导出哪一份。结论与实测表格记在 DESIGN.md。
 *
 * ═══ 怎么拿到 core ═══
 *
 * 走 `tools/_load.ts` 的 `loadCore()`，它是全仓唯一的入口，
 * 负责「检查编译产物是否存在 / 是否比源码旧」。**不要在别的工具里
 * 自己 import `dist-test`** —— 那个坑这个文件亲自踩过一次：
 * 跑完变异测试忘了重新编译，基准拿着被故意改坏的产物跑出了一整张
 * 看起来完全正常的错表。规矩与代价写在 `_load.ts` 的文件头。
 *
 * 用法：
 *   node node_modules/typescript/bin/tsc -p tsconfig.test.json
 *   node tools/bench-step.ts
 *   node tools/bench-step.ts --sizes=4,8,16,32   # 外推用，可超出 MAX_SIZE
 *
 * 退出码：**跑完了就恒为 0**（它只报告数据，不判定谁快谁慢，
 * 更不会因为「位并行更慢」而失败）。但**根本没跑成**（产物缺失或过期）
 * 走 `loadCore()` 的 exit 1 —— 那两件事必须长得不一样。
 */
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { loadCore } from "./_load.ts";
import type { Board, Topology } from "../src/core/types.js";

/** 类型来自源码（源码永远在），运行时来自编译产物（可能没编译） */
type LifeModule = typeof import("../src/core/life.js");
type StepFn = (b: Board, topo: Topology) => Board;

/* ═══ 测量参数 ═══ */

/** 丢弃的前若干步：JIT 要先看到热点循环才优化，热身期的数据没有意义 */
const WARMUP_STEPS = 100;
/** 单轮测量步数。≥ 2000 是为了把单步的计时噪声摊薄 */
const STEPS = 2000;
/** 轮数。取各轮中位数，抵消偶发的 GC 与调度抖动 */
const ROUNDS = 5;

/**
 * 全局预热步数。
 *
 * 为什么不能只靠每格那 100 步：**实测发现绝对数字会随测量顺序漂移**。
 * 先测 16×16 时朴素是 10.5 µs/步；先测 4×4、再测同一个 16×16 就变成
 * 7.2 µs/步 —— 差别不在被测代码，在于轮到 16×16 时 V8 有没有优化完。
 * 一个随运行顺序变化的绝对数字，既没法写进文档也没法跨版本比较。
 * 所以先不分尺寸地把两个实现都跑热，再开始计时。
 */
const PREHEAT_STEPS = 2000;

/** 预设实际会用的三档尺寸。引擎支持矩形，但预设只用正方形 */
const DEFAULT_SIDES = [4, 8, 16] as const;

/**
 * `--sizes=` 允许加测更大的棋盘。
 *
 * 用途只有一个：**判断两个实现的反超点有多远**。若 32×32 就压平，
 * 「将来放大棋盘时位并行会赢」这句话就值得重新审视；若要到 256×256
 * 才反超，那它在本项目里就永远等不到那一天。
 *
 * 可以超过 `MAX_SIZE`（16）—— `assertSize` 只在造棋盘时调用，两个演化
 * 函数本身不校验尺寸。**但这不是产品支持的尺寸**，跑出来的数只作外推参考。
 */
function parseSides(argv: readonly string[]): number[] {
  const arg = argv.find((a) => a.startsWith("--sizes="));
  if (!arg) return [...DEFAULT_SIDES];
  const parsed = arg
    .slice("--sizes=".length)
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 2);
  if (parsed.length === 0) {
    console.log("✗ --sizes= 没解析出任何合法边长，退回默认 4,8,16");
    return [...DEFAULT_SIDES];
  }
  return parsed;
}

const SIDES = Object.freeze(parseSides(process.argv.slice(2)));

/** 全部按正方形测。矩形由差分测试覆盖，不在这里铺开 */
const SIZES = SIDES.map((n) => [n, n] as const);

const TOPOLOGIES = ["bounded", "torus"] as const;

/** 起始棋盘填充率。太高第一代就崩、太低立刻全灭，都不像对局中盘 */
const DENSITY = 0.35;

/* ═══ 造棋盘：与 src/test/life-diff.test.ts 同一套 mulberry32 ═══
   同一套写法而不是同一份代码 —— 失败时能拿同一个 seed 手工复现。
   随机棋盘必须确定，否则两次运行的表格不可比。 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBoard(cols: number, rows: number, p: number, rand: () => number): Board {
  const cells = new Uint8Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = rand() < p ? 1 : 0;
  return { cols, rows, cells };
}

/* ═══ 计时 ═══ */

/**
 * 返回每步耗时的**中位数**（微秒）。
 *
 * 每轮都从同一副起始棋盘重新开始：接着上一轮的结果跑的话，两轮的棋盘不同，
 * 两个实现之间也就不可比了。
 */
function timeSteps(fn: StepFn, start: Board, topo: Topology): number {
  const samples: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    let b = start;
    for (let i = 0; i < WARMUP_STEPS; i++) b = fn(b, topo);
    const t0 = performance.now();
    for (let i = 0; i < STEPS; i++) b = fn(b, topo);
    const t1 = performance.now();
    samples.push(((t1 - t0) / STEPS) * 1000);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

/** 中文字符占两格，直接按 length 算会让表头与数据错位 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[　-鿿＀-￯]/.test(ch) ? 2 : 1;
  return w;
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)));
}

/**
 * 把两个实现都跑热，且**不分尺寸**地反复跑。
 *
 * 用 16×16 是因为它同时覆盖「最多行数」与「最宽 BigInt」，跑热它之后
 * 小尺寸的热路径也已经就位。
 */
function preheat(fn: StepFn, topo: Topology): void {
  let b = randomBoard(16, 16, DENSITY, rng(987654321));
  for (let i = 0; i < PREHEAT_STEPS; i++) b = fn(b, topo);
}

/* ═══ 主流程 ═══ */

/** 产物存在性、是否过期，都由 _load.ts 统一把关（缺失/过期 → exit 1） */
const ARTIFACT = new URL("../dist-test/core/life.js", import.meta.url);
const life = await loadCore<LifeModule>("core/life.js");

const { referenceStep, lifeStep, bitwiseStep, toRows } = life;

console.log("演化实现基准 —— 朴素 vs 位并行");
console.log(
  `  参数：预热 ${WARMUP_STEPS} 步 × 测量 ${STEPS} 步 × ${ROUNDS} 轮（取中位数），` +
    `随机棋盘 p=${DENSITY}`,
);
console.log(`  尺寸：${SIDES.map((n) => `${n}×${n}`).join(" ")}`);
console.log(`  被测对象：${fileURLToPath(ARTIFACT)}`);
console.log("");

for (const topo of TOPOLOGIES) {
  preheat(referenceStep, topo);
  preheat(lifeStep, topo);
  preheat(bitwiseStep, topo);
}

/* ── 自检：三条路径必须在算同一件事 ──
   若它们算的不是同一个函数，下面的耗时对比毫无意义。
   这里不做全量比对（那是 src/test/life-diff.test.ts 的职责），
   但比 T6 之前多跑一些：**位并行那一路在 T6 之后不再是测试文件里
   被比对的对方**（测试文件被冻结在 T5 的形态，它比的是
   lifeStep 与 referenceStep 两条朴素路径），所以这里补一条覆盖
   不同密度的运行时自检，免得那一路变成完全无人核对的死代码。 */
const SELF_CHECK_DENSITIES = [0.05, 0.2, 0.35, 0.5, 0.8] as const;
const SELF_CHECK_TRIALS = 10;
const SELF_PAIRS: ReadonlyArray<readonly [string, StepFn]> = [
  ["lifeStep", lifeStep],
  ["bitwiseStep", bitwiseStep],
];

let selfCheckOk = 0;
let selfCheckTotal = 0;
const selfCheckBad: string[] = [];
for (const [cols, nrows] of SIZES) {
  for (const topo of TOPOLOGIES) {
    for (const p of SELF_CHECK_DENSITIES) {
      const rand = rng(cols * 1000 + nrows * 10 + Math.round(p * 100));
      for (let trial = 0; trial < SELF_CHECK_TRIALS; trial++) {
        const start = randomBoard(cols, nrows, p, rand);
        const want = toRows(referenceStep(start, topo)).join("\n");
        for (const [name, fn] of SELF_PAIRS) {
          selfCheckTotal++;
          if (toRows(fn(start, topo)).join("\n") === want) selfCheckOk++;
          else selfCheckBad.push(`${name} @ ${cols}×${nrows} ${topo} p=${p}`);
        }
      }
    }
  }
}
console.log(`▸ 一致性自检（每格逐格比对 referenceStep）：${selfCheckOk}/${selfCheckTotal} 通过`);
if (selfCheckBad.length) {
  console.log(`  ✗ 不一致：${selfCheckBad.slice(0, 10).join("、")}`);
  console.log("  两份实现在算不同的东西 —— 下面的耗时对比**不可解读**。");
}
console.log("");

/* ── 主表 ── */

interface Row {
  size: string;
  topo: string;
  naive: number;
  prod: number;
  bitwise: number;
  ratio: number;
}

const rows: Row[] = [];
for (const [cols, nrows] of SIZES) {
  for (const topo of TOPOLOGIES) {
    // 同一副起始棋盘喂给三个实现 —— 否则比的是三份不同的工作量
    const start = randomBoard(cols, nrows, DENSITY, rng(cols * 1000 + nrows));
    const naive = timeSteps(referenceStep, start, topo);
    const prod = timeSteps(lifeStep, start, topo);
    const bitwise = timeSteps(bitwiseStep, start, topo);
    rows.push({
      size: `${cols}×${nrows}`,
      topo,
      naive,
      prod,
      bitwise,
      ratio: bitwise / naive,
    });
  }
}

const headers = ["尺寸", "拓扑", "朴素", "生产", "位并行", "倍数"];
const cellsOf = (r: Row): string[] => [
  r.size,
  r.topo,
  r.naive.toFixed(2),
  r.prod.toFixed(2),
  r.bitwise.toFixed(2),
  `${r.ratio.toFixed(2)}×`,
];
const widths = headers.map((h, i) =>
  Math.max(displayWidth(h), ...rows.map((r) => displayWidth(cellsOf(r)[i]))),
);
const line = (cells: string[]): string =>
  "  " + cells.map((c, i) => pad(c, widths[i])).join("  │ ");

console.log(line(headers));
console.log("  " + widths.map((w) => "─".repeat(w)).join("──┼─"));
for (const r of rows) console.log(line(cellsOf(r)));
console.log("");
console.log("  单位一律是 µs/步。三个实现分别是：");
console.log("    朴素   = referenceStep —— 测试基准，不对外使用");
console.log("    生产   = lifeStep      —— **真正导出、上线跑的就是它**");
console.log("    位并行 = bitwiseStep   —— 保留备查，未采用");
console.log("  倍数 = 位并行 ÷ 朴素，> 1 表示位并行更慢。");
console.log("");

/* ── 判读：只复述表里的数，不替人做决定 ── */

/* 生产实现与基准是两份独立写法，快慢不一定一致。生产的如果明显更慢，
   说明「朴素更快」这个结论在它身上打了折扣 —— 这一行不能不看。 */
const prodWorst = Math.max(...rows.map((r) => r.prod / r.naive));
const prodBest = Math.min(...rows.map((r) => r.prod / r.naive));
console.log(
  `▸ 生产 lifeStep ÷ 朴素基准：${prodBest.toFixed(2)}× ~ ${prodWorst.toFixed(2)}×` +
    `（< 1 表示生产实现更快）`,
);
console.log("");

console.log("▸ 按尺寸判读（大尺寸才是位并行的主场，若它真有主场的话）：");
for (const [cols, nrows] of SIZES) {
  const size = `${cols}×${nrows}`;
  const got = rows.filter((r) => r.size === size);
  const faster = got.filter((r) => r.ratio < 1).map((r) => r.topo);
  const slower = got.filter((r) => r.ratio >= 1).map((r) => r.topo);
  const parts: string[] = [];
  if (faster.length) parts.push(`位并行更快：${faster.join("、")}`);
  if (slower.length) parts.push(`朴素更快：${slower.join("、")}`);
  console.log(`  ${size}  ${parts.join("；")}`);
}
console.log("");
console.log("（结论与「什么条件下该重新审视」写在 DESIGN.md。这个脚本只出数据，不替你决定。）");
