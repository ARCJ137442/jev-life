/**
 * 棋盘基础操作的测试。
 *
 * 两条贯穿全篇的纪律：
 *
 * 1. **夹具一律 ≥ MIN_SIZE**。`MIN_SIZE = 4` 不是摆设 —— 环绕拓扑下
 *    rows=2 会让 r-1 与 r+1 变成同一行，所以 2×2 的「棋盘」在规则上不存在。
 *    用 2×2 写测试会撞在 assertSize 上，测的就不是被测函数了。
 *
 * 2. **纯度用「同一批对象 + 快照对比」验证**，不是「再造一个棋盘比一比」。
 *    jev-2048 的第一条红线就是这么栽的：`validMoves()` 内部调 `moveTiles()`，
 *    一旦后者有副作用，每次询问合法方向都会真把棋盘搅乱一次 —— 而用
 *    makeTile 造新对象的测试**根本覆盖不到**这类 bug，因为新对象本来就是干净的。
 *    这里同理：legalCells 会被 UI 每帧调用来高亮可选格，flip 一旦有副作用，
 *    每次高亮都会改棋盘。所以下面的测试显式把**同一个 Board** 交给每个函数，
 *    再断言它没被动过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aliveCount,
  assertSize,
  boardFromRows,
  cellAt,
  createBoard,
  flip,
  isAlive,
  legalCells,
  sameBoard,
  toRows,
} from "../core/life.js";
import { MAX_SIZE, MIN_SIZE } from "../core/types.js";

/** 棋盘格图案 —— 活死各半，索引算错时最容易暴露 */
function checker(cols: number, rows: number): string[] {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => ((r + c) % 2 === 0 ? "#" : ".")).join(""),
  );
}

/**
 * 形状与密度各异的夹具。
 *
 * 「互斥」与「完备」这两条性质必须**在不同尺寸、不同活死比例下都成立** ——
 * 只验一个 4×4 的话，把 cols 与 rows 写反、或者把二维索引算成 `c * rows + r`
 * 之类的错误，恰好可能在那一个形状上不出错。
 */
const FIXTURES: ReadonlyArray<readonly [string, string[]]> = [
  ["4×4 稀疏", ["#..#", ".##.", "....", "#.#."]],
  ["5×6 棋盘格", checker(5, 6)],
  ["8×8 棋盘格", checker(8, 8)],
  ["7×4 全活", Array.from({ length: 4 }, () => "#".repeat(7))],
  ["16×16 全死", Array.from({ length: 16 }, () => ".".repeat(16))],
];

/* ═══ 构造与渲染 ═══ */

test("boardFromRows 按 . 与 # 构造棋盘", () => {
  const b = boardFromRows(["....", "..#.", "...X", "...."]);
  assert.equal(b.cols, 4);
  assert.equal(b.rows, 4);
  assert.equal(b.cells.length, 16);
  assert.equal(isAlive(b, 1 * 4 + 2), true, "(1,2) 应为活");
  assert.equal(isAlive(b, 2 * 4 + 3), true, "'X' 也应算作活细胞");
  assert.equal(isAlive(b, 0), false);
  assert.equal(aliveCount(b), 2);
});

test("boardFromRows 拒绝行长度不一致，并指出是第几行", () => {
  assert.throws(
    () => boardFromRows(["....", "....", "...", "...."]),
    /第 2 行/,
    "第三行短了一列 —— 报错必须指出位置，否则 16×16 的棋盘上根本找不到",
  );
  assert.throws(() => boardFromRows(["....", "....", "....", "....."]), /第 3 行/);
});

test("toRows 与 boardFromRows 互逆", () => {
  const rows = [".#..", "#.#.", "..#.", "...."];
  assert.deepEqual(toRows(boardFromRows(rows)), rows);
  // 非方阵也要成立 —— 上次转置错误的常见藏身处
  assert.deepEqual(toRows(boardFromRows(checker(5, 7))), checker(5, 7));
});

