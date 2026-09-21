import { test } from "node:test";
import assert from "node:assert/strict";

import {
  boardFromRows,
  boardKey,
  classifyTermination,
  createBoard,
  flip,
  legalCells,
  lifeStep,
} from "../core/life.js";
import type { Board, GameRules, GameSnapshot } from "../core/types.js";

/**
 * 胜负判定用的是「生死比例的界限 + 防抖」，不是「累计净增长的绝对阈值」。
 *
 * 为什么换：绝对格数换个棋盘尺寸就不可比 —— 设计文档的开局是 14 个活细胞，
 * 在 8×8（64 格）上是 21.9%，在 16×16（256 格）上只有 5.5%。逼得每个尺寸
 * 都要单独标定一整套阈值。比例天然跨尺寸可比，那个麻烦基本消失。
 *
 * 净增长没有消失 —— 它不再决定胜负，但仍然是跑分 CSV 里记录的一项统计。
 *
 * ⚠ 下面这些阈值全部是占位值，标定要等 T13 的跑分出来才谈得上。
 *   顺带记住 21.9% 这个数：设计文档的开局离「死之执获胜线」有多近，
 *   直接决定这局棋可玩不可玩。
 */
const rules: GameRules = {
  turnLimit: 90,
  lifeWinRatio: 0.6, // 活细胞占比 ≥ 60% 且连续保持 lifeStreak 回合 → 生之执胜
  deathWinRatio: 0.05, // ≤ 5% 且连续保持 deathStreak 回合 → 死之执胜
  lifeStreak: 3, // 防抖：只越界一代不算赢
  deathStreak: 3,
};

/**
 * 造快照。`ratioHistory` 从最早到最近排列，**只含此前各回合** ——
 * 当前占比由 board 现算（`aliveCount / (cols * rows)`），单一来源。
 *
 * 这一条是本文件最容易写错的地方：手写数字的用例里，那个数字必须与夹具棋盘
 * 的**实际**占比一致，否则测的是一份自相矛盾的状态。下面每个用例都标了
 * 当前的占比是怎么算出来的。
 */
function snap(board: Board, turn: number, ratioHistory: number[]): GameSnapshot {
  return { board, topology: "bounded", turn, ratioHistory };
}

/**
 * 8×8 棋盘，前 n 格活 —— 占比 n/64。
 *
 * 为什么不用 4×4：4×4 的占比分辨率只有 1/16 = 0.0625，而「死之执越界但防抖未满」
 * 那个用例需要一个**非零且 ≤ 0.05** 的当前占比 —— 4×4 上根本凑不出来
 * （1 格就已经 0.0625 > 0.05，0 格则是全死棋盘）。
 */
function boardWithAlive(n: number): Board {
  const b = createBoard(8, 8);
  for (let i = 0; i < n; i++) b.cells[i] = 1;
  return b;
}

/** 45/64 = 0.703125 ≥ lifeWinRatio(0.6) */
const lifeRatioBoard = () => boardWithAlive(45);
/** 2/64 = 0.03125 ≤ deathWinRatio(0.05) */
const deathRatioBoard = () => boardWithAlive(2);
/** 7/64 = 0.109375 —— 高于 deathWinRatio(0.05)，但远不到 lifeWinRatio(0.6) */
const aboveDeathBoard = () => boardWithAlive(7);
/** 16/64 = 0.25 —— 夹在两条线之间 */
const midRatioBoard = () => boardWithAlive(16);

/* ═══ 状态哈希 ═══ */

test("boardKey 对相同棋盘稳定，对不同棋盘不同", () => {
  const a = boardFromRows([".#..", "....", "....", "...."]);
  const b = boardFromRows([".#..", "....", "....", "...."]);
  const c = boardFromRows(["#...", "....", "....", "...."]);
  assert.equal(boardKey(a), boardKey(b));
  assert.notEqual(boardKey(a), boardKey(c));
});

test("boardKey 含尺寸，尺寸不同的棋盘不会撞 key", () => {
  // 4×4 全死与 5×5 全死：cells 都是全 0。若 key 只编码 cells 而不带尺寸，
  // 这两者会撞在一起 —— 而它们是不同的局面（合法落点、后继全都不同）。
  const four = boardFromRows(["....", "....", "....", "...."]);
  const five = boardFromRows([".....", ".....", ".....", ".....", "....."]);
  assert.notEqual(boardKey(four), boardKey(five), "4×4 与 5×5 的全死棋盘撞了 key —— key 没带尺寸");
});

/* ═══ 胜负线：比例 + 防抖 ═══
   防抖的用途是挡住「一代走运就赢」—— 生命游戏是混沌的，单代涨落很大。 */

