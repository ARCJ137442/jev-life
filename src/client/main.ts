/**
 * 装配层：core 的引擎 / 决策 / 通道 → DOM。
 *
 * ═══ T14 的边界 ═══
 *
 * 本任务只搭**骨架**：能起来、能开一局、能看日志。棋盘与三张图的**绘制**
 * 归 T15（`render.ts`），所以这里只有 `fitCanvas` 的尺寸管理，没有绘图代码。
 * 三块画布的尺寸在 T14 就已经是最终值 —— 一块 0×0 或没设 DPR 的画布，
 * 接上绘图代码之后看到的第一眼永远是「糊的」，而那时人会去怀疑绘图代码。
 *
 * ═══ 与 2048 的一处结构性差异 ═══
 *
 * 一回合是「双方**同时**各翻一格、再演化一代」。两个请求用 `Promise.all`
 * 并发发出、都基于**演化前**的棋盘。顺序 await 的结果一模一样（两边本来就
 * 不知道对方走了哪），但代码结构会误导人以为死之执能看到生之执的落子 ——
 * 而这个项目的全部意义就是别搞错这种因果关系。
 *
 * 两边各发一个请求也**不需要任何冲突消解**：合法集天然互斥（生之执只能翻
 * 死格、死之执只能翻活格）。
 */
import {
  aliveCount,
  boardFromRows,
  boardKey,
  classifyTermination,
  createBoard,
  flip,
  lifeStep,
  toRows,
} from "../core/life.js";
import { buildQuestions, buildState } from "../core/context.js";
import type { RoleContext, StateInput } from "../core/context.js";
import {
  PLACEHOLDERS,
  TEMPLATE_KEYS,
  placeholdersIn,
  templateIssues,
  templateVars,
} from "../core/template.js";
import type { RuleTemplateKey, RuleTemplates } from "../core/template.js";
import { parseAnswers } from "../core/channels.js";
import { resolveDecision } from "../core/decide.js";
import type { CellProbabilities } from "../core/decide.js";
import type { Channel } from "../core/channels.js";
import type { Board, Cell, GameRules, Role, Termination } from "../core/types.js";
import { MAX_SIZE, MIN_SIZE } from "../core/types.js";
import type { Questions } from "../shared/types.js";
import { JevError } from "../shared/backend.js";
import type { DecisionRequest, DecisionResult, LlmCallOptions } from "../shared/backend.js";
import {
  BACKENDS,
  createBackend,
  isBackendReachable,
  isStaticHosting,
  type BackendId,
  type ClientConfig,
} from "./api.js";
import {
  MAX_MEMORY,
  MAX_RETRY,
  channelOf,
  clamp01,
  clampFlipMs,
  clampOpeningId,
  clampPace,
  clampRatio,
  clampSize,
  clampStreak,
  clampTurnLimit,
  coupleLlmSettings,
  defaultRole,
  desiredEffort,
  effortDegraded,
  isPresetSize,
  load,
  presetFor,
  save,
  templatesOf,
  type ArchiveSettings,
  type Persisted,
  type RoleSettings,
} from "./config.js";
import {
  ConfidenceChart,
  HeatChart,
  MomentumChart,
  ROLE_COLOR,
  buildHeat,
  withAlpha,
} from "./chart.js";
import type { ChartPoint, ChartSeries, MomentumInput } from "./chart.js";
import { BoardRenderer, FLIP_MS } from "./render.js";
import { scoreNow, turnScoreViews } from "./score.js";
import type { ScoreView } from "./score.js";
import { deserializeTurn, serializeTurn, type StoredTurn } from "./session.js";
import {
  clearSession,
  loadSession,
  rawSession,
  saveSession,
  saveSessionNow,
  type RoleLog,
  type Session,
  type SessionInput,
  type TurnLog,
} from "./session.js";
import {
  ArchiveError,
  buildArchive,
  download,
  downloadRaw,
  extract,
  parseArchive,
  readFile,
  type ArchiveKind,
} from "./archive.js";
import { applyDom, getLang, onLangChange, setLang, t } from "./i18n.js";
import { modeUi } from "./mode.js";
import type { Opening } from "../core/presets.js";

/* ═══════════ 常量 ═══════════ */

/**
 * 角色的展示元数据。
 *
 * 配色不是审美选择：**绿、红、黄、白四个色相已经被「内容」占用**
 * （绿=生之执、红=死之执、黄=中段/交集、白=活细胞），所以界面主题色只能落在
 * 青/蓝/紫一带，用户选了青。角色色本身**不随主题走** —— 它们是数据的一部分。
 *
 * `band` / `faint` 由 `color` 现算而不是各写一份字面量：它们本来就是同一个色
 * 的两种透明度，写成字面量的话，改主色时漏改一处就会出现「带子与中位线不同色」，
 * 而那看起来像是渲染出错。
 */
const ROLE_META: Record<Role, { labelKey: string; color: string; band: string; faint: string }> = {
  life: {
    labelKey: "log.roleLife",
    color: ROLE_COLOR.life,
    band: withAlpha(ROLE_COLOR.life, 0.3),
    faint: withAlpha(ROLE_COLOR.life, 0.05),
  },
  death: {
    labelKey: "log.roleDeath",
    color: ROLE_COLOR.death,
    band: withAlpha(ROLE_COLOR.death, 0.3),
    faint: withAlpha(ROLE_COLOR.death, 0.05),
  },
};

/**
 * 角色的渲染顺序。
 *
 * ★ 从 `Object.keys` 取而不是写一个数组字面量：`tools/check-dom.ts` 会把
 * **方括号包裹的字符串字面量一律当成 DOM id 清单**（它扫的是全文），
 * 于是把 life 与 death 写成方括号字符串数组，会被报成两个不存在的 id。
 * 字符串键的对象没有这个问题，而且插入顺序是有保证的。
 */
const ROLE_ORDER = Object.keys(ROLE_META) as Role[];

const ROLE_OF_KEY: Record<string, Role> = { life: "life", death: "death" };

/** 顶栏顺序 = 用户的自然动线：先玩 → 调整 → 接通模型 → 回看 → 存下来 */
const DRAWERS = ["dGame", "dStrategy", "dApi", "dLog", "dArchive"];

/** 日志面板一次最多渲染多少条 —— 几百条 <details> 全渲染会明显卡顿 */
const LOG_PAGE_SIZE = 60;

/** 置信度图最多保留多少个回合的点 */
const MAX_CHART_POINTS = 120;

/** 交互模式下不进存档的日志上限（内存里留这么多，存档只留 MAX_PERSISTED_LOGS 条） */
const MAX_LOGS = 400;

/**
 * 取 DOM 元素。
 *
 * 拿不到时返回 null（类型上被断言掉了），后续访问会抛
 * 「Cannot read properties of null」。这种错误若发生在**模块求值阶段**，
 * 会静默中断整个启动流程 —— 表现为「棋盘空白、点一下直接判负」，
 * 与真正的原因（一个多出来的字符串）毫无关联，排查成本极高。
 *
 * 两道防线：
 *   1. `boot()` 里用 `assertDom()` 一次性核对全部 id
 *   2. 构建前由 `tools/check-dom.ts` 静态比对，从源头拦住
 */
const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

/** 启动自检：把所有缺失的 id 一次性报出来，而不是让第一个 null 静默炸掉 */
function assertDom(ids: string[]): void {
  const missing = ids.filter((id) => !document.getElementById(id));
  if (missing.length) {
    throw new Error(
      t("boot.missingDom", { n: missing.length, list: missing.map((m) => "#" + m).join(", ") }) +
        t("boot.missingDomHint"),
    );
  }
}

/* ═══════════ 持久化 + 渲染器 ═══════════ */

const store: Persisted = load();

const boardCanvas = $<HTMLCanvasElement>("board");
const renderer = new BoardRenderer(boardCanvas, ROLE_COLOR);
const chart = new ConfidenceChart($<HTMLCanvasElement>("chart"));
const momentum = new MomentumChart($<HTMLCanvasElement>("momentum"), ROLE_COLOR);
const heat = new HeatChart($<HTMLCanvasElement>("heat"), ROLE_COLOR);

/* ═══════════ 状态 ═══════════ */

/** 决策面板上一条被展示的决策（缓存下来，供切换语言时按新语言重画） */
interface ShownDecision {
  readonly role: Role;
  readonly cell: Cell;
  readonly prob: number;
  readonly reasonKey: string;
  readonly reasonParams?: Record<string, string | number>;
  readonly coerced: boolean;
  readonly belowThreshold: boolean;
}

interface AppState {
  board: Board;
  turn: number;
  running: boolean;
  /**
   * 「开始对弈」是否已经被按过。
   *
   * 与 `turn > 0` **不是一回事**：第一回合可能因为上游报错而失败，那时
   * `turn` 仍是 0，但这一局已经开始了 —— 棋盘该锁定。用 `turn` 兼职当这个
   * 判据，会让「第一次调用失败之后还能继续手绘开局」这种事悄悄成立。
   */
  started: boolean;
  busy: boolean;
  finished: boolean;
  termination: Termination | null;
  /** 各回合的完整记录。**同时是喂给 Jev 的记忆源** */
  history: TurnRecordLike[];
  /** 此前各回合的活细胞占比（不含当前局面）—— 防抖判定要用 */
  ratioHistory: number[];
  /** 出现过的局面键 —— repeatBlocked 判定要用 */
  seen: Set<string>;
  logs: TurnLog[];
  scores: { life: number; death: number };
  /** 本局活细胞数的最大 / 最小值（记分板的 A.MAX / A.MIN） */
  aliveMax: number;
  aliveMin: number;
  costTotal: number;
  /** 有调用无法计价。此时页脚那个数是**下界**，不是总额 */
  costUnknown: boolean;
  /**
   * 密钥。**只在内存里**，按玩家分，绝不落盘、绝不导出。
   * 刷新页面即清空，这是刻意的：少一个能泄漏的地方。
   */
  keys: Record<Role, string>;
  /** 抽屉里当前查看 / 编辑的玩家 */
  role: Role;
  /** 决策面板的内容。null = 显示 `shownIdleKey` 那条空闲文案 */
  shown: ShownDecision[] | null;
  shownIdleKey: string;
  shownIdleParams?: Record<string, string | number>;
  /**
   * 本回合双方各自的**完整**概率分布 —— 决策热力图（③）的数据源。
   *
   * 与日志分开存：日志里只有 top / bottom / median 三个标量与概率前 5，
   * 那是给「这一手有多分散」用的；热力图要的是**每一格**的值。
   *
   * **只在内存里**，不进存档：热力图说的是「这一手」，刷新之后那个「这一手」
   * 已经不存在了，恢复出一张上一局的热力图只会误导人。
   */
  probs: Record<Role, CellProbabilities | null>;
  /**
   * `probs` 是**按哪一副棋盘**算出来的。
   *
   * 热力图（③）要按它取值，不能按 `state.board` —— 一回合打到这一步时
   * `state.board` 已经是**演化之后**的那一副了，而概率是逐格按「这格属于谁的
   * 候选集」查出来的。两副棋盘对不上，翻过的那一片格子会整片取到 0。
   * 见 `refreshModelCharts()` 的注释。
   *
   * 与 `probs` 同生共死：null = 还没有分布可画。
   */
  probsBoard: Board | null;
}

/** `TurnRecord` 的形状。core 那侧的 `TurnRecord` 走 import type，这里只借它的结构 */
type TurnRecordLike = import("../shared/types.js").TurnRecord;

const state: AppState = {
  // 占位棋盘必须是一副**合法**的棋盘：`boardFromRows` 会当场校验尺寸
  // （最小 4×4），用一行 "...." 这种随手写的占位会在**模块求值阶段**抛错 ——
  // 那正是 CLAUDE.md 红线 2 描述的故障形态：静默中断启动，表现为「棋盘空白」，
  // 而报错点离原因（一个占位字符串）很远。无头冒烟跑第一次就抓到了它。
  board: createBoard(store.duel.cols, store.duel.rows),
  turn: 0,
  running: false,
  started: false,
  busy: false,
  finished: false,
  termination: null,
  history: [],
  ratioHistory: [],
  seen: new Set<string>(),
  logs: [],
  scores: { life: 0, death: 0 },
  aliveMax: 0,
  aliveMin: 0,
  costTotal: 0,
  costUnknown: false,
  keys: { life: "", death: "" },
  role: "life",
  shown: null,
  shownIdleKey: "decision.idle",
  probs: { life: null, death: null },
  probsBoard: null,
};

const ledEl = $("led");
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 最近一次的状态栏内容。
 *
 * 存 **key 而不是已翻译的文本** —— 切换语言时要能按新语言重画，而状态栏是
 * 「一次性写上去」的，没有别的途径能恢复它。
 */
let lastLed: {
  cls: "" | "on" | "busy" | "err";
  key: string;
  params?: Record<string, string | number>;
} | null = null;

function setLed(
  cls: "" | "on" | "busy" | "err",
  key: string,
  params?: Record<string, string | number>,
): void {
  lastLed = { cls, key, params };
  ledEl.className = "led" + (cls ? " " + cls : "");
  $("status").textContent = t(key, params);
}

/* ═══════════ 从设置现算的小工具 ═══════════ */

const roleLabel = (role: Role): string => t(ROLE_META[role].labelKey);

const other = (role: Role): Role => (role === "life" ? "death" : "life");

function preset() {
  return presetFor(store.duel.cols, store.duel.rows);
}

/**
 * 当前生效的规则 —— **全部五项都取自 `store.duel`**，不再从预设现拼。
 *
 * ⚠ **T14 曾把胜负线定成只读**，理由是「预设标着 `calibrated: false`，做成
 * 四个可调项会暗示它们已经标定过」。那个顾虑仍然成立，但**解法不是藏起来、
 * 而是标注**（用户 2026-09-21 定）：藏起来并不能让它变准。
 *
 * 换尺寸时这五项会被**整套重播**成新尺寸的预设值（见 `setSize`）—— 预设的意义
 * 就是「一整套参数」，只搬其中几项会得到谁也没配过的组合。
 */
function currentRules(): GameRules {
  const d = store.duel;
  return {
    turnLimit: d.turnLimit,
    lifeWinRatio: d.lifeWinRatio,
    deathWinRatio: d.deathWinRatio,
    lifeStreak: d.lifeStreak,
    deathStreak: d.deathStreak,
  };
}

/**
 * 当前生效的开局。**null = 「自定义」**（手绘过，或该尺寸没有开局库）。
 *
 * 这里刻意不回落 `p.openings[0]`：回落会让「非预设尺寸」去执行一套为 8×8
 * 设计的结构摆放，而 `compose()` 对重叠是**当场抛错**的 —— 于是选 7×11
 * 点开一局，得到的是一句「开局有结构重叠」，而真正的原因是「这个尺寸根本
 * 没有开局库」。
 */
function openingOf(): Opening | null {
  if (store.duel.openingId === "") return null;
  return preset().openings.find((o) => o.id === store.duel.openingId) ?? null;
}

const openingName = (o: Opening): string => (getLang() === "en" ? o.nameEn : o.nameZh);

const totalCells = (): number => state.board.cols * state.board.rows;

const ratioOf = (n: number): number => n / totalCells();

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** 把玩家级设置变成 `core/context.ts` 的 `RoleContext` */
function roleContextOf(s: RoleSettings): RoleContext {
  const note = s.ruleNote.trim();
  return {
    // 留空时整个字段不出现，而不是出现一个空串 —— 空串仍然在告诉模型
    // 「这里本来有话要说」，那是另一种提示
    ...(note === "" ? {} : { ruleNote: note }),
    strategyHint: s.strategyHint,
    predictOutcome: s.predictOutcome,
    // null（最大）= 在预算内尽量塞满。core 没有 token 预算这个概念，
    // 所以这里落到滑块上限 —— 再多的历史也超出任何模型的上下文窗口
    memory: s.memory === null ? MAX_MEMORY : s.memory,
    detectPatterns: s.detectPatterns,
  };
}

/** `RoleSettings` → 传输层配置。密钥只从内存取，且代管后端一律不带 */
function clientConfigOf(role: Role): ClientConfig {
  const s = store.roles[role];
  const b = BACKENDS[s.provider];
  return {
    provider: s.provider,
    base: s.base,
    model: s.model,
    apiKey: b.needsKey ? (state.keys[role] ?? "") : "",
  };
}

const retryPolicy = () => ({ max: store.api.retryMax, baseMs: store.api.retryBaseMs });

/* ═══════════ 记分板与页脚 ═══════════ */

/**
 * 把一组读数写进那五个格子。
 *
 * ★ 取值全部来自参数，**不去读 `state`** —— 记分板要能显示「某一副棋盘」的
 * 读数，而回合进行到一半时 `state.board` 已经是**演化之后**的那一副了
 * （见 `score.ts` 文件头：数字跑到画面之前就是从这里来的）。
 */
