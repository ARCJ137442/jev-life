/**
 * 侧栏三张图里**能被断言的那部分**。
 *
 * 无头环境里没有 canvas，三张图都画不出来 —— 所以这里测的同样是「与像素无关」
 * 的那几层：交集的区间、优势面积的切分、占比配色、以及热力图每格的取值。
 *
 * ═══ 一条刻意做的差分测试 ═══
 *
 * 生死态势图上线头的那个「连续越界几轮」，与 `classifyTermination` 判胜负用的
 * 防抖计数**必须是同一个数**。两份实现各写一遍的话，迟早会出现「图上连续 3 轮
 * 越界、却还没判胜」这种谁也说不清的画面 —— 而它不会被任何单边测试发现。
 * 所以这里拿真实的终局判定当基准，逐例对拍（见「态势图的越界计数」一节）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { aliveCount, boardFromRows, boardKey, classifyTermination } from "../core/life.js";
import type { Board, GameRules } from "../core/types.js";
import {
  ConfidenceChart,
  HEAT_ROLE_DEATH,
  HEAT_ROLE_LIFE,
  HeatChart,
  MomentumChart,
  ROLE_COLOR,
  bandOverlap,
  buildHeat,
  momentumBounds,
  ratioColor,
  splitArea,
  trailingRun,
  withAlpha,
  type AreaRun,
  type ChartPoint,
} from "../client/chart.js";
import { fakeCanvas, fillsInLastFrame, installRaf } from "./_canvas.js";
import { t } from "../client/i18n.js";

const PALETTE = { life: "#4ade80", death: "#f87171" };

/* ═══════════ ① 置信度：两带的交集 ═══════════ */

const pt = (bottom: number, top: number, median = (bottom + top) / 2): ChartPoint => ({
  top,
  bottom,
  median,
});

test("bandOverlap：完全重合的带，交集是整段", () => {
  const a = [pt(0, 0.4), pt(0.1, 0.5), pt(0.2, 0.6)];
  assert.deepEqual(bandOverlap(a, a), [{ from: 0, to: 2 }]);
});

test("bandOverlap：两带错开（一个全在上方）时没有交集", () => {
  const a = [pt(0.6, 0.9), pt(0.6, 0.9)];
  const b = [pt(0, 0.3), pt(0, 0.3)];
  assert.deepEqual(bandOverlap(a, b), []);
});

test("bandOverlap：只在中间几段相交时，回报的区间正好是那几段", () => {
  const a = [pt(0.6, 0.9), pt(0.2, 0.8), pt(0.1, 0.9), pt(0.85, 0.95)];
  const b = [pt(0.0, 0.2), pt(0.3, 0.7), pt(0.4, 0.6), pt(0.0, 0.5)];
  // 第 0 段：a=[.6,.9] b=[0,.2] → 空；第 3 段：a=[.85,.95] b=[0,.5] → 空
  assert.deepEqual(bandOverlap(a, b), [{ from: 1, to: 2 }]);
});

test("bandOverlap：刚好擦边（上界等于下界）不算交集", () => {
  // 面积为零的「交集」画出来是一条看不见的线。把它算进来只会让人以为
  // 黄色区域断了一截
  const a = [pt(0.5, 0.9), pt(0.5, 0.9)];
  const b = [pt(0.1, 0.5), pt(0.1, 0.5)];
  assert.deepEqual(bandOverlap(a, b), []);
});

test("bandOverlap：长度不等时只比到较短的那条", () => {
  const a = [pt(0, 0.9), pt(0, 0.9), pt(0, 0.9)];
  const b = [pt(0, 0.5)];
  assert.deepEqual(bandOverlap(a, b), [{ from: 0, to: 0 }]);
});

test("bandOverlap：空输入不炸", () => {
  assert.deepEqual(bandOverlap([], [pt(0, 1)]), []);
  assert.deepEqual(bandOverlap([pt(0, 1)], []), []);
});

/* ═══════════ ② 生死态势：面积切分 ═══════════ */

