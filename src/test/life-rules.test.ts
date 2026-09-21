import { test } from "node:test";
import assert from "node:assert/strict";

import {
  actionCells,
  allCells,
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
  return { board, mode: "duel", topology: "bounded", turn, ratioHistory };
}

/** 同一副局面、同一段历史，**单人模式**下的快照 */
function soloSnap(board: Board, turn: number, ratioHistory: number[]): GameSnapshot {
  return { board, mode: "solo", topology: "bounded", turn, ratioHistory };
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
  assert.equal(classifyTermination(snap(b, 10, [0.3, 0.7]), rules, new Set<string>()), null);
});

test("连续越界达到 lifeStreak 回合，生之执获胜", () => {
  const b = lifeRatioBoard();
  // 序列 = [0.3, 0.7, 0.7, 0.703125] → 末尾连续 3 个 ≥ 0.6
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.3, 0.7, 0.7]), rules, new Set<string>()),
    { reason: "lifeWinRatio", winner: "life" },
  );
});

test("连续被打断则重新计数", () => {
  const b = lifeRatioBoard();
  // 序列 = [0.7, 0.7, 0.3, 0.703125] → 末尾只连续 1 个，前面的 0.3 把计数截断了
  assert.equal(
    classifyTermination(snap(b, 10, [0.7, 0.7, 0.3]), rules, new Set<string>()),
    null,
  );
});

test("死之执侧同理，且两侧阈值与防抖长度可以不同", () => {
  const b = deathRatioBoard(); // 当前占比 0.03125 ≤ deathWinRatio(0.05)
  // 序列 = [0.3, 0.03, 0.03125] → 连续 2 个 ≤ 0.05，未满 deathStreak(3)
  assert.equal(
    classifyTermination(snap(b, 10, [0.3, 0.03]), rules, new Set<string>()),
    null,
    "只连续 2 回合（当前这一代也计入），防抖未满",
  );
  // 序列 = [0.3, 0.03, 0.03, 0.03125] → 连续 3 个
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.3, 0.03, 0.03]), rules, new Set<string>()),
    { reason: "deathWinRatio", winner: "death" },
  );
});

test("0.109375 没有越死之执的界 —— 阈值是 0.05 不是 0.2", () => {
  const b = aboveDeathBoard(); // 当前占比 0.109375
  // 序列全是 0.1/0.109375 —— 高于 0.05，一个都不越界
  assert.equal(
    classifyTermination(snap(b, 10, [0.1, 0.1, 0.1, 0.1]), rules, new Set<string>()),
    null,
    "高于 0.05，不该被判越界（这条用例是阈值从 0.2 改到 0.05 时加的回归）",
  );
});

test("到回合上限仍未越界 → 和局", () => {
  const b = midRatioBoard(); // 当前占比 0.25，夹在两条线之间
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0.25, 0.25]), rules, new Set<string>()),
    { reason: "turnLimit", winner: null },
  );
});

test("胜负线优先于回合上限 —— 同一回合两者都满足时判胜负", () => {
  const b = lifeRatioBoard();
  // 序列 = [0.7, 0.7, 0.703125]，turn 也已到 90
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0.7, 0.7]), rules, new Set<string>()),
    { reason: "lifeWinRatio", winner: "life" },
    "两者同时满足时应判胜负，而不是和局",
  );
});

test("胜负线优先于无棋可走 —— 全死棋盘若已连续越界，原因归胜负线", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  // 序列 = [0, 0, 0, 0]：生之执侧连续 0 个，死之执侧连续 4 个 ≥ deathStreak(3)。
  // 死之执此时也确实无格可翻（棋盘全死），但判定顺序把胜负线排在前面。
  assert.deepEqual(
    classifyTermination(snap(b, 5, [0, 0, 0]), rules, new Set<string>()),
    { reason: "deathWinRatio", winner: "death" },
    "胜负线在前，就不该报成 noLegalCell",
  );
});

