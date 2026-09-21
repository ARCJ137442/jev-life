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
import type { RoleContext, StateInput } from "../core/context.js";
import { DEFAULT_TEMPLATES } from "../core/template.js";
// 协议类型与 TurnRecord 在 T12 搬去了 src/shared/types.ts（原地不留副本），
// 所以这里也改成从新家取
import type { Questions, TurnRecord } from "../shared/types.js";
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
    mode: "duel",
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

/* ══════════════════════════════════════════════════════════════════
   ★ 规则文本改由模板渲染之后，两条必须守住的东西
   ══════════════════════════════════════════════════════════════════ */

test("★ 出厂模板拼出来的那六段文字，逐字锁在这里", () => {
  // ⚠ 这一条**必须**是硬编码的期望文案，不能写成「与不带模板时对拍」——
  // 那种对拍是**恒真**的：现在两条路径都走 `renderTemplates`，不带模板时
  // 用的就是出厂模板，两边永远相等。第一版正是那么写的，变异测试当场证明
  // 它杀不掉任何变异（把默认模板改掉它照样绿）。
  //
  // 为什么值得逐字锁：这六段是**测量基线** —— 措辞一变，所有既有对局与
  // 之前跑过的数据就不再可比，而症状只是「数字好像不太一样」。
  // 所以改默认模板必须是一次**有意识**的改动：改完这里会红，红的时候
  // 想清楚「这条修改值不值得让旧数据失去可比性」。
  const texts = buildState(input({ role: "life", mode: "duel", topology: "bounded" })).rules;

  assert.equal(
    texts.role_statement,
    "生之执：你是 Life。你的目标是在对局结束时让累计净增长尽可能大 —— " +
      "也就是让棋盘上的活细胞尽可能多。你每回合可以翻转一个死格为活。" +
      "注意：让细胞活着对你有利。",
  );
  assert.equal(
    texts.objective,
    "计分方式：每回合双方各翻一格，然后棋盘演化一代；" +
      "演化后的活细胞数与上一回合相比的变化量，就是这一回合的净增长。" +
      "把各回合的净增长累加起来，得到累计净增长，记在 scores 里。" +
      "你是生之执：累计净增长越大越好 —— 终局时结算的就是它。",
  );
  // ⚠ 与模板化之前相比，这里**词序变了**（原来是「当前是第 13 回合，还剩 78 回合」）：
  // 回合上限那一项现在是一个占位符（`{{turnLimit}}` → 「共 90 回合，还剩 78 回合」），
  // 信息一字不少，只是与「当前第几回合」换了位置。这是引入模板时唯一一处
  // 措辞重排，记在这里备查。
  assert.equal(texts.horizon, "本局共 90 回合，还剩 78 回合，当前是第 13 回合。");
  assert.equal(
    texts.win_condition,
    "存活比例 = 棋盘上的活细胞数 ÷ 总格数（8×8 = 64 格），记在 alive_ratio 里。\n" +
      "生之执获胜：存活比例「连续」 3 回合 ≥ 60%。\n" +
      "死之执获胜：存活比例「连续」 3 回合 ≤ 5%。\n" +
      "「连续」是这条规则的关键部分（防抖）：生命棋单代的涨落很大，只看一代就判胜负等于把胜负交给运气。" +
      "所以必须是连续越界满 3 / 3 回合才算赢，中途只要有一回合回到两条线之间，计数就从头开始。",
  );
  assert.equal(
    texts.topology_note,
    "拓扑：有界（bounded）。棋盘之外一律算死格 —— 界外没有邻居，" +
      "一个贴着边界的活细胞在边界那一侧就是没有邻居。棋盘不会卷起来，边界是墙。",
  );
  assert.equal(
    texts.termination_conditions,
    "对局在下列任一情况下立即结束：\n" +
      "1. 一方达成获胜条件（存活比例连续越界达到规定回合数，详见获胜条件）。\n" +
      "2. 走投无路之一：棋盘全死 —— 死之执把活细胞清空了，判死之执胜；" +
      "棋盘全活 —— 生之执把棋盘占满了，判生之执胜。" +
      "这不是「没棋可走就输」，而是一方把自己的目标推到了极限。\n" +
      "3. 走投无路之二：此后无论双方怎么落子，下一回合的局面都会重复已经出现过的局面（推不动了）—— " +
      "按当时的存活比例判：≥ 60% 判生之执胜，≤ 5% 判死之执胜，夹在两条线之间判和局。\n" +
      "4. 回合数达到上限 90：仍未分出胜负，判和局。",
  );
});

