/**
 * 记分板那两帧读数。
 *
 * 这一层锁的是**时机**：一回合有落子与演化两段，方块在这两段各自开始的那一刻
 * 才变，读数必须跟着那两刻走。时机本身（哪一帧、隔多少毫秒）要 DOM 与 rAF，
 * 在无头环境里断言不了 —— 由 `render.test.ts` 的 `onPhase` 用例守着；
 * 这里守的是「哪一刻该显示哪个数」。
 *
 * 做错了**不会报错**：五个格子照样有数、照样会变，只是数字比画面早一步。
 * 用户看到的是一句「它算错了」，而算术一个字都没错。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { turnScoreViews, scoreNow } from "../client/score.js";
import { aliveCount, boardFromRows, flip, lifeStep } from "../core/life.js";
import type { Board } from "../core/types.js";

/* ══════════════════════════════════════════════════════════════════
   夹具
   ══════════════════════════════════════════════════════════════════ */

/**
 * 4×4：一个方块 + 右下角一只孤立的细胞。
 *
 * 夹具是挑过的 —— 随便一副棋盘很可能「翻一格 +1、演化又原样留住」，那样两帧
 * 的读数相同，**「报早了」这件事就测不出来**（这条测试的第一版正是栽在
 * 自带的那个 `assert.notEqual` 守卫上）。这一副的演化会再 +1：5 → 6 → 7。
 */
const ROWS = [
  "....",
  ".##.",
  ".##.",
  "..#.",
];

const BOARD = (): Board => boardFromRows(ROWS);
const cell = (r: number, c: number): number => r * 4 + c;

interface Fixture {
  readonly mid: Board;
  readonly after: Board;
  readonly before: number;
  readonly midAlive: number;
  readonly afterAlive: number;
}

/** 造一个「落子改变了活细胞数、演化又改了一次」的局面（否则两帧读数会相同，测不出东西） */
function fixture(): Fixture {
  const board = BOARD();
  const mid = flip(board, cell(1, 0)); // 生之执落子：(1,0) 由死转活 → +1
  const after = lifeStep(mid, "bounded");
  return {
    mid,
    after,
    before: aliveCount(board),
    midAlive: aliveCount(mid),
    afterAlive: aliveCount(after),
  };
}

/* ══════════════════════════════════════════════════════════════════
   ① 两帧各报哪一副棋盘
   ══════════════════════════════════════════════════════════════════ */

test("★ 落子那一帧报的是**落子后、演化前**的棋盘 —— 不是这一回合的结局", () => {
  const f = fixture();
  assert.notEqual(f.midAlive, f.afterAlive, "夹具不合格：两帧的活细胞数一样，测不出「报早了」");

  const v = turnScoreViews({ mid: f.mid, after: f.after, turn: 7, maxBefore: 0, minBefore: 99 });

  assert.equal(v.flip.alive, f.midAlive, "落子相报的是演化后的数 —— 数字跑到画面之前了");
  assert.equal(v.flip.ratio, f.midAlive / 16, "占比没跟着那一帧的活细胞数走");
  assert.equal(v.evolve.alive, f.afterAlive);
  assert.equal(v.evolve.ratio, f.afterAlive / 16);
});

test("★ 演化那一帧报的是演化后的棋盘，且**两帧以 `mid` 与 `after` 分区**", () => {
  const f = fixture();
  const other = { ...f, mid: f.after, after: f.mid }; // 交换两副棋盘
  const v = turnScoreViews({ mid: other.mid, after: other.after, turn: 7, maxBefore: 0, minBefore: 99 });

  assert.equal(v.flip.alive, f.afterAlive);
  assert.equal(v.evolve.alive, f.midAlive);
});

test("TURN 在两帧里是同一个数（当前回合，不是「已完成回合数」）", () => {
  // 落子相里屏幕上那一副就是第 N 回合的棋盘，决策面板与日志也把这一手记在
  // 第 N 回合下。让它等到演化才跳，会得到「决策面板 #N、记分板 TURN N−1」这种同屏矛盾
  const f = fixture();
  const v = turnScoreViews({ mid: f.mid, after: f.after, turn: 13, maxBefore: 0, minBefore: 99 });
  assert.equal(v.flip.turn, 13);
  assert.equal(v.evolve.turn, 13);
});

/* ══════════════════════════════════════════════════════════════════
   ② 极值：算进去，但晚一帧显示
   ══════════════════════════════════════════════════════════════════ */

