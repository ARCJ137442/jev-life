/**
 * 配置持久化。
 *
 * 写入 localStorage 的只有**非敏感**内容：对局级设置、双方玩家的设置、重试参数。
 * API Key 绝不落盘 —— 它只存在于内存（代理模式下更是连浏览器都拿不到）。
 *
 * ═══ 分成两级：对局级 / 玩家级（DESIGN 第七节）═══
 *
 * | 级别 | 项 | 判据 |
 * |---|---|---|
 * | 对局级 | 尺寸 / 拓扑 / 终局规则 / 开局 | 它们是**博弈的定义**，两边不同就不是同一个游戏 |
 * | 玩家级 | 后端 / 模型 / 上下文 / 决策策略 / 阈值 … | 描述**这个玩家怎么想** |
 *
 * 2048 那套「影响谁的输入」的判据在生命棋里失效了（规则不自明、换后端就是换
 * 一套 prompt 构造方式，两者**都**影响模型的输入）。这一版按级别分。
 *
 * ★ **后端与模型是玩家级的**，这一条不能退。跨模型对照（Jev 当生执、LLM 当死执）
 * 恰恰要求两边能选不同的后端；后端若只有一份，这个配置根本配不出来。
 * 代价是「双侧同步」必须是一个**动作**（把 A 的玩家级设置整体复制到 B），
 * 否则每换一次对照都要手配两遍。见 `main.ts` 的 `syncRoleSettings()`。
 */
import type { Role, Topology } from "../core/types.js";
import { MAX_SIZE, MIN_SIZE } from "../core/types.js";
// 只借它的**类型**：能力表（谁收哪些档位）住在 broker 里，界面不另抄一份
// —— 抄一份的话，往能力表里加一个上游时界面会照旧标注「不支持」
import type { LlmReasoningEffort } from "../shared/llm-broker.js";
import type { Channel } from "../core/channels.js";
import type { Strategy } from "../core/decide.js";
import type { BackendId } from "./api.js";
import { BACKENDS } from "./api.js";
import { detectLang, type Lang } from "./i18n.js";
// 落子相时长的出厂值住在渲染器里（那里记着它的来历与那次归因教训）——
// 这里引用它而不是抄一个数字：抄一份的话，改了一处就会得到
// 「恢复默认之后动画速度与刚装好时不一样」这种没人查得出来的差异
import { FLIP_MS } from "./render.js";
import { PRESETS } from "../core/presets.js";
import type { SizePreset } from "../core/presets.js";

const KEY = "jevlife.v1";

/* ══════════════ 对局级 ══════════════ */

export interface DuelSettings {
  /**
   * 棋盘尺寸。**长与宽各自 2~16**，可以是任意非方尺寸。
   *
   * ═══ 预设与自由输入是两层，不是互相取代 ═══（ui-spec 第五节）
   *
   * | 层 | 尺寸 | 代价 |
   * |---|---|---|
   * | **预设** | 4 / 8 / 16 正方形 | 它们带**成套的标定参数**（开局库、回合上限、阈值） |
   * | **自定义** | 长宽各自 2~16，可非方 | 参数由用户自己负责，界面会标明「未标定」 |
   *
   * 所以「尺寸合法」与「尺寸有预设」是两件事，判据分别是 `MIN_SIZE/MAX_SIZE`
   * 与 `isPresetSize()`。把它们合成一条（早先的写法）会让 7×11 这类尺寸
   * 被静默改写成 8×8 —— 用户填的值消失，而且没有任何提示。
   */
  cols: number;
  rows: number;
  topology: Topology;
  /**
   * 回合上限。
   *
   * ★ 它**同时是「游戏」项与「模型输入」**：`core/context.ts` 的 `horizon`
   * 会把「本局共 N 回合，当前第 T 回合」写进 state。所以把 90 改成 60 之后
   * 重开一局，**概率分布必须变化** —— 那是关卡二的验收标准之一。
   */
  turnLimit: number;
  /**
   * 开局 id。开局库按尺寸分级，换尺寸时它会自动落到该尺寸的第一项。
   *
   * ★ **空串 = 「自定义」**，不是「还没选」。它有两个来源，而且语义相同：
   *   - 用户手绘了开局（画完就把这一项清空）
   *   - 尺寸不是预设（4/8/16）—— 那些尺寸**没有开局库**，只能从空棋盘开始画
   *
   * 用一个哨兵值而不是另加一个 `custom: boolean`：两处状态表达同一件事时，
   * 迟早会出现「custom 为真、openingId 却指着一个真开局」这种谁也说不清的组合，
   * 而界面上那句话究竟是哪一个说了算，得看到代码才知道。
   */
  openingId: string;
  animations: boolean;
  /** 落子处的发光粒子 */
  particles: boolean;
  paceMs: number;
  /**
   * 落子相时长（ms）—— **整套动画的节奏**，见 `render.ts` 的 `BoardRenderer.flipMs`。
   *
   * 放在对局级而不是玩家级：它纯粹是画面，两个行动方没有各自的「动画速度」。
   * 与 `paceMs` 也不是一回事 —— 那个是**两次调用之间**等多久，这个是**一次
   * 落子演多久**，两者互不影响（paceMs = 0 时上游一返回就直接往下走，
   * 但动画仍然按它自己的节奏演完）。
   */
  flipMs: number;
}

