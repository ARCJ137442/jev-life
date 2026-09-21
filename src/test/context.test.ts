/**
 * `core/context.ts` 的测试。
 *
 * 这个文件锁的不是「代码跑得起来」，而是三件**做错了也照样跑得动**的事：
 *
 *   1. **死之执的目标必须显式反向**。模型的默认直觉是「让细胞活下来」，
 *      方向词写漏了不会报错，只会让整局实验在测另一个游戏 —— 而结果看起来
 *      完全正常（有概率、有胜负有统计）。
 *   2. **规则项必须真的进 state**。少写一条终局规则，state 依然是一份合法
 *      JSON，Jev 也照样给出决策，只是它在玩另一个游戏（2048 那条
 *      「对 Jev 说谎」教训的加强版：生命棋的规则不自明）。
 *   3. **开关关掉时字段要整个不出现**，不是空数组 —— 空数组仍然在告诉模型
 *      「这里什么都没有」，那是另一种提示，不是「把脚手架拆干净」。
 *
 * 夹具一律 ≥ `MIN_SIZE`(4)：计划里曾用 2×2 的棋盘写测试，连造都造不出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_ROLE_CONTEXT, buildQuestions, buildState } from "../core/context.js";
import type { Questions, RoleContext, StateInput, TurnRecord } from "../core/context.js";
import { aliveCount, boardFromRows, flip, legalCells, lifeStep } from "../core/life.js";
import type { Board, Cell, GameRules } from "../core/types.js";

/* ══════════════════════════════════════════════════════════════════
   夹具
   ══════════════════════════════════════════════════════════════════ */

const RULES: GameRules = {
  turnLimit: 90,
  lifeWinRatio: 0.6,
  deathWinRatio: 0.05,
  lifeStreak: 3,
  deathStreak: 3,
};

/** 8×8：一个方块 + 一只滑翔机。尺寸 ≥ MIN_SIZE，且方块是检测器认得的结构 */
const ROWS = [
  "........",
  ".##.....",
  ".##.....",
  "........",
  "........",
  "......#.",
  ".......#",
  ".....###",
];

/** `state.aids.board` 的期望形态，从 ROWS 现算 —— 不另抄一份 0/1 网格 */
const GRID: number[][] = ROWS.map((row) => [...row].map((ch) => (ch === "#" ? 1 : 0)));

const BOARD = (): Board => boardFromRows(ROWS);

function rc(board: Board, cell: Cell): [number, number] {
  return [Math.floor(cell / board.cols), cell % board.cols];
}

/** `Object.hasOwn` 而不是 `in`：`in` 会把原型链上的东西也算进来 */
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);

function turnRecord(turn: number, alive: number, netGrowth: number): TurnRecord {
  const board = BOARD();
  return {
    turn,
    board,
    lifeFlip: legalCells(board, "life")[0],
    deathFlip: legalCells(board, "death")[0],
    aliveCount: alive,
    netGrowth,
  };
}

function input(over: Partial<StateInput> = {}): StateInput {
  return {
    board: BOARD(),
    role: "life",
    topology: "bounded",
    rules: RULES,
    turn: 12,
    scores: { life: 3, death: 3 },
    history: [],
    context: { ...DEFAULT_ROLE_CONTEXT },
    ...over,
  };
}

function ctx(over: Partial<RoleContext> = {}): RoleContext {
  return { ...DEFAULT_ROLE_CONTEXT, ...over };
}

/** noul 问题的形状。`Question.criteria` 是联合类型，测试里收窄一次免得通篇缩写 */
interface NoulQ {
  readonly type: string;
  readonly instructions: string;
  readonly criteria: { true: string; false: string };
}

function firstQuestion(qs: Questions): NoulQ {
  const key = Object.keys(qs)[0];
  assert.ok(key, "一道题都没有");
  return qs[key] as NoulQ;
}

/* ══════════════════════════════════════════════════════════════════
   ① 分区：rules 可移植，aids 是喂给这个 AI 玩家的脚手架
   ══════════════════════════════════════════════════════════════════ */