test("★ 落子相里 ALIVE 不会大过 A.MAX —— 落子这一帧也算进极值", () => {
  // 不算的话会出现「ALIVE 3 / A.MAX 2」这种一眼看去就是坏了的组合
  const f = fixture();
  const v = turnScoreViews({ mid: f.mid, after: f.after, turn: 7, maxBefore: 1, minBefore: 1 });

  assert.equal(v.flip.max, Math.max(1, f.midAlive), "落子相里 ALIVE 超过了 A.MAX");
  assert.ok(v.flip.alive <= v.flip.max, `ALIVE(${v.flip.alive}) > A.MAX(${v.flip.max})`);
  assert.ok(v.flip.alive >= v.flip.min, `ALIVE(${v.flip.alive}) < A.MIN(${v.flip.min})`);
});

test("★ 落子相**不报**演化后的极值 —— 那是还没发生的事", () => {
  const f = fixture();
  // 造一个「演化后才出现的峰值」：maxBefore 与 mid 都比 after 小
  const peak = Math.max(f.midAlive, f.afterAlive);
  const v = turnScoreViews({ mid: f.mid, after: f.after, turn: 7, maxBefore: 1, minBefore: 9 });

  assert.equal(v.flip.max, Math.max(1, f.midAlive), "落子相把演化后的峰值提前报了出来");
  assert.equal(v.evolve.max, Math.max(1, peak));
  // 谷值同理
  assert.equal(v.flip.min, Math.min(9, f.midAlive));
  assert.equal(v.evolve.min, Math.min(9, f.midAlive, f.afterAlive));
});

test("★ 存下来的极值要含演化后的那一刻（终局统计没有第二次机会）", () => {
  // `evolve.max/min` 就是回写 `state.aliveMax/aliveMin` 的值。开局时整局的
  // 极值就是 `before`（上一回合结束时的活细胞数），这一回合再叠上 mid 与 after
  // —— 漏掉演化后那一下，终局面板报的峰值会偏低，而那一局的数字已经定了
  const f = fixture();
  const v = turnScoreViews({
    mid: f.mid,
    after: f.after,
    turn: 7,
    maxBefore: f.before,
    minBefore: f.before,
  });

  assert.equal(v.evolve.max, Math.max(f.before, f.midAlive, f.afterAlive));
  assert.equal(v.evolve.min, Math.min(f.before, f.midAlive, f.afterAlive));
});

test("极值只增不减：上一回合的极值不会因为这一回合的数更小 / 更大而被盖掉", () => {
  const f = fixture();
  // 40 高于这一回合的任何一帧、0 低于任何一帧 —— 两个极值都该原样留着
  const v = turnScoreViews({ mid: f.mid, after: f.after, turn: 7, maxBefore: 40, minBefore: 0 });

  assert.equal(v.evolve.max, 40, "上一回合的峰值被这一回合更小的数盖掉了");
  assert.equal(v.evolve.min, 0, "上一回合的谷值被这一回合更大的数盖掉了");
  // 落子那一帧同理：极值是**整局**的，不是这一回合的
  assert.equal(v.flip.max, 40);
  assert.equal(v.flip.min, 0);
});

/* ══════════════════════════════════════════════════════════════════
   ③ 瞬时路径与纯度
   ══════════════════════════════════════════════════════════════════ */

test("scoreNow：棋盘瞬时变化（手绘 / 开新局 / 恢复存档）只有一帧，直接读当前棋盘", () => {
  const board = flip(BOARD(), cell(0, 0));
  const v = scoreNow(board, 3, 5, 1);
  assert.deepEqual(v, { alive: aliveCount(board), ratio: aliveCount(board) / 16, turn: 3, max: 5, min: 1 });
});

test("不改动传入的棋盘（引擎纯度那条红线同样适用于只读的算数）", () => {
  const f = fixture();
  const midBefore = Array.from(f.mid.cells);
  const afterBefore = Array.from(f.after.cells);

  turnScoreViews({ mid: f.mid, after: f.after, turn: 7, maxBefore: 0, minBefore: 99 });

  assert.deepEqual(Array.from(f.mid.cells), midBefore, "mid 被改动了");
  assert.deepEqual(Array.from(f.after.cells), afterBefore, "after 被改动了");
});

test("占比的分母是**那一副棋盘**的格数（非方、非 8×8 也算对）", () => {
  const board = boardFromRows(["#...", "....", "...."]); // 3 行 4 列
  const v = scoreNow(board, 0, 1, 1);
  assert.equal(v.ratio, 1 / 12);
});
