/**
 * 配置持久化。
 *
 * 写入 localStorage 的只有**非敏感**内容：对局级设置、双方玩家的设置、重试参数。
 * API Key 绝不落盘 —— 它只存在于内存（代理模式下更是连浏览器都拿不到）。
 *
 * ═══ 分成两级：对局级 / 玩家级（DESIGN 第六节）═══
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
import type { GameRules, Mode, Role, Topology } from "../core/types.js";
import { MAX_SIZE, MIN_SIZE } from "../core/types.js";
import { DEFAULT_TEMPLATES, TEMPLATE_KEYS } from "../core/template.js";
import type { RuleTemplates } from "../core/template.js";
// 能力表（谁收哪些档位）住在 broker 里，界面**不另抄一份** —— 抄一份的话，
// 往能力表里加一个上游时界面会照旧标注「不支持」。`clampEffort` 因此是
// **运行期**依赖，不只是类型。
import { clampEffort, type LlmReasoningEffort } from "../shared/llm-broker.js";
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
  /**
   * 对局模式（双人对弈 / 纯生执单人）。
   *
   * 它是对局级的：两边不同就不是同一个游戏。改它**等于换一局** ——
   * 半局中把死之执抽走，前几回合的记录里那些死之执落点就成了无法解释的数据。
   */
  mode: Mode;
  topology: Topology;
  /**
   * 回合上限。**`null` = 不设上限**（留空即此，见 `GameRules.turnLimit`）。
   *
   * ★ 它**同时是「游戏」项与「模型输入」**：`core/context.ts` 的 `horizon`
   * 会把「本局共 N 回合，当前第 T 回合」写进 state。所以把 90 改成 60 之后
   * 重开一局，**概率分布必须变化** —— 那是关卡二的验收标准之一。
   *
   * 不设上限时 `horizon` 写的是「本局**不设回合上限**」，而不是一个巨大的数：
   * 后者会让模型以为「还有很多回合，不急」，而那是一条凭空造出来的规则。
   */
  turnLimit: number | null;
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

  /* ══════════ 胜负线（对局级）══════════
   *
   * ★ **T14 曾把它们定成只读**，理由是「预设标着 `calibrated: false`，做成
   * 四个可调项会暗示它们已经标定过」。那个顾虑仍然成立，但**解法不是藏起来、
   * 而是标注**（用户 2026-09-21 定）：藏起来并不能让它变准，只会让人以为它
   * 不可调。所以四个值开放，界面上同时明说「占位值、未经跑分标定」。
   *
   * 它们**进入发给 Jev 的 state**（`core/context.ts` 的 `win_condition` 与
   * `termination_conditions` 都按它们现拼），所以改完重开一局，概率分布
   * **应当**变化 —— 那是这一档设置的验收标准。
   *
   * 两条线倒挂（死之执的线 ≥ 生之执的线）不禁止，但界面会说明 —— 见
   * `main.ts` 的 `syncGameUi`。禁止它要凭空替用户判断什么值「合理」，
   * 而这四个数恰恰是拿来试的。
   */

  /** 活细胞占比 ≥ 此值且连续保持 lifeStreak 回合 → 生之执获胜 */
  lifeWinRatio: number;
  /** ≤ 此值且连续保持 deathStreak 回合 → 死之执获胜 */
  deathWinRatio: number;
  /** 防抖：连续越界多少回合才算赢。两侧分开，因为博弈本身不对称 */
  lifeStreak: number;
  deathStreak: number;
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
  /**
   * 规则说明书的模板（六项）→ `rules` 里对应那六项。
   *
   * 与 `ruleNote` 同级（玩家级）：`ruleNote` 是**补充**，这六份是**正文**。
   * 正文之所以能被编辑，是因为模板把「措辞」与「数值」分开了 —— 措辞由这里
   * 定，数值永远来自 `store.duel` 与当前局面（见 `core/template.ts` 文件头）。
   *
   * ⚠ 空串 = **用出厂措辞**（`renderTemplates` 里逐项回落），不是「这一项不要」。
   * 六项里任意一项空了，发给模型的都是一条空规则 —— 那正是「对 Jev 说谎」。
   */
  templates: RuleTemplates;

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
function defaultTurnLimit(cols: number, rows: number): number | null {
  return presetFor(cols, rows).rules.turnLimit;
}

function defaultOpeningId(cols: number, rows: number): string {
  const preset = presetFor(cols, rows);
  return preset.openings[0]?.id ?? "";
}