function renderScore(v: ScoreView): void {
  $("sAlive").textContent = String(v.alive);
  $("sRatio").textContent = pct(v.ratio);
  $("sTurn").textContent = String(v.turn);
  $("sMax").textContent = String(v.max);
  $("sMin").textContent = String(v.min);
}

/**
 * 棋盘**瞬时**变化后的记分板（手绘开局、清空、开新局、恢复存档）。
 *
 * 这些路径没有动画 —— 方块在点下去的那一刻就变了，所以记分板同步改。
 * 一回合那两段动画走的是 `renderer.playTurn` 的 `onPhase`，不经过这里。
 */
function updateStats(): void {
  renderScore(scoreNow(state.board, state.turn, state.aliveMax, state.aliveMin));
}

/**
 * 累计费用与均次费用。
 *
 * 两处数据同源（`costTotal` 与已成功调用次数），放在一起更新，免得某一处
 * 漏改导致两个数字对不上。失败的调用不产生费用，也不计入分母。
 */
function updateCostUi(): void {
  // 分母 = 成功调用次数。单人模式下每回合只有一次调用，乘 2 会把均次费用
  // 算成一半 —— 而这个数正是用来横向比后端的，错一半没人看得出来
  const perTurn = store.duel.mode === "solo" ? 1 : ROLE_ORDER.length;
  const ok = state.logs.filter((r) => !r.failed).length * perTurn;
  $("cost").textContent =
    (state.costUnknown ? "≥ $" : "$") + state.costTotal.toFixed(6);
  // 单次调用常常只有十万分之几美元，4 位小数会一律显示成 $0.0000
  $("avgCost").textContent = ok > 0 ? `$${(state.costTotal / ok).toFixed(8)}` : "—";
}

/* ═══════════ 画布自适应 ═══════════ */

/**
 * 棋盘画布取「可用宽 / 可用高」的较小者 —— 生命棋的棋盘是正方形，
 * 用长边会让它在窄屏上被裁掉。
 *
 * 尺寸与绘制现在是同一件事：格子的边长只有在画布尺寸定下来之后才算得出，
 * 所以这里直接把可用空间交给渲染器，由它按 `GUTTER_K` 反推格子边长。
 * 棋盘尺寸也一并传进去 —— 渲染器不持有棋盘状态（它只认视觉）。
 */
function fitBoard(): void {
  const box = boardCanvas.parentElement;
  if (!box) return;
  const size = Math.min(box.clientWidth, box.clientHeight);
  renderer.resize(size, size, state.board.cols, state.board.rows);
}

/**
 * 侧栏三张图的尺寸。
 *
 * 三张图**高度固定、宽度跟着侧栏走**：它们的信息量都在横轴（回合）上，
 * 而侧栏本身是 `max-content` 撑出来的 —— 让图去挤压侧栏宽度会反过来让
 * 记分板折行（2048 那条教训）。
 */
/**
 * 生死态势图的高度。
 *
 * 曾经压到 48（「侧栏纵向空间稀缺」），后来 ① 并到 ③ 右边腾出了整张卡的高度，
 * 用户随即要求**恢复成两倍**（2026-09-21）—— 这一相本来就该看清楚「谁在推、
 * 谁在退」，压扁了那条折线就只剩一个趋势。
 */
const MOM_H = 96;

/**
 * 置信度图的兜底高度。
 *
 * 正常路径下它**不生效**：那一格与热力图并排，两者取同样高（见 `fitCharts`）。
 * 留一个数是给「布局还没量出来（clientWidth 为 0）」的头几帧用的。
 */
const CONF_H = 132;

/** 热力图边长上限。16×16 时它是 16 格的网格，边长太小会糊成一片 */
const HEAT_MAX = 132;

function fitCharts(): void {
  const momBox = $("momentumBox");
  momentum.resize(Math.max(0, momBox.clientWidth - 16), MOM_H);

  // ③ 与棋盘同形：正方形，边长取「容器宽」与「高度上限」的较小者。
  // 它与 ① 并排，所以容器宽只是侧栏的一半 —— 「削宽度」换来的高度给了文本
  const heatBox = $("heatBox");
  const side = Math.min(Math.max(0, heatBox.clientWidth - 2), HEAT_MAX);
  heat.resize(side, side);

  // ★ ① 与 ③ **等高**，且宽度铺满自己那一栏：它们并排在同一行里，高度不一致
  // 会读成「没对齐」，而 ① 挪到这里来本来就是为了换高度、不是换宽度。
  //
  // 不减内边距：`.confbox` 没有 padding（它不是一张卡，见 index.html 的注释），
  // 横向边距与间距全部由 `.decrow` 的 gap 给 —— 与热力图那一栏对齐
  const confBox = $("chartBox");
  chart.resize(Math.max(0, confBox.clientWidth), side > 0 ? side : CONF_H);
}

new ResizeObserver(() => {
  fitBoard();
  fitCharts();
}).observe(document.body);
window.addEventListener("orientationchange", () =>
  setTimeout(() => {
    fitBoard();
    fitCharts();
  }, 140),
);

/* ═══════════ 置信度图的数据 ═══════════ */

/**
 * ①②③ 的分工（别混）：① 是**模型的**时间序列，② 是**游戏的**时间序列，
 * ③ 是**当回合**的空间分布。
 */
function chartSeries(): ChartSeries[] {
  const out: ChartSeries[] = [];
  for (const role of ROLE_ORDER) {
    const meta = ROLE_META[role];
    const points: ChartPoint[] = [];
    for (const row of state.logs) {
      if (row.failed) continue; // 失败的回合没有分布，画上去会在图上砸出一个 0 的坑
      const rl = row[role];
      if (!rl || rl.error) continue;
      points.push({ top: rl.top, bottom: rl.bottom, median: rl.median });
    }
    out.push({
      stroke: meta.color,
      fillFrom: meta.band,
      fillTo: meta.faint,
      points: points.slice(-MAX_CHART_POINTS),
    });
  }
  return out;
}

/**
 * ② 的数据：活细胞占比的序列。
 *
 * 索引 0 = 开局，索引 i = 第 i 回合演化之后。`ratioHistory` 里存的是**每一回合
 * 开始时**的占比，所以「历史 + 当前局面」拼起来正好是这条序列 —— 与
 * `classifyTermination` 用的是同一条（它也是这么拼的）。图上的越界计数因此与
 * 判负用的防抖计数是同一个数，不会出现「图上连续 3 轮越界、却还没判胜」。
 */
function momentumInput(): MomentumInput {
  return {
    ratios: [...state.ratioHistory, ratioOf(aliveCount(state.board))],
    rules: currentRules(),
  };
}

/**
 * 卡片二（**模型**）的两张图：③ 当回合的分布 + ① 它的历史。
 *
 * 它们跟着**决策**落地（回包一到就画）—— 那一手是模型刚给出的，画上去就是
 * 「此刻的读数」，没有「还没发生」的问题。
 */
function refreshModelCharts(): void {
  chart.setData(chartSeries());
  // ★ 热力图要按**决策当时**那副棋盘取值，不能按 `state.board`。
  //
  // 概率是逐格查出来的：「这一格属于谁的候选集」由那时棋盘上这一格的生死决定
  // （死格是生之执的候选、活格是死之执的候选）。拿**演化之后**的棋盘去查，
  // 这一手翻过、或被演化改写过的那一片格子角色就反了 —— 查的是另一张表，
  // 取回来一片 0。而「每一格都有值、没有空隙」正是这张图的规格。
  const basis = state.probsBoard ?? state.board;
  if (state.probs.life || state.probs.death) heat.setData(buildHeat(basis, state.probs));
  else heat.clear();
}

/**
 * 卡片一（**游戏**）的那张图：② 生死态势 = 计分板的时间序列。
 *
 * ★ 它与记分板同处一卡、说的是同一件事的两个视角，所以**跟同一个时刻走**：
 * 本回合那个点要等**演化落地**才画。在回包一到就画的话，画面还在落子相，
 * 曲线已经把这一回合的结局报出来了 —— 与记分板的旧毛病是同一处。
 *
 * （序列本身是「整段重算」而不是「追加一个点」，所以即使某一帧因为动画被打断
 * 而没画成，下一帧也会把该有的点补齐。）
 */
function refreshMomentumChart(): void {
  momentum.setData(momentumInput());
}

/** 三张图一起刷新。**没有动画**的路径用（恢复存档、失败回合）—— 那时不存在
 *  「哪一刻」的问题，一次画完 */
function refreshCharts(): void {
  refreshModelCharts();
  refreshMomentumChart();
}

/* ═══════════ 决策面板 ═══════════ */

/**
 * 本回合的决策读数。
 *
 * ═══ 两处「不显示」是刻意的（用户 2026-09-21 定）═══
 *
 *   1. **不显示「概率前 5」** —— 那 5 个数在旁边的热力图上一眼就能看出个大概，
 *      而它们占了整整一行，把真正要读的文本挤下去了
 *   2. **不显示「取概率最高的那一格」** —— 那是 `greedy` 策略的**定义**
 *      （`reason.takeTop`），写在「策略」抽屉里；每一回合都重复一遍等于没说话。
 *      其余几种原因（coerced / belowThreshold / sampled）**照旧显示**：
 *      那些说的是「这一手和默认不一样」，正是需要被看见的
 *
 * ═══ 分两栏 ═══
 *
 * 左 = 生之执、右 = 死之执（顺序即 `ROLE_ORDER`）。单人模式只有一条读数，
 * 那时不加 `two`，它独占整行 —— 半栏里挤一条独苗会让人以为另一边没跑成。
 */
function renderDecision(): void {
  const host = $("decision");
  $("dTurn").textContent = state.turn ? `#${state.turn}` : "";

  if (!state.shown) {
    host.className = "prows";
    host.innerHTML = `<div class="idle">${escapeHtml(t(state.shownIdleKey, state.shownIdleParams))}</div>`;
    return;
  }

  const two = state.shown.length > 1;
  host.className = two ? "prows two" : "prows";
  host.innerHTML = state.shown
    .map((d) => {
      const flags: string[] = [];
      if (d.coerced) flags.push(`<span class="flag">coerced</span>`);
      if (d.belowThreshold) flags.push(`<span class="flag">below</span>`);
      // 「取概率最高的那一格」是 greedy 的定义，不在这里复述
      const note =
        d.reasonKey === "reason.takeTop"
          ? ""
          : `<div class="pnote">${escapeHtml(t(d.reasonKey, d.reasonParams))}</div>`;
      return `<div class="pcol"><div class="prow" style="--rc:${ROLE_META[d.role].color}">
        <div class="phead">
          <span class="pwho">${escapeHtml(roleLabel(d.role))}</span>
          <span class="pcell">${t("decision.flip", { row: rowOf(d.cell), col: colOf(d.cell) })}</span>
          <span class="pp">${t("log.p")}=${d.prob.toFixed(3)}</span>
          ${flags.join("")}
        </div>
        ${note}
      </div></div>`;
    })
    .join("");
}

const rowOf = (cell: Cell): number => Math.floor(cell / state.board.cols);
const colOf = (cell: Cell): number => cell % state.board.cols;

function showIdleDecision(key: string, params?: Record<string, string | number>): void {
  state.shown = null;
  state.shownIdleKey = key;
  state.shownIdleParams = params;
  renderDecision();
}

/* ═══════════ 覆盖层 ═══════════ */

interface OvBtn {
  label: string;
  fn: () => void;
  primary?: boolean;
}

function showOverlay(title: string, msg: string, isErr: boolean, buttons: OvBtn[]): void {
  let ov = document.getElementById("overlay");
  if (!ov) {
    ov = document.createElement("div");
    ov.id = "overlay";
    ov.className = "overlay";
    boardCanvas.parentElement?.appendChild(ov);
  }
  const safe = msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  ov.innerHTML = `<h2>${escapeHtml(title)}</h2><p class="${isErr ? "err" : ""}">${safe}</p>`;
  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;justify-content:center";
  for (const b of buttons) {
    const el = document.createElement("button");
    el.textContent = b.label;
    if (b.primary) el.className = "primary";
    el.onclick = b.fn;
    bar.appendChild(el);
  }
  ov.appendChild(bar);
  ov.classList.add("show");
}

function hideOverlay(): void {
  document.getElementById("overlay")?.classList.remove("show");
}

/* ═══════════ 决策循环 ═══════════ */

interface RoleAttempt {
  readonly role: Role;
  readonly settings: RoleSettings;
  readonly channel: Channel;
  readonly request: DecisionRequest;
}

interface RoleOutcome {
  readonly ok: boolean;
  readonly result: DecisionResult | null;
  readonly probs: CellProbabilities | null;
  readonly cell: Cell | null;
  readonly reasonKey: string;
  readonly reasonParams?: Record<string, string | number>;
  readonly coerced: boolean;
  readonly belowThreshold: boolean;
  readonly error: string;
  /** 上游报的额度 / 鉴权问题 —— 它要的是「换后端」而不是「重试」 */
  readonly quotaExhausted: boolean;
  /**
   * 这条后端在当前部署下**根本走不通**（静态托管 + 未配远端地址）。
   *
   * 与 `quotaExhausted` 分开：那一条是「上游说不行」，这一条是「连请求都没发出去」。
   * 把它并进「调用失败」会让用户去点重试，而重试永远不会成功 ——
   * 这与配额那条是同一个理由：**用户能采取的行动不同，提示就该不同**。
   */
  readonly unreachable: boolean;
}

/** 本回合双方各自的一条决策读数，供日志与决策面板共用 */
type DecisionRow = ShownDecision;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 一次角色调用：发请求 → 解析回包 → 决策。**三步在同一个 try 里**。
 *
 * 这样写不是图省事：`parseAnswers` 对不上题面时会抛错（缺题、多题、概率缺失），
 * 而它与网络错误在用户看来是同一件事 —— 「这一回合没跑成」。把两者分开处理
 * 会多出一条只有协议错误才走的分支，那条分支没人会去测。
 */
async function evaluateRole(attempt: RoleAttempt): Promise<RoleOutcome> {
  const { role, settings } = attempt;
  const failed = (e: unknown, unreachable = false): RoleOutcome => {
    const err = e as Error & { quotaExhausted?: boolean };
    return {
      ok: false,
      result: null,
      probs: null,
      cell: null,
      reasonKey: "",
      coerced: false,
      belowThreshold: false,
      error: err.message,
      quotaExhausted: e instanceof JevError ? e.quotaExhausted : err.quotaExhausted === true,
      unreachable,
    };
  };

  // 地址解析不出来 = 这条后端在这个部署形态下根本不存在（静态托管 + 未配远端地址）。
  // **在出发之前就失败**：真发出去只会得到一个 404，而 404 与「后端挂了」在界面上
  // 长得一模一样，用户会去点重试。
  const backend = createBackend(clientConfigOf(role), {
    retry: retryPolicy(),
    // ★ 构造时就要知道「这一次怎么谈」：`DecisionBackend.kind` 是**构造期定死**的
    // （统计要按「后端 × 模型 × 调用配置」分组，而 JSON 输出与工具循环是两个
    // 不同的东西）。请求上也带着同一份，那条路走 `req.llm ?? opts.llm` ——
    // 这里传只是为了让 `kind` 说实话。漏传的症状是工具循环的调用被记进 JSON 那一栏，
    // 而两栏混在一起算出来的平均值谁也不代表
    ...(() => {
      const llm = llmCallOf(role);
      return llm === undefined ? {} : { llm };
    })(),
    hooks: {
      onRetry: (n, _err, delay) => setLed("busy", "status.retrying", { n, s: (delay / 1000).toFixed(1) }),
    },
  });
  if (!backend) {
    return failed(
      new Error(
        t("err.backendUnreachable", {
          role: roleLabel(role),
          label: t(BACKENDS[settings.provider].labelKey),
        }),
      ),
      true,
    );
  }

  try {
    const res = await backend.evaluate(attempt.request);

    const probs = parseAnswers(attempt.channel, res.answers, state.board, role);
    const r = resolveDecision(probs, state.board, role, settings.strategy, settings.threshold);
    return {
      ok: true,
      result: res,
      probs,
      cell: r.cell,
      reasonKey: r.reasonKey,
      reasonParams: r.reasonParams,
      coerced: r.coerced,
      belowThreshold: r.belowThreshold,
      error: "",
      quotaExhausted: false,
      unreachable: false,
    };
  } catch (e) {
    console.error(e);
    return failed(e);
  }
}

