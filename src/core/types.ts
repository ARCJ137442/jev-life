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
 * ⚠ **从 4 放宽到 2**（2026-09-21，用户要求长宽各自可自定义 2~16）。
 * 原本取 4 是为了回避环绕拓扑下的退化尺寸，现在改成**允许它、但把后果讲清楚**。
 *
 * 2×2 在两种拓扑下是两回事：
 *
 * | 拓扑 | 2×2 的行为 |
 * |---|---|
 * | `bounded` | **完全正常**。一个 2×2 全活就是一个方块，是标准静物 |
 * | `torus` | **能跑，但不是直觉中的环面**：`rows = 2` 时 `r-1` 与 `r+1` 是同一行，`cols = 2` 同理，于是 8 个邻居位置映射到更少的格子上，**同一个格子被重复计数**。这是「标准环绕」的推论，结果是确定的，只是没有对应的几何直觉 |
 *
 * 所以界面上 **`torus` + 极小尺寸**这个组合应当给一句提示（见 `docs/ui-spec.md`），
 * 而不是默默算出一个别人看不懂的结果。**引擎层面不禁止** —— 它算得出来，也自洽。
 */
export const MIN_SIZE = 2;

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
  /**
   * **对局级**：某一方一格都落不下去了，因为棋盘已经是它要的样子 ——
   * 全死（死之执把活细胞**清空**了）/ 全活（生之执把棋盘**占满**了）。
   *
   * **清空或占满的那一方获胜** —— 那是双方各自的目的被推到极限的形态，
   * 对方自然一格都翻不动。注意别照字面读成「没棋走就输」。
   * 胜方**不来自占比阈值**，这与 repeatBlocked 不同（见 life.ts 的注释）。
   *
   * 判的是棋盘本身，与被问的一方无关：同一个全死棋盘无论谁问，都报这条原因。
   */
  | "noLegalCell"
  /**
   * **按回合判**：双方都有落点，但不存在任何一对 (生之执落点, 死之执落点)
   * 能演化出见过的局面之外的新局面 —— 走也白走。
   *
   * 判定单位是回合而不是某一方：回合的结构是「双方同时各走一步，再演化一代」，
   * 一方惰性不代表这一回合推不动（另一方可能推得动）。
   *
   * 胜方按当前占比定（`ratioWinner`）：占比冻住了，在胜负线之外的那一方会把
   * 这个占比无限保持下去；夹在两条线之间才是和局。
   */
  | "repeatBlocked";

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