test("state 分三块：rules 是可移植的规则，aids 是喂给 AI 玩家的脚手架", () => {
  const s = buildState(input());

  assert.ok(has(s, "rules") && has(s, "aids"), "state 必须分成 rules / aids 两块");
  assert.ok(has(s, "turn") && has(s, "alive_count") && has(s, "alive_ratio") && has(s, "scores"));

  // 人自己会看棋盘，不需要别人告诉他「0=死格 1=活格」；这些都不是规则的一部分。
  // 混进 rules 就等于把「这个实验台的脚手架」写进了可移植的规则说明书。
  for (const k of ["board", "board_legend", "valid_cells", "detected_patterns", "recent_history", "strategy_hint"]) {
    assert.equal(has(s.rules, k), false, `「${k}」混进了 rules —— 那是脚手架，不是规则`);
  }
  // 反过来：规则项也不该被当成辅助信息
  for (const k of ["role_statement", "objective", "horizon", "win_condition", "termination_conditions", "topology_note"]) {
    assert.equal(has(s.aids, k), false, `「${k}」混进了 aids`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   ② 角色目标必须显式反向
   ══════════════════════════════════════════════════════════════════ */

test("死之执的角色陈述必须显式反向 —— 模型的默认直觉是让细胞活下来", () => {
  const text = buildState(input({ role: "death" })).rules.role_statement;

  assert.match(text, /少/, "没有出现「少」这类方向词 —— 不写死，模型会按「增加细胞」的直觉答");
  assert.match(text, /不利/, "没有说「让细胞活着对你不利」—— 缺了这句显式反向");
  assert.doesNotMatch(text, /尽可能多/, "死之执的陈述里出现了「尽可能多」，方向写反了");
  assert.doesNotMatch(text, /对你有利/, "死之执的陈述里出现了「对你有利」");
});

test("生之执的角色陈述与死之执相反，且两条陈述确实不同", () => {
  const life = buildState(input({ role: "life" })).rules.role_statement;
  const death = buildState(input({ role: "death" })).rules.role_statement;

  assert.match(life, /多/);
  assert.match(life, /有利/);
  assert.doesNotMatch(life, /尽可能少/);
  assert.notEqual(life, death, "两个角色拿到了同一段陈述 —— 至少有一个是错的");
});

/* ══════════════════════════════════════════════════════════════════
   ③ 必须进 state 的规则项（设计文档 7.2 的示例 state 全都没有）
   ══════════════════════════════════════════════════════════════════ */

test("win_condition 必须写清「连续越界」与防抖 —— 只说阈值就是错的", () => {
  const w = buildState(input()).rules.win_condition;

  assert.match(w, /连续/, "没写「连续」—— 防抖被丢了，模型会以为越界一代就赢");
  assert.match(w, /防抖/);
  assert.ok(w.includes(String(RULES.lifeStreak)), "没有带上 lifeStreak 的数值");
  assert.ok(w.includes(String(RULES.deathStreak)), "没有带上 deathStreak 的数值");
  assert.ok(w.includes("60%") && w.includes("5%"), `占比阈值没写全：${w}`);
});

test("horizon 必须带上回合上限与当前回合", () => {
  const h = buildState(input({ turn: 12 })).rules.horizon;

  assert.match(h, /共 90 回合/, "回合上限没写进 horizon");
  assert.match(h, /第 13 回合/, "没写当前是第几回合 —— 模型不知道还剩下多久");
  assert.match(h, /还剩 78 回合/);
});

test("termination_conditions 覆盖回合上限、和局与走投无路", () => {
  const t = buildState(input()).rules.termination_conditions;

  assert.ok(t.includes(String(RULES.turnLimit)), "回合上限没写进终局条件");
  assert.match(t, /和局/, "没写和局 —— 模型不知道平局也终局");
  assert.match(t, /全死|清空/, "没写「把棋盘清空」这条终局");
  assert.match(t, /全活|占满/, "没写「把棋盘占满」这条终局");
  assert.match(t, /重复/, "没写「局面重复、推不动」这条终局");
});

test("topology_note 必须讲清边界怎么算 —— 界外算死与环绕是两种规则", () => {
  const bounded = buildState(input({ topology: "bounded" })).rules.topology_note;
  const torus = buildState(input({ topology: "torus" })).rules.topology_note;

  assert.notEqual(bounded, torus, "两种拓扑给了同一段说明 —— 至少有一个是错的");
  assert.match(bounded, /界外|棋盘之外|边界之外/);
  assert.match(bounded, /死/);
  assert.doesNotMatch(bounded, /相连/, "bounded 的说明里出现了环绕的措辞");
  assert.match(torus, /相连/);
  assert.match(torus, /8 个邻居/, "环绕下每个格子都有完整的 8 个邻居 —— 这句话必须说");
});

test("规则说明是可选补充：填了才出现在 rules 里", () => {
  const note = "本局额外约定：不允许连续两回合翻同一格。";
  const withNote = buildState(input({ context: ctx({ ruleNote: note }) }));

  assert.equal(withNote.rules.rule_note, note);
  assert.equal(has(buildState(input()).rules, "rule_note"), false, "没填规则说明时不该凭空多一个空字段");
});

/* ══════════════════════════════════════════════════════════════════
   ④ 开关：关掉 = 字段整个不出现
   ══════════════════════════════════════════════════════════════════ */

test("自动结构识别默认开；关掉时字段整个不出现（不是空数组）", () => {
  const on = buildState(input());
  assert.equal(has(on.aids, "detected_patterns"), true, "默认应当开着自动结构识别");
  const names = (on.aids.detected_patterns ?? []).map((p) => p.name);
  assert.ok(names.includes("block"), `棋盘上有一个方块，检测结果却是 ${JSON.stringify(names)}`);

  const off = buildState(input({ context: ctx({ detectPatterns: false }) }));
  assert.equal(
    has(off.aids, "detected_patterns"),
    false,
    "关掉之后字段仍然在 —— 空数组仍然是在告诉模型「这里什么也没有」",
  );
});

test("记忆轮数为 0 时不喂历史；>0 时只喂最近 N 回合，按时间从早到晚", () => {
  const history = [turnRecord(1, 10, 0), turnRecord(2, 11, 1), turnRecord(3, 9, -2)];

  assert.equal(has(buildState(input({ history })).aids, "recent_history"), false, "记忆轮数为 0 时不该喂历史");

  const two = buildState(input({ history, context: ctx({ memory: 2 }) }));
  const kept = two.aids.recent_history ?? [];
  assert.equal(kept.length, 2);
  assert.deepEqual(
    kept.map((t) => t.turn),
    [2, 3],
    "喂了最旧的两回合 —— 记忆预算该截取最近的那一端",
  );
  assert.deepEqual(kept[0].board, GRID, "历史里的棋盘形态不对");
  assert.equal(kept[0].net_growth, 1);
  assert.deepEqual(kept[0].life_flip, rc(BOARD(), legalCells(BOARD(), "life")[0]));
});

/* ══════════════════════════════════════════════════════════════════
   ⑤ 分区反转：改「游戏」项，state 必须变（2048 是反过来）
   ══════════════════════════════════════════════════════════════════ */

test("改回合上限后 state 必须变化 —— 游戏项影响 Jev 的输入", () => {
  const a = buildState(input({ rules: { ...RULES, turnLimit: 90 } }));
  const b = buildState(input({ rules: { ...RULES, turnLimit: 60 } }));

  assert.notDeepEqual(a, b, "改回合上限后 state 没变 —— 终局规则没进 state，Jev 不知道自己在玩什么");
  assert.match(b.rules.horizon, /共 60 回合/);
  assert.match(b.rules.termination_conditions, /60/);
});

test("改上下文项（策略提示）后 state 必须变化", () => {
  const a = buildState(input({ context: ctx({ strategyHint: "" }) }));
  const b = buildState(input({ context: ctx({ strategyHint: "优先保住角上的结构。" }) }));

  assert.notDeepEqual(a, b, "改了策略提示 state 没变 —— 提示没有进 Jev 的输入");
  assert.equal(b.aids.strategy_hint, "优先保住角上的结构。");
});

/* ══════════════════════════════════════════════════════════════════
   ⑥ 客观状态与纯度
   ══════════════════════════════════════════════════════════════════ */

test("alive_count / alive_ratio 与棋盘一致，ratio 不做四舍五入", () => {
  const s = buildState(input());
  const n = aliveCount(BOARD());

  assert.equal(s.turn, 12);
  assert.equal(s.alive_count, n);
  // 四舍五入会把 0.596 显示成 0.6 —— 恰好压在那条胜负线上，等于报了个假数。
  // 尺寸都是 2 的幂，占比是精确值，本来就不需要修约。
  assert.equal(s.alive_ratio, n / 64);
  assert.deepEqual(s.aids.board, GRID);
  assert.deepEqual(s.scores, { life: 3, death: 3 });
});

test("buildState / buildQuestions 不改动传入的棋盘与历史（引擎纯度）", () => {
  const board = BOARD();
  const before = Array.from(board.cells);
  const history = [turnRecord(1, 10, 0)];
  const inp = input({ board, history, context: ctx({ memory: 1 }) });

  buildState(inp);
  buildQuestions({ kind: "noul-all" }, inp);

  assert.deepEqual(Array.from(board.cells), before, "棋盘被改动了 —— 引擎纯度红线");
  assert.equal(history.length, 1, "历史被改动了");
});

/* ══════════════════════════════════════════════════════════════════
   ⑦ 提问：noul-all 一次给全
   ══════════════════════════════════════════════════════════════════ */

test("noul-all：一次给全所有合法格，键名 flip_r_c，判别值随后端", () => {
  const inp = input();
  const cells = legalCells(inp.board, "life");
  assert.ok(cells.length > 1, "夹具要有多个合法格，才锁得住「一次给全」这条");

  const qs = buildQuestions({ kind: "noul-all" }, inp);
  assert.equal(Array.isArray(qs), false, "questions 必须是 record —— 传数组上游直接 400");
  assert.equal(Object.keys(qs).length, cells.length, "题目数量与合法格数量对不上");

  for (const cell of cells) {
    const [r, c] = rc(inp.board, cell);
    const q = qs[`flip_${r}_${c}`] as NoulQ | undefined;
    assert.ok(q, `少了 flip_${r}_${c} 这道题`);
    assert.equal(q.type, "noul");
    assert.deepEqual(Object.keys(q.criteria).sort(), ["false", "true"], "noul 的 criteria 只能是 {true,false}");
  }

  // Vercel 网关把 noul 改名叫 boolean —— 判别值写死会让那条后端 400
  const vercel = buildQuestions({ kind: "noul-all", backend: "vercel" }, inp);
  assert.equal(firstQuestion(vercel).type, "boolean");
});

test("后果预测关：直接问长期价值；开：把单步后果作背景，问的仍是长期价值", () => {
  const inp = input();
  const cell = legalCells(inp.board, "life")[0];
  const [r, c] = rc(inp.board, cell);
  const key = `flip_${r}_${c}`;

  const off = buildQuestions({ kind: "noul-all" }, { ...inp, context: ctx({ predictOutcome: false }) });
  const on = buildQuestions({ kind: "noul-all" }, { ...inp, context: ctx({ predictOutcome: true }) });
  const a = off[key] as NoulQ;
  const b = on[key] as NoulQ;

  assert.notEqual(a.instructions, b.instructions, "后果开关没有改变任何措辞");
  for (const q of [a, b]) {
    assert.match(q.instructions, /最终累计活细胞数/, "问的不是长期价值 —— 那会把答案写在题面上");
  }

  const before = aliveCount(inp.board);
  const after = aliveCount(lifeStep(flip(inp.board, cell), inp.topology));
  assert.match(b.instructions, new RegExp(`活细胞数将从 ${before} 变为 ${after}`), "开了后果预测却没给单步后果");
  assert.equal(/活细胞数将从/.test(a.instructions), false, "没开后果预测却给了单步后果");
});

test("死之执的问法必须反向 —— 否则模型会按「增加细胞」的直觉答", () => {
  const life = firstQuestion(buildQuestions({ kind: "noul-all" }, input({ role: "life" })));
  const death = firstQuestion(buildQuestions({ kind: "noul-all" }, input({ role: "death" })));

  assert.match(life.instructions, /有利于最终累计活细胞数/);
  assert.match(death.instructions, /压低/, "死之执问的仍是「是否有利于活细胞数」—— 方向反了");
  assert.equal(
    /有利于最终累计活细胞数/.test(death.instructions),
    false,
    "死之执的题面没有反向：它问的是增加细胞，而它要的是减少",
  );
  assert.notEqual(life.instructions, death.instructions);
});

test("choice-all / choice-filtered 抛「未实现」—— M1 不做，但类型已经留好", () => {
  assert.throws(() => buildQuestions({ kind: "choice-all" }, input()), /未实现/);
  assert.throws(() => buildQuestions({ kind: "choice-filtered", filter: "flip" }, input()), /未实现/);
});

test("没有合法格时抛出可诊断的错误，而不是发一个空 record", () => {
  const allAlive = boardFromRows(["####", "####", "####", "####"]);
  assert.equal(legalCells(allAlive, "life").length, 0);

  assert.throws(
    () => buildQuestions({ kind: "noul-all" }, input({ board: allAlive, role: "life" })),
    /没有可翻的格子/,
    "空 questions 会被当成一次「问题为零」的请求发出去，上游只会报一个看不懂的错",
  );
});