/** 本回合开打之前先问一次终局 —— 上一回合结束时可能已经把棋走完了 */
function currentVerdict(): Termination | null {
  return classifyTermination(
    {
      board: state.board,
      mode: store.duel.mode,
      topology: store.duel.topology,
      turn: state.turn,
      ratioHistory: state.ratioHistory,
    },
    currentRules(),
    state.seen,
  );
}

async function doTurn(): Promise<void> {
  if (state.busy || state.finished) return;

  const verdict = currentVerdict();
  if (verdict) {
    endGame(verdict);
    return;
  }

  state.busy = true;
  const turnStart = performance.now();
  const at = new Date().toISOString();
  const topology = store.duel.topology;
  const mode = store.duel.mode;
  const solo = mode === "solo";
  const rules = currentRules();
  const board = state.board;
  setLed("busy", modeUi(mode).calling);

  /* ── 双方**同时**决策，都基于演化前的棋盘（见文件头）──
     单人模式只有生之执一方，所以这里只有一个 attempt —— 后面所有按下标取
     `outcomes[1]` 的地方都必须跟着分叉（漏一处的症状是恢复出一手不存在的棋）。 */

  // ⚠ 刻意写成 filter 而不是三元 + 一个只含 life 的字面量数组：方括号包裹的
  // 字符串字面量会被 `tools/check-dom.ts` 当成 DOM id 清单（它扫的是全文，
  // **注释也算**），于是报出一个并不存在的 `#life`。与 `ROLE_ORDER` 那里记的
  // 是同一个坑，只是换了个方向
  const actors: readonly Role[] = ROLE_ORDER.filter((r) => r === "life" || !solo);

  const attempts: RoleAttempt[] = actors.map((role) => {
    const settings = store.roles[role];
    const input: StateInput = {
      board,
      role,
      mode,
      topology,
      rules,
      turn: state.turn,
      scores: { life: state.scores.life, death: state.scores.death },
      history: state.history,
      context: roleContextOf(settings),
      // 规则说明书正文由这个玩家自己的模板渲染。**逐项兜底**在这里再做一次：
      // 导入存档那条路径不经过 `readRole`（见 `templatesOf` 的注释）
      templates: templatesOf(settings.templates),
    };
    const channel = channelOf(settings);
    return {
      role,
      settings,
      channel,
      request: {
        model: settings.model,
        state: buildState(input),
        questions: buildQuestions(channel, input) as Questions,
        // 非 LLM 后端这里整个字段不出现（见 llmCallOf）
        ...(() => {
          const llm = llmCallOf(role);
          return llm === undefined ? {} : { llm };
        })(),
      },
    };
  });

  const t0 = performance.now();
  const outcomes = await Promise.all(attempts.map((a) => evaluateRole(a)));
  const latencyMs = performance.now() - t0;

  /* ── 失败就是失败 ──
     不拿旧分布顶替、不静默跳过。「把一次失败的调用当成模型答不出来」正是
     本项目踩过的坑（免费额度 429 被探针统计成了模型不行）。 */

  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length > 0) {
    state.busy = false;
    const first = failed[0];
    const quota = outcomes.some((o) => o.quotaExhausted);
    const unreachable = outcomes.some((o) => o.unreachable);

    pushLog({
      turn: state.turn + 1,
      at,
      life: roleLogOf(attempts[0], outcomes[0], latencyMs),
      death: solo ? null : roleLogOf(attempts[1], outcomes[1], latencyMs),
      aliveBefore: aliveCount(board),
      aliveAfter: aliveCount(board),
      netGrowth: 0,
      failed: true,
    });

    if (unreachable) {
      // 配置问题，不是故障：重试没有意义，所以这一条路径**不给重试按钮**
      setLed("err", "status.backendUnreachable");
      showOverlay(t("over.backendTitle"), first.error, true, [
        {
          label: t("over.goApi"),
          fn: () => {
            hideOverlay();
            syncApiUi();
            openDrawer("dApi");
          },
          primary: true,
        },
        {
          // 「暂停」而不是「跳过这一回合」：跳过意味着下一回合还会再试一次，
          // 而配置问题不会自己好 —— 那个标签会把人引向一个必然再次失败的按钮
          label: t("over.halt"),
          fn: () => {
            hideOverlay();
            state.running = false;
            syncRunButton();
            setLed("", "status.paused");
          },
        },
      ]);
      return;
    }

    if (quota) {
      setLed("err", "status.quota");
      showQuotaModal(first.error);
    } else {
      setLed("err", "status.apiFail");
    }

    showOverlay(
      t("over.apiFail"),
      store.api.retryMax === null
        ? t("over.failBodyInf", { msg: first.error })
        : t("over.failBody", { msg: first.error, n: store.api.retryMax }),
      true,
      [
        {
          label: t("over.retry"),
          fn: () => {
            hideOverlay();
            void doTurn();
          },
          primary: true,
        },
        {
          label: t("over.skip"),
          fn: () => {
            hideOverlay();
            state.running = false;
            syncRunButton();
            setLed("", "status.paused");
          },
        },
      ],
    );
    return;
  }

  /* ── 两边的读数。决策面板与日志共用同一份，避免两处各算一遍 ── */

  const decisions: DecisionRow[] = attempts.map((a, i) => {
    const o = outcomes[i];
    const probs = o.probs ?? new Map<Cell, number>();
    const cell = o.cell ?? 0;
    return {
      role: a.role,
      cell,
      prob: probs.get(cell) ?? 0,
      reasonKey: o.reasonKey,
      reasonParams: o.reasonParams,
      coerced: o.coerced,
      belowThreshold: o.belowThreshold,
    };
  });

  const cellOf = (role: Role): Cell => {
    const row = decisions.find((d) => d.role === role);
    if (!row) throw new Error(`内部错误：没有 ${role} 的决策`);
    return row.cell;
  };

  const lifeFlip = cellOf("life");
  // ★ 单人模式**不查死之执的落点**：`cellOf("death")` 会当场抛「没有 death
  // 的决策」—— 那是对的，因为死之执压根没有 requests。所以要显式分叉，
  // 而不是给一个默认格号（默认值会变成一个不存在的落点，一路流进历史与动画）
  const deathFlip = solo ? null : cellOf("death");

  /* ── 落子 + 演化一代 ──
     先把**本回合开始时**的占比记进历史：classifyTermination 的序列是
     [...ratioHistory, 当前占比]，把当前局面也塞进历史会让同一代被数两次 */

  const before = aliveCount(board);
  state.ratioHistory.push(ratioOf(before));

  // 引擎是纯函数：flip 返回新棋盘，不会改动传进去的那个。
  // 中间那副（落完子、还没演化）要留下来 —— 棋盘动画的两相就是按它切的：
  // 落子相画「谁翻了哪一格」，演化相画「翻完之后长成什么样」
  const mid = deathFlip === null ? flip(board, lifeFlip) : flip(flip(board, lifeFlip), deathFlip);
  const next = lifeStep(mid, topology);
  const after = aliveCount(next);
  const netGrowth = after - before;

  // 双人模式下两边记的是**同一个**净增长：它是「棋盘涨了多少」这个客观量，
  // 不是某一方的得分。生之执要它大、死之执要它小，所以两边看同一个数。
  //
  // ★ 单人模式**只记生之执那一栏**：死之执不在场，给它记一个数会让这个数
  // 一路进到发给模型的 `scores` 里 —— 一个凭空长出来的「死之执战绩」
  state.scores = {
    life: state.scores.life + netGrowth,
    death: solo ? 0 : state.scores.death + netGrowth,
  };

  state.history.push({
    turn: state.turn,
    board: next,
    lifeFlip,
    // 单人模式下这一栏**整个不出现**（TurnRecord.deathFlip 可选）
    ...(deathFlip === null ? {} : { deathFlip }),
    aliveCount: after,
    netGrowth,
  });
  // 长局时把历史截断到滑块上限。截的是**同一份**队列：它同时是「喂给模型的
  // 记忆」与「存档里的历史」，两份分开会得到「界面上有 40 回合、模型只看到
  // 最近 20 回合」这种谁也说不清的差异。界面上的全程由日志抽屉承担（那条
  // 队列不截断，只按 LOG_PAGE_SIZE 分页渲染）。
  if (state.history.length > MAX_MEMORY) state.history.shift();

  state.board = next;
  state.turn++;
  state.seen.add(boardKey(state.board));

  /* ── 这一回合的两帧读数 ──
     极值（A.MAX / A.MIN）**一次算到演化后**：它是这一局存下来的数，漏掉
     最后一刻的峰值会让终局统计偏低，而那个数没有第二次机会补。
     显示则分两帧给（见 `score.ts` 文件头）—— 存的是整局的极值，
     屏幕上是此刻的那一副。 */
  const views = turnScoreViews({
    mid,
    after: next,
    turn: state.turn,
    maxBefore: state.aliveMax,
    minBefore: state.aliveMin,
  });
  state.aliveMax = views.evolve.max;
  state.aliveMin = views.evolve.min;

  /* ── 把这一回合交给棋盘动画 ──
     两段动画（落子 → 演化）的时间线由渲染器自己排，这里只说「翻了哪两格」。
     粒子也跟着落子走，在渲染器内部生成 —— 撒在哪里是画面的事。

     ★ 记分板挂在**各段落地的那一刻**上（`onPhase`），而不是在这之后立刻刷：
     方块真正变的是那两刻，数字要跟它们同步。态势图（②）同理 —— 它与记分板
     同处一卡、说的都是「游戏本身的客观状态」，本回合那个点要等演化落地才画。 */
  renderer.playTurn(
    {
      mid,
      after: next,
      flips:
        deathFlip === null
          ? [{ cell: lifeFlip, role: "life" }]
          : [
              { cell: lifeFlip, role: "life" },
              { cell: deathFlip, role: "death" },
            ],
    },
    (phase) => {
      renderScore(phase === "flip" ? views.flip : views.evolve);
      if (phase === "evolve") refreshMomentumChart();
    },
  );

  /* ── 本回合的分布，供热力图（③）用 ──
     连同「它是按哪副棋盘算出来的」一起记下来。**这里是 `board`（本回合开始时
     那一副），不是 `state.board`（已经演化过了）** —— 热力图逐格查表，
     基准错一副棋盘就会整片取到 0。 */

  state.probs = { life: null, death: null };
  state.probsBoard = board;
  for (let i = 0; i < attempts.length; i++) state.probs[attempts[i].role] = outcomes[i].probs;

  /* ── 记账 ── */

  for (const o of outcomes) {
    const res = o.result;
    if (!res) continue;
    state.costTotal += res.costUsd ?? 0;
    if (res.costUsd === null) state.costUnknown = true;
  }
  updateCostUi();

  const lastLat = Math.max(...outcomes.map((o) => o.result?.latencyMs ?? 0));
  $("lat").textContent = `${Math.round(lastLat)}ms`;

  state.shown = decisions;
  renderDecision();
  // ⚠ 记分板**不在这里**更新 —— 它挂在 `playTurn` 的 `onPhase` 上。
  // 这里刷的话，数字会跑到落子/演化两段动画之前（正是这一处原来的毛病）

  pushLog({
    turn: state.turn,
    at,
    life: roleLogOf(attempts[0], outcomes[0], latencyMs),
    death: solo ? null : roleLogOf(attempts[1], outcomes[1], latencyMs),
    aliveBefore: before,
    aliveAfter: after,
    netGrowth,
    failed: false,
  });

  setLed("on", "status.online");
  state.busy = false;

  /* ── 本回合结束之后再问一次终局 ──
     这样「单步」也能立刻看到终局，而不必再点一次（play.ts 是在循环顶部问的，
     那是 CLI 的做法 —— 命令行多跑一轮的代价是零） */
  const verdictAfter = currentVerdict();
  if (verdictAfter) {
    endGame(verdictAfter);
    return;
  }

  if (state.running) {
    const rest = store.duel.paceMs - (performance.now() - turnStart);
    if (rest > 0) await wait(rest);
    if (state.running) void doTurn();
  } else {
    setLed("", "status.paused");
  }
}

/** 一个角色的读数 → 日志行 */
function roleLogOf(
  attempt: RoleAttempt,
  outcome: RoleOutcome,
  fallbackLatency: number,
): RoleLog {
  const values = outcome.probs ? [...outcome.probs.values()] : [];
  const res = outcome.result;
  return {
    role: attempt.role,
    cell: outcome.cell,
    row: outcome.cell === null ? -1 : rowOf(outcome.cell),
    col: outcome.cell === null ? -1 : colOf(outcome.cell),
    reasonKey: outcome.reasonKey,
    reasonParams: outcome.reasonParams,
    coerced: outcome.coerced,
    belowThreshold: outcome.belowThreshold,
    prob: outcome.cell === null || !outcome.probs ? 0 : (outcome.probs.get(outcome.cell) ?? 0),
    top: values.length ? Math.max(...values) : 0,
    bottom: values.length ? Math.min(...values) : 0,
    median: median(values),
    // 拿不到真实延迟时用本回合的墙钟顶替，并**在数值上如实反映**：
    // 0 会被读成「瞬间返回」，那是假话
    latencyMs: res ? res.latencyMs : Math.round(fallbackLatency),
    upstreamCalls: res?.upstreamCalls ?? 0,
    inputTokens: res?.usage?.inputTokens ?? 0,
    outputTokens: res?.usage?.outputTokens ?? 0,
    reasoningTokens: res?.usage?.reasoningTokens ?? 0,
    costUsd: res?.costUsd ?? null,
    request: attempt.request,
    response: res?.raw ?? null,
    // ★ 这一手用的六份模板**原文**。
    //
    // 渲染结果已经躺在 `request.state.rules` 里了，再存一份输入不是冗余：
    // 改了模板之后要对照的是「当时用的是哪一版措辞」，而渲染结果只告诉你
    // 那一版**长什么样** —— 它没法把模板改回去重放。规格里管这个叫
    // contextSnapshot，这里就用这个名字。
    contextSnapshot: templatesOf(attempt.settings.templates),
    ...(outcome.ok ? {} : { error: outcome.error }),
  };
}

function pushLog(row: TurnLog): void {
  state.logs.push(row);
  if (state.logs.length > MAX_LOGS) state.logs.shift();
  // 只刷卡片二（模型）：日志是**决策**的产物，而卡片一（记分板与态势图）
  // 跟着棋盘走 —— 成功那一回合由 `playTurn` 的 `onPhase` 在演化落地时刷。
  //
  // 失败那一回合没有动画（棋盘没动），卡片一本来就没有新东西要画。
  refreshModelCharts();
  renderLog();
  persist();
}

/* ═══════════ 终局 ═══════════ */

function reasonText(v: Termination, rules: GameRules): string {
  switch (v.reason) {
    case "lifeWinRatio":
      return t("term.lifeWinRatio", { n: rules.lifeStreak, ratio: pct(rules.lifeWinRatio) });
    case "deathWinRatio":
      return t("term.deathWinRatio", { n: rules.deathStreak, ratio: pct(rules.deathWinRatio) });
    // ★ 单人专有：同一个占比，在单人局里的含义是「局面自己死绝了」而不是
    // 「对手把棋盘压死了」—— 而这里没有对手。措辞照实写
    case "soloDiedOut":
      return t("term.soloDiedOut", { n: rules.deathStreak, ratio: pct(rules.deathWinRatio) });
    case "noLegalCell":
      return v.winner === "life" ? t("term.noLegalCellLife") : t("term.noLegalCellDeath");
    case "repeatBlocked":
      return t("term.repeatBlocked");
    case "turnLimit":
      // 不设上限（null）时这条分支根本到不了 —— `?? "∞"` 只是给类型一个落点
      return t("term.turnLimit", { n: rules.turnLimit ?? "∞" });
  }
}

/** 终局模态。**关掉之后必须能重新打开** —— 见 `bResult` */
function renderResult(): void {
  const v = state.termination;
  if (!v) return;
  const rules = currentRules();
  const alive = aliveCount(state.board);
  const body = [
    `${t("over.reason")}：${reasonText(v, rules)}`,
    `${t("over.winner")}：${v.winner ? roleLabel(v.winner) : t("over.draw")}`,
    t("over.stats", {
      turn: state.turn,
      alive,
      ratio: pct(ratioOf(alive)),
      max: state.aliveMax,
      min: state.aliveMin,
    }),
    // 单人模式没有「双方」可言，那一行改成只有一条线
    store.duel.mode === "solo"
      ? t("over.ratioLineSolo", {
          life: pct(rules.lifeWinRatio),
          death: pct(rules.deathWinRatio),
        })
      : t("over.ratioLine", {
          life: pct(rules.lifeWinRatio),
          death: pct(rules.deathWinRatio),
        }),
  ].join("\n");

  showOverlay(t("over.gameOver"), body, false, [
    {
      label: t("over.again"),
      fn: () => {
        hideOverlay();
        newGame();
      },
      primary: true,
    },
    { label: t("over.close"), fn: hideOverlay },
  ]);
}