/* ══════════════ 玩家级 ══════════════ */

/**
 * 评估通道。
 *
 * M1 只有 `noul-all`（每个合法格一道布尔题）。类型上留成字符串而不是
 * `"noul-all"` 字面量，是为了 T13 补 `choice-all` / `choice-filtered` 时
 * 存档不用改版本号 —— 不认识的通道在载入时回落到 `noul-all`。
 */
export type ChannelId = string;

export interface RoleSettings {
  provider: BackendId;
  base: string;
  model: string;
  channel: ChannelId;
  strategy: Strategy;
  /** 置信度门槛 0–1。0 表示不启用 */
  threshold: number;
  /** 记忆轮数：0 = 不加入；null = 最大（在上下文预算内塞满） */
  memory: number | null;
  /** 后果预测 → 写进题面当**背景**（默认关） */
  predictOutcome: boolean;
  /** 自动结构识别 → aids.detected_patterns（**默认开**） */
  detectPatterns: boolean;
  /** 规则说明（补充）→ rules.rule_note */
  ruleNote: string;
  /** 策略提示 → aids.strategy_hint */
  strategyHint: string;

  /* ══════════ LLM 调用配置（只在选用 LLM 后端时有消费者）══════════
   *
   * 四项都**持久化**：换回 Jev 后端再换回来，设置还在（ui-spec 第五节）。
   * 它们描述的是「怎么跟模型谈」，而玩家级设置本来就是「描述这个玩家怎么想」。
   *
   * ⚠ 这四个值**不直接下发**。UI 的枚举是面向多后端的**并集**，而各上游收的
   * 值不一样（实测：agnes 的 `reasoning_effort` 只接受 none|low|medium|high|max，
   * **不收 xhigh**，直接发会 400 把整个决策请求打掉）。真正的收敛由
   * `llm-broker` 的 `capabilitiesOf()` / `clampEffort()` 做 —— 见 `main.ts`
   * 的 `llmCallOf()`。
   */

  /**
   * 思维链开关（默认**关**）。
   *
   * 实测：两个后端都从 0–63% 升到 **100%**，快 5–40 倍，推理 token 归零。
   * 更硬的理由是它**从结构上消灭了「推理吃光预算」这个失败模式** ——
   * 那是观察到的唯一失败原因。
   */
  chainOfThought: boolean;
  /**
   * 是否允许思考（是 / 否 / 留空）。默认留空。
   *
   * 与 `effort === "none"` 语义重叠，所以两者是**耦合**的：前者选「否」时
   * 强度显示 `none`；强度选 `none` 时前者自动显示「否」。
   */
  allowThinking: "" | "yes" | "no";
  /**
   * 思考强度。默认**留空**。
   *
   * ⚠ 实测六个档位里只有 `none` 与「留空」能跑通，四个显式档位全部劣于不设
   * （3/3 → 0–1/3）。所以界面上必须带那句警示 —— **保留控件、默认留空、
   * 把实测写进提示**，让人知情地选（只有一个后端的数据，别家可能不同，
   * 所以不建议直接删掉控件）。
   */
  effort: "" | LlmReasoningEffort;
  /** 调用策略：JSON 输出 / 工具循环。默认 JSON（实测快 2–4 倍） */
  callPolicy: "json" | "tool";
}

