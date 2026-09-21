/**
 * 上下文组装：把一副棋盘变成 Jev 能读的 `state`，把一次落子变成一张
 * 带类型的 `questions`。
 *
 * ═══ 与 jev-2048 的差异：这里不读 DOM ═══
 *
 * 2048 的 `buildState` / `buildQuestions` 住在 `main.ts` 且直接读输入框
 * （`$("ruleDesc").value`）。那条路径的后果是**无头环境跑不起来** ——
 * 跑分工具要么开一个假 DOM，要么把参数硬编码一份。本模块是纯函数：
 * 所有输入走参数，所有输出是普通对象，Node 里可以直接跑（`tools/bench.ts`
 * 依赖这一点，`tools/scan.ts` 用传递闭包守着它）。
 *
 * 文案因此**必须是直接的字符串常量**，不能走 i18n —— `core/` 一旦引到
 * `client/i18n`，无头环境立刻崩，而且崩在运行时、离真正的原因很远。
 *
 * ═══ state 为什么分三块 ═══
 *
 * ```
 * rules  可移植：人类玩家拿到的说明书就该是这些
 * aids   绑定到这个 AI 玩家：图例、合法格、结构识别、历史、策略提示
 * …      客观状态：turn / alive_count / alive_ratio / scores
 * ```
 *
 * 分出 `aids` 这一层不是为了整齐，有两条立刻可用的东西：
 *
 *   1. **一条可执行的测定**：把 `aids` 整个关掉，看 Jev 的表现掉多少 ——
 *      「把脚手架整个拆掉，看还剩多少是模型自己的」
 *   2. **规则的可移植性可被检查**：`rules` 那块就是完整的说明书，`aids`
 *      那块明确标注为「本实验台的 AI 玩家专享」。人类玩家不需要
 *      「0=死格 1=活格」的图例，也不需要别人告诉他棋盘上有个方块
 *
 * 背景是设计文档里那条反向风险：**规则会被模型塑形** —— 我们把
 * `detected_patterns` 喂给 Jev，规则的一部分就变成了「Jev + 我们喂给它的
 * 结构检测器」。分开记录，是为了让这套规则还能被别人独立使用。
 *
 * `strategy_hint` 归 `aids` 而不是 `rules`，因为它是**实验变量**：
 * 提示词改了就不叫对照实验（2048 用同样的方式对待它 —— 提示词不随界面语言变）。
 */

import { aliveCount, flip, legalCells, lifeStep } from "./life.js";
import { detectPatterns } from "./patterns.js";
import type { DetectedPattern } from "./patterns.js";
import { noulDiscriminator } from "../shared/types.js";
import type { Question, Questions, TurnRecord } from "../shared/types.js";
import type { Channel } from "./channels.js";
import { renderTemplates, templateVars } from "./template.js";
import type { RuleTemplates } from "./template.js";
import type { Board, Cell, GameRules, Mode, Role, Topology } from "./types.js";

/* ══════════════════════════════════════════════════════════════════
   Jev 协议
   ══════════════════════════════════════════════════════════════════

   协议类型曾经**暂住在这里**（`src/shared/` 那时还没建）。T12 建出
   `shared/types.ts` 后已经搬走，这里不留副本 —— 两份类型定义迟早会各自
   演化（`jev-2048` 的 `Strategy` 就被定义了两遍），而它们对不上时不会报错。

   本模块只用到 `Question` / `Questions` / `noulDiscriminator` / `TurnRecord`
   这几个；choice / score 的答案形状、usage、重试策略那些是 API 层的事。 */

/* ══════════════════════════════════════════════════════════════════
   输入类型
   ══════════════════════════════════════════════════════════════════ */

/**
 * 玩家级上下文的可编辑部分 —— 对局级配置（尺寸 / 拓扑 / 规则 / 开局）**不在**这里。
 *
 * 判据是「这描述的是博弈本身，还是这个玩家怎么想」：规则两边共享（两边不同
 * 就不是同一个游戏），而提示、记忆、开关是每一个 AI 玩家各配一份的东西 ——
 * 跨模型对照恰恰要求两边能配得不一样。
 */