test("★ 单人局那两段随模式改说法的文字，也逐字锁住", () => {
  // 单人局的措辞错一个字就是**对 Jev 说谎**（「死之执获胜」在单人局里是一句
  // 关于一个不在场的人的话），而它照样渲染、照样能跑完一局。所以这里同样
  // 逐字锁：这两段是最不该被顺手改掉的东西。
  const texts = buildState(input({ role: "life", mode: "solo" })).rules;

  assert.equal(
    texts.win_condition,
    "存活比例 = 棋盘上的活细胞数 ÷ 总格数（8×8 = 64 格），记在 alive_ratio 里。\n" +
      "你获胜：存活比例「连续」 3 回合 ≥ 60%。\n" +
      "你落败：存活比例「连续」 3 回合 ≤ 5% —— 棋盘死绝。\n" +
      "「连续」是这条规则的关键部分（防抖）：生命棋单代的涨落很大，只看一代就判胜负等于把胜负交给运气。" +
      "所以必须是连续越界满 3 / 3 回合才算赢，中途只要有一回合回到两条线之间，计数就从头开始。",
  );
  assert.equal(
    texts.termination_conditions,
    "对局在下列任一情况下立即结束：\n" +
      "1. 你达成获胜条件，或棋盘死绝（存活比例连续越界达到规定回合数，详见获胜条件）。\n" +
      "2. 棋盘全活 —— 你把棋盘占满了，一个死格都不剩，判你获胜。" +
      "这不是「没棋可走就输」，而是你把自己的目标推到了极限。" +
      "**注意：棋盘全死不会结束对局** —— 那时你仍然可以翻转任意一个死格。\n" +
      "3. 推不动了：此后无论你怎么落子，下一回合的局面都会重复已经出现过的局面 —— " +
      "按当时的存活比例判：≥ 60% 判你胜，≤ 5% 判你落败，夹在两条线之间判和局。\n" +
      "4. 回合数达到上限 90：仍未分出胜负，判和局。",
  );
});

test("不设回合上限时 horizon 的那句话，逐字锁住", () => {
  const h = buildState(input({ rules: { ...RULES, turnLimit: null } })).rules.horizon;
  assert.equal(h, "本局不设回合上限 —— 一直下到分出胜负、走投无路或推不动为止，当前是第 13 回合。");
});