function endGame(v: Termination): void {
  state.running = false;
  state.finished = true;
  state.termination = v;
  syncRunButton();
  // 结束后立即落盘并标记 finished —— 刷新页面不该「续玩」一局已经结束的棋
  saveSessionNow(sessionInput(true));
  $<HTMLButtonElement>("bResult").disabled = false;
  setLed("", "over.gameOver");
  renderResult();
}

/* ═══════════ 控制 ═══════════ */

/**
 * 主按钮的三态。
 *
 * 「还没开始」与「暂停在中途」是**两件事**，用同一个「开始对弈」去标会让人
 * 以为点下去要把当前这一局从头再来（尤其在一局已经走了几十手、或者刚恢复
 * 完一份存档的时候）。判据是 `state.turn`：走出过回合，这一局就不再是新的了。
 *
 * 运行中显示的是**状态**（已开始）而不是动作（暂停）—— 这是刻意的：暂停这个
 * 动作由 title 与高亮边框交代，而「现在到底在不在跑」是这一屏最需要一眼看到的事。
 */
function syncRunButton(): void {
  const b = $<HTMLButtonElement>("bToggle");
  if (state.running) {
    b.textContent = t("ctrl.started");
    b.title = t("ctrl.startedTitle");
    b.classList.remove("primary");
    b.classList.add("running");
  } else {
    const started = state.turn > 0;
    b.textContent = t(started ? "ctrl.resume" : "ctrl.takeover");
    // 单人局的提示不能说「双方 AI」—— 那里只有一个 AI（见 mode.ts 那张表）
    b.title = started ? t("ctrl.resumeTitle") : t(modeUi(store.duel.mode).takeoverTitle);
    b.classList.remove("running");
    b.classList.add("primary");
  }
  b.disabled = state.finished;
  syncDrawUi();
}

/**
 * 现在允许手绘开局吗。
 *
 * 三个条件缺一不可：没结束、没开始过、还没走出过回合。
 *
 * ★ 这是**对局前**的布置，不是对局中的干预 —— 「v1 不做人手动落子」说的是
 * 后者，两者语义完全不同（ui-spec 第五节）。所以判据是「这一局开始了没有」，
 * 而不是「现在轮到谁」。
 *
 * `started` 与 `turn` 分开判不是冗余：第一回合可能因为上游报错而失败，
 * 那时 `turn` 仍是 0，但这一局已经开始了。
 */
const canDraw = (): boolean => !state.finished && !state.started && state.turn === 0;

/** 手绘与「清空棋盘」共用的可用性刷新 */
function syncDrawUi(): void {
  const on = canDraw();
  $("drawHint").style.display = on ? "" : "none";
  $<HTMLButtonElement>("bClearBoard").disabled = !on;
}

/**
 * 画一格。
 *
 * 走的是 `renderer.toggle()` 而**不是** `playTurn()`：开局前还没有行动方，
 * 所以只有缩放，既不撒粒子也不出发光选框 —— 那两个是「某个角色落子」的
 * 视觉标记，借过来会让人以为那是某一方下的子。两个入口分开是刻意的
 * （见 `render.ts` 里 `toggle` 的注释）。
 */
function drawCell(cell: Cell): void {
  state.board = flip(state.board, cell);
  renderer.toggle(state.board, cell);
  markCustomOpening();

  const n = aliveCount(state.board);
  state.aliveMax = Math.max(state.aliveMax, n);
  state.aliveMin = Math.min(state.aliveMin, n);

  updateStats();
  persist();
}

/** 清空棋盘 —— 画错了不必一格一格点回去 */
function clearBoard(): void {
  if (!canDraw()) return;
  state.board = createBoard(store.duel.cols, store.duel.rows);
  state.aliveMax = 0;
  state.aliveMin = 0;
  // 走的也是「自定义」那条路径：清空之后**不留**任何预设名
  markCustomOpening();
  renderer.setBoard(state.board);
  updateStats();
  persist();
  setLed("", "status.ready");
}

function start(): void {
  if (state.running || state.finished) return;
  state.started = true;
  state.running = true;
  syncRunButton();
  hideOverlay();
  void doTurn();
}

function pause(): void {
  state.running = false;
  syncRunButton();
  setLed("", "status.paused");
}

function toggleRun(): void {
  state.running ? pause() : start();
}

function sessionInput(finished: boolean): SessionInput {
  return {
    cols: state.board.cols,
    rows: state.board.rows,
    mode: store.duel.mode,
    topology: store.duel.topology,
    rules: currentRules(),
    openingId: store.duel.openingId,
    board: toRows(state.board),
    turn: state.turn,
    ratioHistory: state.ratioHistory,
    seen: [...state.seen],
    history: state.history.map(serializeTurn),
    scores: state.scores,
    aliveMax: state.aliveMax,
    aliveMin: state.aliveMin,
    logs: state.logs,
    finished,
  };
}

/** 把当前对局写进 localStorage。每回合结束后调用（内部防抖） */
function persist(): void {
  saveSession(sessionInput(false));
}

function newGame(): void {
  const d = store.duel;
  const opening = openingOf();

  // 没有开局 = 自定义：从空棋盘起步，等用户自己画（界面上的「清空棋盘」
  // 与开局列表里的「自定义」走的是同一条路径）
  state.board = opening ? boardFromRows(opening.build(d.cols, d.rows)) : createBoard(d.cols, d.rows);
  state.turn = 0;
  state.running = false;
  state.started = false;
  state.busy = false;
  state.finished = false;
  state.termination = null;
  state.history = [];
  state.ratioHistory = [];
  state.seen = new Set([boardKey(state.board)]);
  state.logs = [];
  state.scores = { life: 0, death: 0 };

  const alive = aliveCount(state.board);
  state.aliveMax = alive;
  state.aliveMin = alive;
  state.costTotal = 0;
  state.costUnknown = false;
  state.probs = { life: null, death: null };
  state.probsBoard = null;

  // 棋盘直接落到开局（不走动画）：新局的第一帧应当是「初始局面」本身，
  // 而不是一堆方块从零长出来的过程
  renderer.setBoard(state.board);
  // 三张图都回到「等待数据」——上一局的曲线留在屏幕上会与这一局混起来
  chart.clear();
  momentum.clear();
  heat.clear();
  showIdleDecision("decision.idle");
  renderLog();
  updateStats();
  updateCostUi();
  $("lat").textContent = "—";
  hideOverlay();
  $<HTMLButtonElement>("bResult").disabled = true;
  syncRunButton();
  setLed("", "status.ready");
  saveSessionNow(sessionInput(false));
  fitBoard();
  fitCharts();
}

/** 把一份存档应用到界面上 */
function applySession(s: Session): void {
  state.board = boardFromRows(s.board);
  state.turn = s.turn;
  state.ratioHistory = [...s.ratioHistory];
  state.seen = new Set(s.seen);
  state.history = s.history
    .map((h) => deserializeTurn(h, s.cols))
    .filter((h): h is TurnRecordLike => h !== null);
  state.logs = s.logs;
  state.scores = { life: s.scores.life, death: s.scores.death };
  state.aliveMax = s.aliveMax || aliveCount(state.board);
  state.aliveMin = s.aliveMin || aliveCount(state.board);
  state.finished = false;
  state.termination = null;
  // 恢复出来的这一局「开始过了」。手绘的判据因此落到 `turn === 0` 上：
  // 一份第 0 回合的存档（刚重开、或画到一半就刷新）仍然可以接着画，
  // 而走出过回合的那一局无论如何都锁着
  state.started = false;
  // 恢复出来的那一局不能自动跑起来 —— 刷新之后先让人看一眼再说
  state.running = false;
  state.busy = false;
  // 分布不进存档（见 AppState.probs），所以热力图恢复不出来，只能回到「等待」。
  // 另外两张图是历史的，照旧画得出来
  state.probs = { life: null, death: null };
  state.probsBoard = null;

  state.costTotal = state.logs.reduce(
    (sum, row) => sum + (row.life?.costUsd ?? 0) + (row.death?.costUsd ?? 0),
    0,
  );
  state.costUnknown = state.logs.some(
    (row) => (row.life && row.life.costUsd === null) || (row.death && row.death.costUsd === null),
  );

  renderer.setBoard(state.board);
  refreshCharts();
  renderLog();
  updateStats();
  updateCostUi();
  const last = state.logs[state.logs.length - 1];
  $("lat").textContent = last ? `${Math.round(Math.max(last.life?.latencyMs ?? 0, last.death?.latencyMs ?? 0))}ms` : "—";
  showIdleDecision("decision.restored", { n: state.turn });
  $<HTMLButtonElement>("bResult").disabled = true;
  syncRunButton();
  fitBoard();
  fitCharts();
}

function restoreSession(): boolean {
  const r = loadSession();

  if (r.status === "none") return false;

  if (r.status === "incompatible") {
    showIncompatibleModal(r.raw, r.reason);
    return false;
  }

  const s = r.session;
  // 尺寸 / 拓扑对不上、或该局已结束 —— 这类是「正常的作废」，不必打扰用户。
  // 尺寸对不上就作废是必须的：开局库按尺寸分级，换尺寸之后那份存档的开局
  // 在新尺寸下根本不存在
  if (
    s.finished ||
    s.cols !== store.duel.cols ||
    s.rows !== store.duel.rows ||
    // 模式对不上就作废：单人局的历史里根本没有死之执的落点，塞进双人局会
    // 得到一段「另一方从没走过棋」的过去，而那看起来与真的一模一样
    s.mode !== store.duel.mode ||
    s.topology !== store.duel.topology
  ) {
    clearSession();
    return false;
  }

  applySession(s);
  setLed("", "salv.restoredShort", { n: s.turn });
  return true;
}

/* ═══════════ 日志面板 ═══════════ */

function fmtJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * 日志条目的稳定标识。
 *
 * 不能只用 turn —— 调用失败后重试会产生同一回合的第二条记录。
 * 用 turn + 时间戳组合，保证每条记录在整个会话内唯一。
 */
const logKey = (r: TurnLog): string => `${r.turn}@${r.at}`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 一个角色的折叠块：摘要行 + 展开后的完整请求 / 回包。
 *
 * 键名用 `data-copy` + `data-role` 两个属性而不是把两者拼进一个字符串里 ——
 * 拼接出来的键要再切一次，而切错时表现是「复制到了另一个角色的请求」，
 * 这种错不会报任何异常。
 */
function roleSummary(rl: RoleLog | null, role: Role): string {
  if (!rl) return "";
  const meta = ROLE_META[role];
  const who = `<i class="lgdot" style="--rc:${meta.color}"></i>${escapeHtml(roleLabel(role))}`;
  if (rl.error) {
    return `<span class="lgr">${who} <b class="err">${escapeHtml(t("log.failed"))}</b></span>`;
  }
  return `<span class="lgr">${who} (${rl.row},${rl.col}) ${rl.prob.toFixed(2)}</span>`;
}

function roleBlock(rl: RoleLog | null, role: Role, key: string): string {
  if (!rl) return "";
  const meta = ROLE_META[role];
  const note = rl.error ? escapeHtml(rl.error) : escapeHtml(t(rl.reasonKey, rl.reasonParams));
  const hasPayload = rl.request !== null;
  return `<div class="lgrole" style="--rc:${meta.color}">
    <div class="lgrow"><span>${escapeHtml(roleLabel(role))}</span><code>${note}</code></div>
    <div class="lgrow"><span>${escapeHtml(t("log.p"))}</span><code>${rl.top.toFixed(3)} / ${rl.median.toFixed(
      3,
    )} / ${rl.bottom.toFixed(3)}</code></div>
    <div class="lgrow"><span>${escapeHtml(t("stats.latency"))}</span><code>${Math.round(
      rl.latencyMs,
    )}ms · ${t("log.calls", { n: rl.upstreamCalls })} · in ${rl.inputTokens} / out ${rl.outputTokens}（reasoning ${
      rl.reasoningTokens
    }）· ${rl.costUsd === null ? escapeHtml(t("log.costUnknown")) : `$${rl.costUsd.toFixed(6)}`}</code></div>
    <div class="lgbtns">
      <button data-copy="req" data-role="${role}" data-k="${escapeHtml(key)}">${escapeHtml(t("log.copyReq"))}</button>
      <button data-copy="res" data-role="${role}" data-k="${escapeHtml(key)}">${escapeHtml(t("log.copyRes"))}</button>
      <button data-copy="both" data-role="${role}" data-k="${escapeHtml(key)}">${escapeHtml(t("log.copyBoth"))}</button>
      ${rl.contextSnapshot ? `<button data-copy="snap" data-role="${role}" data-k="${escapeHtml(key)}">${escapeHtml(t("log.copySnap"))}</button>` : ""}
    </div>
    <div class="lglabel">${escapeHtml(t("log.reqLabel"))}</div>
    ${hasPayload ? `<pre>${escapeHtml(fmtJson(rl.request))}</pre>` : `<div class="lghint">${escapeHtml(t("log.noPayload"))}</div>`}
    <div class="lglabel">${escapeHtml(t("log.resLabel"))}</div>
    ${rl.error ? `<div class="lghint">${escapeHtml(t("log.noResponse"))}</div>` : `<pre>${escapeHtml(fmtJson(rl.response))}</pre>`}
    <!-- ★ 这一手用的六份模板原文。
         渲染出来的规则文本已经在上面的 request 里了 —— 这里存的是它的**输入**，
         因为改了模板之后要对照的正是「当时用的是哪一版措辞」。
         老存档没有这一栏，所以整块可以缺席 -->
    ${rl.contextSnapshot ? `<div class="lglabel">${escapeHtml(t("log.snapLabel"))}</div>
    <pre>${escapeHtml(fmtJson(rl.contextSnapshot))}</pre>` : ""}
  </div>`;
}

/**
 * 重绘日志列表。
 *
 * 这里做了两件「防止画面抖动」的事，缺一不可：
 *
 *   1. **保留展开状态**。新条目到来时如果整表重建，用户正在看的那个展开项会
 *      「啪」地合上。所以先收集哪些 key 是展开的，再把 open 属性直接写进
 *      生成的 HTML —— 而不是渲染完再补设，后者会先画一帧关闭态再展开。
 *   2. **保留滚动位置**。`innerHTML = ...` 会把 scrollTop 归零，
 *      用户往下翻看历史时突然被拽回顶部。
 */
function renderLog(): void {
  const host = $("logList");
  const n = state.logs.length;
  $("logCount").textContent = n ? t("log.turnCount", { n }) : "";

  const openKeys = new Set<string>();
  for (const d of host.querySelectorAll<HTMLDetailsElement>("details[data-key]")) {
    if (d.open) openKeys.add(d.dataset.key ?? "");
  }
  const scrollTop = host.scrollTop;

  if (n === 0) {
    host.innerHTML = `<div class="idle">${escapeHtml(t("log.empty"))}</div>`;
    return;
  }

  const paged = state.logs.slice(-LOG_PAGE_SIZE);

  // 最新的在最上面
  host.innerHTML = paged
    .slice()
    .reverse()
    .map((r) => {
      const key = logKey(r);
      const tm = r.at.slice(11, 19);
      const cls = r.failed ? "lg err" : r.life?.coerced || r.death?.coerced ? "lg warn" : "lg";
      const flips = r.failed
        ? `<span class="lgmove err">${escapeHtml(t("log.failed"))}</span>`
        : `${roleSummary(r.life, "life")}${roleSummary(r.death, "death")}`;
      const growth = r.failed ? "" : `<span class="lggrow">${r.netGrowth >= 0 ? "+" : ""}${r.netGrowth}</span>`;
      const openAttr = openKeys.has(key) ? " open" : "";
      const lat = Math.round(Math.max(r.life?.latencyMs ?? 0, r.death?.latencyMs ?? 0));
      const tok = (r.life?.outputTokens ?? 0) + (r.death?.outputTokens ?? 0);
      return `<details class="${cls}" data-key="${escapeHtml(key)}"${openAttr}>
        <summary>
          <span class="lgturn">#${r.turn}</span>
          ${flips}
          ${growth}
          <span class="lgmeta">${lat}ms · ${tok}tok · ${tm}</span>
        </summary>
        <div class="lgbody">
          ${r.failed ? `<div class="lgrow"><span>${escapeHtml(t("over.reason"))}</span><code>${escapeHtml(
            r.life?.error || r.death?.error || "",
          )}</code></div>` : ""}
          ${roleBlock(r.life, "life", key)}
          ${roleBlock(r.death, "death", key)}
        </div>
      </details>`;
    })
    .join("");

  if (paged.length < n) {
    host.insertAdjacentHTML(
      "beforeend",
      `<div class="lghint">${escapeHtml(t("log.pagedNote", { n: LOG_PAGE_SIZE }))}</div>`,
    );
  }

  host.scrollTop = scrollTop;

  host.querySelectorAll<HTMLButtonElement>("button[data-copy]").forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      const want = btn.dataset.k ?? "";
      const role = ROLE_OF_KEY[btn.dataset.role ?? ""];
      const row = state.logs.find((r) => logKey(r) === want);
      if (!row || !role) return;
      const rl = row[role];
      if (!rl) return;
      const kind = btn.dataset.copy;
      const parts: string[] = [];
      if (kind === "req" || kind === "both") parts.push(fmtJson(rl.request));
      if (kind === "res" || kind === "both") parts.push(fmtJson(rl.response));
      if (kind === "snap") parts.push(fmtJson(rl.contextSnapshot));
      void copyText(parts.join("\n\n"), btn);
    };
  });
}