/** 一段「折线与中线之间」的面积（梯形法，用下标差当横轴长度） */
function areaOf(run: AreaRun, mid: number): number {
  let sum = 0;
  for (let i = 1; i < run.pts.length; i++) {
    const a = run.pts[i - 1];
    const b = run.pts[i];
    sum += ((Math.abs(a.v - mid) + Math.abs(b.v - mid)) / 2) * (b.i - a.i);
  }
  return sum;
}

test("splitArea：穿过中线时在交点断开，两侧各一段", () => {
  const runs = splitArea([0, 1], 0.5);
  assert.equal(runs.length, 2, "一段穿过中线的折线必须被拆成两段");

  assert.equal(runs[0].above, false, "先走的是下半段");
  assert.deepEqual(runs[0].pts, [{ i: 0, v: 0 }, { i: 0.5, v: 0.5 }]);

  assert.equal(runs[1].above, true);
  assert.deepEqual(runs[1].pts, [{ i: 0.5, v: 0.5 }, { i: 1, v: 1 }]);
});

test("splitArea：切开之后总面积等于「折线到中线的距离」的积分", () => {
  // 这是切分**没有丢面积、也没有重复计面积**的判据：线性插值下
  // ∫|v−0.5| 可以手算，两段之和必须与它相等
  const runs = splitArea([0, 1], 0.5);
  const above = runs.filter((r) => r.above).reduce((s, r) => s + areaOf(r, 0.5), 0);
  const below = runs.filter((r) => !r.above).reduce((s, r) => s + areaOf(r, 0.5), 0);

  assert.ok(Math.abs(above - 0.125) < 1e-12, `上方面积应为 0.125，实为 ${above}`);
  assert.ok(Math.abs(below - 0.125) < 1e-12, `下方面积应为 0.125，实为 ${below}`);
  assert.ok(Math.abs(above + below - 0.25) < 1e-12, "两段之和应为 0.25");
});

test("splitArea：全程在一侧时不切，且没有多余的零长度段", () => {
  const above = splitArea([0.7, 0.8, 1], 0.5);
  assert.equal(above.length, 1);
  assert.equal(above[0].above, true);
  assert.equal(above[0].pts.length, 3);

  const below = splitArea([0, 0.1, 0.4], 0.5);
  assert.equal(below.length, 1);
  assert.equal(below[0].above, false);
});

test("splitArea：多次往返穿过中线，段数等于穿越次数 + 1", () => {
  const runs = splitArea([0, 1, 0, 1], 0.5);
  assert.equal(runs.length, 4);
  assert.deepEqual(
    runs.map((r) => r.above),
    [false, true, false, true],
  );
  // 相邻两段必须首尾相接（交点被两段共用），否则中间会裂开一条缝
  for (let i = 1; i < runs.length; i++) {
    const prev = runs[i - 1].pts[runs[i - 1].pts.length - 1];
    assert.deepEqual(runs[i].pts[0], prev, `第 ${i} 段没有接上一段的尾`);
  }
});

test("splitArea：恰好落在中线上归上侧，不会产生零宽段", () => {
  const runs = splitArea([0.5, 0.5], 0.5);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].above, true);
});

test("splitArea：单点与空序列不炸", () => {
  assert.deepEqual(splitArea([], 0.5), []);
  assert.equal(splitArea([0.3], 0.5).length, 1);
});

/* ═══════════ ② 生死态势：配色 ═══════════ */

test("ratioColor：两端就是角色色，中点是黄", () => {
  const rgb = (hex: string): string => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
  };
  // 折线的顶端与它正上方那条「生之执界限」是同一条色 —— 不同色的话，
  // 看起来像是渲染出错了。这条断言让那次改动**红**，而不是靠人记得
  assert.equal(ratioColor(1), rgb(ROLE_COLOR.life), "1 处应当是生之执的绿");
  assert.equal(ratioColor(0), rgb(ROLE_COLOR.death), "0 处应当是死之执的红");
  assert.equal(ratioColor(0.5), "rgb(251,191,36)", "0.5 处是黄（图表语义，不属于任何角色）");
});

test("ratioColor：从红到绿一路单调变绿，不会中途回头", () => {
  const green = (s: string): number => Number(s.slice(s.indexOf(",") + 1, s.lastIndexOf(",")));
  let prev = -1;
  for (let i = 0; i <= 20; i++) {
    const g = green(ratioColor(i / 20));
    assert.ok(g > prev, `v=${i / 20} 处绿色分量没有继续增加：${g} vs ${prev}`);
    prev = g;
  }
});

