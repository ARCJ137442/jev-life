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
   注意这是两种不同的情况，不能合并：
   - noLegalCell：该角色的可翻集合本身就是空的（全死 → 死执无处可翻）
   - repeatBlocked：可翻集合非空，但每一格翻完演化一代都会落回见过的局面 */

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
 * 注意这条是**对判定规则本身的单元测试**，不是「构造了一个自然死局」。
 * 我推演过：4×4 角落放一个方块并不构成死局 —— 仍有落点能改变局面。
 * 自然死局要靠 `seen` 积累到把所有后继都覆盖才出现，很难在测试里手工构造。
 * 所以这里直接给定 `seen`，验证规则按预期裁决。
 */
/** 夹具：4×4 的方块（静物），4 个活细胞 → 占比 0.25，夹在两条线之间 */
const stuckBoard = () => boardFromRows([".##.", ".##.", "....", "...."]);

/** 某角色全部落点的后继 —— 与实现在 classifyTermination 内部算的是同一件事 */
function successorsOf(b: Board, role: "life" | "death"): Set<string> {
  return new Set(legalCells(b, role).map((c) => boardKey(lifeStep(flip(b, c), "bounded"))));
}

test("所有候选落点都会导致重复时，判 repeatBlocked（占比居中 → 和局）", () => {
  const b = stuckBoard();
  const seen = new Set([boardKey(b), ...successorsOf(b, "life")]);
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.25]), "life", rules, seen),
    { reason: "repeatBlocked", winner: null },
  );
});

test("只要还有一个候选能产生新状态，就不该判 repeatBlocked", () => {
  const b = stuckBoard();
  const all = legalCells(b, "life");
  assert.ok(all.length > 1, "这个夹具需要至少两个候选才有意义");
  // 只把「除第一个之外」的后继塞进 seen —— 第一个仍能产生新状态
  const seen = new Set([boardKey(b)]);
  for (const cell of all.slice(1)) seen.add(boardKey(lifeStep(flip(b, cell), "bounded")));
  assert.equal(classifyTermination(snap(b, 10, [0.25]), "life", rules, seen), null);
});

test("两个角色的合法集不同，repeatBlocked 必须按角色分别判定", () => {
  // 同一个 seen 下，一方走投无路而另一方还有路。
  //
  // 这个夹具上死之执的 4 个落点**全部**会演化回原局面：方块是静物，敲掉任一角
  // 变成 L 三格，而缺的那格恰好有 3 个活邻居 —— 下一代又长回方块（实测确认）。
  // 生之执的 12 个落点则各自走向新局面，没有一个回到原状。
  const b = stuckBoard();
  const seen = new Set([boardKey(b)]);

  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.25]), "death", rules, seen),
    { reason: "repeatBlocked", winner: null },
    "死之执每一格翻完都回到原局面，应判走投无路",
  );
  assert.equal(
    classifyTermination(snap(b, 10, [0.25]), "life", rules, seen),
    null,
    "生之执还有落点能走出新局面（只是占比居中、回合未满），不该被判走投无路",
  );
});

test("repeatBlocked 时同样按占比定胜负 —— 占比越界则判该方胜", () => {
  // 15/16 活，占比 0.9375 ≥ lifeWinRatio。生之执只剩 1 格可翻，
  // 而它的后继已经见过 —— 这时不该因为「防抖未满」判和局，规则第 2 条直接按占比定胜负。
  const b = boardFromRows(["####", "####", "####", "###."]);
  const seen = new Set([boardKey(b), ...successorsOf(b, "life")]);
  // 序列 = [0.9, 0.9375] → 连续 2 < lifeStreak(3)，胜负线这一条确实没越
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.9]), "life", rules, seen),
    { reason: "repeatBlocked", winner: "life" },
  );
});

test("终局判定不改动入参", () => {
  const b = stuckBoard();
  const ratios = [0.25, 0.25];
  const before = Array.from(b.cells);
  classifyTermination(snap(b, 10, ratios), "life", rules, new Set<string>());
  assert.deepEqual(Array.from(b.cells), before);
  assert.deepEqual(ratios, [0.25, 0.25], "ratioHistory 被改动了");
});
