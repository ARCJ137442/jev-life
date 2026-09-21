/**
 * `core/decide.ts` 的测试。
 *
 * 源仓库（jev-2048）的 `decision.ts` **零测试覆盖** —— 它不在 `tsconfig.test.json`
 * 的 include 里。这个文件是来还那笔债的。
 *
 * 这里锁的不是「代码跑得起来」，而是四件**做错了也照样跑得动**的事：
 *
 *   1. **首选非法时只在模型自己的分布内取次优**。改成「随便挑一个合法格」不会
 *      报错，只会让整局实验悄悄变成另一个算法 —— 而结果看起来完全正常
 *      （有落子、有概率、有胜负）。
 *   2. **`threshold` 只标记、不改动作**。它一旦真的改了动作，测到的就是
 *      「阈值策略」而不是「模型」，而这正是设计要避免的那件事。
 *   3. **`sample` 必须可重放**。源仓库用不可注入的 `Math.random`，导致这条
 *      策略**根本无法测**；这里把 `rand` 提成参数，所以要用固定序列把它钉死。
 *   4. **合法集依赖角色**。生之执翻死格、死之执翻活格，两个集合天然互斥 ——
 *      角色传错了不会报错，只会让一整局棋两边都在替对方落子。
 *
 * 夹具一律 ≥ `MIN_SIZE`(4)：2×2 在环绕拓扑下邻居会被重复计数，从规则上就排除了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { bestLegalCell, rankProbabilities, resolveDecision } from "../core/decide.js";
import type { CellProbabilities } from "../core/decide.js";
import { boardFromRows, legalCells } from "../core/life.js";
import type { Board, Cell } from "../core/types.js";

/* ══════════════════════════════════════════════════════════════════
   夹具
   ══════════════════════════════════════════════════════════════════ */

/**
 * 4×4，三个活细胞：0=(0,0) 5=(1,1) 10=(2,2)。
 *
 * 三个而不是一个，是为了让「生之执的合法集」与「死之执的合法集」都留得下
 * 多个可选项 —— 只有一个活细胞时，死之执的次优项根本不存在，
 * 「首选非法 → 取次优合法」这条路径压根测不到。
 */
const ROWS4 = ["#...", ".#..", "..#.", "...."];

const BOARD = (): Board => boardFromRows(ROWS4);

/** 死格（生之执的合法集）。三个活格 = 0 / 5 / 10，所以剩下这 13 格 */
const DEAD: readonly Cell[] = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15];

/** 概率分布夹具。用 Map 的插入顺序刻意打乱，逼实现自己排序而不是吃现成顺序 */
const dist = (entries: ReadonlyArray<readonly [Cell, number]>): CellProbabilities =>
  new Map(entries);

/* ══════════════════════════════════════════════════════════════════
   一、首选合法 → 直接取
   ══════════════════════════════════════════════════════════════════ */

test("首选合法 → 直接取，不标记纠正", () => {
  const board = BOARD();
  const d = dist([[5, 0.7], [0, 0.2], [10, 0.1]]);
  const r = resolveDecision(d, board, "death", "greedy", 0);

  assert.equal(r.cell, 5);
  assert.equal(r.coerced, false);
  assert.equal(r.reasonKey, "reason.takeTop");
  assert.equal(r.belowThreshold, false);
  // 没有被纠正时不该带「纠正了谁」的参数 —— 带了会让 UI 显示一句不存在的话
  assert.equal(r.reasonParams, undefined);
});

test("分布里的插入顺序不影响结果 —— 排序是实现自己的事", () => {
  const board = BOARD();
  // 同一组数，两种插入顺序
  const a = resolveDecision(dist([[5, 0.7], [0, 0.2], [10, 0.1]]), board, "death", "greedy", 0);
  const b = resolveDecision(dist([[10, 0.1], [5, 0.7], [0, 0.2]]), board, "death", "greedy", 0);
  assert.equal(a.cell, b.cell);
});

/* ══════════════════════════════════════════════════════════════════
   二、首选非法 → 只在模型自己的分布内退而求其次
   ══════════════════════════════════════════════════════════════════ */

