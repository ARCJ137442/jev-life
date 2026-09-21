import type { Board, Cell, Role } from "./types.js";
import { MAX_SIZE, MIN_SIZE } from "./types.js";

/**
 * 引擎纯度是硬约束 —— 与 jev-2048 的第一条红线同源。
 *
 * 那边的教训是：validMoves() 的实现是「对每个方向试着走一步，看是否移动」，
 * 一旦 moveTiles 有副作用，每次询问合法方向都会真把棋盘搅乱一次，
 * 症状是「方块跑到别的列」「动画走对角线」，而根因在引擎不在渲染。
 *
 * 这边同理：legalCells() 会被 UI 频繁调用（高亮可选格），
 * 一旦 flip 有副作用，每次高亮都会改棋盘。
 *
 * 所以本模块所有的 Board 变换一律**返回新对象**，绝不写回入参的 cells。
 */

export function assertSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new Error(`棋盘尺寸必须是整数，收到 ${cols}×${rows}`);
  }
  if (cols < MIN_SIZE || rows < MIN_SIZE || cols > MAX_SIZE || rows > MAX_SIZE) {
    throw new Error(`棋盘尺寸须在 ${MIN_SIZE}–${MAX_SIZE} 之间，收到 ${cols}×${rows}`);
  }
}

export function createBoard(cols: number, rows: number): Board {
  assertSize(cols, rows);
  return { cols, rows, cells: new Uint8Array(cols * rows) };
}

/** 用字符串行构造棋盘，'.' = 死，'#' 或 'X' 或 'o' = 活。测试与开局定义用 */
export function boardFromRows(rows: string[]): Board {
  const r = rows.length;
  const c = rows[0]?.length ?? 0;

  // 先查行长一致，再查尺寸。反过来的话，「第 3 行少了一列」这种错会先撞上
  // 尺寸下限，报出「棋盘尺寸须在 4–16 之间」—— 而 4×4 的棋盘恰好合法，
  // 真正的原因（某一行少打了一个点）被一条无关的报错盖掉了。
  for (let i = 0; i < r; i++) {
    if (rows[i].length !== c) {
      throw new Error(`第 ${i} 行长度不一致（期望 ${c} 列，实得 ${rows[i].length} 列）`);
    }
  }
  assertSize(c, r);

  const cells = new Uint8Array(c * r);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const ch = rows[i][j];
      if (ch === "#" || ch === "X" || ch === "o") cells[i * c + j] = 1;
    }
  }
  return { cols: c, rows: r, cells };
}

export function toRows(b: Board): string[] {
  const out: string[] = [];
  for (let r = 0; r < b.rows; r++) {
    let line = "";
    for (let c = 0; c < b.cols; c++) line += b.cells[r * b.cols + c] ? "#" : ".";
    out.push(line);
  }
  return out;
}

/**
 * 校验并归一化一个格子索引。
 *
 * 非整数必须一并拒绝：`cells[1.5]` 在 Uint8Array 上读得到 undefined（不是报错），
 * 于是 `isAlive` 会安静地返回 false —— 一个越界的坐标看起来就像一格死细胞。
 */
export function cellAt(b: Board, cell: Cell): Cell {
  if (!Number.isInteger(cell) || cell < 0 || cell >= b.cells.length) {
    throw new Error(`格子索引越界：${cell}（棋盘 ${b.cols}×${b.rows}）`);
  }
  return cell;
}

export function isAlive(b: Board, cell: Cell): boolean {
  return b.cells[cellAt(b, cell)] === 1;
}

export function aliveCount(b: Board): number {
  let n = 0;
  for (let i = 0; i < b.cells.length; i++) n += b.cells[i];
  return n;
}

/** 返回新 Board，绝不改动入参 */
export function flip(b: Board, cell: Cell): Board {
  cellAt(b, cell);
  const cells = Uint8Array.from(b.cells);
  cells[cell] = cells[cell] ? 0 : 1;
  return { cols: b.cols, rows: b.rows, cells };
}

export function sameBoard(a: Board, b: Board): boolean {
  return a.cols === b.cols && a.rows === b.rows && a.cells.every((v, i) => v === b.cells[i]);
}

/**
 * 某角色当前可以翻的格子。
 *
 * 生之执只能把死格子变活，死之执只能把活格子变死 —— 两个集合**天然互斥**。
 * 这是「同时决策」成立的数学基础：两边各发一个请求、都基于演化前的棋盘，
 * 落子永远不会撞在同一格上，不需要任何冲突消解规则。
 *
 * 两个集合的并集恰是全部格子（每格非死即活），所以双方合起来覆盖整个棋盘 ——
 * 不会有某一格两个角色都落不了子。
 */
export function legalCells(b: Board, role: Role): Cell[] {
  const want = role === "life" ? 0 : 1;
  const out: Cell[] = [];
  for (let i = 0; i < b.cells.length; i++) if (b.cells[i] === want) out.push(i);
  return out;
}
