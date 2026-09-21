/**
 * 记分板的取值 —— 一个回合的**两个时刻**。
 *
 * ═══ 为什么要单独一个模块 ═══
 *
 * 一回合有**两段动画**（落子 → 演化），方块是在这两段各自开始的那一刻才真正
 * 变的。记分板必须跟着这两段走。原来的写法是在**回包一到**就把五个格子刷成
 * 「演化之后」的值 —— 于是画面还在落子相，记分板已经把这一回合的结局报出来了。
 * 数字比画面早一步，读起来就是「它算错了」，而根因在**时机**不在算术。
 *
 * 时机本身在无头环境里断言不了（要 DOM、要 rAF），但「哪个时刻该显示哪个数」
 * 可以 —— 那是这里唯一的判断，所以把它做成纯函数。
 *
 * ═══ 三处口径，都是刻意的 ═══
 *
 * 1. **`TURN` 在两个时刻是同一个数**。它是「当前回合」，而落子相里屏幕上那一副
 *    就是第 N 回合的棋盘（这一手的落子已经生效），决策面板与日志也把这一手记在
 *    第 N 回合下。让它跟着演化才跳，会得到「决策面板 `#N`、记分板 `TURN N−1`」
 *    这种同屏矛盾。
 * 2. **`A.MAX` / `A.MIN` 把落子相那一帧也算进去**。它就是屏幕上的那一副棋盘；
 *    不算的话会出现「`ALIVE` 比 `A.MAX` 还大」—— 一眼看去就是坏的。
 *    手绘开局那条路径本来就是每点一下都算一次，两边因此同一条口径。
 * 3. **但落子相里不显示演化后的极值**。那是还没发生的事 —— 上面的「算进去」
 *    说的是**这一局存下来的极值**要含它（不然终局统计会漏掉最后一刻的峰值），
 *    而屏幕上要等演化落地才报。
 *
 * 于是 `state.aliveMax / aliveMin` 一次算到演化后（存下来的值不会漏），
 * 显示则分两帧给 —— 两者不矛盾：**存的是整局的极值，显示的是此刻的屏幕**。
 */

import { aliveCount } from "../core/life.js";
import type { Board } from "../core/types.js";

/** 记分板上那五列的取值。`ALIVE` | `RATIO` | `TURN` | `A.MAX` | `A.MIN` */
export interface ScoreView {
  readonly alive: number;
  /** 活细胞占比 0~1。**不修约** —— 与 `alive_ratio` 同一条口径 */
  readonly ratio: number;
  readonly turn: number;
  readonly max: number;
  readonly min: number;
}

export interface TurnBoards {
  /** 落子之后、演化之前的那一副 */
  readonly mid: Board;
  /** 演化之后的那一副 */
  readonly after: Board;
  /** 这一手所属的回合（= 演化之后的已完成回合数，即 `state.turn`） */
  readonly turn: number;
  /** 这一回合开始之前，整局的活细胞数极值 */
  readonly maxBefore: number;
  readonly minBefore: number;
}

function view(board: Board, alive: number, turn: number, max: number, min: number): ScoreView {
  return { alive, ratio: alive / (board.cols * board.rows), turn, max, min };
}

/** 某一副棋盘此刻的读数 —— 棋盘瞬时变化（手绘、开新局、恢复存档）那条路径用 */
export function scoreNow(board: Board, turn: number, max: number, min: number): ScoreView {
  return view(board, aliveCount(board), turn, max, min);
}

/**
 * 一回合的两帧读数：`flip` = 落子落地那一刻，`evolve` = 演化落地那一刻。
 *
 * `evolve` 的 `max` / `min` 就是要存进 `state.aliveMax` / `aliveMin` 的值 ——
 * 调用方拿它回写，别自己再算一遍（两份算术迟早会不一致）。
 */
export function turnScoreViews(t: TurnBoards): { flip: ScoreView; evolve: ScoreView } {
  const midAlive = aliveCount(t.mid);
  const afterAlive = aliveCount(t.after);
  // 落子那一格也是屏幕上真实出现过的活细胞数，整局的极值要含它
  const max = Math.max(t.maxBefore, midAlive, afterAlive);
  const min = Math.min(t.minBefore, midAlive, afterAlive);

  return {
    // 落子相：极值只到「上一回合结束 + 这一手本身」为止 —— 演化后的值还没发生
    flip: view(
      t.mid,
      midAlive,
      t.turn,
      Math.max(t.maxBefore, midAlive),
      Math.min(t.minBefore, midAlive),
    ),
    evolve: view(t.after, afterAlive, t.turn, max, min),
  };
}