test("单次越界不足以判赢 —— 防抖生效", () => {
  const b = lifeRatioBoard(); // 当前占比 0.703125
  // 序列（历史 + 现算的当前）= [0.3, 0.7, 0.703125]，末尾连续越界 2 回合 < lifeStreak(3)
  assert.equal(classifyTermination(snap(b, 10, [0.3, 0.7]), "life", rules, new Set<string>()), null);
});

test("连续越界达到 lifeStreak 回合，生之执获胜", () => {
  const b = lifeRatioBoard();
  // 序列 = [0.3, 0.7, 0.7, 0.703125] → 末尾连续 3 个 ≥ 0.6
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.3, 0.7, 0.7]), "life", rules, new Set<string>()),
    { reason: "lifeWinRatio", winner: "life" },
  );
});

test("连续被打断则重新计数", () => {
  const b = lifeRatioBoard();
  // 序列 = [0.7, 0.7, 0.3, 0.703125] → 末尾只连续 1 个，前面的 0.3 把计数截断了
  assert.equal(
    classifyTermination(snap(b, 10, [0.7, 0.7, 0.3]), "life", rules, new Set<string>()),
    null,
  );
});

test("死之执侧同理，且两侧阈值与防抖长度可以不同", () => {
  const b = deathRatioBoard(); // 当前占比 0.03125 ≤ deathWinRatio(0.05)
  // 序列 = [0.3, 0.03, 0.03125] → 连续 2 个 ≤ 0.05，未满 deathStreak(3)
  assert.equal(
    classifyTermination(snap(b, 10, [0.3, 0.03]), "death", rules, new Set<string>()),
    null,
    "只连续 2 回合（当前这一代也计入），防抖未满",
  );
  // 序列 = [0.3, 0.03, 0.03, 0.03125] → 连续 3 个
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.3, 0.03, 0.03]), "death", rules, new Set<string>()),
    { reason: "deathWinRatio", winner: "death" },
  );
});

test("0.109375 没有越死之执的界 —— 阈值是 0.05 不是 0.2", () => {
  const b = aboveDeathBoard(); // 当前占比 0.109375
  // 序列全是 0.1/0.109375 —— 高于 0.05，一个都不越界
  assert.equal(
    classifyTermination(snap(b, 10, [0.1, 0.1, 0.1, 0.1]), "death", rules, new Set<string>()),
    null,
    "高于 0.05，不该被判越界（这条用例是阈值从 0.2 改到 0.05 时加的回归）",
  );
});

test("到回合上限仍未越界 → 和局", () => {
  const b = midRatioBoard(); // 当前占比 0.25，夹在两条线之间
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0.25, 0.25]), "life", rules, new Set<string>()),
    { reason: "turnLimit", winner: null },
  );
});

test("胜负线优先于回合上限 —— 同一回合两者都满足时判胜负", () => {
  const b = lifeRatioBoard();
  // 序列 = [0.7, 0.7, 0.703125]，turn 也已到 90
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0.7, 0.7]), "life", rules, new Set<string>()),
    { reason: "lifeWinRatio", winner: "life" },
    "两者同时满足时应判胜负，而不是和局",
  );
});

test("胜负线优先于无棋可走 —— 全死棋盘若已连续越界，原因归胜负线", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  // 序列 = [0, 0, 0, 0]：生之执侧连续 0 个，死之执侧连续 4 个 ≥ deathStreak(3)。
  // 死之执此时也确实无格可翻（棋盘全死），但判定顺序把胜负线排在前面。
  assert.deepEqual(
    classifyTermination(snap(b, 5, [0, 0, 0]), "death", rules, new Set<string>()),
    { reason: "deathWinRatio", winner: "death" },
    "胜负线在前，就不该报成 noLegalCell",
  );
});

/* ═══ 走投无路 ═══
   注意这是两种不同的情况，不能合并 —— 而且它们的**判定单位**也不一样：

   - noLegalCell：**按角色**判。该角色必须行动，但可翻集合本身就是空的
     （全死 → 死执无处可翻）。回合因此根本成立不了，游戏结束。
   - repeatBlocked：**按回合**判。回合的结构是「双方同时各走一步，再演化一代」，
     所以「推不动」是对回合而言的 —— 只要存在**任意一对**
     (生之执落点, 死之执落点) 能演化出 seen 之外的局面，这一回合就推得动。

   按角色判 repeatBlocked 是错的：一方全惰性、另一方还有得走时会被误判成卡死。
   实测（16×16 的方块阵，方块间隔 2 格，36 格）确实如此 —— 死之执的 36 个落点
   全是惰性的，而它的回合搭档生之执有 220 个落点、其中 156 个能改变局面。
   旧实现按角色判，于是第 1 代就终局，而它明明推得动。 */