test("ratioColor：越界输入被夹住，不会算出一个负分量", () => {
  assert.equal(ratioColor(-5), ratioColor(0));
  assert.equal(ratioColor(42), ratioColor(1));
});

test("withAlpha：把 #rrggbb 压成 rgba，并夹住 alpha", () => {
  assert.equal(withAlpha("#4ade80", 0.5), "rgba(74,222,128,0.5)");
  assert.equal(withAlpha("#f87171", 2), "rgba(248,113,113,1)");
  assert.equal(withAlpha("#f87171", -1), "rgba(248,113,113,0)");
  // 认不出来的字符串原样返回 —— 宁可颜色不对，也不要画不出来
  assert.equal(withAlpha("rebeccapurple", 0.5), "rebeccapurple");
});

/* ═══════════ ② 生死态势：越界计数与防抖一致 ═══════════ */

test("trailingRun 数列尾的连续段，不数前面那些", () => {
  assert.equal(trailingRun([1, 1, 0, 1, 1, 1], (v) => v === 1), 3);
  assert.equal(trailingRun([1, 1, 1], (v) => v === 1), 3);
  assert.equal(trailingRun([0, 1], (v) => v === 1), 1);
  assert.equal(trailingRun([1], (v) => v === 0), 0);
  assert.equal(trailingRun([], () => true), 0);
});

test("momentumBounds：没越界时不报越界方", () => {
  const rules = { lifeWinRatio: 0.6, deathWinRatio: 0.05 };
  assert.deepEqual(momentumBounds([0.2, 0.3, 0.4], rules), {
    lifeRun: 0,
    deathRun: 0,
    over: null,
  });
  assert.equal(momentumBounds([0.6, 0.59], rules).over, null, "0.59 已经不越线了");
  assert.equal(momentumBounds([0.2, 0.7, 0.5], rules).over, null, "只看末尾");
  assert.equal(momentumBounds([0.2, 0.7, 0.8], rules).over, "life");
  assert.equal(momentumBounds([0.2, 0.0], rules).over, "death");
});

/** 确定性伪随机（LCG）。差分测试要能一字不差地复现，所以不能用 Math.random */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const RULES: GameRules = {
  turnLimit: 1000,
  lifeWinRatio: 0.6,
  deathWinRatio: 0.05,
  lifeStreak: 3,
  deathStreak: 3,
};

/** 4×4 的几副典型棋盘：占满 / 3/4 / 一半 / 1 格 / 全空 */
const DIAL_BOARDS: Board[] = [
  boardFromRows(["####", "####", "####", "####"]),
  boardFromRows(["####", "####", "####", "...."]),
  boardFromRows(["##..", "##..", "....", "...."]),
  boardFromRows(["#...", "....", "....", "...."]),
  boardFromRows(["....", "....", "....", "...."]),
];