test("aliveCount 数出活细胞数", () => {
  assert.equal(aliveCount(boardFromRows(["....", ".##.", ".##.", "...."])), 4);
  assert.equal(aliveCount(boardFromRows(["#...", "#...", "#...", "#..."])), 4);
  assert.equal(aliveCount(createBoard(4, 4)), 0);
});

/* ═══ 尺寸约束 ═══ */

test("createBoard / assertSize 卡住尺寸的上下界与非整数", () => {
  assert.equal(createBoard(MIN_SIZE, MAX_SIZE).cells.length, MIN_SIZE * MAX_SIZE);
  assert.doesNotThrow(() => assertSize(MIN_SIZE, MIN_SIZE));
  assert.doesNotThrow(() => assertSize(MAX_SIZE, MAX_SIZE));
  assert.throws(() => createBoard(MIN_SIZE - 1, MIN_SIZE), /尺寸/);
  assert.throws(() => createBoard(MIN_SIZE, MAX_SIZE + 1), /尺寸/);
  assert.throws(() => createBoard(4.5, 4), /整数/);
});

/* ═══ 单格读写 ═══ */

test("cellAt 拒绝越界索引：非整数、负数、越上界", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  assert.throws(() => cellAt(b, b.cells.length), /越界/);
  assert.throws(() => cellAt(b, -1), /越界/);
  assert.throws(() => cellAt(b, 1.5), /越界/);
  assert.throws(() => cellAt(b, Number.NaN), /越界/);
  assert.equal(cellAt(b, 0), 0);
  assert.equal(cellAt(b, b.cells.length - 1), b.cells.length - 1);
});

test("isAlive 与 flip 在越界时抛错，不静默返回 false", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  assert.throws(() => isAlive(b, b.cells.length), /越界/);
  assert.throws(() => flip(b, -1), /越界/);
});

test("flip 翻转一格，两次回到原状", () => {
  const b = boardFromRows([".#..", "....", "....", "...."]);
  assert.equal(isAlive(b, 0), false);
  assert.equal(isAlive(flip(b, 0), 0), true);
  const twice = flip(flip(b, 1), 1);
  assert.deepEqual(Array.from(twice.cells), Array.from(b.cells));
});

/* ═══ sameBoard ═══ */

test("sameBoard：内容相同则为 true", () => {
  const a = boardFromRows(["##..", "....", "....", "...."]);
  assert.equal(sameBoard(a, boardFromRows(["##..", "....", "....", "...."])), true);
  assert.equal(sameBoard(a, a), true, "自反");
});

test("sameBoard：尺寸不同则为 false —— 即使内容都是全死", () => {
  const four = boardFromRows(["....", "....", "....", "...."]);
  const five = boardFromRows(Array.from({ length: 5 }, () => "....."));
  assert.equal(sameBoard(four, five), false);
  assert.equal(sameBoard(five, four), false);
});

test("sameBoard：尺寸相同但内容不同则为 false", () => {
  const a = boardFromRows(["#...", "....", "....", "...."]);
  const b = boardFromRows([".#..", "....", "....", "...."]);
  assert.equal(aliveCount(a), aliveCount(b), "夹具退化：活细胞数不同就测不出内容比较");
  assert.equal(sameBoard(a, b), false);
});

/* ═══ legalCells ═══ */

test("legalCells：life 与 death 的交集为空", () => {
  // 这条是「同时决策」成立的数学基础：两边各发一个请求、都基于演化前的棋盘，
  // 落子永远不会撞在同一格上，所以不需要任何冲突消解规则。
  // 一旦实现成「不按活死过滤」或过滤条件写反，交集立刻非空 —— 那时两个
  // 请求会同时声称同一格合法，冲突消解就得临时发明，而且会污染测量。
  let mixed = 0;
  for (const [name, rows] of FIXTURES) {
    const b = boardFromRows(rows);
    const life = new Set(legalCells(b, "life"));
    const death = legalCells(b, "death");
    if (life.size > 0 && death.length > 0) mixed++;
    for (const cell of death) {
      assert.equal(life.has(cell), false, `${name}：格子 ${cell} 同时出现在两个合法集里`);
    }
  }
  // 全活 / 全死这两种极端下交集必然为空（其中一方就是空集），互斥在它们上面
  // 是废话。非退化的夹具不够多的话，这条用例等于没测 —— 所以这里卡一个下限。
  // （极端情形另有专门用例：见「全活棋盘 life 为空，全死棋盘 death 为空」。）
  assert.ok(mixed >= 3, `非退化夹具过少（${mixed}），互斥性实际上没被验到`);
});