export interface RoleContext {
  /**
   * 规则说明（补充）。**默认没有**。
   *
   * 规则主体由 `GameRules` 现算（见 `buildState`）—— 再放一份手写的规则
   * 副本，就会与「游戏」面板里的当前设置互相矛盾，相当于对 Jev 说谎，
   * 而 Jev 的决策正是建立在规则描述之上。所以这一栏是**补充**，不是正文。
   */
  readonly ruleNote?: string;
  /** 策略提示。实验变量，改了就不叫对照实验 */
  readonly strategyHint: string;
  /**
   * 后果预测：是否把「这一手之后演化一代」的单步后果作为背景写进题面。
   *
   * 注意它**只是背景**，问题问的自始至终是长期价值 —— 若题面直接问单步后果，
   * 那就是把答案写在题面上。默认关。
   */
  readonly predictOutcome?: boolean;
  /** 记忆轮数：`recent_history` 保留最近几回合。0 = 不喂历史（默认） */
  readonly memory?: number;
  /**
   * 自动结构识别。**默认开**（开箱即用），可关掉做对照实验 ——
   * 关掉它就是「把脚手架拆干净，看模型还剩多少」，与 `aids` 分层的用意同源。
   */
  readonly detectPatterns?: boolean;
}

/**
 * 默认的玩家级上下文。
 *
 * 各个开关**刻意不写在这里** —— 默认值只留在 `buildState` 里一处，
 * 写两份就会出现「这里关了那里还开着」这种谁也不知道以哪份为准的状态。
 *
 * 策略提示默认为空字符串，不是随手写的默认提示：一份默认提示等于替实验者
 * 决定了给模型喂多少先验，而生命棋的知识（哪些结构是静物、滑翔机会飞）
 * 恰恰是这套实验想测量的东西。
 */
export const DEFAULT_ROLE_CONTEXT: RoleContext = {
  strategyHint: "",
};

export interface StateInput {
  readonly board: Board;
  readonly role: Role;
  /**
   * 对局模式。**必填**（理由见 `Mode`）：规则文案在两种模式下**不一样** ——
   * 双人时「每回合双方各翻一格」，单人时只有生之执在动。把双人那句写给单人局，
   * 模型就在玩另一个游戏，而这一整层存在的意义正是「把规则讲清楚」。
   */
  readonly mode: Mode;
  readonly topology: Topology;
  readonly rules: GameRules;
  readonly turn: number;
  /**
   * 双方的累计得分（`life` / `death` 两栏）。
   *
   * 口径由调用方（裁判）定，`buildState` **原样透传、不做换算** ——
   * 在这里悄悄取一次负数，就会变成一份调用方看不见的隐式约定。
   */
  readonly scores: { readonly life: number; readonly death: number };
  /** 此前各回合的记录，从最早到最近。喂给 Jev 的部分受 `memory` 约束 */
  readonly history: readonly TurnRecord[];
  readonly context: RoleContext;
  /**
   * 规则说明书的模板（`core/template.ts`）。**缺省 = 用出厂模板**，
   * 而出厂模板拼出来的就是这一层出现之前那段文字 —— 老的调用方（工具、跑分、
   * 测试）因此不需要跟着改，也不会有两套文案各自演化。
   *
   * 它属于**玩家级**（与 `context.ruleNote` 同级）：措辞是这个实验者给这个
   * 玩家选的说法，两边可以不一样 —— 这正是跨模型对照要的东西。
   */
  readonly templates?: RuleTemplates;
}

/* ══════════════════════════════════════════════════════════════════
   输出的 state
   ══════════════════════════════════════════════════════════════════ */