/* ═══ 走投无路 ═══
   注意这是两种不同的情况，不能合并 —— 而它们**都是对局级的**：

   - noLegalCell：某一方一格都落不下去了 —— 全死（死之执把活细胞**清空**了）
     / 全活（生之执把棋盘**占满**了）。**清空或占满的那一方获胜**。
   - repeatBlocked：双方都有落点，但不存在任何一对 (生之执落点, 死之执落点)
     能演化出 seen 之外的局面 —— 走也白走。胜方按当前占比定，理由见 life.ts。

   ═══ noLegalCell 判的是「谁把棋盘做成了自己要的样子」 ═══

   原因名是 noLegalCell，但它不是「谁没棋走谁就输」—— 恰恰相反：
   一方无子可翻 ⟺ 棋盘全死或全活 ⟺ **它已经把棋盘做成了自己目的的样子**
   （死之执清空全部活细胞 / 生之执把整个棋盘占满）。对方一格都翻不动，
   正是因为它的目的已经彻底达成。所以判它胜，而不是像早先那样去套占比阈值。
   套阈值只在棋盘恰好全死/全活时碰巧给出同一个答案，阈值一被推到极端就会
   把「清空棋盘」改判掉（见下面那条极端阈值的用例）。

   ═══ 为什么这条以前是「按角色判」而现在不是 ═══

   旧实现只查**被问的那一方**，于是全死棋盘上问生之执会掉进 repeatBlocked
   —— 结论碰巧一样（占比 0 也算出死之执胜），但**原因是错的**。终局条件
   全都是对局级的，不属于任何一方，所以 classifyTermination 的 role 参数
   已经去掉了。**去掉 role 是那处修复的结论，不是顺手做的清理** ——
   下一个人想把这个参数加回来时，先看 life.ts 里那段注释。

   ═══ repeatBlocked 的判定单位 ═══

   按角色判 repeatBlocked 是错的：一方全惰性、另一方还有得走时会被误判成卡死。
   实测（16×16 的方块阵，方块间隔 2 格，36 格）确实如此 —— 死之执的 36 个落点
   全是惰性的，而它的回合搭档生之执有 220 个落点、其中 156 个能改变局面。
   旧实现按角色判，于是第 1 代就终局，而它明明推得动。

   ═══ 「无棋可走但占比在两线之间 → 和局」对 noLegalCell 不可达 ═══

   可翻集合为空 ⟺ 棋盘全死或全活 ⟺ 占比恰为 0 或 1，永远落在极值。
   「占比居中 → 和局」只能由 repeatBlocked 触达（见下面占比居中的那条用例）。 */

test("棋盘被清空（全死）→ 死之执无格可翻 → 判死之执胜", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  // 占比 0：防抖未满（序列 = [0, 0] → 连续 2 < deathStreak(3)），
  // 胜负线这一条本来不触发；判死之执胜靠的是「棋盘已被它清空」本身。
  assert.deepEqual(
    classifyTermination(snap(b, 5, [0]), rules, new Set<string>()),
    { reason: "noLegalCell", winner: "death" },
  );
  /*
   * 这条用例**曾经要问两次**，两次的答案还不一样：
   *   问死之执 → { noLegalCell, death }
   *   问生之执 → { repeatBlocked, death }   ← 结论碰巧对，原因错
   * 全死棋盘上生之执**有**落点（16 个死格全可翻），旧实现只查被问的那一方，
   * 于是漏掉了「死之执已把活细胞清空」这个真正的原因。
   *
   * 现在 role 参数没了，两次提问合并成上面那一次 —— 第二行从此不可表达。
   * 这正是这次修复要的效果，所以这里不再重复调用（重复调用只会是同一行代码
   * 写两遍，什么也锁不住）。旧行为由 git 历史与本次提交信息留档。
   */
});

test("棋盘被占满（全活）→ 生之执无格可翻 → 判生之执胜", () => {
  // 对称的另一半：全活棋盘上死之执**有**落点（16 个活格全可翻），
  // 旧实现问死之执时同样会掉进 repeatBlocked。查两边才治得住这一半。
  const b = boardFromRows(["####", "####", "####", "####"]);
  assert.deepEqual(
    classifyTermination(snap(b, 5, [1]), rules, new Set<string>()),
    { reason: "noLegalCell", winner: "life" },
  );
});