test("首选非法 → 取分布内次优的合法格，标记 coerced", () => {
  const board = BOARD();
  // 0 是活格，生之执翻不了；6 与 7 都是死格，且 6 的概率更高
  const d = dist([[0, 0.9], [6, 0.06], [7, 0.04]]);
  const r = resolveDecision(d, board, "life", "greedy", 0);

  assert.equal(r.cell, 6, "应当取分布里概率最高的**合法**格");
  assert.equal(r.coerced, true);
  assert.equal(r.reasonKey, "reason.coerced");
  // 参数必须指向那个**非法的首选**，否则 UI 说不出「模型想走哪儿、被拦下了」
  assert.deepEqual(r.reasonParams, { row: 0, col: 0 });
});

test("绝不引入外部规则 —— 候选只可能来自分布本身", () => {
  const board = BOARD();
  // 分布只覆盖两个死格，合法集有 13 个。若实现跑去用 legal[0]，
  // 这里会拿到 1；正确实现只能在 6 与 7 里挑。
  const d = dist([[4, 0.6], [7, 0.4]]);
  const picked = new Set<Cell>();
  for (let i = 0; i < 50; i++) {
    picked.add(resolveDecision(d, board, "life", "greedy", 0).cell);
  }
  assert.deepEqual([...picked], [4]);
  assert.ok(!picked.has(legalCells(board, "life")[0]), "不该退化到 legal[0]");
});

test("分布里一个合法项都没有 → 只能取 legal[0]，并如实标记", () => {
  const board = BOARD();
  // 三项全是活格，生之执一格都翻不了
  const d = dist([[0, 0.5], [5, 0.3], [10, 0.2]]);
  const r = resolveDecision(d, board, "life", "greedy", 0);

  assert.equal(r.cell, DEAD[0]);
  assert.equal(r.coerced, true);
  assert.equal(r.reasonKey, "reason.noLegal");
});

test("分布为空 → 取 legal[0]，原因与「有分布但无合法项」不同", () => {
  const board = BOARD();
  const r = resolveDecision(new Map(), board, "life", "greedy", 0);

  assert.equal(r.cell, DEAD[0]);
  assert.equal(r.coerced, true);
  assert.equal(r.reasonKey, "reason.noProb");
});

test("无合法格时抛错，而不是返回一个 undefined 的落点", () => {
  // 全活：生之执一格都翻不动。这种局面本该由终局判定先结束对局
  const full = boardFromRows(["####", "####", "####", "####"]);
  assert.equal(legalCells(full, "life").length, 0);
  assert.throws(() => resolveDecision(dist([[0, 1]]), full, "life", "greedy", 0), /没有/);
});

/* ══════════════════════════════════════════════════════════════════
   三、threshold 只标记，不改动作
   ══════════════════════════════════════════════════════════════════ */

test("低于门槛 → 标记 belowThreshold，但落子与 greedy 完全一致", () => {
  const board = BOARD();
  const d = dist([[6, 0.3], [7, 0.25], [1, 0.2]]);

  const greedy = resolveDecision(d, board, "life", "greedy", 0.5);
  const thr = resolveDecision(d, board, "life", "threshold", 0.5);

  assert.equal(thr.cell, 6);
  assert.equal(thr.cell, greedy.cell, "threshold 策略不得改变动作");
  assert.equal(thr.belowThreshold, true);
  assert.equal(greedy.belowThreshold, false);
  assert.equal(thr.reasonKey, "reason.belowThreshold");
  // p / t 是**已修约成整数的百分比字符串** —— 与源仓库的词条契约一致，
  // 直接给 0.3 会被 `{p}%` 渲染成「0.3%」
  assert.deepEqual(thr.reasonParams, { p: "30", t: "50" });
});

test("门槛为 0 表示不启用 —— 即便概率很低也不标记", () => {
  const board = BOARD();
  const r = resolveDecision(dist([[6, 0.01], [7, 0.99]]), board, "life", "threshold", 0);
  assert.equal(r.cell, 7);
  assert.equal(r.belowThreshold, false);
  assert.equal(r.reasonKey, "reason.takeTop");
});