/** 可移植的那一半：人类玩家拿到的说明书就该是这些 */
export interface StateRules {
  readonly role: Role;
  readonly role_statement: string;
  /** 计分方式 */
  readonly objective: string;
  /** 「本局共 N 回合，当前第 T 回合」 */
  readonly horizon: string;
  /** 终局条件的完整文字 */
  readonly termination_conditions: string;
  /** 获胜条件 —— 含防抖，那是这条规则的关键部分 */
  readonly win_condition: string;
  /** 界外算死 / 环绕，必须讲清楚 */
  readonly topology_note: string;
  /** 实验者填了规则说明才出现 */
  readonly rule_note?: string;
}

/** 喂给这个 AI 玩家的脚手架。绑到玩家，不是规则的一部分 */
export interface StateAids {
  readonly board: number[][];
  readonly board_legend: string;
  readonly valid_cells: ReadonlyArray<readonly [number, number]>;
  readonly strategy_hint: string;
  /** 关掉自动结构识别时**整个不出现**（不是空数组） */
  readonly detected_patterns?: SerializedPattern[];
  /** 记忆轮数为 0 时**整个不出现** */
  readonly recent_history?: SerializedTurn[];
}

/** `DetectedPattern` 的 JSON 形态。`period` 缺失时整个字段不出现，不写 undefined */
export interface SerializedPattern {
  readonly name: string;
  readonly kind: DetectedPattern["kind"];
  readonly period?: number;
  /** 绝对坐标的活细胞 */
  readonly cells: ReadonlyArray<readonly [number, number]>;
  readonly oriented: boolean;
}

export interface SerializedTurn {
  readonly turn: number;
  readonly board: number[][];
  readonly life_flip: readonly [number, number];
  /** 单人模式没有死之执那一手，此时**整个字段不出现** */
  readonly death_flip?: readonly [number, number];
  readonly alive_count: number;
  readonly net_growth: number;
}

export interface JevState {
  readonly rules: StateRules;
  readonly aids: StateAids;
  readonly turn: number;
  readonly alive_count: number;
  readonly alive_ratio: number;
  readonly scores: { readonly life: number; readonly death: number };
}

/* ══════════════════════════════════════════════════════════════════
   文案
   ══════════════════════════════════════════════════════════════════

   六项规则文本（角色陈述 / 计分方式 / 回合视野 / 终局条件 / 获胜条件 /
   边界说明）已经搬到 `core/template.ts` —— 那里同时住着它们的**出厂模板**
   与占位符取值表。搬走的理由：那六项现在是「可编辑的模板 + 自动填充」，
   而模板的默认值必须与填充逻辑住在一处，否则「默认值到底长什么样」会有
   两个来源，改一处另一处不会跟着动。

   不变的仍然不变：文案全部写死在 `core/` 里、不走翻译层（理由见文件头），
   参数一律现拼，不出现「写死的可变参数」。 */

/** 图例必须带上尺寸与坐标约定：会变的量一律现拼，不写死 */
function boardLegend(board: Board): string {
  return (
    `棋盘是 ${board.rows} 行 × ${board.cols} 列的网格（aids.board 是一个 ${board.rows}×${board.cols} 的二维数组，` +
    `每行自上而下、每列自左而右）。0 = 死格，1 = 活格。` +
    `坐标写作 (行, 列)，都从 0 开始 —— (0, 0) 是左上角。`
  );
}

/* ══════════════════════════════════════════════════════════════════
   buildState
   ══════════════════════════════════════════════════════════════════ */

/** 二维 0/1 网格。**新数组**，改它不会碰到棋盘 */
function toGrid(board: Board): number[][] {
  const out: number[][] = [];
  for (let r = 0; r < board.rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < board.cols; c++) row.push(board.cells[r * board.cols + c]);
    out.push(row);
  }
  return out;
}

function rowCol(board: Board, cell: Cell): [number, number] {
  return [Math.floor(cell / board.cols), cell % board.cols];
}

