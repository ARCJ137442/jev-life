/**
 * 决策策略 —— 把 Jev 的概率分布转换成实际执行的一格。
 *
 * 设计原则：**只测量 Jev，不引入任何启发式算法。**
 *
 * 因此这里没有规则兜底、没有启发式接管。当 Jev 不确定时，正确的做法不是
 * 悄悄换成别的算法（那会污染测量），而是**把不确定性暴露给用户**：
 * 用户看着置信度追踪图，自己决定阈值该设多少。
 *
 * 为此提供 `threshold` 策略（用户可调，默认 0 = 不启用）：
 * 当最高概率低于该值时，本回合**暂停并标记**，交由用户处置。
 *
 * ═══ 相对 jev-2048 的 `client/decision.ts` 泛化了三处 ═══
 *
 *   1. `Direction` → `Cell`。2048 的落点是四个方向之一，生命棋是棋盘上的
 *      一格。`Cell` 是 `types.ts` 里的一维索引（`r * cols + c`）。
 *   2. **多了一个角色维度**。2048 的合法集是全局的（四个方向人人一样），
 *      生命棋的合法集**依赖角色** —— 生之执只能翻死格、死之执只能翻活格。
 *      所以这里传的是 `board` + `role`，合法集由 `legalCells` 现算，
 *      而不是像 2048 那样由调用方塞一个 `Direction[]` 进来。调用方自己算
 *      合法集的话，「两边用错了同一个集合」是查不出来的（两个集合互斥，
 *      用错了棋盘照样跑，只是两边都在替对方落子）。
 *   3. `reason`（已翻译的字符串）→ `reasonKey` + `reasonParams`。翻译是 UI 层
 *      的事，`core/` 不得碰 i18n（无头环境一 import 就崩）。**词条 key 沿用
 *      源仓库那一套**，这样 T14 的 i18n 表能直接对着抄。
 *
 * 另外两处**行为**上的修正（都是源仓库的实现细节，不是设计意图）：
 *
 *   - `sample` 的 `rand` 提成参数。源仓库用不可注入的 `Math.random`，
 *     导致这条策略**根本无法确定性测试** —— 而它恰恰是三条策略里唯一
 *     带随机性的那条，最需要被测。
 *   - 分布为空 / 无合法项时，源仓库会返回 `legal[0]`；`legal` 也是空的
 *     时候它会返回 `undefined` 冒充一个方向。这里改成**当场抛错**：
 *     无合法格 ⟺ 终局判定本该已经结束对局（见 `context.ts` 的 `buildNoulAll`），
 *     返回一个不存在的落点会把「不该发生的事」变成一个安静的错误答案。
 */
import { legalCells } from "./life.js";
import type { Board, Cell, Role } from "./types.js";

export type Strategy = "greedy" | "sample" | "threshold";

/**
 * 「每格一个概率」—— 通道解析之后的统一形态（`channels.ts` 的 `parseAnswers` 产出）。
 *
 * 决策层刻意**不认识 Jev 的答案形状**（`noul` 还是 `choice`、键名是
 * `flip_r_c` 还是 `"r,c"`）：那些是传输层的事。把协议形状收在 `channels.ts`
 * 一处，换一条通道就不用动这里 —— 这也是四层架构里「适配器内部消化差异」
 * 那条约束在决策层的投影。
 */
export type CellProbabilities = ReadonlyMap<Cell, number>;

export interface Resolution {
  readonly cell: Cell;
  /**
   * `reasonParams` 对应的词条 key。
   *
   * 界面切换语言时，决策面板要按新语言重画 —— 面板是「一次性画好」的，
   * 只有拿得到 key 才能重新翻译，否则会留下上一门语言的残留。
   */
  readonly reasonKey: string;
  readonly reasonParams?: Record<string, string | number>;
  /** Jev 首选非法、退而取其分布内的次优合法格 */
  readonly coerced: boolean;
  /** 最高概率低于用户设定的阈值（仅在 threshold 策略下可能为真） */
  readonly belowThreshold: boolean;
}

/**
 * 按概率降序的 `[格, 概率]` 列表。
 *
 * 同概率时按**格子升序**，而不是听凭插入顺序。源仓库吃的是
 * `Object.entries` 的顺序，也就是上游 JSON 里键的书写顺序 ——
 * 同一个分布换一种写法就会选出不同的一格，而测量要求「同一个分布 ⟹ 同一个落子」。
 */