test("差分：态势图的越界计数与 classifyTermination 的防抖判定完全一致", () => {
  // 用真实的终局判定当基准。两边各写一遍的计数迟早会漂移，而漂移的症状是
  // 「图上已经显示连续 3 轮越界，却还没判生之执胜」—— 看一眼会觉得是模型的问题
  const rand = lcg(20480);
  const levels = [0, 0.03, 0.05, 0.5, 0.62, 0.6, 0.9, 1];

  // 先钉几条**手工构造**的样本：随机采样可能一条都采不到「刚刚够越界」的
  // 那种边界情形，而防抖的全部意义就在那条边界上（差一轮判不判胜）
  const cases: Array<{ board: Board; history: number[] }> = [
    { board: DIAL_BOARDS[0], history: [1, 0.9, 0.8] }, // 生执：4 轮越界，判胜
    { board: DIAL_BOARDS[0], history: [0.1, 0.7] }, // 生执：3 轮，刚好够
    { board: DIAL_BOARDS[0], history: [0.7, 0.8, 0.9] }, // 生执：全程越界
    { board: DIAL_BOARDS[0], history: [0.1, 0.7, 0.5] }, // 末尾掉回中线内
    { board: DIAL_BOARDS[1], history: [0.8, 0.7] }, // 生执：占比 0.75，刚好够 3 轮
    { board: DIAL_BOARDS[1], history: [0.61, 0.61] }, // 生执：擦着 0.6 的线
    { board: DIAL_BOARDS[4], history: [0, 0.03, 0.04] }, // 死执：4 轮，判胜
    { board: DIAL_BOARDS[4], history: [0, 0.04] }, // 死执：3 轮，刚好够
    { board: DIAL_BOARDS[4], history: [0.05, 0] }, // 死执：全在线上或线下
    { board: DIAL_BOARDS[4], history: [0.9, 0.01, 0.02] }, // 死执：从高处跌下来之后连着 3 轮
    { board: DIAL_BOARDS[3], history: [0.03, 0.02] }, // 死执：占比 0.0625 没越线
    { board: DIAL_BOARDS[2], history: [0.9, 0.9, 0.9] }, // 占比冻在中线附近
    { board: DIAL_BOARDS[1], history: [] }, // 没有历史，只有当前局面
  ];
  for (const board of DIAL_BOARDS) {
    for (let trial = 0; trial < 12; trial++) {
      const history: number[] = [];
      const len = 1 + Math.floor(rand() * 5);
      for (let i = 0; i < len; i++) history.push(levels[Math.floor(rand() * levels.length)]);
      cases.push({ board, history });
    }
  }

  let checked = 0;
  let lifeCases = 0;
  let deathCases = 0;

  for (const { board, history } of cases) {
    {
      const ratio = aliveCount(board) / (board.cols * board.rows);
      const series = [...history, ratio];
      const bounds = momentumBounds(series, RULES);
      const verdict = classifyTermination(
        { board, topology: "bounded", turn: history.length, ratioHistory: history },
        RULES,
        new Set([boardKey(board)]),
      );

      const ctx =
        `棋盘=${board.cells.join("")} 历史=[${history.join(",")}] 当前占比=${ratio} ` +
        `→ lifeRun=${bounds.lifeRun} deathRun=${bounds.deathRun} 判定=${verdict?.reason ?? "无"}`;

      assert.equal(
        verdict?.reason === "lifeWinRatio",
        bounds.lifeRun >= RULES.lifeStreak,
        `生之执胜负线与图上的越界计数对不上：${ctx}`,
      );
      assert.equal(
        verdict?.reason === "deathWinRatio",
        bounds.deathRun >= RULES.deathStreak,
        `死之执胜负线与图上的越界计数对不上：${ctx}`,
      );

      checked++;
      if (bounds.lifeRun >= RULES.lifeStreak) lifeCases++;
      if (bounds.deathRun >= RULES.deathStreak) deathCases++;
    }
  }
  assert.equal(cases.length, checked);

  // 下限断言：**逐侧**成立。总数达标可能是被另一条腿撑起来的，
  // 而「生之执那一侧其实一条都没触发」是这类对拍最典型的假绿
  assert.ok(checked >= 60, `对拍样本太少：${checked}`);
  assert.ok(lifeCases >= 6, `触发过生之执胜负线的样本太少：${lifeCases}`);
  assert.ok(deathCases >= 5, `触发过死之执胜负线的样本太少：${deathCases}`);
});

/* ═══════════ ③ 决策热力图 ═══════════ */

/** 一副生死各半的 4×4，用来核对「每格恰好属于一个角色」 */
const HEAT_BOARD = boardFromRows(["##..", ".##.", "....", "###."]);

test("buildHeat：每一格都有值，且恰好被一个角色认领", () => {
  // 生之执的候选是**死格**、死之执的候选是**活格**，两个候选集互斥且并集是全盘。
  // 所以热力图上不该有空隙、也不该有重叠 —— 这是这张图能画出来的前提
  const cells = HEAT_BOARD.cells.length;
  const life = new Map<number, number>();
  const death = new Map<number, number>();
  for (let i = 0; i < cells; i++) {
    if (HEAT_BOARD.cells[i]) death.set(i, 0.01 * (i + 1));
    else life.set(i, 0.01 * (i + 1));
  }

  const heat = buildHeat(HEAT_BOARD, { life, death });
  assert.equal(heat.values.length, cells);
  assert.equal(heat.roles.length, cells);

  for (let i = 0; i < cells; i++) {
    const alive = HEAT_BOARD.cells[i] === 1;
    assert.equal(
      heat.roles[i],
      alive ? HEAT_ROLE_DEATH : HEAT_ROLE_LIFE,
      `第 ${i} 格（${alive ? "活" : "死"}）归属错了`,
    );
    assert.ok(Number.isFinite(heat.values[i]), `第 ${i} 格是 NaN`);
    assert.ok(heat.values[i] > 0, `第 ${i} 格没有值 —— 热力图上会是一个空洞`);
    assert.ok(heat.values[i] <= 1, `第 ${i} 格超过 1：${heat.values[i]}`);
  }
});