/** 非敏感的重试参数。两个玩家共用 —— 它描述的是「本机怎么等」，不是「这个玩家怎么想」 */
export interface ApiSettings {
  retryMax: number | null;
  retryBaseMs: number;
}

/**
 * 存档那一层需要的三块设置。
 *
 * 单独取一个名字而不是直接收 `Persisted`：存档**不该碰界面语言**，
 * 也不该碰任何将来会加进 `Persisted` 的界面状态。收窄成这三块之后，
 * 「导出里混进了不该导出的东西」在类型上就发生不了。
 */
export interface ArchiveSettings {
  duel: DuelSettings;
  roles: Record<Role, RoleSettings>;
  api: ApiSettings;
}

export interface Persisted {
  duel: DuelSettings;
  /** 双方各自的设置。键的顺序即渲染顺序（life 在前） */
  roles: Record<Role, RoleSettings>;
  api: ApiSettings;
  /**
   * 界面语言。刻意放在顶层而**不放进任何一级设置**：它是应用级设置，
   * 不该被「恢复默认」连坐重置。
   */
  lang: Lang;
}

/* ══════════════ 默认值 ══════════════ */

/** 默认尺寸是设计文档的基准档（8×8）。它的内区恰好 4×4，开局库也最完整 */
const DEFAULT_COLS = 8;
const DEFAULT_ROWS = 8;

/**
 * 尺寸是否命中预设之一（4 / 8 / 16 正方形）。
 *
 * **它问的不是「尺寸合法吗」** —— 合法范围是 2~16（`MIN_SIZE`/`MAX_SIZE`），
 * 比预设宽得多。两者的后果完全不同：不合法的尺寸要拒绝，非预设的尺寸只是
 * 「参数未标定」。
 */
export function isPresetSize(cols: number, rows: number): boolean {
  return PRESETS.some((p) => p.cols === cols && p.rows === rows);
}

/**
 * 取某一档预设的参数（规则、开局库、默认拓扑）。
 *
 * ⚠ **非预设尺寸也会返回一个预设**（8×8 那档），因为规则里那些阈值总得有个值。
 * 这是刻意的降级而不是 bug —— 但要配合 `isPresetSize()` 使用：界面必须把
 * 「这些参数不是为这个尺寸标的」显示出来，否则用户会以为 7×11 上的胜负线
 * 与 8×8 上的一样有依据。
 */
export function presetFor(cols: number, rows: number): SizePreset {
  return (
    PRESETS.find((p) => p.cols === cols && p.rows === rows) ?? (PRESETS[1] ?? PRESETS[0])
  );
}

/** 某个尺寸下的默认回合上限 —— 取自预设，不是写死的常量（4×4 是 30，其余是 90） */
function defaultTurnLimit(cols: number, rows: number): number {
  return presetFor(cols, rows).rules.turnLimit;
}

function defaultOpeningId(cols: number, rows: number): string {
  const preset = presetFor(cols, rows);
  return preset.openings[0]?.id ?? "";
}

export const DEFAULT_DUEL: DuelSettings = {
  cols: DEFAULT_COLS,
  rows: DEFAULT_ROWS,
  topology: presetFor(DEFAULT_COLS, DEFAULT_ROWS).defaultTopology,
  turnLimit: defaultTurnLimit(DEFAULT_COLS, DEFAULT_ROWS),
  openingId: defaultOpeningId(DEFAULT_COLS, DEFAULT_ROWS),
  animations: true,
  particles: true,
  paceMs: 1200,
  flipMs: FLIP_MS,
};

export const DEFAULT_API: ApiSettings = {
  retryMax: 3,
  retryBaseMs: 800,
};

/**
 * 一个玩家级设置的出厂值。
 *
 * 两个玩家**用同一份默认**（而不是各写一份）—— 出厂状态下 Jev vs Jev 应当
 * 是公平的；「两边不一样」是用户主动配出来的对照条件，不是默认条件。
 */
export function defaultRole(): RoleSettings {
  return {
    provider: "localproxy",
    base: BACKENDS.localproxy.base,
    model: BACKENDS.localproxy.model,
    channel: "noul-all",
    strategy: "greedy",
    threshold: 0,
    memory: 0,
    predictOutcome: false,
    detectPatterns: true,
    ruleNote: "",
    strategyHint: "",
    chainOfThought: false,
    allowThinking: "",
    effort: "",
    callPolicy: "json",
  };
}