async function copyText(text: string, btn: HTMLButtonElement): Promise<void> {
  const old = btn.textContent;
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t("toast.copied");
  } catch {
    // 非安全上下文（file:// 或内网 http）没有 clipboard API，退回 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    btn.textContent = ok ? t("toast.copied") : t("toast.copyFail");
  }
  setTimeout(() => {
    btn.textContent = old;
  }, 1200);
}

/* ═══════════ 抽屉 ═══════════ */

const scrim = $("scrim");

function openDrawer(id: string): void {
  for (const d of DRAWERS) $(d).classList.toggle("show", d === id);
  scrim.classList.add("show");
}

function closeDrawers(): void {
  for (const d of DRAWERS) $(d).classList.remove("show");
  scrim.classList.remove("show");
}

/**
 * 给每个抽屉右上角注入一个关闭按钮。
 *
 * 宽屏下抽屉是侧栏，点旁边露出的遮罩即可退出；**窄屏下抽屉占满全宽**，
 * 遮罩被完全盖住、点不到，用户只能翻到抽屉底部去找「完成」——
 * 那不是一条能被发现的退出路径。
 */
function addDrawerCloseButtons(): void {
  for (const el of document.querySelectorAll<HTMLElement>(".drawer")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "drawer-close";
    btn.textContent = "✕";
    btn.dataset.i18nTitle = "ui.close";
    btn.setAttribute("aria-label", "close");
    btn.addEventListener("click", () => closeDrawers());
    el.appendChild(btn);
  }
}

/* ═══════════ 游戏抽屉（对局级）═══════════ */

/**
 * 三档预设尺寸。**不是「合法的尺寸只有这三个」** —— 合法的范围是 2~16，
 * 由自由输入那一路承担。预设之所以只有三档，是因为只有它们带成套的标定参数。
 */
const PRESET_SIZES = [
  { cols: 4, rows: 4 },
  { cols: 8, rows: 8 },
  { cols: 16, rows: 16 },
];

const inSizeRange = (v: number): boolean =>
  Number.isInteger(v) && v >= MIN_SIZE && v <= MAX_SIZE;

function renderSizeButtons(): void {
  const host = $("sizeList");
  const { cols, rows } = store.duel;
  const preset = isPresetSize(cols, rows);
  host.innerHTML = PRESET_SIZES.map(
    (s) =>
      `<button data-size="${s.cols}" class="${preset && s.cols === cols && s.rows === rows ? "on" : ""}">${s.cols}×${s.rows}</button>`,
  ).join("");
  for (const b of host.querySelectorAll<HTMLButtonElement>("button[data-size]")) {
    b.onclick = () => {
      const n = Number(b.dataset.size);
      setSize(n, n);
    };
  }
}

/**
 * 换尺寸 = 换一局棋。
 *
 * 回合上限与开局**必须跟着回落**到新尺寸的预设值：开局库按尺寸分级，
 * 沿用旧的 id 会得到一个在新尺寸下不存在的开局；而回合上限也是每档单独给的
 * （4×4 是 30，其余是 90）。留着旧值不报错，只是那一局不是任何一档预设。
 *
 * 非预设尺寸没有可回落的东西：开局落到「自定义（空白棋盘）」，回合上限保持
 * 用户当前的值 —— 界面会同时标明这个尺寸的参数未标定（`game.sizeUncalibrated`）。
 */
function setSize(cols: number, rows: number): void {
  if (!inSizeRange(cols) || !inSizeRange(rows)) return;
  store.duel.cols = cols;
  store.duel.rows = rows;
  if (isPresetSize(cols, rows)) {
    const p = presetFor(cols, rows);
    // 五项参数**整套**搬过来，不是只搬回合上限：预设的意义就是「一整套」，
    // 只搬其中几项会得到谁也没配过的组合（例如 4×4 的 lifeWinRatio 0.5
    // 配上 8×8 的回合上限 90）
    Object.assign(store.duel, {
      turnLimit: p.rules.turnLimit,
      lifeWinRatio: p.rules.lifeWinRatio,
      deathWinRatio: p.rules.deathWinRatio,
      lifeStreak: p.rules.lifeStreak,
      deathStreak: p.rules.deathStreak,
      openingId: p.openings[0]?.id ?? "",
    });
  } else {
    // 非预设尺寸没有可回落的东西：开局落到「自定义（空白棋盘）」，五个参数
    // 保持用户当前的值 —— 界面会同时标明这个尺寸的参数未标定
    store.duel.openingId = "";
  }
  save(store);
  syncGameUi();
  newGame();
}

/**
 * 把开局选择标成「自定义」—— 手绘与清空棋盘共用这一处。
 *
 * 不这么做的话，界面会一直显示着某个预设名（比如 `block-glider`），
 * 而棋盘上是用户自己画的东西 —— 那是界面在**说谎**，而这类谎话没有任何
 * 报错会露出来。
 */
function markCustomOpening(): void {
  if (store.duel.openingId === "") return;
  store.duel.openingId = "";
  save(store);
  renderOpenings();
}

/**
 * 自定义那一项的缩略图 —— 一个空格阵，一眼看出「这里什么都没有」。
 *
 * 刻意写成三段字符串拼接而**不是** `[".", ".", "."]` 这种数组字面量：
 * `tools/check-dom.ts` 会把方括号包裹的字符串字面量一律当成 DOM id 清单
 * （它扫的是全文），多一个方括号数组就多一次「这个 id 不存在」的误报机会。
 */
const BLANK_THUMB = "···\n···\n···";

/**
 * 开局选择器：用 monospace 字符网格画出形状，不只是文字名称。
 *
 * ★ 「自定义」是列表里**常驻的一项**，不是预设之外的补救措施：
 *   - 手绘过之后，选中的那一项要变成它（否则界面谎称这局用的是某个预设）
 *   - 非预设尺寸下，它是**唯一**的一项（那些尺寸没有开局库）
 *   - 它同时就是「清空棋盘」：点它 = 空棋盘 + 清掉预设标记
 *
 * `data-opening=""` 是那个哨兵值本身，空串在 `dataset` 里读出来是 `""`
 * 而不是 `undefined`，所以 `?? 旧值` 这个兜底不会把它吞掉 —— 这一点是刻意的，
 * 也是这里唯一一处用空串而不是缺省来表达「自定义」的地方。
 */