/*
 * 这条锁的是「胜方不来自阈值」这个新性质。
 *
 * 两条规则把阈值推到了极端。注意两条断言里**真正有鉴别力的是第二条**：
 *   - deathWinRatio = 0：全死棋盘占比 0，而 `0 <= 0` 仍然成立，所以就算胜方
 *     来自 ratioWinner，也还是判死之执胜 —— 这一条单独看是**等价**的，
 *     留着是因为它正是「把死之执的线调到 0」这个最自然的误操作。
 *   - lifeWinRatio = 0：ratioWinner 里生之执那条判在前，`0 >= 0` 先命中，
 *     于是旧写法会把**全死棋盘判给生之执** —— 荒谬。这一条才有鉴别力。
 * 两条一起，把「胜方与阈值无关」钉死。
 */
test("『清空棋盘』的胜方不来自阈值 —— 阈值推到极端时结论不变", () => {
  const dead = boardFromRows(["....", "....", "....", "...."]);
  const full = boardFromRows(["####", "####", "####", "####"]);
  // 阈值推到极端，但防抖与历史刻意留短（序列 = [0, 0]，连续 2 < streak 3），
  // 免得胜负线那条分支抢在前面 —— 那样测的就不是 noLegalCell 了。
  const noWinLine: GameRules = { ...rules, deathWinRatio: 0 };
  const noLifeLine: GameRules = { ...rules, lifeWinRatio: 0 };

  assert.deepEqual(
    classifyTermination(snap(dead, 5, [0]), noWinLine, new Set<string>()),
    { reason: "noLegalCell", winner: "death" },
    "deathWinRatio 调到 0，全死棋盘仍应判死之执胜",
  );
  assert.deepEqual(
    classifyTermination(snap(full, 5, [1]), noWinLine, new Set<string>()),
    { reason: "noLegalCell", winner: "life" },
    "同一套极端阈值下，全活棋盘仍应判生之执胜",
  );
  assert.deepEqual(
    classifyTermination(snap(dead, 5, [0]), noLifeLine, new Set<string>()),
    { reason: "noLegalCell", winner: "death" },
    "lifeWinRatio 调到 0 时，『清空棋盘』绝不能被判给生之执 —— 胜方与阈值无关",
  );
});

test("清空棋盘优先于回合上限 —— 回合已满但棋盘已被清空时，原因归 noLegalCell", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0]), rules, new Set<string>()),
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

/** 全部 (生之执落点, 死之执落点) 组合的后继 key —— **双人局**的「推得动」判据 */
function roundSuccessors(b: Board): Set<string> {
  const out = new Set<string>();
  for (const l of legalCells(b, "life")) {
    for (const d of legalCells(b, "death")) out.add(roundKey(b, l, d));
  }
  return out;
}

/**
 * **单人局**全部落点的后继 key。
 *
 * ⚠ 与 `roundSuccessors` 不是一回事，不能互相顶替：单人局只有**一格**落子，
 * 而且行动方生死一体，合法集是**全部格子**（`actionCells`）—— 所以要枚举的是
 * 16 个单翻，不是「死格 × 活格」的成对组合。
 *
 * 这一条是 2026-09-21 生死一体那次改出来的：在那之前单人局只有死格可翻，
 * 有个用例就借用了双人的 `roundSuccessors` 当 `seen`，靠 4×4 上单翻与双翻的
 * 后继 key **偶然重合**而通过。合法集改成全部格子之后不再重合，它就红了 ——
 * 而那次变红是**对的**，被测的语义确实变了。
 */
function soloSuccessors(b: Board): Set<string> {
  const out = new Set<string>();
  for (const c of allCells(b)) out.add(boardKey(lifeStep(flip(b, c), "bounded")));
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
  // 这里曾经还要用另一个 role 再问一遍，确认两边结论一致；role 参数去掉之后
  // 「两边」已经不存在了，那次调用随之消失。
  assert.equal(
    classifyTermination(snap(b, 10, []), rules, seen),
    null,
    "死之执的落点全惰性，但生之执还推得动 —— 不该判走投无路",
  );
});

test("全部组合的后继都已见过时才判 repeatBlocked（占比居中 → 和局）", () => {
  const b = boardFromRows(blockMesh(2));
  const seen = new Set<string>([boardKey(b), ...roundSuccessors(b)]);
  // 占比 36/256 = 0.140625，夹在两条线之间；turn 10 < turnLimit 90。
  // 注意「占比居中 → 和局」这条**只可能由 repeatBlocked 触达**：
  // noLegalCell 只出现在占比恰为 0 或 1 的时候（见本文件「走投无路」那段）。
  assert.deepEqual(
    classifyTermination(snap(b, 10, []), rules, seen),
    { reason: "repeatBlocked", winner: null },
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
    classifyTermination(snap(b, 10, []), rules, seen),
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
    classifyTermination(snap(b, 10, []), rules, seen),
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
    classifyTermination(snap(b, 10, [0.9]), rules, seen),
    { reason: "repeatBlocked", winner: "life" },
  );
});