/* ══════════════ 校验 ══════════════ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function sizeInRange(v: number): boolean {
  return Number.isFinite(v) && v >= MIN_SIZE && v <= MAX_SIZE;
}

/**
 * 把一对尺寸读成合法值。**只卡 2~16 这一条**，不再要求它命中预设。
 *
 * 与 `presetFor` 分开是必要的：预设是「参数标定过的那几档」，合法范围是
 * 「引擎算得出来的那些」。早先这里按预设卡，于是手填的 7×11 会被**静默**
 * 换成 8×8 —— 用户填的值没了，而且不报错。
 */
export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = Math.round(Number(cols));
  const r = Math.round(Number(rows));
  return sizeInRange(c) && sizeInRange(r)
    ? { cols: c, rows: r }
    : { cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
}

function clampTopology(v: unknown, fallback: Topology): Topology {
  return v === "torus" || v === "bounded" ? v : fallback;
}

export function clampTurnLimit(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(999, Math.max(1, n));
}

/**
 * 步进间隔。下限是 **0** —— 那不是「没有间隔」，而是「不等待」：
 * 上游响应多快就多快，用于测极限速度。
 *
 * 注意不能用 `Number(v) || 默认值` 兜底：0 是 falsy，会被吞掉换成默认值，
 * 于是「选了最快」变成「回到默认」，而且没有任何报错。
 */
export function clampPace(v: unknown): number {
  if (v === "" || v === null || v === undefined) return DEFAULT_DUEL.paceMs;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DUEL.paceMs;
  return Math.min(5000, Math.max(0, Math.round(n)));
}

/**
 * 落子相时长。范围卡在 200–5000ms。
 *
 * 下限不是 0：0 表示「这一相不存在」，那正是 `animations` 开关的语义 ——
 * 两个控件表达同一件事，用户会在「动效关着但时长非 0」这种状态上卡住。
 * 上限 5000 是「再长就不像动画了，像卡住」。
 */
export function clampFlipMs(v: unknown): number {
  if (v === "" || v === null || v === undefined) return DEFAULT_DUEL.flipMs;
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_DUEL.flipMs;
  return Math.min(5000, Math.max(200, Math.round(n)));
}

export function clamp01(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 记忆轮数上限（防止 UI 滑块给出荒谬值） */
export const MAX_MEMORY = 60;

/** 重试次数上限（UI 侧护栏，无限重试用 null 表示） */
export const MAX_RETRY = 20;

function clampMemory(v: unknown): number | null {
  if (v === null) return null;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_MEMORY, n));
}

function clampStrategy(v: unknown): Strategy {
  return v === "sample" || v === "threshold" ? v : "greedy";
}

function clampBackend(v: unknown): BackendId {
  return typeof v === "string" && v in BACKENDS ? (v as BackendId) : "localproxy";
}

function clampChannel(v: unknown): ChannelId {
  return v === "noul-all" ? v : "noul-all";
}

/**
 * 开局：id 在**该尺寸**下存在才认，否则回落到该尺寸的第一项。
 *
 * 两条早退，都是「自定义」这个状态的入口：
 *   - 存的就是空串 —— 用户手绘过，或者当时选的就是「自定义」
 *   - 尺寸不是预设 —— 非预设尺寸**没有开局库**，任何一个开局 id 在这里都
 *     没有意义（`presetFor` 会降级返回 8×8 那档，照着它去 `build(cols, rows)`
 *     会拿到一副形状完全不同的棋盘，甚至因结构重叠当场抛错）
 */
export function clampOpeningId(v: unknown, cols: number, rows: number): string {
  if (v === "") return "";
  if (!isPresetSize(cols, rows)) return "";
  const preset = presetFor(cols, rows);
  const hit = typeof v === "string" ? preset.openings.find((o) => o.id === v) : undefined;
  return hit?.id ?? preset.openings[0]?.id ?? "";
}

/** 把某个玩家的设置变成 `core/channels.ts` 的 `Channel` */
export function channelOf(settings: RoleSettings): Channel {
  // backend 只在布尔族通道上出场：判别值（noul / boolean）是「怎么跟上游说话」
  // 的细节，代理那边还会按它自己的上游再归一化一次
  return { kind: "noul-all", backend: settings.provider };
}

/* ══════════════ 读写 ══════════════ */