function serializePattern(p: DetectedPattern): SerializedPattern {
  return {
    name: p.name,
    kind: p.kind,
    // period 是可选字段：静物没有周期，写 undefined 会让「这块是不是振荡器」
    // 变成一个要靠 undefined 判断的问题
    ...(p.period === undefined ? {} : { period: p.period }),
    cells: p.cells,
    oriented: p.oriented,
  };
}

function serializeTurn(t: TurnRecord): SerializedTurn {
  return {
    turn: t.turn,
    board: toGrid(t.board),
    life_flip: rowCol(t.board, t.lifeFlip),
    // ★ 单人模式**没有这一手**：字段整个不出现，而不是编一个格号。
    // 编出来的数会一路流进模型的记忆里，看起来与真的一模一样
    ...(t.deathFlip === undefined ? {} : { death_flip: rowCol(t.board, t.deathFlip) }),
    alive_count: t.aliveCount,
    net_growth: t.netGrowth,
  };
}

export function buildState(input: StateInput): JevState {
  const { board, role, mode, topology, rules, turn, scores, history, context } = input;

  const note = (context.ruleNote ?? "").trim();

  /* ── ① 规则：可移植 ──
     六项文本由模板现渲染：**措辞来自模板，数值来自设置**。没有模板时代
     渲染的就是出厂模板，也就是这一层出现之前那段文字（有对拍用例守着）。 */
  const texts = renderTemplates(
    input.templates,
    templateVars({ role, mode, topology, board, turn, rules }),
  );
  const stateRules: StateRules = {
    role,
    role_statement: texts.role_statement,
    objective: texts.objective,
    horizon: texts.horizon,
    termination_conditions: texts.termination_conditions,
    win_condition: texts.win_condition,
    topology_note: texts.topology_note,
    ...(note === "" ? {} : { rule_note: note }),
  };

  /* ── ② 辅助：绑到这个 AI 玩家 ──
     两个开关都做成「关掉 = 字段整个不出现」而不是空数组 —— 空数组仍然在
     告诉模型「这里什么都没有」，那是另一种提示，不是「把脚手架拆掉」。 */
  const detect = context.detectPatterns ?? true;
  const memory = context.memory ?? 0;

  const aids: StateAids = {
    board: toGrid(board),
    board_legend: boardLegend(board),
    valid_cells: legalCells(board, role).map((cell) => rowCol(board, cell)),
    strategy_hint: context.strategyHint.trim(),
    ...(detect ? { detected_patterns: detectPatterns(board).map(serializePattern) } : {}),
    ...(memory > 0 ? { recent_history: history.slice(-memory).map(serializeTurn) } : {}),
  };

  /* ── ③ 客观状态 ──
     ratio 不做修约：修约会把 0.596 显示成 0.6，而 0.6 恰好压在那条胜负线上 ——
     等于报了一个假数。三档尺寸都是 2 的幂，占比本来就是精确值。 */
  const alive = aliveCount(board);

  return {
    rules: stateRules,
    aids,
    turn,
    alive_count: alive,
    alive_ratio: alive / (board.cols * board.rows),
    scores: { life: scores.life, death: scores.death },
  };
}

/* ══════════════════════════════════════════════════════════════════
   buildQuestions
   ══════════════════════════════════════════════════════════════════

   `Channel`（三条通道的类型）住在 `channels.ts` —— 那边同时管着**回包怎么读**
   （`parseAnswers`）。词汇与解析放在一处，省得「题面在这边、答案在那边」
   两边各演化一次。本模块只负责按通道组题。

   一条通道 = 一个请求：下面两条 `build*` 都返回**完整的** `Questions` record，
   调用方一次性发出去、绝不循环。 */