test("buildHeat：归一化的分母是两个角色共用的全局最大值", () => {
  // 按各自的最大值归一化的话，两边的「最亮格」会一样亮，强弱就没法比了 ——
  // 而热力图要回答的正是「模型这一手更想要哪一格」。
  // 2 号格是死的（生之执的候选），1 号格是活的（死之执的候选）
  const life = new Map<number, number>([[2, 0.02]]);
  const death = new Map<number, number>([[1, 0.08]]);
  const heat = buildHeat(HEAT_BOARD, { life, death });

  assert.ok(Math.abs(heat.peak - 0.08) < 1e-12, `峰值应取全局最大：${heat.peak}`);
  assert.equal(heat.values[1], 1, "最亮的那一格必须正好是 1");
  assert.ok(Math.abs(heat.values[2] - 0.25) < 1e-12, `次要格应按全局峰值缩：${heat.values[2]}`);
});

test("buildHeat：分布缺失的格子是 0，不是 NaN 也不是别人的值", () => {
  const heat = buildHeat(HEAT_BOARD, { life: null, death: null });
  assert.equal(heat.peak, 0);
  for (const v of heat.values) assert.equal(v, 0);
});

test("buildHeat：某一方缺失时，只让另一方为 0，不牵连整张图", () => {
  // 代理没返回 / 解析失败时会走到这里。整张图黑掉的话，看的人会以为
  // 「这一手模型完全没有偏好」，而事实是「这一半的分布丢了」
  const death = new Map<number, number>([[0, 0.5]]);
  const heat = buildHeat(HEAT_BOARD, { life: null, death });
  assert.equal(heat.values[0], 1, "有分布的那一半照画");
  assert.equal(heat.values[2], 0, "生之执那一半没有数据");
  assert.equal(heat.peak, 0.5, "峰值只来自有数据的那一半");
});

test("buildHeat：格号按 r*cols+c 排，与棋盘同序", () => {
  // 顺序错了整张图会转置或错位，而「热力图和棋盘长得不一样」是很容易
  // 看成「模型就是想要那一格」的
  const life = new Map<number, number>([[7, 0.9]]); // r=1,c=3
  const heat = buildHeat(HEAT_BOARD, { life, death: null });
  assert.equal(HEAT_BOARD.cells[7], 0, "7 号格必须是死格，否则这条测试的前提就不成立");
  assert.equal(heat.values[7], 1);
  assert.equal(heat.values[6], 0, "左边的 6 号格不该跟着亮");
  assert.equal(heat.rows, 4);
  assert.equal(heat.cols, 4);
});

/* ══════════════════════════════════════════════════════════════
   三张图的空转冒烟（用假画布，见 `_canvas.ts`）
   ══════════════════════════════════════════════════════════════

   无头环境里看不到任何一张图，但**画得出异常**：越界的下标、空数据没提前返回、
   坐标系算反了。这一节专门请它们抛出来 —— 断言的是「画了什么」里最粗的那几笔，
   细的（配色、留白、线宽）只能靠人眼。 */

installRaf();

/**
 * 按颜色**前缀**数填充。
 *
 * 热力图的方块用的是 `rgba(74,222,128,α)`（α 随概率变），所以拿调色板的
 * `#4ade80` 去比是比不上的 —— 那正是「测试写错了而看起来像实现错了」的典型。
 */
function fillsWithPrefix(ctx: ReturnType<typeof fakeCanvas>["ctx"], prefix: string): number {
  return ctx.fills.filter((f) => f.frame === ctx.frame && f.color.startsWith(prefix)).length;
}