test("greedy 策略即便低于门槛也不标记 —— 那个字段只属于 threshold", () => {
  const board = BOARD();
  const r = resolveDecision(dist([[6, 0.01], [7, 0.99]]), board, "life", "greedy", 0.9);
  assert.equal(r.cell, 7);
  assert.equal(r.belowThreshold, false);
});

test("threshold 策略下首选非法时，coerced 与 belowThreshold 同时成立", () => {
  const board = BOARD();
  const d = dist([[0, 0.2], [6, 0.15], [7, 0.1]]);
  const r = resolveDecision(d, board, "life", "threshold", 0.5);

  assert.equal(r.cell, 6);
  assert.equal(r.coerced, true);
  assert.equal(r.belowThreshold, true);
  assert.equal(r.reasonKey, "reason.coerced");
});

/* ══════════════════════════════════════════════════════════════════
   四、sample：注入 rand 后可确定性重放
   ══════════════════════════════════════════════════════════════════ */

test("sample：rand 注入固定值 → 结果确定，且轮盘赌落在正确的区间", () => {
  const board = BOARD();
  // 生之执的合法集里三项：1(0.5) 2(0.3) 3(0.2)，归一化后 total = 1
  const d = dist([[1, 0.5], [2, 0.3], [3, 0.2]]);

  assert.equal(resolveDecision(d, board, "life", "sample", 0, () => 0).cell, 1);
  assert.equal(resolveDecision(d, board, "life", "sample", 0, () => 0.49).cell, 1);
  assert.equal(resolveDecision(d, board, "life", "sample", 0, () => 0.51).cell, 2);
  assert.equal(resolveDecision(d, board, "life", "sample", 0, () => 0.99).cell, 3);
});

test("sample：同一个 rand 反复调用得到同一个结果（真的可重放）", () => {
  const board = BOARD();
  const d = dist([[1, 0.25], [2, 0.5], [3, 0.25]]);
  const first = resolveDecision(d, board, "life", "sample", 0, () => 0.4).cell;
  for (let i = 0; i < 20; i++) {
    assert.equal(resolveDecision(d, board, "life", "sample", 0, () => 0.4).cell, first);
  }
});

test("sample：无论 rand 取何值都落在合法格上", () => {
  const board = BOARD();
  const legal = new Set(DEAD);
  // 分布里混着活格（非法）与死格（合法）
  const d = dist([[0, 0.5], [5, 0.3], [1, 0.15], [10, 0.05]]);

  for (let i = 0; i < 100; i++) {
    const t = i / 100;
    const r = resolveDecision(d, board, "life", "sample", 0, () => t);
    assert.ok(legal.has(r.cell), `rand=${t} 落到了非法格 ${r.cell}`);
  }
});

test("sample：选了分布首选时 coerced=false，否则为 true", () => {
  const board = BOARD();
  const d = dist([[6, 0.9], [7, 0.1], [0, 0.0]]);

  // rand=0 → 落在 6（分布首选，也是合法格）
  const top = resolveDecision(d, board, "life", "sample", 0, () => 0);
  assert.equal(top.cell, 6);
  assert.equal(top.coerced, false);

  // rand=0.95 → 落在 7（合法，但不是分布首选）
  const second = resolveDecision(d, board, "life", "sample", 0, () => 0.95);
  assert.equal(second.cell, 7);
  assert.equal(second.coerced, true);
});

test("sample：合法池为空时退回贪心路径，而不是返回 undefined", () => {
  const board = BOARD();
  // 分布只覆盖活格，生之执的池子是空的
  const d = dist([[0, 0.6], [5, 0.4]]);
  const r = resolveDecision(d, board, "life", "sample", 0, () => 0.3);
  assert.equal(r.cell, DEAD[0]);
  assert.equal(r.coerced, true);
  assert.equal(r.reasonKey, "reason.noLegal");
});

/* ══════════════════════════════════════════════════════════════════
   五、rankProbabilities / bestLegalCell
   ══════════════════════════════════════════════════════════════════ */