test("棋盘全死时，死之执无格可翻 —— 此时按占比判死之执胜", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  // 占比 0 ≤ deathWinRatio，防抖未满（序列 = [0, 0] → 连续 2 < 3）本来不该判赢；
  // 但游戏因为「无棋可走」而终止，此时直接按占比定胜负
  assert.deepEqual(
    classifyTermination(snap(b, 5, [0]), "death", rules, new Set<string>()),
    { reason: "noLegalCell", winner: "death" },
  );
});

test("棋盘全活时，生之执无格可翻 —— 此时按占比判生之执胜", () => {
  const b = boardFromRows(["####", "####", "####", "####"]);
  assert.deepEqual(
    classifyTermination(snap(b, 5, [1]), "life", rules, new Set<string>()),
    { reason: "noLegalCell", winner: "life" },
  );
});

test("无棋可走优先于回合上限 —— 回合已满但无棋可走时，原因归无棋可走", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0]), "death", rules, new Set<string>()),
    { reason: "noLegalCell", winner: "death" },
    "无棋可走在回合上限之前，原因不该报成 turnLimit",
  );
});

/*
 * repeatBlocked —— 设计文档漏掉的那条终局原因。
 *
 * 注意这些是**对判定规则本身的单元测试**，不是「构造了一个自然死局」。
 * 我实测过：4×4 上根本不存在双方合起来也推不动的局面 —— 65536 种棋盘穷举，
 * 在「双方都还有落点」的前提下，一对新局面都没有的局面是 **0 个**。
 * （计划里「4×4 角落放一个孤立方块，双方落点可能都惰性」那条提示，
 *   实测不成立：方块的 4 个角被敲掉任一格都会在一代后长回原样，但生之执的
 *   12 个落点里有能改变局面的。）
 *
 * 所以「真卡死」只能由 `seen` 覆盖到全部后继来构造。下面给两种构造：
 *   - 一个手写 `seen` 的（单个活细胞 → 后继只有空棋盘一种），不依赖任何公式
 *   - 一个把全部组合的后继算进 `seen` 的
 * 前者的夹具前提是显式写出来的，后者直接用「全部组合的后继」这个定义本身。
 */

/**
 * 16×16 的方块阵，方块之间空 `gap` 格。
 *
 * `gap = 2`（步长 4）摆出 9 个方块 / 36 格 / 占比 0.140625 —— 正是这次修复的
 * 验收夹具。注意它**不是** presets.ts 里的 `block-mesh`：那个的间隔是 1 格
 * （64 格），实测死之执的 64 个落点里有 4 个能改变局面，推得动，验不了这条。
 */
function blockMesh(gap: number): string[] {
  const SIZE = 16;
  const PAD = 2;
  const stride = 2 + gap;
  const grid = Array.from({ length: SIZE }, () => Array.from({ length: SIZE }, () => "."));
  for (let r = PAD; r + 1 < SIZE - PAD; r += stride) {
    for (let c = PAD; c + 1 < SIZE - PAD; c += stride) {
      grid[r][c] = "#";
      grid[r][c + 1] = "#";
      grid[r + 1][c] = "#";
      grid[r + 1][c + 1] = "#";
    }
  }
  return grid.map((row) => row.join(""));
}

/** 一对落点走完一回合后的局面 key —— 与实现在 classifyTermination 内部算的是同一件事 */
function roundKey(b: Board, life: number, death: number): string {
  return boardKey(lifeStep(flip(flip(b, life), death), "bounded"));
}

/** 全部 (生之执落点, 死之执落点) 组合的后继 key */
function roundSuccessors(b: Board): Set<string> {
  const out = new Set<string>();
  for (const l of legalCells(b, "life")) {
    for (const d of legalCells(b, "death")) out.add(roundKey(b, l, d));
  }
  return out;
}

/*
 * 这条用例锁的是**被推翻的旧语义**，改写自
 * 「两个角色的合法集不同，repeatBlocked 必须按角色分别判定」。
 *
 * 旧实现按角色判：死之执的 36 个落点全惰性 → 判它走投无路。但它从来不是
 * 单独行动的 —— 同一个回合里生之执还要落一子，而那一子能把局面推到新局面。
 * 判定单位错了，结论就错了。
 */
