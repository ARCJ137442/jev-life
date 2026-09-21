/**
 * `core/channels.ts` 的测试。
 *
 * 这个文件锁的是一件**做错了也照样跑得动**的事：**解析失败必须炸，不能静默**。
 *
 * 为什么它是这个模块的头号风险：`noulProbability()` 在两家键名都缺失时
 * **返回 0**（`a.noul ?? a.probability ?? 0`）。一个「模型没答这一题」的回包
 * 因此会变成「模型认为这一格很不利」—— 一份完全合法、完全可用的概率分布，
 * 而且会一路走到决策层被当成真数据用。整局实验的结论就此被污染，
 * 而画面上看不出任何异常。
 *
 * 同源的还有三处：
 *   - 缺一个键 → 分布少一格，剩余概率被轮盘赌放大（等于悄悄改了模型的话）
 *   - 多出一个键 → 我们对回包的理解与题面不一致，说明哪里错了
 *   - 答案指向一个对该角色非法的格 → 棋盘与答案不是同一副
 *
 * 夹具一律 ≥ `MIN_SIZE`(4)。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseAnswers } from "../core/channels.js";
import type { Channel } from "../core/channels.js";
import { boardFromRows, legalCells } from "../core/life.js";
import type { Board, Cell } from "../core/types.js";
import type { Answer, BooleanAnswer } from "../shared/types.js";

/* ══════════════════════════════════════════════════════════════════
   夹具
   ══════════════════════════════════════════════════════════════════ */

/** 4×4，三个活细胞：0=(0,0) 5=(1,1) 10=(2,2) */
const ROWS4 = ["#...", ".#..", "..#.", "...."];
const BOARD = (): Board => boardFromRows(ROWS4);

/** 生之执的合法集（死格） */
const DEAD: readonly Cell[] = [1, 2, 3, 4, 6, 7, 8, 9, 11, 12, 13, 14, 15];

const NOUL: Channel = { kind: "noul-all" };

/** 把「每格一个概率」写成 noul-all 的回包形状 */
function noulAnswers(
  board: Board,
  role: "life" | "death",
  p: (cell: Cell) => number,
): Record<string, Answer> {
  const out: Record<string, Answer> = {};
  for (const cell of legalCells(board, role)) {
    const r = Math.floor(cell / board.cols);
    const c = cell % board.cols;
    out[`flip_${r}_${c}`] = { type: "noul", noul: p(cell) } satisfies BooleanAnswer;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   一、正常路径
   ══════════════════════════════════════════════════════════════════ */

test("noul-all：flip_r_c 的键名解回一维格号，概率原样取出", () => {
  const board = BOARD();
  const answers = noulAnswers(board, "life", (cell) => cell / 100);

  const probs = parseAnswers(NOUL, answers, board, "life");

  assert.equal(probs.size, DEAD.length);
  for (const cell of DEAD) {
    assert.equal(probs.get(cell), cell / 100, `格 ${cell} 的概率不对`);
  }
  // (1,1) 是活格，生之执的问题集里没有它
  assert.equal(probs.get(5), undefined);
});

test("两家键名都要认：Vercel 用 probability，其余用 noul", () => {
  const board = BOARD();
  // 题面必须**完整**（缺键会抛错），所以在全量回包上覆盖这三个键
  const full = noulAnswers(board, "life", () => 0.5);
  Object.assign(full, {
    flip_0_1: { type: "boolean", probability: 0.69 },
    flip_0_2: { type: "noul", noul: 0.96 },
    flip_0_3: { type: "noul", noul: 0 },
  } satisfies Record<string, Answer>);

  const probs = parseAnswers(NOUL, full, board, "life");
  assert.equal(probs.get(1), 0.69);
  assert.equal(probs.get(2), 0.96);
  assert.equal(probs.get(3), 0);
});

test("返回的 Map 按格号升序 —— 同一个回包换一种键序也得到同一个结果", () => {
  const board = BOARD();
  const forward = noulAnswers(board, "life", (cell) => cell / 100);
  const backward: Record<string, Answer> = {};
  for (const k of Object.keys(forward).reverse()) backward[k] = forward[k];

  const a = [...parseAnswers(NOUL, forward, board, "life").entries()];
  const b = [...parseAnswers(NOUL, backward, board, "life").entries()];

  assert.deepEqual(a, b);
  assert.deepEqual(a.map(([cell]) => cell), [...DEAD].sort((x, y) => x - y));
});

test("死之执的题面是活格，同一份棋盘两边解析结果互斥", () => {
  const board = BOARD();
  const life = parseAnswers(NOUL, noulAnswers(board, "life", () => 1), board, "life");
  const death = parseAnswers(NOUL, noulAnswers(board, "death", () => 1), board, "death");

  assert.deepEqual([...death.keys()], [0, 5, 10]);
  for (const cell of death.keys()) assert.equal(life.get(cell), undefined);
});

/* ══════════════════════════════════════════════════════════════════
   二、★ 解析失败必须炸，不能静默
   ══════════════════════════════════════════════════════════════════ */

test("★ 答案里缺了一个键 → 抛错，并点名缺的是哪一个", () => {
  const board = BOARD();
  const answers = noulAnswers(board, "life", () => 0.5);
  delete answers["flip_3_0"]; // 格 12

  assert.throws(
    () => parseAnswers(NOUL, answers, board, "life"),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /flip_3_0/, "错误里必须点名缺的是哪一题");
      return true;
    },
  );
});