export const DEFAULT_DUEL: DuelSettings = {
  cols: DEFAULT_COLS,
  rows: DEFAULT_ROWS,
  // 出厂是双人对弈：那是跨模型对照的载体，也是这个项目的主线
  // ★ 单人局是默认模式（用户 2026-09-21 定）。它是「改默认」不是「强制」——
  // 存档与本地设置里存过 mode 的一律照旧，只有新用户与「恢复默认」走这里
  mode: "solo",
  topology: presetFor(DEFAULT_COLS, DEFAULT_ROWS).defaultTopology,
  turnLimit: defaultTurnLimit(DEFAULT_COLS, DEFAULT_ROWS),
  // 胜负线的出厂值**取自预设**，不另写一份字面量：抄一份的话，改预设里的
  // 阈值时这里不会跟着动，于是「恢复默认」得到的不是出厂那一局
  lifeWinRatio: presetFor(DEFAULT_COLS, DEFAULT_ROWS).rules.lifeWinRatio,
  deathWinRatio: presetFor(DEFAULT_COLS, DEFAULT_ROWS).rules.deathWinRatio,
  lifeStreak: presetFor(DEFAULT_COLS, DEFAULT_ROWS).rules.lifeStreak,
  deathStreak: presetFor(DEFAULT_COLS, DEFAULT_ROWS).rules.deathStreak,
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
    // 出厂模板 = 这一层存在之前那段文案（`context.test.ts` 有一条对拍用例）
    templates: { ...DEFAULT_TEMPLATES },
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

/**
 * 回合上限。**空串与 null 都表示「不设上限」**（用户 2026-09-21 定）。
 *
 * ⚠ 这两种输入必须与 `undefined`（= 这个键根本没存过）分开：
 *   - `""` / `null` → **不设上限**，那是用户或存档的明确选择
 *   - `undefined` 或认不出的值 → 回落到该尺寸的预设值
 * 合并的话，一份老存档（没有这个键）会变成「无上限对局」—— 而它本来是
 * 90 回合的一局，症状是「这局怎么一直不结束」。
 */
export function clampTurnLimit(v: unknown, fallback: number | null): number | null {
  if (v === "" || v === null) return null;
  if (v === undefined) return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(999, Math.max(1, n));
}

/**
 * 胜负线（比例）。范围就是 0~1 —— 它是占比，超出这个范围没有意义。
 *
 * ⚠ **不在这里做「不含 0 也不含 1」之类的合理性判断**：0 与 1 都是合法的
 * 极限设置（「一格都不许有」/「占满才算赢」），而 `classifyTermination`
 * 对它们都有确定行为。替用户挡掉它们等于替用户判断什么值「合理」。
 */
export function clampRatio(v: unknown, fallback: number): number {
  const n = parseNum(v);
  if (n === null) return fallback;
  return Math.min(1, Math.max(0, n));
}

/** 防抖轮数。下限 1：0 轮意味着「单代越界就判胜」，那正是防抖要挡掉的东西 */
export function clampStreak(v: unknown, fallback: number): number {
  const n = parseNum(v);
  if (n === null) return fallback;
  return Math.min(99, Math.max(1, Math.round(n)));
}

/**
 * 「用户到底填了没有」—— 空串与 null/undefined 一律算**没填**，回落到原值。
 *
 * 这四个数上格外要紧：**0 是它们的合法取值**（「一格都不许有」），所以不能用
 * 「0 是 falsy」那套老办法区分，只能显式判空。把「清空输入框」读成 0，会让
 * 「删掉重打」这个动作顺手把胜负线改成一条极端的线，而且没有任何提示。
 *
 * （`clampPace` 记的是同一类坑的另一面：那边栽在 `Number(v) || 默认值`
 * 把合法的 0 吞掉。）
 */
function parseNum(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 某一档尺寸的出厂规则。键名短，是为了下面那四行读起来还是「一列」 */
export function presetRulesFor(cols: number, rows: number): GameRules {
  return presetFor(cols, rows).rules;
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

/**
 * 把一份来路不明的模板读完。
 *
 * 两条入口的**信任级别不同**，所以这个函数必须在**用的时候**调，而不是只在
 * `load()` 里调一次：`load()` 那条（localStorage）已经过 `readRole`，
 * 但**导入存档那条不走它** —— `archive.ts` 的 `asRole` 只做形状兜底
 * （`{ ...defaultRole(), ...raw }`），一个手改过的存档可以把任意值塞进模板，
 * 然后它一路流到 `buildState` 去。这里逐项要求「是字符串」，其余回落出厂措辞。
 */
export function templatesOf(src: unknown): RuleTemplates {
  const o = isObj(src) ? src : {};
  const out = {} as RuleTemplates;
  for (const key of TEMPLATE_KEYS) {
    const v = o[key];
    out[key] = typeof v === "string" ? v : DEFAULT_TEMPLATES[key];
  }
  return out;
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
    // 逐项校验：存档里的模板是用户可改的文本，认不出的值（不是字符串）
    // 一律回落到出厂措辞。**不做 trim**：空白由渲染那一层统一判「等于没填」
    templates: templatesOf(raw.templates),
    // 认不出的档位一律回落到「留空」（= 用上游默认）。**不往最近的档位上凑**：
    // 降级成 none 会悄悄改语义（用户要的是「多想一点」，你给它「不许想」），
    // 而降级成别的档位更是凭空替用户做了决定 —— 与 clampEffort 同一条理由
    chainOfThought: raw.chainOfThought === true,
    allowThinking: isAllowThinking(raw.allowThinking) ? raw.allowThinking : "",
    effort: isEffort(raw.effort) ? raw.effort : "",
    callPolicy: raw.callPolicy === "tool" ? "tool" : "json",
  };
}

/**
 * 三个思考控件的**耦合**，写成一个纯函数而不是散在事件回调里。
 *
 * 判据（ui-spec 第五节「两个思考控件的耦合」，用户定）：
 *
 *   - 「是否允许思考」选**否** → 强度置灰显示 `none`
 *   - 强度选 **`none`** → 「是否允许思考」自动显示**否**
 *   - 两者任一落到 `none` → 思维链开关也显示**关**（它们是同一件事的三种说法）
 *   - 反过来：开了思维链、或把强度拨到别的档位 → 「否」自动解除
 *
 * 三处状态说的是同一件事，所以必须有一个**唯一**的地方把它们对齐 —— 散在
 * 三个 `onchange` 里迟早会漏掉一条（症状是界面显示「允许思考：否」而思维链
 * 是开的，而下发时按哪一条算只有看代码才知道）。
 *
 * @param changed 刚被动的是哪一个。**双向耦合必须知道方向**：把「否」翻成
 *                「是」与把强度从 `none` 拨开，要做的事情不一样
 */
export function coupleLlmSettings(
  s: RoleSettings,
  changed: "cot" | "allow" | "effort",
): RoleSettings {
  const out: RoleSettings = { ...s };

  if (changed === "cot") {
    if (!out.chainOfThought) {
      // 关掉思维链 = 明确不想让它想。强度跟着回到「留空」（下次开起来还是
      // 用户上一轮选的样子），「是否允许思考」也回到留空
      out.effort = "";
      out.allowThinking = "";
    } else if (out.allowThinking === "no" || out.effort === "none") {
      // 打开思维链 = 允许它想。原先那些「不许想」的表达要一并解除
      out.allowThinking = "";
      if (out.effort === "none") out.effort = "";
    }
    return out;
  }

  if (changed === "allow") {
    if (out.allowThinking === "no") {
      out.effort = "none";
      out.chainOfThought = false;
    } else if (out.allowThinking === "yes") {
      out.chainOfThought = true;
      if (out.effort === "none") out.effort = "";
    }
    // 选「留空」时**不动另外两个**：留空是「不说」，不该顺手改掉已经说过的
    return out;
  }

  // changed === "effort"
  if (out.effort === "none") {
    out.allowThinking = "no";
    out.chainOfThought = false;
  } else if (out.effort !== "") {
    out.allowThinking = "";
    out.chainOfThought = true;
  }
  return out;
}

/** 三个控件的原始表单值。`<select>` 的两个是**未校验的字符串** */
export interface LlmControlForm {
  readonly cot: boolean;
  readonly allow: string;
  readonly effort: string;
}

/**
 * **表单值 → 设置**，再对齐耦合。
 *
 * ═══ 为什么这一步要单独存在 ═══
 *
 * 它曾经整个缺失：`commitLlmSettings` 直接拿 store 里的旧值去耦合，**从来
 * 没有读过界面控件**。于是三个控件全部失效 —— 点开关 → store 没变 →
 * `syncLlmUi()` 立刻按旧值重画 DOM → 开关弹回原状。用户看到的是「灰的、
 * 点不动」（关的颜色本来就是灰的），而根因和界面显示的东西毫无关联。
 *
 * 拆出来的直接好处是**这一步现在可测**：DOM 读取只剩调用方那一行，
 * 判断全在这里，无头环境断言得了。这与 `coupleLlmSettings` 分开写的理由
 * 是同一条 —— 上一次 `callPolicy` 出同样的错，就是因为判据埋在回调里，
 * 没有任何测试覆盖得到。
 *
 * ⚠ 两个 `<select>` 的值**必须过校验**再进 store：它们是未校验的字符串，
 * 直接塞进去会让存档里出现认不出的档位。复用 `roleSettingsOf` 归一化存档
 * 用的同一对判据（`isAllowThinking` / `isEffort`），不另抄一份。
 *
 * @param changed 刚被动的是哪一个 —— 耦合有方向，见 `coupleLlmSettings`
 */
export function withLlmControls(
  s: RoleSettings,
  form: LlmControlForm,
  changed: "cot" | "allow" | "effort",
): RoleSettings {
  const next: RoleSettings = { ...s };
  if (changed === "cot") {
    next.chainOfThought = form.cot;
  } else if (changed === "allow") {
    next.allowThinking = isAllowThinking(form.allow) ? form.allow : "";
  } else {
    next.effort = isEffort(form.effort) ? form.effort : "";
  }
  return coupleLlmSettings(next, changed);
}

/**
 * 三个思考控件 → **一个**期望下发的思考强度。
 *
 * `null` 表示**明确要求「不发这个字段」**（用上游自己的默认），与
 * 「客户端没意见」是两回事 —— 后者在这个界面上不存在，因为开关永远有值。
 * 见 `shared/backend.ts` 的 `LlmCallOptions.effort`。
 *
 * 优先级：思维链关（一票否决）→ 「是否允许思考 = 否」→ 强度档位 → 留空。
 * 前三者最终都落到 `none`，与实测口径一致（`none` 与「留空」同为 3/3，
 * 四个显式档位全部劣于不设）。
 */
export function desiredEffort(s: RoleSettings): LlmReasoningEffort | null {
  if (!s.chainOfThought) return "none";
  if (s.allowThinking === "no") return "none";
  if (s.effort === "none") return "none";
  if (s.effort !== "") return s.effort;
  return null;
}

/**
 * 期望的档位到了这条上游手里会不会被丢掉。
 *
 * 界面据此标注「该后端不支持，已降级为默认」—— **在下发之前**就说，
 * 而不是等一个 400 回来再解释（那时报错离原因已经很远）。
 *
 * `null`（留空）不算降级：那本来就是「不发这个字段」。
 */
export function effortDegraded(s: RoleSettings, upstream: string): boolean {
  const want = desiredEffort(s);
  return want !== null && clampEffort(want, upstream) === undefined;
}

/**
 * 认得出的「是否允许思考」取值。与界面下拉的三个 option 一一对应。
 *
 * 与 `isEffort` 同一条纪律：**判据只写一份**。存档归一化（`roleSettingsOf`）
 * 与界面读回（`main.ts` 的 `commitLlmSettings`）走的是同一个函数 ——
 * 界面另抄一份的话，往枚举里加一个取值时两边会各自演化，
 * 而症状是「存盘认得、界面读回不认得」，离原因很远。
 */
export function isAllowThinking(v: unknown): v is "" | "yes" | "no" {
  return v === "" || v === "yes" || v === "no";
}

/** 认得出的思考强度档位。与 `llm-broker` 的并集同源，但**在运行时**校验 */
export function isEffort(v: unknown): v is LlmReasoningEffort {
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
      mode: rawDuel.mode === "solo" ? "solo" : "duel",
      topology: clampTopology(rawDuel.topology, preset.defaultTopology),
      turnLimit: clampTurnLimit(rawDuel.turnLimit, preset.rules.turnLimit),
      lifeWinRatio: clampRatio(rawDuel.lifeWinRatio, preset.rules.lifeWinRatio),
      deathWinRatio: clampRatio(rawDuel.deathWinRatio, preset.rules.deathWinRatio),
      lifeStreak: clampStreak(rawDuel.lifeStreak, preset.rules.lifeStreak),
      deathStreak: clampStreak(rawDuel.deathStreak, preset.rules.deathStreak),
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