export function rankProbabilities(probabilities: CellProbabilities): Array<[Cell, number]> {
  return [...probabilities.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
}

/** 概率最高的合法格。一个合法项都没有时返回 null（**不**退回 legal[0]） */
export function bestLegalCell(
  probabilities: CellProbabilities,
  legal: readonly Cell[],
): { cell: Cell; prob: number } | null {
  const set = new Set(legal);
  for (const [cell, prob] of rankProbabilities(probabilities)) {
    if (set.has(cell)) return { cell, prob };
  }
  return null;
}

function rowCol(board: Board, cell: Cell): [number, number] {
  return [Math.floor(cell / board.cols), cell % board.cols];
}

/** 概率 → 修约成整数的百分比字符串。`0.3` 直接塞进 `{p}%` 会显示成「0.3%」 */
function percent(p: number): string {
  return (p * 100).toFixed(0);
}

/**
 * @param probabilities Jev 给出的「每格一个概率」
 * @param board         当前棋盘 —— 合法集由它和角色现算（见文件头第 2 条）
 * @param role          这一手是谁下的
 * @param strategy      贪心 / 概率采样 / 置信度门槛
 * @param threshold     置信度门槛（仅 threshold 策略使用，0 = 不启用）
 * @param rand          采样用的随机源。**可注入**（见文件头），默认 `Math.random`
 */
export function resolveDecision(
  probabilities: CellProbabilities,
  board: Board,
  role: Role,
  strategy: Strategy,
  threshold: number,
  rand: () => number = Math.random,
): Resolution {
  const legal = legalCells(board, role);
  if (legal.length === 0) {
    throw new Error(
      `${
        role === "life" ? "生之执" : "死之执"
      }没有可翻的格子（棋盘 ${board.cols}×${board.rows}）—— ` +
        "这种情况应当由终局判定先结束对局，而不是来问决策层该走哪一格",
    );
  }

  const ranked = rankProbabilities(probabilities);

  if (ranked.length === 0) {
    return { cell: legal[0], reasonKey: "reason.noProb", coerced: true, belowThreshold: false };
  }

  const legalSet = new Set(legal);
  const [topCell, topProb] = ranked[0];
  // 只在 threshold 策略下才有意义：另外两条策略里用户没设门槛，
  // 标了会让 UI 显示一个「用户根本没要求过的」判断
  const belowThreshold = strategy === "threshold" && threshold > 0 && topProb < threshold;

  // 概率采样：只在合法格里按归一化概率轮盘赌。
  // 归一化的分母是**合法池的和**而不是全分布的和 —— 否则非法格的概率会
  // 变成一个永远轮不到的空白区间，等价于把那些概率丢掉。
  if (strategy === "sample") {
    const pool = ranked.filter(([cell]) => legalSet.has(cell));
    if (pool.length > 0) {
      const total = pool.reduce((s, [, p]) => s + p, 0) || 1;
      let r = rand() * total;
      for (const [cell, p] of pool) {
        r -= p;
        if (r <= 0) {
          return {
            cell,
            reasonKey: "reason.sampled",
            coerced: cell !== topCell,
            belowThreshold,
          };
        }
      }
      // 浮点残差（rand() 恰好给到池子上界时 r 会剩一点点）。取池尾并**如实**算 coerced
      // —— 源仓库在这里写死了 `coerced: false`，那是个只在边界上错的谎
      const last = pool[pool.length - 1][0];
      return {
        cell: last,
        reasonKey: "reason.sampled",
        coerced: last !== topCell,
        belowThreshold,
      };
    }
  }

  // 贪心 / 门槛：取概率最高的合法格
  if (legalSet.has(topCell)) {
    if (belowThreshold) {
      return {
        cell: topCell,
        reasonKey: "reason.belowThreshold",
        reasonParams: { p: percent(topProb), t: percent(threshold) },
        coerced: false,
        belowThreshold,
      };
    }
    return { cell: topCell, reasonKey: "reason.takeTop", coerced: false, belowThreshold };
  }

  // Jev 首选非法 —— 从它自己的分布里退而求其次，不引入外部规则
  const alt = bestLegalCell(probabilities, legal);
  if (alt) {
    const [row, col] = rowCol(board, topCell);
    return {
      cell: alt.cell,
      reasonKey: "reason.coerced",
      // 参数指的是**那个非法的首选**，不是被选中的那一格 —— 界面上要说明的是
      // 「模型想走 (r,c)，但那一格它翻不动」，而不是重复一遍落点
      reasonParams: { row, col },
      coerced: true,
      belowThreshold,
    };
  }

  return { cell: legal[0], reasonKey: "reason.noLegal", coerced: true, belowThreshold };
}