/** 热力图某一角色的方块数。`withAlpha` 的输出长这样：`rgba(74,222,128,0.5)` */
const heatFills = (ctx: ReturnType<typeof fakeCanvas>["ctx"], hex: string): number =>
  fillsWithPrefix(ctx, withAlpha(hex, 0).slice(0, -2));

function momentumSeries(): number[] {
  // 一段有涨有落、末尾停在死之执界限之外的占比序列
  return [0.22, 0.31, 0.44, 0.52, 0.61, 0.48, 0.35, 0.2, 0.09, 0.04, 0.01];
}

test("生死态势图：三条界限线都画了，越界时线头带计数的圆点", () => {
  const { canvas, ctx } = fakeCanvas();
  const c = new MomentumChart(canvas, PALETTE);
  c.resize(240, 96);
  c.setData({ ratios: momentumSeries(), rules: { lifeWinRatio: 0.6, deathWinRatio: 0.05 } });

  // 两条界限线用各自角色的颜色，中线是中性色 —— 颜色是这张图唯一的图例
  assert.ok(ctx.strokes.includes(PALETTE.life), "没有画生之执界限");
  assert.ok(ctx.strokes.includes(PALETTE.death), "没有画死之执界限");
  // 阈值标签：0.60 / 0.50 / 0.05
  assert.ok(ctx.texts.includes("0.60"), `没有标出生之执界限：${ctx.texts.join(",")}`);
  assert.ok(ctx.texts.includes("0.05"), "没有标出死之执界限");

  // 末尾两个点 0.04、0.01 都在死之执的界限（0.05）之下 → 连续越界 2 轮。
  // 线头应当是个带「2」的圆点，颜色与死之执的界限一致（红）
  assert.ok(fillsInLastFrame(ctx, PALETTE.death, 0) > 0, "越界了却没有画线头圆点");
  assert.ok(ctx.texts.includes("2"), `圆点里没有越界轮数：${ctx.texts.join(",")}`);
});

test("生死态势图：没越界时线头是中性小点，不报轮数", () => {
  const { canvas, ctx } = fakeCanvas();
  const c = new MomentumChart(canvas, PALETTE);
  c.resize(240, 96);
  c.setData({ ratios: [0.3, 0.4, 0.5], rules: { lifeWinRatio: 0.6, deathWinRatio: 0.05 } });

  // 两个角色色在图上只用于**界限线**（描边）与线头圆点（填充）。
  // 没越界时不该有任何一处用它们填充
  assert.equal(fillsInLastFrame(ctx, PALETTE.life, 0), 0);
  assert.equal(fillsInLastFrame(ctx, PALETTE.death, 0), 0);
  assert.ok(!ctx.texts.includes("1"), "没越界不该出现轮数");
});

test("生死态势图：没有数据时写「等待」，而不是画一条空线", () => {
  const { canvas, ctx } = fakeCanvas();
  const c = new MomentumChart(canvas, PALETTE);
  c.resize(240, 96);
  assert.ok(ctx.texts.includes(t("chart.mom.waiting")), "空数据时应当写一句「等待」");

  c.setData({ ratios: [], rules: { lifeWinRatio: 0.6, deathWinRatio: 0.05 } });
  assert.ok(ctx.texts.includes(t("chart.mom.waiting")), "空序列也要回到「等待」");

  // 清掉前几次绘制留下的文案：这里要看的是**这一次**画了什么
  ctx.texts.length = 0;
  c.setData({ ratios: [0.5, 0.6], rules: { lifeWinRatio: 0.6, deathWinRatio: 0.05 } });
  assert.ok(!ctx.texts.includes(t("chart.mom.waiting")), "有数据了还写着「等待」");
});

test("决策热力图：每一格都画了一个方块 —— 没有空隙", () => {
  // 规格里那条性质（每格恰好属于一个角色的候选集 → 每格都有值）在**画面上**
  // 的表现就是「填充次数正好等于格数」。少一格就是一个空洞
  const { canvas, ctx } = fakeCanvas();
  const c = new HeatChart(canvas, PALETTE);
  c.resize(132, 132);
  c.setData(buildHeat(HEAT_BOARD, { life: null, death: null }));

  assert.equal(
    heatFills(ctx, PALETTE.life) + heatFills(ctx, PALETTE.death),
    HEAT_BOARD.cells.length,
    "热力图的方块数不等于棋盘格数",
  );
});