function safeParse(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const o: unknown = JSON.parse(raw);
    return isObj(o) ? o : null;
  } catch {
    return null;
  }
}

function readRole(raw: unknown): RoleSettings {
  const d = defaultRole();
  if (!isObj(raw)) return d;
  const provider = clampBackend(raw.provider);
  const preset = BACKENDS[provider];
  return {
    provider,
    // 代管后端的端点与模型由服务端决定：存档里存过什么一律作废，
    // 否则改一次服务端路由，老存档就会指着一条不存在的路径
    base: preset.managed ? preset.base : typeof raw.base === "string" && raw.base ? raw.base : preset.base,
    model: preset.managed ? preset.model : typeof raw.model === "string" ? raw.model : preset.model,
    channel: clampChannel(raw.channel),
    strategy: clampStrategy(raw.strategy),
    threshold: clamp01(raw.threshold),
    memory: raw.memory === null ? null : clampMemory(raw.memory ?? 0),
    predictOutcome: raw.predictOutcome === true,
    // ★ 默认开：只有显式存过 false 才关。写成 `?? true` 会让 undefined 走对，
    // 但会让「存过 null」这类脏数据也变成开 —— 这里只认布尔
    detectPatterns: raw.detectPatterns === undefined ? d.detectPatterns : raw.detectPatterns === true,
    ruleNote: typeof raw.ruleNote === "string" ? raw.ruleNote : d.ruleNote,
    strategyHint: typeof raw.strategyHint === "string" ? raw.strategyHint : d.strategyHint,
    // 认不出的档位一律回落到「留空」（= 用上游默认）。**不往最近的档位上凑**：
    // 降级成 none 会悄悄改语义（用户要的是「多想一点」，你给它「不许想」），
    // 而降级成别的档位更是凭空替用户做了决定 —— 与 clampEffort 同一条理由
    chainOfThought: raw.chainOfThought === true,
    allowThinking:
      raw.allowThinking === "yes" || raw.allowThinking === "no" ? raw.allowThinking : "",
    effort: isEffort(raw.effort) ? raw.effort : "",
    callPolicy: raw.callPolicy === "tool" ? "tool" : "json",
  };
}

/** 认得出的思考强度档位。与 `llm-broker` 的并集同源，但**在运行时**校验 */
function isEffort(v: unknown): v is LlmReasoningEffort {
  return (
    v === "none" ||
    v === "low" ||
    v === "medium" ||
    v === "high" ||
    v === "xhigh" ||
    v === "max"
  );
}

export function load(): Persisted {
  const o = safeParse(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY));

  const rawLang = o?.lang;
  const lang: Lang = rawLang === "en" || rawLang === "zh" ? rawLang : detectLang();

  const rawDuel = isObj(o?.duel) ? o.duel : {};
  const size = clampSize(rawDuel.cols ?? DEFAULT_DUEL.cols, rawDuel.rows ?? DEFAULT_DUEL.rows);
  const preset = presetFor(size.cols, size.rows);

  const rawApi = isObj(o?.api) ? o.api : {};
  const rawRoles = isObj(o?.roles) ? o.roles : {};

  return {
    duel: {
      cols: size.cols,
      rows: size.rows,
      topology: clampTopology(rawDuel.topology, preset.defaultTopology),
      turnLimit: clampTurnLimit(rawDuel.turnLimit, preset.rules.turnLimit),
      openingId: clampOpeningId(rawDuel.openingId, size.cols, size.rows),
      animations: rawDuel.animations !== false,
      particles: rawDuel.particles !== false,
      paceMs: clampPace(rawDuel.paceMs),
      flipMs: clampFlipMs(rawDuel.flipMs),
    },
    roles: {
      life: readRole(rawRoles.life),
      death: readRole(rawRoles.death),
    },
    api: {
      retryMax:
        rawApi.retryMax === null
          ? null
          : Math.max(0, Math.min(MAX_RETRY, Math.round(Number(rawApi.retryMax ?? DEFAULT_API.retryMax) || 0))),
      retryBaseMs: Math.max(
        100,
        Math.min(10_000, Number(rawApi.retryBaseMs ?? DEFAULT_API.retryBaseMs) || 800),
      ),
    },
    lang,
  };
}

export function save(p: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式 / 配额满 —— 静默降级，不影响游戏 */
  }
}
