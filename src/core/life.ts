import type { Board, Cell, Role, Topology } from "./types.js";
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

/**
 * B3/S23 的朴素参照实现 —— **只用于测试**。
 *
 * 刻意写成与 lifeStep 完全不同的思路（逐格双层循环 + 显式边界分支），
 * 这样两个实现不会共享同一个思维错误 —— 若两边用同一套循环写边界，
 * 一个错的对齐会在两处同时出现，差分测试就永远抓不到它。
 * jev-2048 的差分测试用的就是这个手法（engine.test.ts 的 reference()）。
 *
 * 规则（B3/S23）：
 *   死细胞周围恰好 3 个活细胞 → 诞生
 *   活细胞周围 2 或 3 个活细胞 → 存活
 *   其余 → 死亡
 */
export function referenceStep(b: Board, topo: Topology): Board {
  const { cols, rows, cells } = b;
  const next = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          let rr = r + dr;
          let cc = c + dc;
          if (topo === "torus") {
            rr = (rr + rows) % rows;
            cc = (cc + cols) % cols;
          } else if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) {
            continue; // bounded：界外视为死
          }
          n += cells[rr * cols + cc];
        }
      }
      const alive = cells[r * cols + c];
      next[r * cols + c] = alive ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
    }
  }
  return { cols, rows, cells: next };
}

/**
 * 位并行的 B3/S23（每格占 4 bit，整行打包进一个 BigInt）。
 *
 * 为什么是 4 bit：一个格子最多有 8 个活邻居，8 = 0b1000 需要 4 位才放得下，
 * 这样 8 个邻居直接**相加**就不会进位串到隔壁格子 —— 位平面因此能一次算完整行。
 *
 * 为什么选位并行：torus 的水平环绕在位表示下就是一次循环移位，
 * 朴素实现则要为每个边界格子写分支。
 * （它在这个棋盘尺寸下未必更快 —— 见 T6 的基准测试，由数据说话。）
 */
export function lifeStep(b: Board, topo: Topology): Board {
  const { cols, rows, cells } = b;
  const width = BigInt(4 * cols);
  const FRAME = (1n << width) - 1n;

  // 每个 nibble 的四个位平面掩码
  let m0 = 0n;
  let m1 = 0n;
  let m2 = 0n;
  let m3 = 0n;
  for (let c = 0; c < cols; c++) {
    const s = BigInt(4 * c);
    m0 |= 1n << s;
    m1 |= 1n << (s + 1n);
    m2 |= 1n << (s + 2n);
    m3 |= 1n << (s + 3n);
  }

  const packed: bigint[] = [];
  for (let r = 0; r < rows; r++) {
    let x = 0n;
    const base = r * cols;
    for (let c = 0; c < cols; c++) if (cells[base + c]) x |= 1n << BigInt(4 * c);
    packed.push(x);
  }

  const wrap = BigInt(4 * (cols - 1));
  const rollL = (x: bigint): bigint => {
    const top = (x >> wrap) & 0xfn;
    return ((x << 4n) | top) & FRAME;
  };
  const rollR = (x: bigint): bigint => {
    const bot = x & 0xfn;
    return (x >> 4n) | (bot << wrap);
  };
  const shlL = (x: bigint): bigint => (topo === "torus" ? rollL(x) : (x << 4n) & FRAME);
  const shlR = (x: bigint): bigint => (topo === "torus" ? rollR(x) : x >> 4n);

  const rowAt = (r: number): bigint => {
    if (r < 0 || r >= rows) return topo === "torus" ? packed[(r + rows) % rows] : 0n;
    return packed[r];
  };

  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const mid = packed[r];
    const up = rowAt(r - 1);
    const dn = rowAt(r + 1);

    // 8 个邻居相加。每个 nibble 的值落在 0..8，不会进位到相邻 nibble。
    const sum = shlL(up) + up + shlR(up) + shlL(mid) + shlR(mid) + shlL(dn) + dn + shlR(dn);

    // 把四个位平面全部对齐到 nibble 的最低位（4c），才能逐格做条件判断
    const b0 = sum & m0;
    const b1 = (sum & m1) >> 1n;
    const b2 = (sum & m2) >> 2n;
    const b3 = (sum & m3) >> 3n;

    const alive = mid & m0;
    // BigInt 的 ~ 是无限位的，直接用会跑到 frame 之外；取反一律在 m0 掩码内做
    const zero = (x: bigint): bigint => m0 ^ x;

    // 恰好 3 个邻居：0011
    const n3 = b0 & b1 & zero(b2) & zero(b3);
    // 恰好 2 个邻居：0010
    const n2 = b1 & zero(b0) & zero(b2) & zero(b3);

    // 活细胞存活（2 或 3），死细胞诞生（恰好 3）
    const next = (alive & (n2 | n3)) | (zero(alive) & n3);

    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      if ((next >> BigInt(4 * c)) & 1n) out[base + c] = 1;
    }
  }

  return { cols, rows, cells: out };
}
