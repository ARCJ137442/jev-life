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
