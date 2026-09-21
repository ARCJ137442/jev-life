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
import { parseAnswers } from "../core/channels.js";
import { resolveDecision } from "../core/decide.js";
import type { CellProbabilities } from "../core/decide.js";
import type { Channel } from "../core/channels.js";
import type { Board, Cell, GameRules, Role, Termination } from "../core/types.js";
import type { Questions } from "../shared/types.js";
import { JevError } from "../shared/backend.js";
import type { DecisionRequest, DecisionResult } from "../shared/backend.js";
import {
  BACKENDS,
  createBackend,
  isStaticHosting,
  type BackendId,
  type ClientConfig,
} from "./api.js";
import {
  MAX_MEMORY,
  MAX_RETRY,
  channelOf,
  clamp01,
  clampPace,
  clampTurnLimit,
  defaultRole,
  load,
  presetFor,
  save,
  type ArchiveSettings,
  type Persisted,
  type RoleSettings,
} from "./config.js";
import { ConfidenceChart, fitCanvas } from "./chart.js";
import type { ChartPoint, ChartSeries } from "./chart.js";
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
import type { Opening } from "../core/presets.js";

/* ═══════════ 常量 ═══════════ */

/**
 * 角色的展示元数据。
 *
 * 配色不是审美选择：**绿、红、黄、白四个色相已经被「内容」占用**
 * （绿=生之执、红=死之执、黄=中段/交集、白=活细胞），所以界面主题色只能落在
 * 青/蓝/紫一带，用户选了青。角色色本身**不随主题走** —— 它们是数据的一部分。
 */