test("★ 模板改的是措辞，改不了数值：换了模板之后数值仍随设置走", () => {
  const templates = { ...DEFAULT_TEMPLATES, horizon: "剩 {{turnLimit}} / 第 {{turn}} 回合。" };
  const at90 = buildState(input({ templates, rules: { ...RULES, turnLimit: 90 }, turn: 12 }));
  const at60 = buildState(input({ templates, rules: { ...RULES, turnLimit: 60 }, turn: 12 }));

  assert.equal(at90.rules.horizon, "剩 共 90 回合，还剩 78 回合 / 第 13 回合。");
  assert.match(at60.rules.horizon, /共 60 回合/);
  assert.notEqual(at90.rules.horizon, at60.rules.horizon);
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

/* ══════════════════════════════════════════════════════════════════
   ★ 单人模式：规则文案与记忆
   ══════════════════════════════════════════════════════════════════
   这一层存在的意义就是「把规则讲清楚」。单人局里规则**确实不一样**，
   照抄双人那套文案等于让模型去玩另一个游戏 —— 而它不会报错，只会让这一局
   的测量数字谁也不是。 */

test("★ 单人：objective 不能写「双方各翻一格」", () => {
  const duel = buildState(input());
  const solo = buildState(input({ mode: "solo" }));

  assert.ok(duel.rules.objective.includes("双方各翻一格"), duel.rules.objective);
  assert.ok(
    !solo.rules.objective.includes("双方"),
    `单人局的计分说明里还写着「双方」：${solo.rules.objective}`,
  );
  assert.ok(solo.rules.objective.includes("你翻一格"), solo.rules.objective);
  assert.notEqual(duel.rules.objective, solo.rules.objective);
});

test("★ 单人：win_condition 写「你获胜 / 你落败」，不写「死之执获胜」", () => {
  const solo = buildState(input({ mode: "solo" }));
  assert.ok(solo.rules.win_condition.includes("你获胜"), solo.rules.win_condition);
  assert.ok(solo.rules.win_condition.includes("你落败"), solo.rules.win_condition);
  assert.ok(
    !solo.rules.win_condition.includes("死之执获胜"),
    "单人局没有死之执，规则里不该出现它",
  );
});

test("★ 单人：termination_conditions 里「棋盘全死」不是终局，且明说可以继续翻", () => {
  const solo = buildState(input({ mode: "solo" }));
  const duel = buildState(input());
  assert.ok(
    solo.rules.termination_conditions.includes("棋盘全死不会结束对局"),
    solo.rules.termination_conditions,
  );
  assert.ok(!duel.rules.termination_conditions.includes("棋盘全死不会结束对局"));
  // 双人那条「判死之执胜」在单人局里必须消失
  assert.ok(!solo.rules.termination_conditions.includes("判死之执胜"));
});

test("★ 单人：recent_history 里**没有** death_flip 这一栏", () => {
  const board = BOARD();
  const soloInput = input({
    mode: "solo",
    context: { ...DEFAULT_ROLE_CONTEXT, memory: 5 },
    history: [
      {
        turn: 0,
        board,
        lifeFlip: legalCells(board, "life")[0],
        // 单人模式没有这一手
        aliveCount: 3,
        netGrowth: 1,
      },
    ],
  });
  const solo = buildState(soloInput);
  const h = solo.aids.recent_history?.[0] as Record<string, unknown> | undefined;
  assert.ok(h, "记忆没有被写进 state");
  assert.ok(has(h as object, "life_flip"), "生之执那一手应当在");
  assert.ok(
    !has(h as object, "death_flip"),
    "单人模式没有死之执那一手 —— 字段整个不出现，而不是补一个 0（0 是一个真实的格号）",
  );

  // 双人模式下同一栏照旧出现
  const duel = buildState(
    input({
      context: { ...DEFAULT_ROLE_CONTEXT, memory: 5 },
      history: soloInput.history.map((t) => ({ ...t, deathFlip: 0 })),
    }),
  );
  assert.ok(has(duel.aids.recent_history?.[0] as object, "death_flip"));
});

test("★ 不设回合上限时，state 里写「不设上限」而不是一个巨大的数", () => {
  // 写「本局共 99999 回合」会让模型以为「还有很多回合，不急」——
  // 那是一条**凭空造出来的规则**，而不是「没有这条规则」
  const solo = buildState(input({ mode: "solo", rules: { ...RULES, turnLimit: null } }));
  assert.ok(solo.rules.horizon.includes("不设回合上限"), solo.rules.horizon);
  assert.ok(
    !/\d{3,}/.test(solo.rules.horizon.replace(/第 \d+ 回合/, "")),
    `horizon 里还有三位数以上的数字：${solo.rules.horizon}`,
  );
  assert.ok(
    solo.rules.termination_conditions.includes("不设回合上限"),
    solo.rules.termination_conditions,
  );
  // 双人那边同理，而且**不能**再出现「回合数达到上限 N」那一条
  const duel = buildState(input({ rules: { ...RULES, turnLimit: null } }));
  assert.ok(!duel.rules.termination_conditions.includes("回合数达到上限"));
});