test("终局判定不改动入参", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  const ratios = [0.25, 0.25];
  const before = Array.from(b.cells);
  classifyTermination(snap(b, 10, ratios), rules, new Set<string>());
  assert.deepEqual(Array.from(b.cells), before);
  assert.deepEqual(ratios, [0.25, 0.25], "ratioHistory 被改动了");
});

/* ══════════════════════════════════════════════════════════════════
   ★ 单人模式（`Mode = "solo"`）
   ══════════════════════════════════════════════════════════════════
   单人局里没有死之执，于是好几条**对局级**规则的含义跟着变。这一段钉的就是
   那些分叉 —— 它们每一条错了都不会报错，只会让单人局按双人规则判。 */

test("★ 单人：棋盘全死**不是** noLegalCell —— 「死之执无处可翻」在单人局里不成立", () => {
  // 全死棋盘。防抖设成 99 是为了绕开胜负线那一条，单独看 noLegalCell 这个分叉 ——
  // 否则占比 0 会先命中 deathWinRatio，两条路径都结束对局、分不出差别
  const dead = createBoard(4, 4);
  const slow: GameRules = { ...rules, deathStreak: 99, lifeStreak: 99 };

  // 双人：死之执一格都翻不动 → 判死之执胜（棋盘被清空）
  assert.deepEqual(
    classifyTermination(snap(dead, 5, []), slow, new Set<string>()),
    { reason: "noLegalCell", winner: "death" },
    "双人局里棋盘全死应当是 noLegalCell",
  );

  // 单人：生之执处处可翻，所以**不查死之执那一侧**。它落在 repeatBlocked 上 ——
  // 「翻哪一格，演化一代之后都回到这同一副全死局面」，那是真的推不动
  assert.deepEqual(
    classifyTermination(soloSnap(dead, 5, []), slow, new Set<string>([boardKey(dead)])),
    { reason: "repeatBlocked", winner: null },
    "单人局里棋盘全死不该判任何人胜 —— 没有对手，也没有「被清空」这回事",
  );
});

test("★ 单人：占比连续跌破死之执线时，报的是「棋盘死绝」而不是「死之执获胜」", () => {
  const dead = createBoard(4, 4);
  // 序列 = [0, 0, 0]，连续 3 回合 ≤ 5%
  assert.deepEqual(
    classifyTermination(soloSnap(dead, 8, [0, 0]), rules, new Set<string>()),
    { reason: "soloDiedOut", winner: null },
    "单人局没有胜方 —— 胜方为 null，理由另立一条",
  );
  // 同一个局面在双人局里仍然是「死之执获胜」
  assert.deepEqual(classifyTermination(snap(dead, 8, [0, 0]), rules, new Set<string>()), {
    reason: "deathWinRatio",
    winner: "death",
  });
});

test("★ 单人：生之执占满棋盘仍是 noLegalCell 且判生之执胜（这一条两种模式一致）", () => {
  const full = boardFromRows(["####", "####", "####", "####"]);
  assert.deepEqual(
    classifyTermination(soloSnap(full, 8, []), { ...rules, lifeStreak: 99 }, new Set<string>()),
    { reason: "noLegalCell", winner: "life" },
  );
});

test("★ 单人：repeatBlocked 的胜方不会落到「死之执」上", () => {
  // 占比冻在死之执线附近、防抖又没满时，双人那条按占比定胜负；
  // 单人局里把「死之执胜」映成 null（没有对手），不能照抄
  const b = boardFromRows(["####", "####", "####", "###."]);
  const slow: GameRules = { ...rules, lifeStreak: 99, deathStreak: 99 };

  // 两种模式的 `seen` **必须分开造**：双人的后继是「死格 × 活格」成对组合，
  // 单人只有单翻、而且合法集是全部格子（`soloSuccessors` 的注释记着这次改动）
  const duelSeen = new Set<string>([boardKey(b), ...roundSuccessors(b)]);
  const soloSeen = new Set<string>([boardKey(b), ...soloSuccessors(b)]);

  // 双人：占比 0.9375 ≥ lifeWinRatio → 生之执胜
  assert.equal(classifyTermination(snap(b, 10, [0.9]), slow, duelSeen)?.winner, "life");
  // 单人：同一副局面，结论同样是玩家胜（映 null 只针对 death 那一侧）
  assert.deepEqual(classifyTermination(soloSnap(b, 10, [0.9]), slow, soloSeen), {
    reason: "repeatBlocked",
    winner: "life",
  });
});