test("★ 答案里只有一个 type、没有概率字段 → 抛错（绝不当成 0）", () => {
  const board = BOARD();
  const answers = noulAnswers(board, "life", () => 0.5);
  // noulProbability 在这里会还回 0 —— 于是一个「没答」变成「很不利」
  answers["flip_0_1"] = { type: "noul" } as Answer;

  assert.throws(
    () => parseAnswers(NOUL, answers, board, "life"),
    /flip_0_1/,
  );
});

test("概率不是数字 / 超出 [0,1] / 是 NaN → 一律抛错", () => {
  const board = BOARD();
  for (const bad of ["0.5", null, -0.01, 1.01, NaN, Infinity]) {
    const answers = noulAnswers(board, "life", () => 0.5);
    answers["flip_0_1"] = { type: "noul", noul: bad } as unknown as Answer;
    assert.throws(
      () => parseAnswers(NOUL, answers, board, "life"),
      /flip_0_1/,
      `概率是 ${String(bad)} 时应当抛错`,
    );
  }
});

test("答案里多出一个题面上没有的键 → 抛错（我们对回包的理解与题面不一致）", () => {
  const board = BOARD();
  const answers = noulAnswers(board, "life", () => 0.5);
  answers["flip_1_1"] = { type: "noul", noul: 0.5 }; // (1,1) 是活格，题面里没有

  assert.throws(
    () => parseAnswers(NOUL, answers, board, "life"),
    /flip_1_1/,
  );
});

test("空 answers → 抛错，绝不返回空映射", () => {
  const board = BOARD();
  assert.throws(() => parseAnswers(NOUL, {}, board, "life"), /没有/);
});

test("键名格式不对 → 抛错并点出这个键", () => {
  const board = BOARD();
  const answers = noulAnswers(board, "life", () => 0.5);
  delete answers["flip_0_1"];
  answers["0,1"] = { type: "noul", noul: 0.5 };

  assert.throws(() => parseAnswers(NOUL, answers, board, "life"), /0,1/);
});

test("行列越界（flip_9_9）→ 抛错，不会算出一个越界的格号", () => {
  const board = BOARD();
  const answers = noulAnswers(board, "life", () => 0.5);
  delete answers["flip_0_1"];
  answers["flip_9_9"] = { type: "noul", noul: 0.5 };

  assert.throws(() => parseAnswers(NOUL, answers, board, "life"), /flip_9_9/);
});

test("答案指向一个对该角色非法的格 → 抛错（棋盘与答案不是同一副）", () => {
  const board = BOARD();
  // 题面按生之执造，却拿死之执的身份去解析：9 个键都会对不上
  const answers = noulAnswers(board, "life", () => 0.5);
  assert.throws(() => parseAnswers(NOUL, answers, board, "death"), /flip/);
});

/* ══════════════════════════════════════════════════════════════════
   三、M1 只实现 noul-all
   ══════════════════════════════════════════════════════════════════ */

test("choice-all / choice-filtered 抛「未实现」—— 类型留好，M1 不做", () => {
  const board = BOARD();
  const answers = noulAnswers(board, "life", () => 0.5);

  for (const ch of [
    { kind: "choice-all" },
    { kind: "choice-filtered", filter: "x" },
  ] as Channel[]) {
    assert.throws(
      () => parseAnswers(ch, answers, board, "life"),
      /未实现/,
      `通道 ${ch.kind} 应当明确抛「未实现」，而不是安静地返回空映射`,
    );
  }
});

/* ══════════════════════════════════════════════════════════════════
   四、纯函数
   ══════════════════════════════════════════════════════════════════ */

test("不改动入参：同一批对象传进去，棋盘与答案都必须原样", () => {
  const board = BOARD();
  const cellsBefore = Uint8Array.from(board.cells);
  const cellsIdentity = board.cells;
  const answers = noulAnswers(board, "life", () => 0.5);
  const keysBefore = Object.keys(answers).sort();

  parseAnswers(NOUL, answers, board, "life");

  assert.deepEqual([...board.cells], [...cellsBefore]);
  assert.equal(board.cells, cellsIdentity, "底层数组被换掉了");
  assert.deepEqual(Object.keys(answers).sort(), keysBefore);
});