test("rankProbabilities：按概率降序，同概率按格子升序（不依赖插入顺序）", () => {
  const ranked = rankProbabilities(dist([[7, 0.5], [2, 0.5], [9, 0.1]]));
  assert.deepEqual(ranked, [[2, 0.5], [7, 0.5], [9, 0.1]]);

  // 反过来插一遍，结果必须一样
  const again = rankProbabilities(dist([[9, 0.1], [2, 0.5], [7, 0.5]]));
  assert.deepEqual(again, ranked);
});

test("bestLegalCell：跳过非法项取最高的合法项；一个都没有则 null", () => {
  const board = BOARD();
  const d = dist([[0, 0.9], [5, 0.05], [6, 0.03]]);

  assert.deepEqual(bestLegalCell(d, legalCells(board, "life")), { cell: 6, prob: 0.03 });
  // 死之执的合法集里只有 0 这一项在分布里
  assert.deepEqual(bestLegalCell(d, legalCells(board, "death")), { cell: 0, prob: 0.9 });

  const onlyIllegal = dist([[1, 0.9], [2, 0.1]]);
  assert.equal(bestLegalCell(onlyIllegal, legalCells(board, "death")), null);
});

/* ══════════════════════════════════════════════════════════════════
   六、角色真的起作用
   ══════════════════════════════════════════════════════════════════ */

test("同一份分布，换角色得到不同的落子 —— 合法集不是全局的", () => {
  const board = BOARD();
  const d = dist([[0, 0.9], [1, 0.1]]);

  const asDeath = resolveDecision(d, board, "death", "greedy", 0);
  const asLife = resolveDecision(d, board, "life", "greedy", 0);

  assert.equal(asDeath.cell, 0, "死之执能翻活格 0");
  assert.equal(asDeath.coerced, false);
  assert.equal(asLife.cell, 1, "生之执翻不了活格 0，只能退到 1");
  assert.equal(asLife.coerced, true);
  assert.notEqual(asDeath.cell, asLife.cell);
});

test("两个角色的合法集天然互斥，合起来覆盖整个棋盘", () => {
  const board = BOARD();
  const life = new Set(legalCells(board, "life"));
  const death = new Set(legalCells(board, "death"));

  for (const c of death) assert.ok(!life.has(c), `格子 ${c} 同时属于两边`);
  assert.equal(life.size + death.size, board.cells.length);
});

test("任何策略下返回的落点都必须是合法的", () => {
  const board = BOARD();
  const d = dist([[0, 0.4], [5, 0.3], [1, 0.2], [2, 0.1]]);

  for (const role of ["life", "death"] as const) {
    const legal = new Set(legalCells(board, role));
    for (const strategy of ["greedy", "sample", "threshold"] as const) {
      for (const t of [0, 0.5, 1]) {
        const r = resolveDecision(d, board, role, strategy, t, () => t);
        assert.ok(
          legal.has(r.cell),
          `role=${role} strategy=${strategy} threshold=${t} 给出了非法落点 ${r.cell}`,
        );
      }
    }
  }
});

/* ══════════════════════════════════════════════════════════════════
   七、纯函数
   ══════════════════════════════════════════════════════════════════ */

test("不改动入参：同一批对象传进去，棋盘与分布都必须原样", () => {
  // ★ 关键在于**同一批对象被反复传进去**。用 makeBoard() 每次造新对象的写法
  //   覆盖不到副作用类 bug：改动发生在被丢弃的那一份上，断言照样通过。
  const board = BOARD();
  const cellsBefore = Uint8Array.from(board.cells);
  const cellsIdentity = board.cells;

  const d = dist([[0, 0.9], [1, 0.1], [5, 0.0]]);
  const entriesBefore = [...d.entries()];

  resolveDecision(d, board, "life", "sample", 0.5, () => 0.3);
  resolveDecision(d, board, "death", "threshold", 0.5);
  resolveDecision(d, board, "life", "greedy", 0);

  assert.deepEqual([...board.cells], [...cellsBefore]);
  assert.equal(board.cells, cellsIdentity, "底层数组被换掉了，说明有人拷了一份回去");
  assert.deepEqual([...d.entries()], entriesBefore);
});