test("决策热力图：长宽可不等（2×16 也不该溢出或重叠）", () => {
  const { canvas, ctx } = fakeCanvas();
  const c = new HeatChart(canvas, PALETTE);
  c.resize(132, 132);
  const board = boardFromRows(["##", "#.", ".#", "##"]); // 4×2，只验几何
  const heat = buildHeat(board, { life: null, death: null });

  c.setData(heat);
  assert.equal(heat.rows, 4);
  assert.equal(heat.cols, 2);
  assert.equal(heatFills(ctx, PALETTE.life) + heatFills(ctx, PALETTE.death), 8);
});

test("置信度图：两带相交时画出黄色交集，不相交时一格都不画", () => {
  const overlap = "rgba(251,191,36,.42)";

  const { canvas, ctx } = fakeCanvas();
  const c = new ConfidenceChart(canvas);
  c.resize(240, 92);
  c.setData([
    { stroke: PALETTE.life, fillFrom: "rgba(74,222,128,.3)", fillTo: "rgba(74,222,128,.05)", points: [pt(0.1, 0.9), pt(0.1, 0.9)] },
    { stroke: PALETTE.death, fillFrom: "rgba(248,113,113,.3)", fillTo: "rgba(248,113,113,.05)", points: [pt(0.0, 0.5), pt(0.0, 0.5)] },
  ]);
  assert.ok(fillsInLastFrame(ctx, overlap, 0) > 0, "两带明明相交，却没有画交集");

  // 一条全在上、一条全在下 → 交集为空
  const { canvas: c2, ctx: ctx2 } = fakeCanvas();
  const c2c = new ConfidenceChart(c2);
  c2c.resize(240, 92);
  c2c.setData([
    { stroke: PALETTE.life, fillFrom: "rgba(74,222,128,.3)", fillTo: "rgba(74,222,128,.05)", points: [pt(0.6, 0.9), pt(0.6, 0.9)] },
    { stroke: PALETTE.death, fillFrom: "rgba(248,113,113,.3)", fillTo: "rgba(248,113,113,.05)", points: [pt(0.0, 0.3), pt(0.0, 0.3)] },
  ]);
  assert.equal(fillsInLastFrame(ctx2, overlap, 0), 0, "两带不相交却画了交集");
});

test("置信度图：只有一个回合的数据时写「等待」，而不是画一个点", () => {
  const { canvas, ctx } = fakeCanvas();
  const c = new ConfidenceChart(canvas);
  c.resize(240, 92);
  c.setData([
    { stroke: PALETTE.life, fillFrom: "rgba(74,222,128,.3)", fillTo: "rgba(74,222,128,.05)", points: [pt(0.1, 0.9)] },
    { stroke: PALETTE.death, fillFrom: "rgba(248,113,113,.3)", fillTo: "rgba(248,113,113,.05)", points: [pt(0.0, 0.5)] },
  ]);
  assert.ok(ctx.texts.includes(t("chart.conf.waiting")), "只有一个点时应当写「等待对局数据」");
});

test("置信度图：两带都在且有两个点时，「等待」必须消失", () => {
  // 上一条的反面。少了它，「等待」写死在那儿也能让上面那条通过
  const { canvas, ctx } = fakeCanvas();
  const c = new ConfidenceChart(canvas);
  c.resize(240, 92);
  ctx.texts.length = 0; // 只看这一次绘制
  c.setData([
    { stroke: PALETTE.life, fillFrom: "rgba(74,222,128,.3)", fillTo: "rgba(74,222,128,.05)", points: [pt(0.1, 0.9), pt(0.2, 0.8)] },
    { stroke: PALETTE.death, fillFrom: "rgba(248,113,113,.3)", fillTo: "rgba(248,113,113,.05)", points: [pt(0.0, 0.5), pt(0.1, 0.6)] },
  ]);
  assert.ok(!ctx.texts.includes(t("chart.conf.waiting")), "有数据了还写着「等待对局数据」");
});