test("★ actionCells：双人局与 legalCells 逐格相同；单人局是**全部格子**", () => {
  const b = boardFromRows(["##..", ".##.", "....", "###."]);

  // 双人局：一个字节都不该变 —— 这条改动**不允许**碰到双人的合法集
  for (const role of ["life", "death"] as const) {
    assert.deepEqual(
      actionCells(b, role, "duel"),
      legalCells(b, role),
      `${role} 在双人局下的合法集被改动了`,
    );
  }

  // 单人局：行动方生死一体，两种都能翻 ⟹ 全部格子（升序）
  assert.deepEqual(actionCells(b, "life", "solo"), allCells(b));
  assert.equal(actionCells(b, "life", "solo").length, b.cells.length);
  // 「全部」不是「死格那一半」的同义词 —— 夹具上两者本来就不同，
  // 免得将来棋盘凑巧对称、这条断言变成恒真
  assert.notDeepEqual(actionCells(b, "life", "solo"), legalCells(b, "life"));
});

test("★ 单人：翻**活格**也算法定落点 —— 只查死格会把「其实推得动」判成推不动", () => {
  // 15 活 1 死：只有 1 个死格可翻，但那 1 个落点推不出新局面；
  // 而「把某个活格翻死」能。旧实现只枚举死格 ⟹ 误判推不动
  const b = boardFromRows(["####", "####", "####", "###."]);
  const slow: GameRules = { ...rules, lifeStreak: 99, deathStreak: 99 };

  // 先把夹具前提钉死，免得将来棋盘变了、用例却还在「靠运气」通过
  assert.equal(legalCells(b, "life").length, 1, "夹具不是预期的 1 个死格");
  assert.equal(actionCells(b, "life", "solo").length, 16, "单人局的合法集应当是全部 16 格");

  // `seen` 里只放「翻那个死格」得到的那一个后继 —— 于是推得动的**唯一**出路
  // 就是翻活格。旧实现（只枚举死格）会在这里判 true
  const onlyDeadFlip = new Set<string>([
    boardKey(b),
    boardKey(lifeStep(flip(b, legalCells(b, "life")[0]), "bounded")),
  ]);
  assert.equal(
    classifyTermination(soloSnap(b, 10, [0.5]), slow, onlyDeadFlip),
    null,
    "翻活格能推出新局面，却被判成推不动 —— 合法集少算了活格那一半",
  );
});

test("★ 回合上限 = null 表示**不设上限**：回合数再大也不判和局", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  const noLimit: GameRules = { ...rules, turnLimit: null };

  // 双人：与 rules.turnLimit(90) 比，第 500 回合早就该判和局了
  assert.deepEqual(classifyTermination(snap(b, 500, []), rules, new Set<string>()), {
    reason: "turnLimit",
    winner: null,
  });
  // 不设上限时同一步什么都不发生。
  // ⚠ 这里刻意用一个**极大**的回合数：拿 500 去测，把实现换成
  // `rules.turnLimit ?? Number.MAX_SAFE_INTEGER` 也能通过 —— 那是一个
  // **等价变异**，测不出「null 是真无上限」还是「只是上限很大」
  assert.equal(
    classifyTermination(snap(b, Number.MAX_SAFE_INTEGER, []), noLimit, new Set<string>()),
    null,
    "不设上限的对局不该因为回合数被掐断",
  );

  // 其余终局条件照旧生效 —— 「不设上限」不等于「不会结束」
  const full = boardFromRows(["####", "####", "####", "##.."]); // 14/16 = 0.875
  assert.equal(
    classifyTermination(snap(full, 500, [0.9]), { ...noLimit, lifeStreak: 2 }, new Set<string>())
      ?.reason,
    "lifeWinRatio",
    "不设回合上限之后，胜负线这一条仍然必须生效",
  );
});
