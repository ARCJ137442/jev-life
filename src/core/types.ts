/**
 * 生命棋的核心类型。
 *
 * 与 jev-2048 的一处关键差异：**棋盘尺寸不在模块级可变状态里**。
 * 2048 的 COLS/ROWS 是 ESM live binding（types.ts:17-21），好处是不用
 * 到处传宽高，代价是每个测试用例开头都要 setBoardSize(4,4) 复位，
 * 且「读到的值可能是刚才被别人改过的」这件事永远无法从代码上看出来。
 * 这里把宽高放进 Board 对象，不可变，没有全局状态。
 */

/** 边界语义 */
export type Topology = "bounded" | "torus";

/** 对局角色。短名直接用 Life / Death —— 长名 Keeper of Life 见 TERMS.md */
export type Role = "life" | "death";

/** 格子的一维索引：r * cols + c */
export type Cell = number;

export interface Board {
  readonly cols: number;
  readonly rows: number;
  /** 长度 cols*rows，取值 0 或 1 */
  readonly cells: Uint8Array;
}

/**
 * 最小棋盘尺寸。
 *
 * 下限取 4 而不是 1，因为环绕拓扑下退化尺寸的语义会变得诡异：
 * rows=2 时 r-1 与 r+1 是同一行，邻居被重复计数。与其在算法里特殊处理，
 * 不如从规则上排除。
 */
export const MIN_SIZE = 4;

/** 尺寸上限。8×8 是设计文档的推荐值；放大到 16×16 时全量 noul 会变成 256 个问题。 */
export const MAX_SIZE = 16;

/**
 * 对局规则。
 *
 * 胜负线用**比例**而不是绝对格数：绝对格数换个棋盘尺寸就不可比 ——
 * 设计文档的开局是 14 个活细胞，在 8×8（64 格）上是 21.9%，
 * 在 16×16（256 格）上只有 5.5%，逼得每个尺寸都要单独标定一整套阈值。
 *
 * 防抖（streak）的理由：生命游戏是混沌的，单代涨落很大。
 * 只看一代就判胜负，等于把胜负交给运气。
 */
export interface GameRules {
  /** 回合上限。到上限仍未分出胜负 → 和局 */
  readonly turnLimit: number;
  /** 活细胞占比 ≥ 此值，且**连续**保持 lifeStreak 回合 → 生之执获胜 */
  readonly lifeWinRatio: number;
  /** ≤ 此值且连续保持 deathStreak 回合 → 死之执获胜 */
  readonly deathWinRatio: number;
  /** 防抖：连续越界多少回合才算赢。两侧分开，因为博弈本身不对称 */
  readonly lifeStreak: number;
  readonly deathStreak: number;
}

export type TerminationReason =
  | "lifeWinRatio"
  | "deathWinRatio"
  | "turnLimit"
  | "noLegalCell" // 该角色的可翻集合本身就是空的
  | "repeatBlocked"; // 可翻集合非空，但每一格翻完都会落回见过的局面

export interface Termination {
  readonly reason: TerminationReason;
  /** null = 和局 */
  readonly winner: Role | null;
}

/** 终局判定需要的不只是当前棋盘 —— 防抖要用到占比历史，判重复要用到拓扑 */
export interface GameSnapshot {
  readonly board: Board;
  /** 算后继状态要用（repeatBlocked 检测） */
  readonly topology: Topology;
  readonly turn: number;
  /**
   * **此前各回合**的活细胞占比，从最早到最近。
   *
   * 刻意**不含当前局面** —— 当前占比由 `aliveCount(board) / (cols * rows)` 现算，
   * 单一来源。若把当前占比也塞进来，同一件事就有了两份可以互相矛盾的真相，
   * 而两份真相迟早会不一致。
   */
  readonly ratioHistory: readonly number[];
}