function renderOpenings(): void {
  const host = $("openingList");
  const custom = store.duel.openingId === "";

  const builtin = isPresetSize(store.duel.cols, store.duel.rows)
    ? preset()
        .openings.map((o) => {
          const on = o.id === store.duel.openingId ? " on" : "";
          const thumb = o.preview
            .map((row) => escapeHtml(row.replace(/#/g, "■").replace(/\./g, "·")))
            .join("\n");
          return `<button class="opening${on}" data-opening="${escapeHtml(o.id)}">
            <pre class="thumb">${thumb}</pre>
            <span class="obody">
              <span class="oname">${escapeHtml(openingName(o))}</span>
              <span class="onote">${escapeHtml(o.note)}</span>
            </span>
          </button>`;
        })
        .join("")
    : `<div class="desc">${escapeHtml(t("game.noOpeningLib"))}</div>`;

  const customBtn = `<button class="opening${custom ? " on" : ""}" data-opening="">
    <pre class="thumb">${BLANK_THUMB}</pre>
    <span class="obody">
      <span class="oname">${escapeHtml(t("game.customOpening"))}</span>
      <span class="onote">${escapeHtml(t("game.customOpeningNote"))}</span>
    </span>
  </button>`;

  host.innerHTML = builtin + customBtn;

  for (const b of host.querySelectorAll<HTMLButtonElement>("button[data-opening]")) {
    b.onclick = () => {
      store.duel.openingId = b.dataset.opening ?? store.duel.openingId;
      save(store);
      renderOpenings();
      newGame();
    };
  }
}

/**
 * ★ 单人模式：把**界面上有、实际不生效**的东西收掉。
 *
 * 逻辑侧早就贯穿到位了（每回合请求数、只跑生之执、日志无 `death_flip`、
 * 计分、终局文案、`soloDiedOut`），缺的一直是界面这一半：单人模式下
 * 死之执那一栏的设置仍然显示、仍然可编辑，**而它们一项都不会被用到**。
 * 这与刚修掉的 `callPolicy` 是同一类错 —— 界面上有、实际不生效，
 * 症状离原因很远（用户会以为「我关了思维链怎么没用」，其实那一栏根本没人读）。
 *
 * 所以这里做三件事，缺一不可：
 *   1. **停用**死之执那一栏（两个抽屉都有），而不是藏起来 ——
 *      藏起来会让人以为这个角色被删了，而那几项设置其实还在存档里
 *   2. **说明理由**：`roleHint` / `api.roleNote` 换成单人版。不写理由的
 *      停用与「坏了」在用户眼里是同一件事
 *   3. **措辞跟着含义走**：死之执那条胜负线在单人局里仍有意义（它是
 *      「棋盘死绝」的判据），但不再是「对手赢了」—— 标签与说明都换掉
 *
 * 它由 `syncGameUi()` 调用（`relanguage()` 与 `applyDuelSettings()` 都会
 * 走到那里），所以语言切换、模式切换、导入存档三条路径都不需要各自记得调。
 */
function syncModeUi(): void {
  // 「哪一项该怎么变」全在 `mode.ts` 那张表里，并由 `mode.test.ts` 断言 ——
  // 这里只管把它落到 DOM 上
  const m = modeUi(store.duel.mode);

  // 死之执那一栏在整个单人局里都没有消费者。当前如果正停在它上面，
  // 先把视角挪回生之执，再让两个抽屉各自重画一次 —— 否则用户会看着一栏
  // 已被停用的设置，而它显示的还是死之执的
  if (!m.deathColumnEnabled && state.role === "death") {
    // 先落盘再走 —— 用户可能刚在死之执那一栏里改完还没失焦，直接切走会把
    // 编辑内容丢掉，而且没有任何提示。停用是「不再读它」，不是「把它删了」
    applyRoleSettings();
    state.role = "life";
    syncStrategyUi();
    syncApiUi();
  }

  // 两个抽屉各有一组 roletab（策略 / API），一次全处理
  for (const b of document.querySelectorAll<HTMLButtonElement>(".roletab")) {
    const role = ROLE_OF_KEY[b.dataset.role ?? ""];
    const off = !m.deathColumnEnabled && role === "death";
    b.disabled = off;
    // 停用的按钮上的 title 是**唯一**能说明「为什么按不动」的地方
    b.title = off ? t(m.roleHint) : "";
  }
  $("roleHint").textContent = t(m.roleHint);
  $("apiRoleNote").textContent = t(m.roleHint);

  // ① 置信度图的图例：单人时死之执那一项整个不出现。
  // 那张图上永远不会有红色的带（没有死之执的日志就取不到分布），
  // 留一个没有曲线的图例比没有图例更坏
  $("lgdDeath").style.display = m.deathLegendVisible ? "" : "none";

  // ② 死之执那条线：单人局里它是「棋盘死绝」，不是「对手赢了」
  $("deathWinLbl").textContent = t(m.deathWinLabel);

  // ③ 措辞里带「双方」的那几处（单步按钮的提示、副标题、记忆说明）
  $<HTMLButtonElement>("bStep").title = t(m.stepTitle);
  $("subTitle").title = t(m.subtitleTitle);
  $("memDesc").textContent = t(m.memoryDesc);
}

function syncGameUi(): void {
  renderSizeButtons();
  renderOpenings();

  $<HTMLSelectElement>("inpMode").value = store.duel.mode;
  $<HTMLInputElement>("inpCols").value = String(store.duel.cols);
  $<HTMLInputElement>("inpRows").value = String(store.duel.rows);
  $<HTMLSelectElement>("inpTopology").value = store.duel.topology;
  $<HTMLInputElement>("inpTurnLimit").value =
    store.duel.turnLimit === null ? "" : String(store.duel.turnLimit);
  $<HTMLInputElement>("inpAnim").checked = store.duel.animations;
  $<HTMLInputElement>("inpParticles").checked = store.duel.particles;

  // ★ 「该尺寸的参数未标定」。它是**预设与自由输入分两层**这件事的另一半 ——
  // 只做自由输入而不说这句，用户会以为 7×11 上的胜负线与 8×8 上的一样有依据
  const customSize = !isPresetSize(store.duel.cols, store.duel.rows);
  const sizeNote = $("sizeNote");
  sizeNote.textContent = customSize ? t("game.sizeUncalibrated") : "";
  sizeNote.style.display = customSize ? "" : "none";

  // 环绕 + 极小尺寸：引擎算得出来（见 core/types.ts 的 MIN_SIZE 注释），
  // 但邻居会被重复计数，没有对应的几何直觉 —— 说清楚，而不是默默算一个
  // 别人看不懂的结果
  const tinyTorus =
    store.duel.topology === "torus" &&
    (store.duel.cols <= 3 || store.duel.rows <= 3);
  $("topoWarn").style.display = tinyTorus ? "block" : "none";

  // 胜负线是**玩家可填**的（用户 2026-09-21 定）。四个框存的都是**整数百分比**
  // —— 与图上的标注同一套口径，省掉「0.30 到底是几成」那种心算
  $<HTMLInputElement>("inpLifeWin").value = String(Math.round(store.duel.lifeWinRatio * 100));
  $<HTMLInputElement>("inpLifeStreak").value = String(store.duel.lifeStreak);
  $<HTMLInputElement>("inpDeathWin").value = String(Math.round(store.duel.deathWinRatio * 100));
  $<HTMLInputElement>("inpDeathStreak").value = String(store.duel.deathStreak);

  const rules = currentRules();
  // ★ 单人局里那两条线的**含义**变了（跌破死之执那条线的意思是「棋盘死绝」，
  // 没有对手），所以整段说明跟着换一套措辞 —— 阈值本身照旧生效，换的只是说法
  const m = modeUi(store.duel.mode);
  $("rulesNote").textContent =
    t(m.rulesNote, {
      life: Math.round(rules.lifeWinRatio * 100),
      ls: rules.lifeStreak,
      death: Math.round(rules.deathWinRatio * 100),
      ds: rules.deathStreak,
    }) +
    // 「占位、未标定」**始终**显示：三档预设的 calibrated 全是 false，
    // 而那正是开放这四个框的前提 —— 不标就等于说它们可信
    " " +
    t("game.rulesUncalibrated") +
    // 两条线倒挂：不禁止（这四个数本来就是拿来试的），但要说出来 ——
    // 判终局时生之执那条先判，倒挂会让死之执的线实际上永远轮不到
    (store.duel.deathWinRatio >= store.duel.lifeWinRatio ? " " + t(m.rulesInverted) : "");

  // 三个纯画面设置的**唯一**消费者（T14 里前两个没有任何消费者，只留了一句注释）。
  // 接在这里而不是散到各处：改了设置之后 `applyDuelSettings` 必定回到这里，
  // 于是「开关生效了吗」永远只有一个答案
  renderer.animations = store.duel.animations;
  renderer.particlesEnabled = store.duel.particles;
  renderer.flipMs = store.duel.flipMs;
  $<HTMLInputElement>("inpFlipMs").value = String(store.duel.flipMs);
  $("flipMsVal").textContent = paceLabel(store.duel.flipMs);

  // 模式相关的那些（措辞、停用、图例）收在**一处** —— 放在这个函数的末尾，
  // 是因为它是「对局级设置变了」的唯一汇聚点（`relanguage()` 也走这里）
  syncModeUi();
}

/**
 * 读一个「整数百分比」输入框，换算回 0~1 的比例。
 *
 * 四个胜负线输入框存的都是百分比（与图上标注同一口径）。越界与非法值一律
 * 回落到**修改前**的值，而不是夹到边界：夹边界看起来像生效了，用户会以为
 * 「填 200 得到 100」是他自己填的。
 */
function pctField(id: string, fallback: number): number {
  return clampRatio(Number($<HTMLInputElement>(id).value) / 100, fallback);
}

/**
 * 回合上限的校验。**留空 = 不设上限，合法**（用户 2026-09-21 定）。
 *
 * 只挡「填了但不是 1 以上的整数」—— 那是真的填错了。空与 0 要分开：
 * 空是「不要上限」，而 0 会得到一个「第 0 回合就判和局」的规则。
 */
function validateTurnLimit(): boolean {
  const raw = $<HTMLInputElement>("inpTurnLimit").value.trim();
  const bad = raw !== "" && (!Number.isInteger(Number(raw)) || Number(raw) < 1);
  $("turnLimitWarn").style.display = bad ? "block" : "none";
  return !bad;
}

/**
 * 对局级设置的写回。
 *
 * @param restart 这一项改了之后，当前这一局还算不算同一局？
 *
 *   **算**（拓扑、回合上限）—— 它们进 state.rules，是博弈定义的一部分。
 *   让它们在半局中生效，会让这一局的前后两半**不可比**：前 30 回合按 90 回合
 *   的视野下，后 30 回合按 60 回合的视野下，而这一局的任何统计都跨着这条线。
 *   所以立即重开 —— 与尺寸、开局那两项同一种处理。
 *
 *   **不算**（动效、粒子）—— 它们纯粹是画面，与 Jev 看到的东西无关，
 *   点一下开关就把棋局清掉是不可接受的。
 */
function applyDuelSettings(restart: boolean): void {
  const d = store.duel;
  d.mode = $<HTMLSelectElement>("inpMode").value === "solo" ? "solo" : "duel";
  d.topology = $<HTMLSelectElement>("inpTopology").value === "torus" ? "torus" : "bounded";
  d.turnLimit = clampTurnLimit($<HTMLInputElement>("inpTurnLimit").value, d.turnLimit);
  d.lifeWinRatio = pctField("inpLifeWin", d.lifeWinRatio);
  d.deathWinRatio = pctField("inpDeathWin", d.deathWinRatio);
  d.lifeStreak = clampStreak($<HTMLInputElement>("inpLifeStreak").value, d.lifeStreak);
  d.deathStreak = clampStreak($<HTMLInputElement>("inpDeathStreak").value, d.deathStreak);
  d.animations = $<HTMLInputElement>("inpAnim").checked;
  d.particles = $<HTMLInputElement>("inpParticles").checked;
  d.flipMs = clampFlipMs($<HTMLInputElement>("inpFlipMs").value);
  save(store);
  syncGameUi();
  if (restart) newGame();
}

/**
 * 动效开关（`store.duel.animations` / `particles`）的落点在 `syncGameUi()` 的
 * 结尾 —— 那是 T14 就定好的位置，这里不再转发一次。
 */
function bindGameSettings(): void {
  // 定义博弈的两项：改了就重开（理由见 applyDuelSettings）
  $("inpTurnLimit").addEventListener("change", () => {
    if (validateTurnLimit()) applyDuelSettings(true);
  });

  // 自由尺寸：长与宽各自 2~16，两个框都改完（change 在失焦 / 回车时触发）才重开一局。
  // 越界的值由 `clampSize` 拨回合法范围，而 `syncGameUi()` 会把结果写回输入框 ——
  // 用户看得见自己填的值被改成了什么，不做静默夹取
  const applySizeInputs = (): void => {
    const next = clampSize(
      $<HTMLInputElement>("inpCols").value,
      $<HTMLInputElement>("inpRows").value,
    );
    // 值没变就**不重开**：在抽屉里按 Tab 路过这两个框、或者把 7 改成 7，
    // 都不该把手上画了一半的开局清掉。只把显示拨回当前值
    if (next.cols === store.duel.cols && next.rows === store.duel.rows) {
      syncGameUi();
      return;
    }
    setSize(next.cols, next.rows);
  };
  for (const id of ["inpCols", "inpRows"]) {
    $(id).addEventListener("change", applySizeInputs);
  }
  $("inpMode").addEventListener("change", () => applyDuelSettings(true));
  $("inpTopology").addEventListener("change", () => applyDuelSettings(true));
  // 胜负线与回合上限同类：它们是**博弈定义**，改了就不是同一局（理由见
  // applyDuelSettings 的注释）—— 半局中改胜负线会让这一局的前后两半不可比
  for (const id of ["inpLifeWin", "inpLifeStreak", "inpDeathWin", "inpDeathStreak"]) {
    $(id).addEventListener("change", () => applyDuelSettings(true));
  }
  // 纯画面：改了不重开
  for (const id of ["inpAnim", "inpParticles"]) {
    $(id).addEventListener("change", () => applyDuelSettings(false));
  }

  // 时长滑块按 `input` 实时生效（与步进间隔那个同一种手感）—— 拖动时就能看见
  // 左边那一相变慢，而不是松手之后才跳一下。代价是每次 input 都写一遍配置，
  // 所以这里不走 `applyDuelSettings`（它会重画整个抽屉）
  const flipSlider = $<HTMLInputElement>("inpFlipMs");
  flipSlider.addEventListener("input", () => {
    store.duel.flipMs = clampFlipMs(flipSlider.value);
    $("flipMsVal").textContent = paceLabel(store.duel.flipMs);
    renderer.flipMs = store.duel.flipMs;
    save(store);
  });
}

function resetDuelSettings(): void {
  const p = presetFor(store.duel.cols, store.duel.rows);
  store.duel.mode = "duel";
  store.duel.topology = p.defaultTopology;
  store.duel.turnLimit = p.rules.turnLimit;
  store.duel.lifeWinRatio = p.rules.lifeWinRatio;
  store.duel.deathWinRatio = p.rules.deathWinRatio;
  store.duel.lifeStreak = p.rules.lifeStreak;
  store.duel.deathStreak = p.rules.deathStreak;
  // 自定义尺寸没有开局库，恢复默认同样落到「自定义」而不是某个 8×8 的开局
  store.duel.openingId = clampOpeningId(p.openings[0]?.id ?? "", store.duel.cols, store.duel.rows);
  store.duel.animations = true;
  store.duel.particles = true;
  store.duel.paceMs = 1200;
  store.duel.flipMs = FLIP_MS;
  save(store);
  syncGameUi();
  syncPaceUi();
  newGame();
}

/* ═══════════ 策略抽屉（玩家级）═══════════
 *
 * ★ ★ 本抽屉（以及 API 抽屉）里**故意缺席**的四个控件
 *   ——「等 LLM 适配器落地时一并加」，改写自 ui-spec 第五节的控件清单 ★ ★
 *
 *   · 思维链开关（策略 › 上下文，默认关）
 *   · 是否允许思考（三态：是 / 否 / 留空，仅 LLM 后端可见）
 *   · 思考强度（六档，默认留空 + UI 警示，仅 LLM 后端可见）
 *   · 调用策略（工具循环 / JSON，归 API 抽屉，默认 JSON，仅 LLM 后端可见）
 *
 * T14 不做它们，理由**不是没时间**：`DecisionBackend` 目前只有 `systemone`
 * 一个实现（`shared/backend.ts`），`llm-json` / `llm-tool` 都还没写。这四个
 * 控件的取值**没有任何消费者** —— 做出来就是一组点了没反应的死 UI。而
 * 「界面上有、实际不生效」恰恰是本项目最该防的那种错：症状与原因无关，
 * 用户会以为「关掉思维链没用」，其实那个开关根本没接线。
 *
 * 接线的位置已经留好，不需要回头动结构：
 *   · 值 → `store.roles[role]`（玩家级设置对象，加字段即可，见 config.ts）
 *   · 后端能力表（谁支持 reasoning_effort、谁不收 xhigh）→ 属于**适配器**，
 *     由 broker 持有，**不该由界面猜** —— 直接下发 UI 的枚举会把整个请求
 *     打成 400（ui-spec 第五节第 3 条的实测结论）
 */


function syncRoleTabs(): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>(".roletab")) {
    const role = ROLE_OF_KEY[b.dataset.role ?? ""];
    b.classList.toggle("on", role === state.role);
  }
  // ⚠ `#roleHint` **不在这里写** —— 它的措辞随模式变（单人局要说明死之执那一栏
  // 为什么停用），而两个抽屉都会调本函数、谁后调谁说了算。留一个写者：
  // `syncModeUi()`。曾经写在这里，结果是打开一次 API 抽屉就把单人说明顶回
  // 「双边可以配得不一样」——而那正是单人局里已经作废的那句话

  // 两个「复制到另一方」按钮的**方向**写在标签里，所以它们不是静态文案：
  // 既随语言变，也随当前选中的玩家变。写在 HTML 里会得到一句永远中文、
  // 且永远不说方向的提示 —— 那正是 relanguage() 要消灭的那类残留。
  const label = t("strategy.sync", {
    from: roleLabel(state.role),
    to: roleLabel(other(state.role)),
  });
  $("bStrategySync").textContent = label;
  $("bApiSync").textContent = label;
}

/* ═══════════ 规则说明书模板（正文）═══════════
 *
 * 六项模板的编辑器。**结构建一次，之后只更新取值与提示** —— 每次 sync 都重建
 * `innerHTML` 会把正在编辑的光标与选区顶掉，而 `syncStrategyUi` 会被语言切换、
 * 切玩家、改任意一栏设置触发（比「偶尔」频繁得多）。
 *
 * 每一条模板下面是两类提示，都是**只提示不阻止**：
 *   · 校验：缺了哪个占位符（模型会少知道一件事）、哪个认不出、哪个没闭合
 *   · 对照：这一项里的占位符**当前会填成什么** —— 这一条是「不透明」的正解，
 *     用户不必先保存、再开局、再去日志里翻
 */

/** 每项模板给几行。长的（终局条件、获胜条件）给 6 行，省得用户一进来就得拖 */
const TPL_ROWS: Record<RuleTemplateKey, number> = {
  role_statement: 3,
  objective: 4,
  horizon: 2,
  termination_conditions: 6,
  win_condition: 6,
  topology_note: 3,
};

function tplBox(key: RuleTemplateKey): HTMLElement {
  return $("tplList").querySelector<HTMLElement>(`[data-tpl="${key}"]`) as HTMLElement;
}

function buildTplEditor(): void {
  const host = $("tplList");
  if (host.childElementCount > 0) return;

  for (const key of TEMPLATE_KEYS) {
    const box = document.createElement("div");
    box.className = "field";
    box.dataset.tpl = key;

    const label = document.createElement("label");
    const input = document.createElement("textarea");
    input.rows = TPL_ROWS[key];
    const issues = document.createElement("div");
    issues.className = "tplissues";
    issues.dataset.tplIssues = key;
    const help = document.createElement("div");
    help.className = "tplhelp";
    help.dataset.tplHelp = key;

    box.append(label, input, issues, help);
    host.appendChild(box);
    input.addEventListener("change", applyRoleSettings);
  }
}

/** 把一组文本行铺进一个容器。**用 textContent**：占位符展开值里可能有用户写的
 *  花括号与尖括号，拼 HTML 会把它们当标签 */
function setLines(host: HTMLElement, lines: readonly string[]): void {
  host.replaceChildren(
    ...lines.map((text) => {
      const d = document.createElement("div");
      d.textContent = text;
      return d;
    }),
  );
}

function syncTplEditor(s: RoleSettings): void {
  buildTplEditor();
  const tpl = templatesOf(s.templates);
  const vars = templateVars({
    role: state.role,
    mode: store.duel.mode,
    topology: store.duel.topology,
    board: state.board,
    turn: state.turn,
    rules: currentRules(),
  });
  const issues = templateIssues(tpl);

  for (const key of TEMPLATE_KEYS) {
    const box = tplBox(key);
    box.querySelector("label")!.textContent = t(`tpl.${key}`);
    const input = box.querySelector("textarea") as HTMLTextAreaElement;
    // 正在编辑的那一栏不覆写 —— 否则切语言/切玩家会把没提交的输入吞掉
    if (document.activeElement !== input) input.value = tpl[key];

    setLines(
      box.querySelector<HTMLElement>("[data-tpl-issues]")!,
      issues
        .filter((i) => i.key === key)
        .map((i) => {
          if (i.kind === "unknown") return t("tpl.unknown", { name: `{{${i.placeholder}}}` });
          if (i.kind === "unclosed") return t("tpl.unclosed");
          const whyKey = PLACEHOLDERS.find((p) => p.name === i.placeholder)?.whyKey ?? "";
          return t("tpl.missing", {
            name: `{{${i.placeholder}}}`,
            why: whyKey ? t(whyKey) : "",
          });
        }),
    );

    setLines(box.querySelector<HTMLElement>("[data-tpl-help]")!, [
      t("tpl.help"),
      ...placeholdersIn(tpl[key]).map((name) =>
        Object.hasOwn(vars, name)
          ? `{{${name}}} → ${vars[name]}`
          : `{{${name}}} ${t("tpl.helpUnknown")}`,
      ),
    ]);
  }
}

/**
 * 界面上那六栏 → `RuleTemplates`。空串**原样存**（渲染那一层才知道怎么回落）。
 *
 * ⚠ 类型写成 `RuleTemplates` 而不是索引访问（`RoleSettings` 后跟方括号里的
 * 字段名）：那种写法是**方括号包着一个字符串字面量**，而 `tools/check-dom.ts`
 * 把全文里所有这种形状都当成 DOM id 清单 —— 于是它会报出一个并不存在的 id。
 * 这条注释本身也踩过一次：把那个写法原样写进说明里，一样会被扫到。
 * 与 `ROLE_ORDER` 那里记的是同一个坑。
 */
function readTplFromUi(): RuleTemplates {
  // 先保证编辑器存在：这个函数会在 `syncStrategyUi` 之前被调用到
  // （模式切到单人时要把当前这一栏落盘），那时六个框可能还没建出来
  buildTplEditor();
  const out = {} as RuleTemplates;
  for (const key of TEMPLATE_KEYS) {
    out[key] = (tplBox(key).querySelector("textarea") as HTMLTextAreaElement).value;
  }
  return out;
}

function syncStrategyUi(): void {
  const s = store.roles[state.role];
  $<HTMLTextAreaElement>("ruleNote").value = s.ruleNote;
  $<HTMLTextAreaElement>("hintText").value = s.strategyHint;
  $<HTMLInputElement>("inpPredict").checked = s.predictOutcome;
  $<HTMLInputElement>("inpDetect").checked = s.detectPatterns;
  $<HTMLInputElement>("inpMemory").value = s.memory === null ? "max" : String(s.memory);
  $("memoryVal").textContent = s.memory === null ? t("strategy.max") : String(s.memory);
  $<HTMLSelectElement>("inpStrategy").value = s.strategy;
  $<HTMLInputElement>("inpThreshold").value = String(Math.round(s.threshold * 100));
  $("thresholdVal").textContent = `${Math.round(s.threshold * 100)}%`;
  $("thresholdRow").style.display = s.strategy === "threshold" ? "" : "none";
  $<HTMLSelectElement>("inpChannel").value = s.channel;
  syncTplEditor(s);
  syncRoleTabs();
}

function applyRoleSettings(): void {
  const s = store.roles[state.role];
  s.ruleNote = $<HTMLTextAreaElement>("ruleNote").value;
  s.strategyHint = $<HTMLTextAreaElement>("hintText").value;
  s.templates = readTplFromUi();
  s.predictOutcome = $<HTMLInputElement>("inpPredict").checked;
  s.detectPatterns = $<HTMLInputElement>("inpDetect").checked;
  s.strategy = $<HTMLSelectElement>("inpStrategy").value as RoleSettings["strategy"];
  s.threshold = clamp01(Number($<HTMLInputElement>("inpThreshold").value) / 100);
  const memRaw = $<HTMLInputElement>("inpMemory").value;
  s.memory = memRaw === "max" ? null : Math.max(0, Math.min(MAX_MEMORY, Math.round(Number(memRaw) || 0)));
  save(store);
  syncStrategyUi();
}

function bindStrategySettings(): void {
  // 六个模板的 textarea 不是静态 HTML（由 `buildTplEditor` 现建），
  // 它们的事件在那边一并绑上（同一条 `applyRoleSettings` 路径）
  for (const id of ["ruleNote", "hintText", "inpPredict", "inpDetect", "inpStrategy", "inpChannel"]) {
    $(id).addEventListener("change", applyRoleSettings);
  }
  const th = $<HTMLInputElement>("inpThreshold");
  th.addEventListener("input", () => {
    $("thresholdVal").textContent = `${th.value}%`;
  });
  th.addEventListener("change", applyRoleSettings);

  const mem = $<HTMLInputElement>("inpMemory");
  mem.addEventListener("input", () => {
    $("memoryVal").textContent = mem.value === "max" ? t("strategy.max") : mem.value;
  });
  mem.addEventListener("change", applyRoleSettings);
  $("bMemMax").onclick = () => {
    mem.value = "max";
    applyRoleSettings();
  };

  for (const b of document.querySelectorAll<HTMLButtonElement>(".roletab")) {
    b.onclick = () => {
      // 切换玩家之前先把当前这一栏的编辑落盘 —— 否则「改完 A 直接点 B」
      // 会把刚改的内容丢掉，而且没有任何提示
      applyRoleSettings();
      const role = ROLE_OF_KEY[b.dataset.role ?? ""];
      if (!role) return;
      state.role = role;
      syncStrategyUi();
      syncApiUi();
    };
  }
}

/**
 * 双侧同步：把当前玩家的**全部玩家级设置**整体复制给另一方。
 *
 * 两个方向都要有 —— 方向由「当前选中的玩家」决定，所以是一个按钮而不是两个。
 * 它是**动作**而不是分区的属性：Jev vs Jev 时开着省事，Jev vs LLM 时关掉做对照。
 *
 * 后端与模型也一起复制，这是刻意的：用户如果只想同步上下文，那说明他真正
 * 想要的是「两边一样」这个状态，而不是「A 的后端配 B 的提示词」这种
 * 谁也说不清的中间态。
 */
function syncRoleSettings(): void {
  applyRoleSettings();
  const from = state.role;
  const to = other(from);
  store.roles[to] = { ...store.roles[from] };
  save(store);
  syncStrategyUi();
  syncApiUi();
  toast(t("strategy.syncDone", { from: roleLabel(from), to: roleLabel(to) }));
}

function resetRoleSettings(): void {
  store.roles[state.role] = defaultRole();
  save(store);
  syncStrategyUi();
  syncApiUi();
  newGame();
}

/* ═══════════ API 抽屉 ═══════════ */

const selBackend = $<HTMLSelectElement>("selBackend");
const inpKey = $<HTMLInputElement>("inpKey");
const staticHost = isStaticHosting();

/** 填充后端的下拉选项。抽成函数是因为语言切换时它得重建（否则停在旧语言） */
function fillBackendOptions(): void {
  const keep = selBackend.value || store.roles[state.role].provider;
  selBackend.replaceChildren();
  for (const [id, b] of Object.entries(BACKENDS)) {
    const o = document.createElement("option");
    o.value = id;
    // 开箱即用的后端不加「已验证」标记 —— 那是在暗示它背后有可验证的第三方服务
    const name = t(b.labelKey);
    // ★ 地址走不通的（静态托管 + 未配远端地址）**置灰**，不藏起来。
    // 藏起来会让人以为「这个项目没有免费试用」，而它其实只是**在当前部署形态下**
    // 走不通 —— 换到本机或 Vercel 就有了。留着并写明原因，用户才知道该怎么修。
    const reachable = isBackendReachable(b.base);
    o.disabled = !reachable;
    o.textContent =
      (b.needsKey ? `${name}${b.verified ? " ✓" : t("backend.unverifiedTag")}` : name) +
      (reachable ? "" : t("backend.unreachableTag"));
    selBackend.appendChild(o);
  }
  selBackend.value = keep;
}

/** 状态栏的后端标签 —— **单一来源**，别在别处另写一份 */
function updateBackendLabel(): void {
  const s = store.roles[state.role];
  const b = BACKENDS[s.provider];
  const name = t(b.labelKey);
  const reachable = isBackendReachable(s.base);
  const label =
    (b.needsKey || !staticHost ? name : t("backend.remoteSuffix", { label: name })) +
    (reachable ? "" : t("backend.unreachableTag"));
  const el = $("backend");

  // 代管后端的模型是本站服务端的内部选择：用户既改不了，也不该看到 ——
  // 展示它只会让人以为那是个可调项，还会把上游选型泄露到 UI 上
  if (b.managed) {
    el.textContent = `${roleLabel(state.role)} · ${label}`;
    el.title = t("backend.currentTitleShort", { label });
    return;
  }
  el.textContent = `${roleLabel(state.role)} · ${label} · ${s.model}`;
  el.title = t("backend.currentTitle", { label, model: s.model });
}

/** 按后端类型决定哪些字段可编辑、哪些提示要显示 */
function applyBackendGating(provider: BackendId): void {
  const b = BACKENDS[provider];
  $("advancedApi").style.display = b.managed ? "none" : "";
  $("modelHint").textContent = b.managed
    ? t("backend.modelManagedHint")
    : t("backend.modelPlaceholder", { model: b.model });

  const note = t(b.noteKey);
  const el = $("backendNote");
  el.textContent = isBackendReachable(b.base)
    ? b.verified
      ? t("backend.verified") + (b.needsKey ? note : "")
      : t("backend.unverified") + note
    : t("backend.unreachableNote");
  el.style.display = el.textContent ? "" : "none";

  if (b.needsKey) {
    inpKey.disabled = false;
    inpKey.placeholder = t("backend.keyPlaceholder");
    inpKey.style.userSelect = "auto";
  } else {
    inpKey.disabled = true;
    inpKey.value = "";
    inpKey.placeholder = t("backend.noKeyPlaceholder");
    inpKey.style.userSelect = "none";
  }
}

/**
 * LLM 四个控件 → 请求体上的 `llm` 字段。
 *
 * **非 LLM 后端返回 `undefined`**（整个字段不出现）：Jev 协议的后端不认识它，
 * 而发一个没人看的字段等于给上游送一个未知参数。
 *
 * 这里送的是**期望值**，不是最终下发的值 —— 收敛在服务端按上游能力表做。
 * 见 `shared/backend.ts` 的 `LlmCallOptions` 与 `llm-broker` 的 `clampEffort`。
 */
function llmCallOf(role: Role): LlmCallOptions | undefined {
  const s = store.roles[role];
  if (!BACKENDS[s.provider].isLlm) return undefined;
  // ★ `callPolicy` 必须跟着走。它曾经只存进配置、只画在界面上，**没有任何
  // 消费者** —— 「界面上有、实际不生效」正是这个项目最该防的那一类：
  // 用户下拉选了「工具循环」，实际什么都不变，而症状离原因很远
  return { effort: desiredEffort(s), callPolicy: s.callPolicy };
}

/**
 * LLM 那一块的可见性、取值与两条提示。
 *
 * 三条必须同屏出现，缺一条都会让人做出错的判断：
 *   1. 只有在 LLM 后端上才有意义 —— 否则是一排点了没反应的死控件
 *   2. 思考强度的实测警示 —— 四个显式档位全部劣于不设，不说就等于骗
 *   3. 「该后端不支持，已降级为默认」—— 能力的收敛在服务端做，而用户要在
 *      点下去**之前**知道这一档在这条后端上等于没设
 */
function syncLlmUi(): void {
  const s = store.roles[state.role];
  const b = BACKENDS[s.provider];
  $("llmCfg").style.display = b.isLlm ? "" : "none";
  if (!b.isLlm) return;

  $<HTMLInputElement>("inpCot").checked = s.chainOfThought;
  $<HTMLSelectElement>("inpAllowThink").value = s.allowThinking;
  $<HTMLSelectElement>("inpEffort").value = s.effort;
  // 「是否允许思考 = 否」时强度置灰：两者都落到 none，让用户去拨一个
  // 已经不生效的下拉框是误导
  $<HTMLSelectElement>("inpEffort").disabled = s.allowThinking === "no";
  $<HTMLSelectElement>("inpCallPolicy").value = s.callPolicy;

  const upstream = b.llmUpstream ?? "";
  const degraded = effortDegraded(s, upstream);
  const note = $("effortNote");
  note.textContent = degraded ? t("api.effortDegraded") : "";
  note.style.display = degraded ? "" : "none";

  // 实测警示**始终**显示（而不是只在选了档位时才出现）：它是「默认留空」
  // 这个默认值的理由，不写出来读者只会以为留空是个随便定的出厂值
  $("effortWarn").style.display = "block";
}

/** 三个思考控件改完之后走同一条路：先对齐耦合，再存盘重画 */
function commitLlmSettings(changed: "cot" | "allow" | "effort"): void {
  store.roles[state.role] = coupleLlmSettings(store.roles[state.role], changed);
  save(store);
  syncLlmUi();
}

/** 打开抽屉 / 切玩家时：填**当前生效的配置**，而不是后端默认值 */
function syncApiUi(): void {
  const s = store.roles[state.role];
  const b = BACKENDS[s.provider];
  fillBackendOptions();
  selBackend.value = s.provider;
  $<HTMLInputElement>("inpBase").value = s.base;
  // 代管后端的模型由服务端决定：输入框禁用，且**不显示默认值**
  $<HTMLInputElement>("inpModel").value = b.managed ? "" : s.model === b.model ? "" : s.model;
  $<HTMLInputElement>("inpModel").placeholder = b.managed ? t("backend.modelManaged") : b.model;
  applyBackendGating(s.provider);
  inpKey.value = "";
  updateBackendLabel();
  syncRoleTabs();

  $<HTMLInputElement>("inpRetryMax").value =
    store.api.retryMax === null ? "inf" : String(store.api.retryMax);
  $<HTMLInputElement>("inpRetryBase").value = String(store.api.retryBaseMs);
  $("retryPreview").textContent = previewBackoff(store.api.retryMax, store.api.retryBaseMs);
  syncLlmUi();
}

function previewBackoff(max: number | null, base: number): string {
  const n = max === null ? 5 : Math.min(max, 5);
  if (n === 0) return t("retry.none");
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`${((base * Math.pow(2, i)) / 1000).toFixed(1)}s`);
  }
  return parts.join(" → ") + (max === null || max > 5 ? " → …" : "");
}