test("legalCells：两者的并集恰是全部格子", () => {
  // 每个格子要么是死格（归 life）要么是活格（归 death），没有第三种。
  // 这条保证双方各自算出的「候选空间」拼起来是完整棋盘 —— 少一格就意味着
  // 有一类落子双方都按不出来，而且不会有任何报错，只会让某一边莫名少一步。
  for (const [name, rows] of FIXTURES) {
    const b = boardFromRows(rows);
    const union = new Set([...legalCells(b, "life"), ...legalCells(b, "death")]);
    assert.equal(union.size, b.cells.length, `${name}：并集大小不等于格子总数`);
    for (let i = 0; i < b.cells.length; i++) {
      assert.equal(union.has(i), true, `${name}：格子 ${i} 不属于任何一方`);
    }
  }
});

test("legalCells：数量与死格数 / aliveCount 一致", () => {
  for (const [name, rows] of FIXTURES) {
    const b = boardFromRows(rows);
    assert.equal(
      legalCells(b, "life").length,
      b.cells.length - aliveCount(b),
      `${name}：life 的候选数应等于死格数`,
    );
    assert.equal(
      legalCells(b, "death").length,
      aliveCount(b),
      `${name}：death 的候选数应等于活细胞数`,
    );
  }
});

test("legalCells：全活棋盘 life 为空，全死棋盘 death 为空", () => {
  const full = boardFromRows(Array.from({ length: 5 }, () => "#####"));
  assert.deepEqual(legalCells(full, "life"), [], "没有死格，生之执无子可落");
  assert.equal(legalCells(full, "death").length, 25);

  const empty = createBoard(5, 5);
  assert.deepEqual(legalCells(empty, "death"), [], "没有活格，死之执无子可落");
  assert.equal(legalCells(empty, "life").length, 25);
});

/* ═══ 纯度：同一个 Board 交给每个函数，逐个确认没被改动 ═══ */

test("所有基础操作都不改动入参（同一批对象 + 快照对比）", () => {
  const b = boardFromRows(["#..#", ".##.", "....", "#.#."]);
  const before = JSON.stringify(Array.from(b.cells));
  const sizeBefore = `${b.cols}x${b.rows}`;

  const ops: ReadonlyArray<readonly [string, () => unknown]> = [
    ["flip", () => flip(b, 0)],
    ["flip(最后一格)", () => flip(b, b.cells.length - 1)],
    ["legalCells(life)", () => legalCells(b, "life")],
    ["legalCells(death)", () => legalCells(b, "death")],
    ["aliveCount", () => aliveCount(b)],
    ["toRows", () => toRows(b)],
    ["cellAt", () => cellAt(b, 5)],
    ["isAlive", () => isAlive(b, 5)],
    ["sameBoard", () => sameBoard(b, b)],
    ["assertSize", () => assertSize(b.cols, b.rows)],
  ];

  for (const [name, run] of ops) {
    run();
    assert.equal(JSON.stringify(Array.from(b.cells)), before, `${name} 修改了入参的 cells`);
    assert.equal(`${b.cols}x${b.rows}`, sizeBefore, `${name} 修改了入参的尺寸`);
  }
});

test("flip 返回的 Board 不与入参共享底层数组", () => {
  // 上面那条快照对比抓不到「返回后再改」—— 一个直接传 `b.cells` 的实现
  // 能通过所有「调用前后不变」的断言，但调用方一改返回值，入参就被污染了。
  const b = boardFromRows(["#...", "....", "....", "...."]);
  const next = flip(b, 5);
  next.cells[0] = 0;
  assert.equal(b.cells[0], 1, "flip 返回的 Board 与入参共享底层数组");
});