test("只有一方惰性不算卡死 —— repeatBlocked 是回合级的，与角色无关", () => {
  const b = boardFromRows(blockMesh(2));
  const seen = new Set<string>([boardKey(b)]);

  // 夹具前提先钉死，免得将来棋盘或规则变了、用例却还在「靠运气」通过
  const deaths = legalCells(b, "death");
  assert.equal(deaths.length, 36, "夹具不是预期的 36 个活细胞");
  assert.ok(
    deaths.every((d) => boardKey(lifeStep(flip(b, d), "bounded")) === boardKey(b)),
    "夹具前提不成立：死之执存在能改变局面的落点",
  );
  const lifes = legalCells(b, "life");
  const lifeChanges = lifes.filter(
    (l) => boardKey(lifeStep(flip(b, l), "bounded")) !== boardKey(b),
  );
  assert.equal(lifes.length, 220);
  assert.equal(lifeChanges.length, 156, "夹具前提不成立：生之执能改变局面的落点数变了");

  // 死之执单独走一步确实全惰性 —— 但它和生之执是同一个回合的两半。
  // 存在能走出新局面的组合（实测第一对命中是 l=1, d=38），所以这一回合推得动。
  assert.equal(
    classifyTermination(snap(b, 10, []), "death", rules, seen),
    null,
    "死之执的落点全惰性，但生之执还推得动 —— 不该判走投无路",
  );
  assert.equal(
    classifyTermination(snap(b, 10, []), "life", rules, seen),
    null,
    "同一个局面上两个角色的结论必须一致：repeatBlocked 不含角色",
  );
});

test("全部组合的后继都已见过时才判 repeatBlocked（占比居中 → 和局）", () => {
  const b = boardFromRows(blockMesh(2));
  const seen = new Set<string>([boardKey(b), ...roundSuccessors(b)]);
  // 占比 36/256 = 0.140625，夹在两条线之间；turn 10 < turnLimit 90
  assert.deepEqual(
    classifyTermination(snap(b, 10, []), "life", rules, seen),
    { reason: "repeatBlocked", winner: null },
  );
  assert.deepEqual(
    classifyTermination(snap(b, 10, []), "death", rules, seen),
    { reason: "repeatBlocked", winner: null },
    "回合级的判定不该因为换了个角色就改口",
  );
});

test("手写的 seen 也能构造出真卡死：孤零零一个活细胞的下场只有空棋盘", () => {
  const b = boardFromRows(["#...", "....", "....", "...."]);
  const dead = boardFromRows(["....", "....", "....", "...."]);
  // 这一局面的回合后继**只有**空棋盘一种：死之执把唯一的活细胞敲掉、生之执
  // 在别处补一个，而单个活细胞周围一个邻居都没有，下一代必死。
  // seen 里这两个 key 都是手写的，没有任何一条来自实现内部的计算公式。
  const seen = new Set<string>([boardKey(b), boardKey(dead)]);
  // 占比 1/16 = 0.0625，高于 deathWinRatio(0.05) → 不硬判胜方
  assert.deepEqual(
    classifyTermination(snap(b, 10, []), "life", rules, seen),
    { reason: "repeatBlocked", winner: null },
  );
});

test("只要还有一对组合能产生新局面，就不该判 repeatBlocked", () => {
  const b = boardFromRows(blockMesh(2));
  // 必须先把「就是原局面」的后继剔掉 —— 它本来就在 seen 里（seen 含当前局面），
  // 拿它当那个「被漏掉的」等于什么都没漏。实测这个夹具上惰性组合占了很大一部分。
  const fresh = [...roundSuccessors(b)].filter((k) => k !== boardKey(b));
  assert.ok(fresh.length > 1, "这个夹具需要至少两种新局面才有意义");
  // 只漏掉其中一种 —— 只要它还能被某一对组合走出来，就不算推不动
  const seen = new Set<string>([boardKey(b), ...fresh.slice(1)]);
  assert.equal(
    classifyTermination(snap(b, 10, []), "life", rules, seen),
    null,
    "漏掉一种新局面都不该判走投无路，何况这里漏的是全部新局面里的一种",
  );
});

test("repeatBlocked 时同样按占比定胜负 —— 占比越界则判该方胜", () => {
  // 15/16 活，占比 0.9375 ≥ lifeWinRatio。生之执只剩 1 格可翻、
  // 回合也已经推不动了 —— 这时不该因为「防抖未满」判和局，规则第 2 条直接按占比定胜负。
  const b = boardFromRows(["####", "####", "####", "###."]);
  const seen = new Set<string>([boardKey(b), ...roundSuccessors(b)]);
  // 序列 = [0.9, 0.9375] → 连续 2 < lifeStreak(3)，胜负线这一条确实没越
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.9]), "life", rules, seen),
    { reason: "repeatBlocked", winner: "life" },
  );
});

test("终局判定不改动入参", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  const ratios = [0.25, 0.25];
  const before = Array.from(b.cells);
  classifyTermination(snap(b, 10, ratios), "life", rules, new Set<string>());
  assert.deepEqual(Array.from(b.cells), before);
  assert.deepEqual(ratios, [0.25, 0.25], "ratioHistory 被改动了");
});