/** 切换后端时：把该后端的默认端点与模型预置进表单 */
function onBackendSwitch(): void {
  const provider = selBackend.value as BackendId;
  const b = BACKENDS[provider];
  $<HTMLInputElement>("inpBase").value = b.base;
  $<HTMLInputElement>("inpModel").value = "";
  $<HTMLInputElement>("inpModel").placeholder = b.managed ? t("backend.modelManaged") : b.model;
  applyBackendGating(provider);
  syncLlmUi();
}

/**
 * 把表单写回当前玩家的设置。
 *
 * 密钥走 `state.keys`（内存），其余走 store（落盘）—— **这一行是那条红线的
 * 唯一落点**：只要密钥不进 store，它就不可能被 `save()` 写进 localStorage、
 * 也不可能被 `buildArchive()` 写进导出文件。类型上也够不着（`RoleSettings`
 * 里没有这个字段）。
 */
function commitApiSettings(): void {
  const s = store.roles[state.role];
  const provider = selBackend.value as BackendId;
  const b = BACKENDS[provider];
  s.provider = provider;
  s.base = $<HTMLInputElement>("inpBase").value.trim() || b.base;
  s.model = $<HTMLInputElement>("inpModel").value.trim() || b.model;

  const raw = $<HTMLInputElement>("inpRetryMax").value.trim().toLowerCase();
  const infinite = raw === "inf" || raw === "∞" || raw === "unlimited";
  store.api.retryMax = infinite
    ? null
    : Math.max(0, Math.min(MAX_RETRY, Math.round(Number(raw) || 0)));
  store.api.retryBaseMs = Math.max(
    100,
    Math.min(10_000, Number($<HTMLInputElement>("inpRetryBase").value) || store.api.retryBaseMs),
  );

  // ★ 空输入框 = 「不改」，不是「清掉」。
  //
  // 密钥**从不回显**（每次打开抽屉都是空的），所以「空」承载不了「用户想要一个空
  // 密钥」这个意思 —— 把空读成清除，会让「点开抽屉、什么都没输、点保存」变成
  // 一次静默的密钥清除，而失败要等到下一次调用才以一个 401 现身，症状与原因
  // 隔得很远。刷新页面本来就会清空密钥，所以这里不需要再给一条清除路径。
  const typed = inpKey.value.trim();
  if (!b.needsKey) state.keys[state.role] = "";
  else if (typed !== "") state.keys[state.role] = typed;

  save(store);
  updateBackendLabel();
  syncApiUi();
}

/* ═══════════ 存档：导入导出 ═══════════ */

function archiveSettings(): ArchiveSettings {
  return { duel: store.duel, roles: store.roles, api: store.api };
}

function sessionSnapshot(): SessionInput | null {
  if (state.turn === 0 && state.logs.length === 0) return null;
  return sessionInput(false);
}

function doExport(kind: ArchiveKind, label: string): void {
  download(buildArchive(kind, archiveSettings(), sessionSnapshot(), state.logs), label);
  toast(t("toast.exported", { label }));
}

/** 顶部短暂提示。导出/导入这类操作需要即时反馈，但不值得弹框 */
let toastTimer = 0;
function toast(msg: string, isErr = false): void {
  const el = $("toast");
  el.textContent = msg;
  el.classList.toggle("err", isErr);
  el.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2600);
}

/** 触发文件选择，选完交给 handler */
let pendingImport: ((text: string) => void) | null = null;

function pickFile(handler: (text: string) => void): void {
  pendingImport = handler;
  $<HTMLInputElement>("fileInput").click();
}

function onFileChosen(e: Event): void {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许连续选同一个文件
  if (!file || !pendingImport) return;
  const handler = pendingImport;
  pendingImport = null;

  readFile(file)
    .then(handler)
    .catch((err: unknown) => toast(t("toast.readFail", { msg: (err as Error).message }), true));
}

/**
 * 应用导入的档案。
 *
 * 各类档案的作用范围严格按「它自己声称的类型」来 —— 策略档不会顺带改掉
 * 对局设置，对局档也不会碰重试参数。**密钥不在任何一档里**（它压根不在 store
 * 里），所以「导入一份朋友的存档」不会覆盖你自己的密钥。
 */
function applyImported(text: string, expect: ArchiveKind): void {
  try {
    const archive = parseArchive(text);
    const r = extract(archive);

    if (archive.kind !== expect && archive.kind !== "all") {
      throw new ArchiveError(
        t("toast.kindMismatch", { from: t(`kind.${archive.kind}`), to: t(`kind.${expect}`) }),
      );
    }

    const touched: string[] = [];

    if (r.duel) {
      // 规范化走的是与「本地已有配置」完全相同的那条路径（clamp*），
      // 不会出现「导入更宽松」这种只有一条入口才有的漏洞
      // 尺寸只卡 2~16，**不往预设上凑** —— 导入一份 7×11 的对局档，
      // 得到的应当还是 7×11，而不是一份静默变成 8×8 的设置
      const size = clampSize(r.duel.cols, r.duel.rows);
      const hit = presetFor(size.cols, size.rows);
      store.duel = {
        ...store.duel,
        cols: size.cols,
        rows: size.rows,
        mode: r.duel.mode === "solo" ? "solo" : "duel",
        topology: r.duel.topology === "torus" ? "torus" : hit.defaultTopology,
        turnLimit: clampTurnLimit(r.duel.turnLimit, hit.rules.turnLimit),
        // 胜负线也过 clamp：导入的档案不比自己配的宽松（同一条纪律）
        lifeWinRatio: clampRatio(r.duel.lifeWinRatio, hit.rules.lifeWinRatio),
        deathWinRatio: clampRatio(r.duel.deathWinRatio, hit.rules.deathWinRatio),
        lifeStreak: clampStreak(r.duel.lifeStreak, hit.rules.lifeStreak),
        deathStreak: clampStreak(r.duel.deathStreak, hit.rules.deathStreak),
        openingId: clampOpeningId(r.duel.openingId, size.cols, size.rows),
        animations: r.duel.animations !== false,
        particles: r.duel.particles !== false,
        paceMs: clampPace(r.duel.paceMs),
      };
      touched.push(t("field.gameSettings"));
    }
    if (r.roles) {
      store.roles = { life: r.roles.life, death: r.roles.death };
      touched.push(t("field.roles"));
    }
    if (r.api) {
      store.api = { ...store.api, ...r.api };
      touched.push(t("field.apiSettings"));
    }

    save(store);
    syncGameUi();
    syncApiUi();
    syncStrategyUi();
    syncPaceUi();

    // 对局单独处理：有就覆盖当前局
    if (r.session && Array.isArray(r.session.board) && r.session.board.length > 0) {
      const s = r.session;
      if (
        s.cols === store.duel.cols &&
        s.rows === store.duel.rows &&
        (s.topology ?? store.duel.topology) === store.duel.topology
      ) {
        applySession({
          v: 0,
          app: "",
          cols: s.cols,
          rows: s.rows,
          mode: store.duel.mode,
          topology: store.duel.topology,
          rules: currentRules(),
          openingId: store.duel.openingId,
          board: s.board,
          turn: Number(s.turn) || 0,
          ratioHistory: Array.isArray(s.ratioHistory) ? s.ratioHistory : [],
          seen: Array.isArray(s.seen) ? s.seen : [],
          history: Array.isArray(s.history) ? s.history : [],
          scores: s.scores ?? { life: 0, death: 0 },
          aliveMax: Number(s.aliveMax) || 0,
          aliveMin: Number(s.aliveMin) || 0,
          logs: Array.isArray(s.logs) ? s.logs : [],
          finished: false,
          savedAt: "",
        });
        persist();
        touched.push(t("field.session"));
      } else {
        toast(t("toast.importEmpty"), true);
      }
    } else if (r.duel) {
      newGame();
    }

    closeDrawers();
    toast(touched.length ? t("toast.imported", { list: touched.join(", ") }) : t("toast.importEmpty"));
  } catch (err) {
    toast(t("toast.importFail", { msg: (err as Error).message }), true);
  }
}