const ROLE_META: Record<Role, { labelKey: string; color: string; band: string; faint: string }> = {
  life: {
    labelKey: "log.roleLife",
    color: "#4ade80",
    band: "rgba(74,222,128,.30)",
    faint: "rgba(74,222,128,.05)",
  },
  death: {
    labelKey: "log.roleDeath",
    color: "#f87171",
    band: "rgba(248,113,113,.30)",
    faint: "rgba(248,113,113,.05)",
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
const chart = new ConfidenceChart($<HTMLCanvasElement>("chart"));

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
  /** 概率前 5：`[格号, 概率]` */
  readonly top: ReadonlyArray<readonly [Cell, number]>;
}

interface AppState {
  board: Board;
  turn: number;
  running: boolean;
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
 * 当前生效的规则 = 预设的规则 + 界面上可改的回合上限。
 *
 * 胜负线（`lifeWinRatio` 等）**不开放给界面改**：它们是占位值没错，但把它们
 * 做成四个滑块会让人以为那四个数已经标定过。预设里已经标了 `calibrated: false`，
 * 界面照实把它显示出来（见 `game.rulesUncalibrated`）。
 */
function currentRules(): GameRules {
  return { ...preset().rules, turnLimit: store.duel.turnLimit };
}

function openingOf(): Opening {
  const p = preset();
  return p.openings.find((o) => o.id === store.duel.openingId) ?? p.openings[0];
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

function updateStats(): void {
  const alive = aliveCount(state.board);
  $("sAlive").textContent = String(alive);
  $("sRatio").textContent = pct(ratioOf(alive));
  $("sTurn").textContent = String(state.turn);
  $("sMax").textContent = String(state.aliveMax);
  $("sMin").textContent = String(state.aliveMin);
}

/**
 * 累计费用与均次费用。
 *
 * 两处数据同源（`costTotal` 与已成功调用次数），放在一起更新，免得某一处
 * 漏改导致两个数字对不上。失败的调用不产生费用，也不计入分母。
 */
function updateCostUi(): void {
  const ok = state.logs.filter((r) => !r.failed).length * ROLE_ORDER.length;
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
 * T14 只负责尺寸（见文件头）。真正的绘制在 T15 的 `render.ts`。
 */
function fitBoard(): void {
  const box = boardCanvas.parentElement;
  if (!box) return;
  const size = Math.min(box.clientWidth, box.clientHeight);
  fitCanvas(boardCanvas, size, size);
}

/**
 * 侧栏三张图的尺寸。
 *
 * 三张图**高度固定、宽度跟着侧栏走**：它们的信息量都在横轴（回合）上，
 * 而侧栏本身是 `max-content` 撑出来的 —— 让图去挤压侧栏宽度会反过来让
 * 记分板折行（2048 那条教训）。两张占位画布只做尺寸，绘制归 T15。
 */
const CONF_H = 92;
const MOM_H = 96;
const HEAT_MAX = 132;

function fitCharts(): void {
  const confBox = $("chartBox");
  chart.resize(Math.max(0, confBox.clientWidth - 16), CONF_H);

  const momBox = $("momentumBox");
  fitCanvas(
    $<HTMLCanvasElement>("momentum"),
    Math.max(0, momBox.clientWidth - 16),
    MOM_H,
  );

  // ③ 与棋盘同形：正方形，边长取「容器宽」与「高度上限」的较小者。
  // 16×16 时它是 16 格的网格，边长太小会糊成一片；太大又挤掉上面两张图
  const heatBox = $("heatBox");
  const side = Math.min(Math.max(0, heatBox.clientWidth - 2), HEAT_MAX);
  fitCanvas($<HTMLCanvasElement>("heat"), side, side);
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
 * ③ 是**当回合**的空间分布。这里只产 ① 的数据；② 的数据在 `state.ratioHistory`
 * 里、③ 的在 `state.lastProbs` 里，都留给 T15。
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

/* ═══════════ 决策面板 ═══════════ */

function renderDecision(): void {
  const host = $("decision");
  $("dTurn").textContent = state.turn ? `#${state.turn}` : "";

  if (!state.shown) {
    host.innerHTML = `<div class="idle">${escapeHtml(t(state.shownIdleKey, state.shownIdleParams))}</div>`;
    return;
  }

  host.innerHTML = state.shown
    .map((d) => {
      const flags: string[] = [];
      if (d.coerced) flags.push(`<span class="flag">coerced</span>`);
      if (d.belowThreshold) flags.push(`<span class="flag">below</span>`);
      const top = d.top
        .map(([cell, p]) => `${rcText(cell)} ${p.toFixed(3)}`)
        .join(" · ");
      return `<div class="prow" style="--rc:${ROLE_META[d.role].color}">
        <div class="phead">
          <span class="pwho">${escapeHtml(roleLabel(d.role))}</span>
          <span class="pcell">${t("decision.flip", { row: rowOf(d.cell), col: colOf(d.cell) })}</span>
          <span class="pp">${t("log.p")}=${d.prob.toFixed(3)}</span>
          ${flags.join("")}
        </div>
        <div class="pnote">${escapeHtml(t(d.reasonKey, d.reasonParams))}</div>
        <div class="ptop">${escapeHtml(t("decision.top5"))}：${escapeHtml(top)}</div>
      </div>`;
    })
    .join("");
}

const rowOf = (cell: Cell): number => Math.floor(cell / state.board.cols);
const colOf = (cell: Cell): number => cell % state.board.cols;
const rcText = (cell: Cell): string => `(${rowOf(cell)},${colOf(cell)})`;

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
  const failed = (e: unknown): RoleOutcome => {
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
    };
  };

  try {
    const res = await createBackend(clientConfigOf(role), {
      retry: retryPolicy(),
      hooks: {
        onRetry: (n, _err, delay) => setLed("busy", "status.retrying", { n, s: (delay / 1000).toFixed(1) }),
      },
    }).evaluate(attempt.request);

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
  const rules = currentRules();
  const board = state.board;
  setLed("busy", "status.calling");

  /* ── 双方**同时**决策，都基于演化前的棋盘（见文件头）── */

  const attempts: RoleAttempt[] = ROLE_ORDER.map((role) => {
    const settings = store.roles[role];
    const input: StateInput = {
      board,
      role,
      topology,
      rules,
      turn: state.turn,
      scores: { life: state.scores.life, death: state.scores.death },
      history: state.history,
      context: roleContextOf(settings),
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

    pushLog({
      turn: state.turn + 1,
      at,
      life: roleLogOf(attempts[0], outcomes[0], latencyMs),
      death: roleLogOf(attempts[1], outcomes[1], latencyMs),
      aliveBefore: aliveCount(board),
      aliveAfter: aliveCount(board),
      netGrowth: 0,
      failed: true,
    });

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
      top: topFive(probs),
    };
  });

  const cellOf = (role: Role): Cell => {
    const row = decisions.find((d) => d.role === role);
    if (!row) throw new Error(`内部错误：没有 ${role} 的决策`);
    return row.cell;
  };

  const lifeFlip = cellOf("life");
  const deathFlip = cellOf("death");

  /* ── 落子 + 演化一代 ──
     先把**本回合开始时**的占比记进历史：classifyTermination 的序列是
     [...ratioHistory, 当前占比]，把当前局面也塞进历史会让同一代被数两次 */

  const before = aliveCount(board);
  state.ratioHistory.push(ratioOf(before));

  // 引擎是纯函数：flip 返回新棋盘，不会改动传进去的那个
  const next = lifeStep(flip(flip(board, lifeFlip), deathFlip), topology);
  const after = aliveCount(next);
  const netGrowth = after - before;

  // 两边记的是**同一个**净增长：它是「棋盘涨了多少」这个客观量，
  // 不是某一方的得分。生之执要它大、死之执要它小，所以两边看同一个数
  state.scores = {
    life: state.scores.life + netGrowth,
    death: state.scores.death + netGrowth,
  };

  state.history.push({
    turn: state.turn,
    board: next,
    lifeFlip,
    deathFlip,
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
  state.aliveMax = Math.max(state.aliveMax, after);
  state.aliveMin = Math.min(state.aliveMin, after);

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
  updateStats();

  pushLog({
    turn: state.turn,
    at,
    life: roleLogOf(attempts[0], outcomes[0], latencyMs),
    death: roleLogOf(attempts[1], outcomes[1], latencyMs),
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

/** 分布的前 5 名。同概率时按格子升序 —— 顺序必须是确定的 */
function topFive(probs: CellProbabilities): ReadonlyArray<readonly [Cell, number]> {
  return [...probs.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 5);
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
    ...(outcome.ok ? {} : { error: outcome.error }),
  };
}

function pushLog(row: TurnLog): void {
  state.logs.push(row);
  if (state.logs.length > MAX_LOGS) state.logs.shift();
  chart.setData(chartSeries());
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
    case "noLegalCell":
      return v.winner === "life" ? t("term.noLegalCellLife") : t("term.noLegalCellDeath");
    case "repeatBlocked":
      return t("term.repeatBlocked");
    case "turnLimit":
      return t("term.turnLimit", { n: rules.turnLimit });
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
    t("over.ratioLine", {
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

function syncRunButton(): void {
  const b = $<HTMLButtonElement>("bToggle");
  if (state.running) {
    b.textContent = t("ctrl.pause");
    b.classList.remove("primary");
    b.classList.add("running");
  } else {
    b.textContent = t("ctrl.takeover");
    b.classList.remove("running");
    b.classList.add("primary");
  }
  b.disabled = state.finished;
  b.title = t("ctrl.takeoverTitle");
}

function start(): void {
  if (state.running || state.finished) return;
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

  state.board = boardFromRows(opening.build(d.cols, d.rows));
  state.turn = 0;
  state.running = false;
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

  chart.clear();
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
  // 恢复出来的那一局不能自动跑起来 —— 刷新之后先让人看一眼再说
  state.running = false;
  state.busy = false;

  state.costTotal = state.logs.reduce(
    (sum, row) => sum + (row.life?.costUsd ?? 0) + (row.death?.costUsd ?? 0),
    0,
  );
  state.costUnknown = state.logs.some(
    (row) => (row.life && row.life.costUsd === null) || (row.death && row.death.costUsd === null),
  );

  chart.setData(chartSeries());
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
    </div>
    <div class="lglabel">${escapeHtml(t("log.reqLabel"))}</div>
    ${hasPayload ? `<pre>${escapeHtml(fmtJson(rl.request))}</pre>` : `<div class="lghint">${escapeHtml(t("log.noPayload"))}</div>`}
    <div class="lglabel">${escapeHtml(t("log.resLabel"))}</div>
    ${rl.error ? `<div class="lghint">${escapeHtml(t("log.noResponse"))}</div>` : `<pre>${escapeHtml(fmtJson(rl.response))}</pre>`}
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

function renderSizeButtons(): void {
  const host = $("sizeList");
  host.innerHTML = PRESET_SIZES.map(
    (s) =>
      `<button data-size="${s.cols}" class="${s.cols === store.duel.cols && s.rows === store.duel.rows ? "on" : ""}">${s.cols}×${s.rows}</button>`,
  ).join("");
  for (const b of host.querySelectorAll<HTMLButtonElement>("button[data-size]")) {
    b.onclick = () => setSize(Number(b.dataset.size));
  }
}

/** 三档预设尺寸。**不是任意宽高** —— 每档的规则与开局库都是单独配的 */
const PRESET_SIZES = [
  { cols: 4, rows: 4 },
  { cols: 8, rows: 8 },
  { cols: 16, rows: 16 },
];

/**
 * 换尺寸 = 换一局棋。
 *
 * 回合上限与开局**必须跟着回落**到新尺寸的预设值：开局库按尺寸分级，
 * 沿用旧的 id 会得到一个在新尺寸下不存在的开局；而回合上限也是每档单独给的
 * （4×4 是 30，其余是 90）。留着旧值不报错，只是那一局不是任何一档预设。
 */
function setSize(cols: number): void {
  const hit = PRESET_SIZES.find((s) => s.cols === cols);
  if (!hit) return;
  const p = presetFor(hit.cols, hit.rows);
  store.duel.cols = hit.cols;
  store.duel.rows = hit.rows;
  store.duel.turnLimit = p.rules.turnLimit;
  store.duel.openingId = p.openings[0]?.id ?? "";
  save(store);
  syncGameUi();
  newGame();
}

/** 开局选择器：用 monospace 字符网格画出形状，不只是文字名称 */
function renderOpenings(): void {
  const host = $("openingList");
  host.innerHTML = preset()
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
    .join("");
  for (const b of host.querySelectorAll<HTMLButtonElement>("button[data-opening]")) {
    b.onclick = () => {
      store.duel.openingId = b.dataset.opening ?? store.duel.openingId;
      save(store);
      renderOpenings();
      newGame();
    };
  }
}

function syncGameUi(): void {
  renderSizeButtons();
  renderOpenings();

  $<HTMLSelectElement>("inpTopology").value = store.duel.topology;
  $<HTMLInputElement>("inpTurnLimit").value = String(store.duel.turnLimit);
  $<HTMLInputElement>("inpAnim").checked = store.duel.animations;
  $<HTMLInputElement>("inpParticles").checked = store.duel.particles;

  const rules = currentRules();
  $("rulesNote").textContent =
    t("game.rulesNote", {
      life: Math.round(rules.lifeWinRatio * 100),
      ls: rules.lifeStreak,
      death: Math.round(rules.deathWinRatio * 100),
      ds: rules.deathStreak,
    }) +
    " " +
    (preset().calibrated ? "" : t("game.rulesUncalibrated"));
}

function validateTurnLimit(): boolean {
  const n = Number($<HTMLInputElement>("inpTurnLimit").value);
  const bad = !Number.isInteger(n) || n < 1;
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
  d.topology = $<HTMLSelectElement>("inpTopology").value === "torus" ? "torus" : "bounded";
  d.turnLimit = clampTurnLimit($<HTMLInputElement>("inpTurnLimit").value, d.turnLimit);
  d.animations = $<HTMLInputElement>("inpAnim").checked;
  d.particles = $<HTMLInputElement>("inpParticles").checked;
  save(store);
  syncGameUi();
  if (restart) newGame();
}

/**
 * ⚠ T15 的接口（此处刻意只留注释，不留半截代码）：
 *
 * 动效开关（`store.duel.animations` / `particles`）目前**没有任何消费者** ——
 * T14 没有 `render.ts`。T15 接上渲染器时，要接的是
 * `syncGameUi()` 结尾处那一个位置（`renderer.animations = store.duel.animations`），
 * 而不是回头去找「哪个开关该喂给谁」。
 *
 * 不在这里先写一个空转的转发函数：一个没人读的变量会让「开关生效了吗」
 * 变成一个查不出来的问题。
 */
function bindGameSettings(): void {
  // 定义博弈的两项：改了就重开（理由见 applyDuelSettings）
  $("inpTurnLimit").addEventListener("change", () => {
    if (validateTurnLimit()) applyDuelSettings(true);
  });
  $("inpTopology").addEventListener("change", () => applyDuelSettings(true));
  // 纯画面：改了不重开
  for (const id of ["inpAnim", "inpParticles"]) {
    $(id).addEventListener("change", () => applyDuelSettings(false));
  }
}

function resetDuelSettings(): void {
  const p = presetFor(store.duel.cols, store.duel.rows);
  store.duel.topology = p.defaultTopology;
  store.duel.turnLimit = p.rules.turnLimit;
  store.duel.openingId = p.openings[0]?.id ?? "";
  store.duel.animations = true;
  store.duel.particles = true;
  store.duel.paceMs = 1200;
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
  $("roleHint").textContent = t("strategy.perRoleNote");
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
  syncRoleTabs();
}

function applyRoleSettings(): void {
  const s = store.roles[state.role];
  s.ruleNote = $<HTMLTextAreaElement>("ruleNote").value;
  s.strategyHint = $<HTMLTextAreaElement>("hintText").value;
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
    o.textContent = b.needsKey ? `${name}${b.verified ? " ✓" : t("backend.unverifiedTag")}` : name;
    selBackend.appendChild(o);
  }
  selBackend.value = keep;
}

/** 状态栏的后端标签 —— **单一来源**，别在别处另写一份 */
function updateBackendLabel(): void {
  const s = store.roles[state.role];
  const b = BACKENDS[s.provider];
  const name = t(b.labelKey);
  const label = b.needsKey || !staticHost ? name : t("backend.remoteSuffix", { label: name });
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
  el.textContent = b.verified
    ? t("backend.verified") + (b.needsKey ? note : "")
    : t("backend.unverified") + note;
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
      const hit = presetFor(r.duel.cols, r.duel.rows);
      store.duel = {
        ...store.duel,
        cols: hit.cols,
        rows: hit.rows,
        topology: r.duel.topology === "torus" ? "torus" : hit.defaultTopology,
        turnLimit: clampTurnLimit(r.duel.turnLimit, hit.rules.turnLimit),
        openingId: hit.openings.find((o) => o.id === r.duel?.openingId)?.id ?? hit.openings[0]?.id ?? "",
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
  chart.redraw();
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
    "bToggle", "bStep", "bNew", "bResult", "pace", "paceVal",
    "bLang", "langLbl", "bGame", "bStrategy", "bApi", "bLog", "bArchive",
    "scrim", "dGame", "dStrategy", "dApi", "dLog", "dArchive", "toast", "fileInput",
    "sizeList", "inpTopology", "inpTurnLimit", "turnLimitWarn", "rulesNote",
    "openingList", "inpAnim", "inpParticles", "bGameReset", "bGameDone",
    "roleHint", "ruleNote", "hintText", "inpPredict", "inpDetect",
    "inpMemory", "memoryVal", "bMemMax", "inpStrategy", "thresholdRow",
    "inpThreshold", "thresholdVal", "inpChannel", "bStrategySync", "bStrategyReset", "bStrategyDone",
    "selBackend", "inpKey", "keyHint", "inpBase", "inpModel", "advancedApi", "modelHint", "backendNote",
    "inpRetryMax", "inpRetryBase", "retryPreview", "bApiSync", "bApiReset", "bApiSave", "bApiClose",
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
      turnLimit: store.duel.turnLimit,
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