/**
 * 一道布尔题的题面。
 *
 * ★ 这里有个陷阱：`noul` 的 `criteria` 只能是 `{true, false}`，所以「后果预测」
 * **放不进 criteria，只能进 instructions**。而如果 instructions 直接问单步后果
 * 并把答案写进去，就等于把答案写在题面上。
 *
 * 处理方式是**分开问、分别问**：单步后果作为**背景**（且明说是背景），
 * 问的自始至终是长期价值。死之执的问法还要再反向一次 ——
 * 否则模型会按「增加细胞」的直觉答，测到的是直觉不是规则理解。
 */
function noulInstructions(input: StateInput, r: number, c: number): string {
  const { role, board, topology, context } = input;
  const at = `(${r}, ${c})`;

  const who = role === "life" ? "生之执" : "死之执";
  const act =
    role === "life"
      ? `把一个死格翻成活细胞`
      : `把一个活细胞翻成死格`;

  // 背景 = 只算「你这一手 + 演化一代」，不含对手这一回合的应对。
  // 明说是背景，是为了别让模型把「单步后果」当成整回合的结果。
  let background = "";
  if (context.predictOutcome ?? false) {
    const before = aliveCount(board);
    const after = aliveCount(lifeStep(flip(board, cellOf(board, r, c)), topology));
    background = `作为背景（只考虑这一手、不含对手的应对）：若现在就演化一代，棋盘上的活细胞数将从 ${before} 变为 ${after}。`;
  }

  const ask =
    role === "life"
      ? "这一手是否有利于最终累计活细胞数（越大越好）？"
      : "这一手是否有利于压低最终累计活细胞数（越小越好）？";

  return `本回合你（${who}）在 ${at} ${act}。${background}${ask}`;
}

function cellOf(board: Board, r: number, c: number): Cell {
  return r * board.cols + c;
}

function buildNoulAll(input: StateInput, backend: string): Questions {
  const cells = legalCells(input.board, input.role);

  // 合法集为空 ⟺ 棋盘全死 / 全活 ⟺ 终局判定本该已经结束对局。
  // 这里抛错而不是返回空 record：空 record 会被当成一次「问题为零」的请求
  // 发出去，上游只会报一个看不懂的协议错，而真正的原因在两跳之外。
  if (cells.length === 0) {
    throw new Error(
      `${
        input.role === "life" ? "生之执" : "死之执"
      }没有可翻的格子（棋盘 ${input.board.cols}×${input.board.rows}）—— ` +
        "这种情况应当由终局判定先结束对局，而不是发一次没有问题的请求",
    );
  }

  // 判别值按**界面上的后端 id** 取。对直连后端（自己带密钥打到网关那份）这就是
  // 最终值；对代管代理（免费试用 1 / 2）它只是客户端**能知道的那一半** ——
  // 代理会在转发前按它自己的上游再归一化一次（`shared/types.ts` 的
  // `normalizeQuestionTypes`）。**别为了代理在这里改什么**：客户端本来就无从
  // 知道代理转发到哪，按 id 猜正是那个「一发就 400」的来源。
  const type = noulDiscriminator(backend);
  const out: Record<string, Question> = {};

  for (const cell of cells) {
    const [r, c] = rowCol(input.board, cell);
    out[`flip_${r}_${c}`] = {
      type,
      instructions: noulInstructions(input, r, c),
      // noul 的 criteria 只有两个键。注意这里的「有利」是**相对于题面问的那个方向**
      // —— 死之执那一份的题面问的是「压低」，所以「有利」= 有利于压低。
      criteria: { true: "有利", false: "不利" },
    };
  }

  return out;
}

export function buildQuestions(channel: Channel, ctx: StateInput): Questions {
  if (channel.kind === "noul-all") return buildNoulAll(ctx, channel.backend ?? "");

  // choice-* 两条通道 M1 不实现：类型先定下来，免得 T13 再回头改签名
  // （一条通道 = 一个请求这条约束，也在这里一次性说清）
  throw new Error(
    `通道「${channel.kind}」尚未实现：M1 只实现 noul-all，choice-all 与 choice-filtered 由 T13 补`,
  );
}