/* ═══════════ 额度不足提示 ═══════════ */

/**
 * 额度用尽不该跟「网络抖动」共用同一个错误框。
 *
 * 两者的**用户可采取的行动完全不同**：网络问题该重试，额度问题该换后端。
 * 用一个通用错误框会让用户反复点重试，而重试永远不会成功。
 */
function showQuotaModal(detail: string): void {
  $("quotaDetail").textContent = detail;
  $("quotaModal").classList.add("show");
  setLed("err", "status.quota");
}

/* ═══════════ 不兼容存档提示 ═══════════ */

/**
 * 磁盘上有数据但读不懂时的兜底。
 *
 * 刻意**不自动清理** —— 那等于替玩家做决定，而丢掉的可能是几十回合的对局。
 * 先让玩家把原始数据导出留存，再决定是否重置。
 */
function showIncompatibleModal(raw: string, reason: string): void {
  $("incompatReason").textContent = reason;
  $("incompatSize").textContent = `${(raw.length / 1024).toFixed(1)} KB`;
  $("incompatPreview").textContent = raw.slice(0, 400) + (raw.length > 400 ? "\n…" : "");
  $("incompatModal").classList.add("show");
  setLed("err", "incompat.title");
}

/* ═══════════ 节奏滑块 ═══════════ */

const paceSlider = $<HTMLInputElement>("pace");

/**
 * 步进间隔是**实时控制**而非配置项 —— 它既不进请求，也不改变动作如何落实，
 * 只影响自动走棋的播放速度。所以只在棋盘下方留一个滑块，设置抽屉里不重复出现。
 */
const paceLabel = (ms: number): string => (ms === 0 ? t("pace.instant") : `${(ms / 1000).toFixed(1)}s`);

function syncPaceUi(): void {
  paceSlider.value = String(store.duel.paceMs);
  $("paceVal").textContent = paceLabel(store.duel.paceMs);
}

/* ═══════════ 启动 ═══════════ */

/**
 * 按当前语言重画**全部**文案。
 *
 * 静态文案由 `applyDom()` 扫描 `data-i18n*` 属性搞定；动态内容是各函数一次性
 * 写进 DOM 的，必须逐个重放 —— 尤其是决策面板与状态栏，它们除了那份缓存
 * 没有别的途径能恢复内容（见 `state.shown` / `lastLed`）。
 */
function relanguage(): void {
  applyDom();

  if (lastLed) setLed(lastLed.cls, lastLed.key, lastLed.params);
  renderDecision();
  syncGameUi();
  syncStrategyUi();
  syncApiUi();
  syncPaceUi();
  syncRunButton();
  renderLog();
  // 三块画布上的文案（「等待对局数据」等）是**绘制那一刻**写死的，切换语言后
  // 不重绘就会一直停在旧语言。棋盘上没有文案，但它一样便宜 —— 一起重绘，
  // 免得下次往棋盘上加字时漏掉这一处
  renderer.redraw();
  chart.redraw();
  momentum.redraw();
  heat.redraw();
  $<HTMLButtonElement>("bResult").title = t("ctrl.resultTitle");
}

function bindLanguage(): void {
  $("bLang").addEventListener("click", () => {
    setLang(getLang() === "zh" ? "en" : "zh");
  });
}

function bindQuotaModal(): void {
  $("bQuotaSwitch").onclick = () => {
    $("quotaModal").classList.remove("show");
    openDrawer("dApi");
  };
  $("bQuotaClose").onclick = () => {
    $("quotaModal").classList.remove("show");
    setLed("", "status.paused");
  };
}

function bindIncompatibleModal(): void {
  $("bIncompatExport").onclick = () => {
    const raw = rawSession();
    if (!raw) {
      toast(t("salv.rawGone"), true);
      return;
    }
    downloadRaw(raw, "incompatible-session");
    toast(t("salv.exported"));
  };

  /**
   * 强行加载：尽力抢救。
   *
   * 这是「责任在用户」的路径 —— 严格校验已经失败过一次，接下来能救回多少
   * 取决于数据本身。应用负责如实报告抢救了什么、丢了什么，不替用户判断值不值。
   */
  $("bIncompatForce").onclick = () => {
    const raw = rawSession();
    if (!raw) {
      toast(t("salv.rawGone"), true);
      return;
    }
    try {
      const o: unknown = JSON.parse(raw);
      const r = o as Record<string, unknown>;
      const board = Array.isArray(r.board) ? (r.board as unknown[]).filter((x) => typeof x === "string") : [];
      if (board.length === 0 || board.length !== store.duel.rows) {
        toast(t("salv.forceFail"), true);
        return;
      }
      const salvaged: string[] = [];
      if (typeof r.turn !== "number") salvaged.push(t("salv.turn"));
      if (!Array.isArray(r.history)) salvaged.push(t("salv.memory"));

      applySession({
        v: 0,
        app: "",
        cols: store.duel.cols,
        rows: store.duel.rows,
        mode: store.duel.mode,
        topology: store.duel.topology,
        rules: currentRules(),
        openingId: store.duel.openingId,
        board: board as string[],
        turn: Number(r.turn) || 0,
        ratioHistory: Array.isArray(r.ratioHistory) ? (r.ratioHistory as number[]) : [],
        seen: Array.isArray(r.seen) ? (r.seen as string[]).filter((s) => typeof s === "string") : [],
        history: Array.isArray(r.history) ? (r.history as StoredTurn[]) : [],
        scores: { life: 0, death: 0 },
        aliveMax: 0,
        aliveMin: 0,
        logs: [],
        finished: false,
        savedAt: "",
      });
      saveSessionNow(sessionInput(false));
      $("incompatModal").classList.remove("show");
      setLed("on", "salv.forced", { n: state.turn });
      toast(
        salvaged.length
          ? t("salv.forcedPartial", { list: salvaged.join("; ") })
          : t("salv.forcedShort", { n: state.turn }),
      );
    } catch {
      toast(t("salv.forceFail"), true);
    }
  };

  $("bIncompatReset").onclick = () => {
    if (!window.confirm(t("confirm.incompatReset"))) return;
    clearSession();
    $("incompatModal").classList.remove("show");
    newGame();
    setLed("", "confirm.resetDone");
    toast(t("confirm.resetDone"));
  };

  // 关掉弹框 = 先不动数据，开新局继续玩（存档原样留着）
  $("bIncompatLater").onclick = () => {
    $("incompatModal").classList.remove("show");
    setLed("", "confirm.kept");
  };
}

function bindControls(): void {
  $("bToggle").onclick = toggleRun;

  // 手绘开局：点格子即翻转。绑定在**画布**上而不是某一层覆盖元素上 ——
  // 格号由一个来源（渲染器的几何）现算，见 `BoardRenderer.cellAtPoint`
  boardCanvas.addEventListener("click", (e) => {
    if (!canDraw()) return;
    const cell = renderer.cellAtPoint(e.clientX, e.clientY);
    if (cell !== null) drawCell(cell);
  });
  $("bClearBoard").onclick = clearBoard;

  $("bStep").onclick = () => {
    pause();
    void doTurn();
  };
  $("bNew").onclick = newGame;
  $("bResult").onclick = () => {
    if (state.termination) renderResult();
  };

  $("bArchive").onclick = () => openDrawer("dArchive");
  $("bGame").onclick = () => openDrawer("dGame");
  $("bStrategy").onclick = () => openDrawer("dStrategy");
  $("bApi").onclick = () => {
    syncApiUi();
    openDrawer("dApi");
  };
  $("bLog").onclick = () => {
    renderLog();
    openDrawer("dLog");
  };

  /* 导入导出 */
  $("bExpGame").onclick = () => doExport("game", t("kind.game"));
  $("bExpStrategy").onclick = () => doExport("strategy", t("kind.strategy"));
  $("bExpApi").onclick = () => doExport("api", t("kind.api"));
  $("bExpLog").onclick = () => doExport("log", t("kind.log"));
  $("bExpAll").onclick = () => doExport("all", t("kind.all"));

  $("bImpGame").onclick = () => pickFile((text) => applyImported(text, "game"));
  $("bImpStrategy").onclick = () => pickFile((text) => applyImported(text, "strategy"));
  $("bImpApi").onclick = () => pickFile((text) => applyImported(text, "api"));

  $("fileInput").addEventListener("change", onFileChosen);

  $("bArchiveWipe").onclick = () => {
    if (!window.confirm(t("confirm.wipeAll"))) return;
    clearSession();
    try {
      localStorage.removeItem("jevlife.v1");
    } catch {
      /* ignore */
    }
    location.reload();
  };

  /* 恢复默认 */
  $("bGameReset").onclick = () => {
    if (window.confirm(t("confirm.gameReset"))) resetDuelSettings();
  };
  $("bStrategyReset").onclick = () => {
    if (window.confirm(t("confirm.strategyReset"))) resetRoleSettings();
  };
  $("bApiReset").onclick = () => {
    if (!window.confirm(t("confirm.apiReset"))) return;
    store.api = { retryMax: 3, retryBaseMs: 800 };
    save(store);
    syncApiUi();
  };
  $("bLogClear").onclick = () => {
    if (!window.confirm(t("confirm.logClear"))) return;
    state.logs = [];
    chart.clear();
    renderLog();
    persist();
  };

  /* 双侧同步：一个动作，方向由当前选中的玩家决定 */
  $("bStrategySync").onclick = syncRoleSettings;
  $("bApiSync").onclick = () => {
    commitApiSettings();
    syncRoleSettings();
  };

  $("bCopyAll").onclick = (e) => {
    const all = state.logs.map((r) => ({
      turn: r.turn,
      at: r.at,
      life: r.life,
      death: r.death,
      aliveBefore: r.aliveBefore,
      aliveAfter: r.aliveAfter,
      netGrowth: r.netGrowth,
      failed: r.failed,
    }));
    void copyText(fmtJson(all), e.currentTarget as HTMLButtonElement);
  };

  /* LLM 调用配置。三个思考控件走同一条「先对齐耦合再存盘」的路；
     调用策略只影响服务端怎么问，没有耦合，直接写回 */
  $("inpCot").addEventListener("change", () => commitLlmSettings("cot"));
  $("inpAllowThink").addEventListener("change", () => commitLlmSettings("allow"));
  $("inpEffort").addEventListener("change", () => commitLlmSettings("effort"));
  $("inpCallPolicy").addEventListener("change", () => {
    const s = store.roles[state.role];
    s.callPolicy = $<HTMLSelectElement>("inpCallPolicy").value === "tool" ? "tool" : "json";
    save(store);
    syncLlmUi();
  });

  selBackend.onchange = onBackendSwitch;
  $("bApiSave").onclick = () => {
    commitApiSettings();
    closeDrawers();
  };
  $("bApiClose").onclick = closeDrawers;
  scrim.onclick = closeDrawers;

  for (const id of ["bArchiveDone", "bGameDone", "bStrategyDone", "bLogDone"]) {
    $(id).onclick = closeDrawers;
  }

  for (const id of ["inpRetryMax", "inpRetryBase"]) {
    $(id).addEventListener("change", commitApiSettings);
  }

  paceSlider.addEventListener("input", () => {
    store.duel.paceMs = clampPace(paceSlider.value);
    $("paceVal").textContent = paceLabel(store.duel.paceMs);
    save(store);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawers();
      return;
    }
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
    if (e.key === " ") {
      e.preventDefault();
      toggleRun();
    }
  });
}

function boot(): void {
  // 先把所有必需的 id 一次性核对完，缺哪个直接说清楚
  assertDom([
    "board", "chart", "chartBox", "momentum", "momentumBox", "heat", "heatBox",
    "led", "status", "cost", "avgCost", "lat", "backend",
    "sAlive", "sRatio", "sTurn", "sMax", "sMin", "decision", "dTurn",
    "lgdDeath", "subTitle", "memDesc", "deathWinLbl", "apiRoleNote", "tplList",
    "bToggle", "bStep", "bNew", "bClearBoard", "drawHint", "bResult", "pace", "paceVal",
    "bLang", "langLbl", "bGame", "bStrategy", "bApi", "bLog", "bArchive",
    "scrim", "dGame", "dStrategy", "dApi", "dLog", "dArchive", "toast", "fileInput",
    "sizeList", "inpCols", "inpRows", "sizeNote", "inpMode", "inpTopology", "topoWarn",
    "inpTurnLimit", "turnLimitWarn", "rulesNote",
    "inpLifeWin", "inpLifeStreak", "inpDeathWin", "inpDeathStreak",
    "openingList", "inpAnim", "inpParticles", "inpFlipMs", "flipMsVal", "bGameReset", "bGameDone",
    "roleHint", "ruleNote", "hintText", "inpPredict", "inpDetect",
    "inpMemory", "memoryVal", "bMemMax", "inpStrategy", "thresholdRow",
    "inpThreshold", "thresholdVal", "inpChannel", "bStrategySync", "bStrategyReset", "bStrategyDone",
    "selBackend", "inpKey", "keyHint", "inpBase", "inpModel", "advancedApi", "modelHint", "backendNote",
    "inpRetryMax", "inpRetryBase", "retryPreview", "bApiSync", "bApiReset", "bApiSave", "bApiClose",
    "llmCfg", "inpCot", "inpAllowThink", "inpEffort", "effortWarn", "effortNote", "inpCallPolicy",
    "logList", "logCount", "bCopyAll", "bLogClear", "bLogDone",
    "bExpGame", "bImpGame", "bExpStrategy", "bImpStrategy", "bExpApi", "bImpApi",
    "bExpLog", "bExpAll", "bArchiveWipe", "bArchiveDone",
    "incompatModal", "incompatReason", "incompatSize", "incompatPreview",
    "bIncompatExport", "bIncompatForce", "bIncompatReset", "bIncompatLater",
    "quotaModal", "quotaDetail", "bQuotaSwitch", "bQuotaClose",
  ]);

  // 语言：先套用已保存的选择，绑定切换按钮，再订阅「切换后重绘」。
  // setLang 只在值真的变了才广播，所以这里的首次套用不会触发重绘
  setLang(store.lang);
  bindLanguage();
  addDrawerCloseButtons();
  onLangChange(() => {
    store.lang = getLang();
    save(store);
    relanguage();
  });
  applyDom();

  $<HTMLButtonElement>("bResult").title = t("ctrl.resultTitle");

  bindControls();
  bindGameSettings();
  bindStrategySettings();
  bindQuotaModal();
  bindIncompatibleModal();

  syncGameUi();
  syncStrategyUi();
  syncApiUi();
  syncPaceUi();
  syncRunButton();

  fitBoard();
  fitCharts();

  // 优先还原上一局；没有可还原的存档才开新局
  if (!restoreSession()) newGame();

  console.info(
    t("dev.bootInfo", {
      cols: store.duel.cols,
      rows: store.duel.rows,
      topology: store.duel.topology,
      opening: store.duel.openingId,
      turnLimit: store.duel.turnLimit ?? "∞",
      channel: store.roles.life.channel,
    }),
  );
}

try {
  boot();
} catch (err) {
  console.error(t("dev.bootFail"), err);
  setLed("err", "status.apiFail");
  const msg = err instanceof Error ? err.message : String(err);
  // 用最朴素的方式报错 —— 此时弹框、抽屉、toast 这些依赖可能本身就不可用
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;" +
    "background:#08090b;z-index:9999;padding:24px;text-align:center;" +
    "font:13px/1.7 ui-monospace,monospace;color:#f5b5b5;white-space:pre-wrap";
  box.textContent = t("boot.failedBody", { msg });
  document.body.appendChild(box);
}

// 布局稳定之前字号与容器尺寸还会变（webfont 载入、侧栏换行），
// 所以头几次 resize 各量一遍
for (const delay of [60, 200, 500]) {
  setTimeout(() => {
    fitBoard();
    fitCharts();
  }, delay);
}
