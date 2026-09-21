/**
 * Jev–LLM broker：把 Jev 形状的请求翻译成 LLM 调用，再把回包翻译回 Jev 形状。
 *
 * ═══ 它在四层架构里的位置 ═══
 *
 *   游戏态势
 *      │   { model, state, questions }        ← Jev 形状
 *      ▼
 *   Jev 兼容 API        ← 上层只认这一层
 *      │
 *      ▼
 *   Jev–LLM broker      ← **本文件**
 *      │   { model, messages, response_format }
 *      ▼
 *   LLM 提供商（OpenAI 兼容）
 *
 * **本文件是纯函数，不碰网络、不碰 DOM、不读环境变量。** 发请求由调用方
 * （`src/server/server.ts` 的服务端代理、`api/_upstream.ts`）负责。
 * 这样它可以被单测穷举，而网络那部分只剩「怎么发」这一点点逻辑。
 *
 * ═══ 为什么 broker 放服务端而不是浏览器 ═══
 *
 * 1. **密钥不落地浏览器**（与其余几条上游同一条纪律）
 * 2. **客户端一行不用改** —— 翻译在服务端做掉之后，`llm-json` 后端对客户端而言
 *    与 `systemone` 完全一样，只是 base 不同。上层「分不出对面是谁」，
 *    这正是 `DESIGN.md` 第八节那条约束要的效果
 *
 * ═══ 实测依据（详见 docs/llm-backends.md）═══
 *
 * - **默认关思维链**：两个后端实测 0–63% → 100%，且从结构上消灭了
 *   「推理吃光预算」这个失败模式（观察到的唯一失败原因）
 * - **空 content + finish_reason=length 必须当失败**，不能当正常回包
 *   （HTTP 200，看着像成功，实际什么都没答）
 * - **reasoningTokens 单独记账**（可占输出的 100%）
 */

import type { Answer, Criteria, Question, Questions } from "./types.js";

/** 只依赖用到的那几个字段，避免与 `typeof fetch` 的重载集纠缠 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/* ══════════════════════════════════════════════════════════════════
   请求侧：Jev 形状 → LLM 形状
   ══════════════════════════════════════════════════════════════════ */

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  /** 只有 assistant 消息有：它必须**原样回述**，否则上游会拒收随后的 tool 消息 */
  readonly tool_calls?: readonly LlmToolCallWire[];
  /** 只有 tool 消息有：对应哪一次 tool_call */
  readonly tool_call_id?: string;
}

/**
 * 线上形态的 tool_call —— 回包里的原样形状，**与 `LlmToolCall` 不是一回事**。
 *
 * 分两个类型是因为它们的用途相反：`LlmToolCallWire` 是「上游发来的原文」，
 * 而 `LlmToolCall` 是「我们要回述出去的东西」。回述时**必须带上 `type: "function"`**
 * —— 少了它上游会拒收整个会话。
 */
export interface LlmToolCallWire {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface LlmRequest {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly response_format: { readonly type: "json_object" };
  readonly max_tokens: number;
  /**
   * 关思维链（`"none"`）。**默认想要的就是它** —— 实测依据见文件头。
   *
   * ⚠ **可选，且上游不认识这个字段时整项不发。** 不能「反正 `none` 是我们要的
   * 就一律发出去」：实测有上游对未知枚举**严格校验**（agnes 对 `xhigh` 直接 400），
   * 猜错的代价是整个决策请求被打掉，而报错离原因很远 —— 与判别值那次是同一类事故。
   */
  readonly reasoning_effort?: LlmReasoningEffort;
}

/**
 * 思考强度的合法取值。
 *
 * ⚠ **这是「并集」，不是任何一个后端都全收的**。实测 agnes（SGLang）只接受
 * `none | low | medium | high | max`，**没有 `xhigh`** —— 直接发出去会
 * **400 把整个请求打掉**。
 *
 * 所以下发前必须过 `capabilitiesOf()`：不支持的取值**不发**（留空用后端默认），
 * 而不是原样塞进请求体。UI 上也应标注「该后端不支持，已降级为默认」。
 */
export type LlmReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * 协议族 —— 「用户自备 base URL」那两条后端的身份。
 *
 * ⚠ **它们是「协议」，不是「厂商」。** 能力表按它索引，是因为**能收哪些参数
 * 由协议决定**（Anthropic 协议里压根没有 `reasoning_effort` 这个字段），
 * 而不是因为某一家网关碰巧做了什么。这与 `agnes` 那条按**具体上游**索引的
 * 条目是两种东西，别把它们混成一类。
 */
export type LlmProtocol = "openai" | "anthropic";

export const OPENAI_COMPAT_UPSTREAM = "openai-compat";
export const ANTHROPIC_COMPAT_UPSTREAM = "anthropic-compat";

export interface UpstreamCapabilities {
  /**
   * 该上游**认不认识** `reasoning_effort` 这个字段。
   *
   * `false` 时整个字段不发 —— 见 `LlmRequest.reasoning_effort` 那段注释。
   */
  readonly supportsEffort: boolean;
  /** 认识的话，接受哪些取值 */
  readonly reasoningEfforts: readonly LlmReasoningEffort[];
}

/**
 * 各上游的能力表。
 *
 * ⚠ **不在表里的上游，字段一律不发。** 这是刻意的保守选择：
 * 不发的代价是「拿不到关思维链的收益」（质量问题），
 * 发错值的代价是「整个决策请求 400」（可用性问题）—— 后者严重得多，
 * 而且报错离真正的原因很远。
 *
 * 所以**新增一个上游时，要实测它收哪些值再往这里加**，不要凭「它也是 OpenAI 兼容的」
 * 就假定它收。
 */
const CAPABILITIES: Record<string, UpstreamCapabilities> = {
  // 实测：none / low / medium / high / max 全收，**xhigh 报 400**
  agnes: { supportsEffort: true, reasoningEfforts: ["none", "low", "medium", "high", "max"] },

  // ── 协议族（用户自备 base URL 的两条）──
  //
  // ⚠ 这两条的**依据强度与 `agnes` 那条不同**，不要混着看：
  // 后者是「在这一家网关上逐档实测」，前者是「在这个协议上验过两个独立实现」
  // （Agnes 的 SGLang 与 DeepSeek）。用户填的地址可能来自我们没见过的第三家 ——
  // 「OpenAI 兼容」这个承诺是否真的成立，取决于那一家。
  //
  // 保守方向仍然是「不发」：收不了的档位一律不发，代价是拿不到关思维链的收益
  // （质量问题），发错值的代价是整个决策请求 400（可用性问题）。
  [OPENAI_COMPAT_UPSTREAM]: {
    supportsEffort: true,
    reasoningEfforts: ["none", "low", "medium", "high", "max"],
  },
  // Anthropic 协议里**没有** `reasoning_effort`。它能表达「关思考」的方式是
  // `thinking: {type:"disabled"}` —— 所以这一族只认 `none`，其余档位一律不发
  // （见 `anthropicThinking`）。实测：Agnes 的 Anthropic 端点上
  // `thinking:{type:"disabled"}` 回 200；`reasoning_effort` 也回 200 但**看不出
  // 效果**（n=1，只能算观察），所以不赌它。
  [ANTHROPIC_COMPAT_UPSTREAM]: { supportsEffort: true, reasoningEfforts: ["none"] },
};

const UNKNOWN: UpstreamCapabilities = { supportsEffort: false, reasoningEfforts: [] };

export function capabilitiesOf(upstream: string): UpstreamCapabilities {
  return CAPABILITIES[upstream] ?? UNKNOWN;
}

/**
 * 把一个「思考强度」的期望值收敛成该上游真的能收的值。
 *
 * **收不了时返回 `undefined`（= 不发这个字段）**，而不是降级成某个档位 ——
 * 降级成 `none` 会悄悄改变语义（用户要的是「多想一点」，你给它「不许想」），
 * 而降级成别的档位更是凭空替用户做了决定。不发 = 用上游默认，是唯一中性的选择。
 */
export function clampEffort(
  desired: LlmReasoningEffort | undefined,
  upstream: string,
): LlmReasoningEffort | undefined {
  if (desired === undefined) return undefined;
  const cap = capabilitiesOf(upstream);
  if (!cap.supportsEffort) return undefined;
  return cap.reasoningEfforts.includes(desired) ? desired : undefined;
}

/**
 * 三态 effort → 最终下发的那个值（或 `undefined` = 不发）。
 *
 * ★ **两条调用策略（JSON / 工具循环）必须走同一个函数。** 思考强度的收敛是
 * 「这个上游收什么」的知识，与「用哪种协议问」无关；各写一份迟早会走样，
 * 而走样的症状是「换一个调用策略，思维链开关就失灵了」——离原因很远。
 *
 * 三态的理由见 `toLlmRequest` 的 `opts.effort`：省略 → 默认姿态 `none`；
 * `null` → 明确要求不发（**连能力表都不查**）；档位 → 过能力表。
 */
export function resolveEffort(
  desired: LlmReasoningEffort | null | undefined,
  upstream: string,
): LlmReasoningEffort | undefined {
  return desired === null ? undefined : clampEffort(desired ?? "none", upstream);
}

/** 默认的输出上限。够 64 个布尔答案，又不会被无限推理拖住 */
export const DEFAULT_MAX_TOKENS = 4000;

const SYS_PREFIX =
  "你在为一个棋盘博弈做决策。你会收到一段局面描述和若干问题，" +
  "每个问题都要给出一个 0 到 1 之间的概率。";

const JSON_SHAPE =
  '只输出 JSON，形如 {"answers":[{"key":"原样的题目标识符","value":0.72}]}，' +
  "不要任何其他文字。每个问题都要给出一条，key 必须原样返回。";

/**
 * 两种协议**共用**这两段提示词。
 *
 * ⚠ 抽出来不是为了少写几行：提示词是**实验变量**。两条协议各写一份，
 * 迟早会在某次改动里走样，而走样的症状是「换一种协议，成功率就变了」——
 * 于是「协议」与「提示词」这两个变量被搅在一起，对照实验作废。
 * 实测依据（`docs/llm-backends.md` 第三节）那张成功率表用的是同一份提示词。
 */
function systemPrompt(shape: string, effort: LlmReasoningEffort | null | undefined): string {
  // ⚠ 这一行判的是**调用方显式传了 `"none"`**，而不是「最终下发的 effort 是 none」。
  // 于是默认路径（调用方省略 effort）下：请求体里带着 `reasoning_effort: "none"`，
  // 提示词里却**没有**这句「直接给出答案」。两者说的其实是同一件事。
  // 没顺手改的理由：提示词是**实验变量**，而这条不一致没有实测依据支撑改哪一边
  // （`docs/llm-backends.md` 那张成功率表来自探针脚本，不是这份提示词）。
  // 要改之前先测 —— 别把它当成一处笔误。
  return [SYS_PREFIX, effort === "none" ? "直接给出答案，不要展开推理过程。" : "", shape]
    .filter(Boolean)
    .join(" ");
}

function userPrompt(state: unknown, questions: Questions): string {
  const keys = Object.keys(questions);
  const lines = keys.map((k) => `- ${k}: ${questionText(questions[k])}`);
  return [
    "当前局面：",
    JSON.stringify(state, null, 1),
    "",
    `请回答以下 ${keys.length} 个问题：`,
    ...lines,
  ].join("\n");
}

/**
 * Jev 形状 → LLM 形状。
 *
 * 纯函数：不改动入参。
 */
export function toLlmRequest(
  model: string,
  state: unknown,
  questions: Questions,
  opts: {
    readonly upstream: string;
    /**
     * 期望的思考强度。**三态**（与 `shared/backend.ts` 的 `LlmCallOptions.effort` 同源）：
     *
     *   - 省略 → 用默认姿态 `none`（关思维链），这是实测最好的那一档
     *   - `null` → **明确要求「不发这个字段」**，用上游自己的默认
     *   - 具体档位 → 过 `clampEffort`，收不了就不发
     *
     * `null` 不能与「省略」合并：界面上「留空」是一次明确的选择
     * （实测与 `none` 同为 3/3，而四个显式档位全部劣于不设）。
     */
    readonly effort?: LlmReasoningEffort | null;
    readonly maxTokens?: number;
  },
): LlmRequest {
  // 关思维链是**默认姿态**（实测依据见文件头）。上游不认识这个字段就**整个不发** ——
  // 不能回落到 "none"：那是在猜它能收，而猜错的代价是整个请求 400。
  const effort = resolveEffort(opts.effort, opts.upstream);

  return {
    model,
    messages: [
      { role: "system", content: systemPrompt(JSON_SHAPE, opts.effort) },
      { role: "user", content: userPrompt(state, questions) },
    ],
    response_format: { type: "json_object" },
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  };
}

/**
 * 把一条 `Question` 摊平成给模型看的一句话。
 *
 * `criteria` 的形状随类型而异（`DESIGN.md` 与 `shared/types.ts` 有说明），
 * 这里只处理生命棋实际会用到的两种。**遇到不认识的形状要抛错，不能静默产出
 * 一句空话** —— 一句空话会让模型去猜，而它猜出来的东西会混进统计里。
 */
export function questionText(q: Question): string {
  if (q.type === "noul" || q.type === "boolean") {
    const c = q.criteria as { true?: string; false?: string };
    const yes = c?.true ?? "是";
    const no = c?.false ?? "否";
    return `${q.instructions}（倾向「${yes}」就给高分、倾向「${no}」就给低分；给一个 0 到 1 的数）`;
  }
  if (q.type === "choice") {
    const c = q.criteria as Record<string, string>;
    const opts = Object.keys(c ?? {});
    return `${q.instructions}（从这些里选：${opts.join(" / ")}）`;
  }
  throw new Error(`LLM broker 暂不支持的问题类型：${q.type}`);
}

/* ══════════════════════════════════════════════════════════════════
   响应侧：LLM 形状 → Jev 形状
   ══════════════════════════════════════════════════════════════════ */

/**
 * broker 自己的错误类型 —— 调用方据此决定重试还是直接报错。
 *
 * ⚠ **这里刻意不用 TypeScript 的「构造函数参数属性」**（`constructor(readonly x: T)`），
 * 写法比现在啰嗦但必须如此：
 *
 * `api/_upstream.ts` 会在 **Node 的 strip-only 模式**下 import 本文件
 * （`src/test/normalize.test.ts` 为了配假 fetch 抓请求体而直接运行它）。
 * 参数属性能生成运行时代码，而 strip-only **只擦类型不做代码生成** ——
 * 用了它会在 import 的那一刻抛：
 *
 *     SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
 *     TypeScript parameter property is not supported in strip-only mode
 *
 * 同一条约束对本文件里的**任何**代码都成立：**不能用 `enum`、`namespace`、
 * 参数属性、装饰器**。加运行期代码之前先想一下这一条。
 */
export class BrokerError extends Error {
  /** 是否值得重试。**「模型没答」值得重试，「模型答错形状」也值得**（实测是偶发的） */
  readonly retryable: boolean;
  /** 上游报的结束原因，便于统计 */
  readonly finishReason: string | undefined;

  constructor(message: string, retryable = true, finishReason?: string) {
    super(message);
    this.name = "BrokerError";
    this.retryable = retryable;
    this.finishReason = finishReason;
  }
}

/**
 * 从 LLM 的回包里取出 `content`，并**在它是空的时候抛错**。
 *
 * ★ 这是本文件最重要的一处判断。实测的失败形态只有一种：
 *
 *     finish_reason: "length" + content 为空字符串
 *
 * **HTTP 200，看着像成功，实际什么都没答。** 若不在这里拦住，它会以一个
 * 「答案数 0」的结果流进统计，表现成「模型不行」——而真正的原因是推理把
 * `max_tokens` 吃光了。**症状与原因无关**，正是本项目反复出现的那个母题。
 */
export function extractContent(choice: {
  readonly message?: { readonly content?: string | null };
  readonly finish_reason?: string;
} | undefined): string {
  if (!choice) throw new BrokerError("回包里没有 choices[0]", true);

  const content = choice.message?.content ?? "";
  if (content.trim() === "") {
    const fr = choice.finish_reason ?? "未知";
    throw new BrokerError(
      fr === "length"
        ? "上游把输出预算全部用在了推理上，没有产出答案（finish_reason=length）"
        : `上游返回了空的 content（finish_reason=${fr}）`,
      true,
      fr,
    );
  }
  return content;
}

/**
 * 解析 LLM 给出的 JSON，翻译回 Jev 形状的 `answers`。
 *
 * 容错是**刻意收窄**的：只接受 `{"answers":[...]}`（或裸数组），
 * 每条必须有 `key` 与数值型 `value`。**不接受「差不多」的形状** ——
 * 猜出来的答案会混进统计，而混进去之后没法分辨。
 *
 * ⚠ 返回的题数**可能少于**给定的题数。调用方必须检查：
 * 这与「答案为空」是两回事，但对决策而言同样是残缺的。
 */
/**
 * 剥掉整段包住正文的 markdown 代码围栏。
 *
 * ★ **这条是端到端跑真 key 才发现的**（纯函数的形状测试全绿）：
 * OpenAI 那边带了 `response_format: {type:"json_object"}`，回的是裸 JSON；
 * **Anthropic 协议没有这个字段可发**，于是同一份提示词、同一个模型，
 * 回的是
 *
 *     ```json
 *     {"answers":[…]}
 *     ```
 *
 * 不剥的话，JSON 路径（`callPolicy` 的**默认值**）在这条协议上 100% 失败，
 * 而失败文案是「上游输出的不是合法 JSON」—— 看着像模型不听话，
 * 真正的原因在协议少了一个字段。**症状与原因无关**，又一个。
 *
 * ⚠ **只在围栏包住整段正文时才剥。** 围栏前面还有别的话时**不猜** ——
 * 往前找 JSON 等于替模型决定「哪一段才是答案」，而猜出来的东西会混进统计。
 * 要放宽这条边界，先有实测依据说明放宽能救回多少。
 *
 * 纯函数：不改动入参。
 */
function unwrapFence(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstLineEnd = trimmed.indexOf("\n");
  if (firstLineEnd === -1) return trimmed;
  const body = trimmed.slice(firstLineEnd + 1);
  // 取**最后**一个围栏：这样「围栏 + 后面跟一句话」也认得出来
  const close = body.lastIndexOf("```");
  return close === -1 ? trimmed : body.slice(0, close);
}

export function fromLlmContent(content: string, questions: Questions): Record<string, Answer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(unwrapFence(content));
  } catch {
    throw new BrokerError(`上游输出的不是合法 JSON：${content.slice(0, 120)}`, true);
  }

  const raw = Array.isArray(parsed)
    ? parsed
    : (parsed as { answers?: unknown } | null)?.answers;

  if (!Array.isArray(raw)) {
    throw new BrokerError(
      `上游输出的 JSON 里没有 answers 数组：${content.slice(0, 120)}`,
      true,
    );
  }

  const type = upstreamTypeFor(questions);
  const out: Record<string, Answer> = {};
  for (const item of raw) {
    const key = (item as { key?: unknown })?.key;
    const value = (item as { value?: unknown })?.value;
    // 键必须是**问过的**那些 —— 模型凭空多答一个键，是它跑偏的信号，
    // 放进去会让「答案数」这个统计失真
    if (typeof key !== "string" || !(key in questions)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = { type: type as Answer["type"], noul: clamp01(value) } as Answer;
  }

  if (Object.keys(out).length === 0) {
    throw new BrokerError(
      `上游没答出任何一道题（原始 answers 有 ${raw.length} 条，但键或值都不合法）`,
      true,
    );
  }
  return out;
}

/**
 * 概率落在 0~1 之外时的处理：**夹住，不丢弃**。
 *
 * 实测模型偶尔会回 1.5 或 -0.2 这类值。丢弃它等于白跑一次调用，
 * 而夹住至少保住了这一题的信息。代价是它确实是被改过的值 ——
 * 所以调用方统计时应当能看出「这一题被夹过」。
 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 这一组问题的布尔答案该用哪个判别值。
 *
 * 与 `shared/types.ts` 的 `noulDiscriminator` 是同一件事，但这里按
 * **题目的形状**推（`criteria` 是 `{true,false}` 就是布尔族），而不是按后端 id ——
 * broker 不该关心客户端叫它什么。
 */
function upstreamTypeFor(questions: Questions): string {
  const first = Object.values(questions)[0];
  if (!first) return "noul";
  const c = first.criteria as Criteria;
  if (!Array.isArray(c) && typeof c === "object" && "true" in c) return first.type;
  return first.type;
}

/* ══════════════════════════════════════════════════════════════════
   给调用方的一条捷径
   ══════════════════════════════════════════════════════════════════ */

/** 从 OpenAI 兼容回包里取出 usage（含推理 token） */
export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * 其中属于推理的部分。
   *
   * **没报就是 0，不是 `null`** —— 与 `costUsd` 的语义不同：
   * 「不知道价格」和「没有推理」是两回事。
   */
  readonly reasoningTokens: number;
}

/* ══════════════════════════════════════════════════════════════════
   工具循环路径（`callPolicy = "tool"`）
   ══════════════════════════════════════════════════════════════════

   ★ **循环本身不在这里。** broker 是纯函数：不碰网络、不碰 DOM、不读环境变量。
   所以这里只有三块积木 —— 拼请求、解析 tool_call、拼回包消息 ——
   而 `for` 那个循环落在真正发请求的那一层（`src/server/server.ts` 与
   `api/_upstream.ts`，两处同源的重复）。

   实测依据（`docs/llm-backends.md` 第三节）：

   - N = 1/6/12/24 各 2 次，**8/8 全成功、上游调用次数恒为 1** ——
     模型总是选择一轮全答完。所以这里**不主动限制每轮批量**，
     由模型自己在「省往返」与「稳妥」之间权衡，而那个权衡本身就是要测的东西
   - 于是 `remaining` 回包**在实测里从未被用到**（第二轮都没进过）。
     **保留它**（低成本保险），但**不要声称它被验证过** ——
     要测它得构造一个必然分多轮的场面（N 远大于单次输出上限）
*/

/** 工具名。**它来自实测脚本，不是一个随手的命名** —— 改了等于换一个实验条件 */
export const ANSWER_TOOL_NAME = "answer_questions";

/**
 * 工具定义。
 *
 * ⚠ `parameters` 是**真的 JSON Schema**，不是 `DESIGN.md` 第八节那段简化示意 ——
 * 后者是写给人读的（`{"answers":[{...}]}` 这种写法上游不认）。
 * 这里的形状与 `../llm-lab/batch.mjs` 逐字一致，因为那份是跑通过的。
 *
 * `minItems: 1` 是「一次可答 ≥1 个」那条设计的落点。**刻意不设 `maxItems`** ——
 * 卡成 1 的话 24 题就是 24 次往返，而实测模型自己会收敛到「一轮全答」。
 */
export function answerTool(): LlmToolDefinition {
  return {
    type: "function",
    function: {
      name: ANSWER_TOOL_NAME,
      description:
        "回答一个或多个问题。可以一次只答一个，也可以一次答多个。" +
        "key 必须是题目给定的原样标识符，value 是判断的概率（0 到 1）。",
      parameters: {
        type: "object",
        properties: {
          answers: {
            type: "array",
            minItems: 1,
            description: "本轮要回答的问题，至少要有一条",
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "题目的原样标识符" },
                value: { type: "number", description: "判断的概率，0 到 1" },
              },
              required: ["key", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["answers"],
        additionalProperties: false,
      },
    },
  };
}

/** 一次工具调用的形状，从上游回包里取出来之后的样子 */
export interface LlmToolCall {
  readonly id: string;
  readonly name: string;
  /** 原始 arguments 字符串，**未解析** —— 解析要按 questions 过滤，属于下一步 */
  readonly argumentsJson: string;
}

export interface LlmToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface LlmToolRequest {
  readonly model: string;
  readonly messages: readonly LlmMessage[];
  readonly tools: readonly LlmToolDefinition[];
  /** `auto`：把「这轮答几个、要不要答」交给模型 —— 实测它就收敛到一轮全答 */
  readonly tool_choice: "auto";
  readonly max_tokens: number;
  /** 与 JSON 路径同一套收敛，见 `resolveEffort` */
  readonly reasoning_effort?: LlmReasoningEffort;
}

const TOOL_SHAPE =
  `用 ${ANSWER_TOOL_NAME} 工具回答问题。可以一次只答一个，也可以一次答多个；` +
  "key 必须原样返回。每次调用后我会告诉你还剩几题。";

/**
 * Jev 形状 → LLM 工具调用形状。
 *
 * 与 `toLlmRequest` 的差别只有两处：**不带 `response_format`**（形状改由 schema
 * 约束），以及带 `tools` / `tool_choice`。`response_format` 与 `tools` 是两条互斥
 * 的路，同时发出去上游行为如何**没有实测过** —— 不拿没测过的组合去跑对照实验。
 *
 * 纯函数：不改动入参。
 */
export function buildToolRequest(
  model: string,
  state: unknown,
  questions: Questions,
  opts: {
    readonly upstream: string;
    /** 三态，语义与 `toLlmRequest` 完全一致（见那里的注释） */
    readonly effort?: LlmReasoningEffort | null;
    readonly maxTokens?: number;
  },
): LlmToolRequest {
  const effort = resolveEffort(opts.effort, opts.upstream);

  return {
    model,
    messages: [
      { role: "system", content: systemPrompt(TOOL_SHAPE, opts.effort) },
      { role: "user", content: userPrompt(state, questions) },
    ],
    tools: [answerTool()],
    tool_choice: "auto",
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(effort === undefined ? {} : { reasoning_effort: effort }),
  };
}

/**
 * 从回包里取出 tool_calls。
 *
 * ★ **工具路径的「空 content + finish_reason=length」在这里拦。**
 * 实测观察到的唯一失败形态是推理把预算吃光 —— 此时 `content` 为空、
 * **一个 tool_call 都不发**，而 HTTP 是 200。`extractContent` 管不了这件事：
 * 工具调用成功时 `content` 本来就可能为 null（实测回包正是如此），
 * 所以不能拿「content 空」当判据，得看**有没有 tool_calls**。
 *
 * 三种「没有 tool_call」的情形要分开报，因为它们指向完全不同的处置：
 *   1. 预算烧光（`finish_reason: "length"`）→ 值得重试，或把预算调大
 *   2. 模型回了一段文字（通常是提示词没让它用工具）→ 重试也是白搭，要看提示词
 *   3. 回包结构就不对（没有 choices[0]）→ 上游或网关的问题
 * **归成一个「模型没答」就等于把三种故障混成一栏统计** —— 那是踩过的坑。
 */
export function extractToolCalls(
  choice:
    | {
        readonly message?: { readonly content?: string | null; readonly tool_calls?: unknown };
        readonly finish_reason?: string;
      }
    | undefined,
): LlmToolCall[] {
  if (!choice) throw new BrokerError("回包里没有 choices[0]", true);

  const fr = choice.finish_reason ?? "未知";
  const raw = choice.message?.tool_calls;

  if (Array.isArray(raw) && raw.length > 0) {
    const out: LlmToolCall[] = [];
    for (const t of raw) {
      const c = t as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      // 没有 id 就没法回述 tool 消息（`tool_call_id` 是必填的），整条丢掉
      if (typeof c?.id !== "string") continue;
      out.push({
        id: c.id,
        name: typeof c.function?.name === "string" ? c.function.name : ANSWER_TOOL_NAME,
        argumentsJson: typeof c.function?.arguments === "string" ? c.function.arguments : "{}",
      });
    }
    if (out.length === 0) {
      throw new BrokerError(`回包里有 ${raw.length} 条 tool_calls，但没有一条带 id`, true, fr);
    }
    return out;
  }

  const content = choice.message?.content ?? "";
  if (content.trim() === "") {
    throw new BrokerError(
      fr === "length"
        ? "上游把输出预算全部用在了推理上，一个 tool_call 都没发（finish_reason=length）"
        : `上游既没有调用工具，content 也是空的（finish_reason=${fr}）`,
      true,
      fr,
    );
  }
  throw new BrokerError(
    `上游回了文字而不是工具调用（finish_reason=${fr}）：${content.slice(0, 120)}`,
    true,
    fr,
  );
}

/**
 * 一次工具调用的参数 → Jev 形状的答案。
 *
 * 容错口径与 `fromLlmContent` **刻意一致**：键必须在问过的那些里、值必须是有限数、
 * 越界夹住不丢弃。坏 JSON / 缺 `answers` **返回空映射而不抛** ——
 * 与实测脚本 `catch { /* 坏参数忽略 *\/ }` 的处理一致：
 * 一条坏参数不该炸掉整轮，它只是这一轮没答出东西，由**调用方**判断这算不算失败
 * （「一轮一个有效答案都没有」才是失败，见循环那一层）。
 *
 * 纯函数：不改动入参。
 */
export function answersFromToolArguments(
  argumentsJson: string,
  questions: Questions,
): Record<string, Answer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return {};
  }
  return answersFromToolInput(parsed, questions);
}

/**
 * 同上，但入参已经是**解析好的对象**。
 *
 * ★ 分出这一支是因为 **Anthropic 协议的 `tool_use.input` 就是对象**，不是
 * OpenAI 那种 JSON 字符串（实测回包：
 * `{"type":"tool_use","id":"call_…","name":"answer_questions","input":{…}}`）。
 * 照抄 OpenAI 那条路会先 `JSON.parse` 一个对象 —— 那会抛，
 * 而按「坏参数忽略」的口径，症状是**每一轮都收下零个答案**、
 * 循环空转到轮次上限才报一个与原因无关的错。
 *
 * 容错口径与 `answersFromToolArguments` 完全一致（键要在问过的那些里、
 * 值要是有限数、越界夹住不丢弃、坏形状返回空映射而不抛）。
 * 纯函数：不改动入参。
 */
export function answersFromToolInput(input: unknown, questions: Questions): Record<string, Answer> {
  const raw = (input as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(raw)) return {};

  const type = upstreamTypeFor(questions);
  const out: Record<string, Answer> = {};
  for (const item of raw) {
    const key = (item as { key?: unknown })?.key;
    const value = (item as { value?: unknown })?.value;
    if (typeof key !== "string" || !(key in questions)) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    out[key] = { type: type as Answer["type"], noul: clamp01(value) } as Answer;
  }
  return out;
}

/**
 * 告诉模型**还剩多少**的那条回包。
 *
 * ⚠ **实测里它从未被用到**（8/8 都是一轮答完，循环第二轮都没进）。
 * 保留它是因为成本极低，而一旦碰上「N 远大于单次输出上限」的场面，
 * 没有它模型就无从知道还剩什么 —— 但**不要声称它被验证过**。
 */
export function toolResultMessage(
  toolCallId: string,
  accepted: readonly string[],
  remaining: number,
  remainingKeys: readonly string[],
): LlmMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify({ accepted, remaining, remaining_keys: remainingKeys }),
  };
}

/**
 * 复述 assistant 那一次 `tool_calls`。
 *
 * **不回述的话上游会拒收随后的 tool 消息** —— OpenAI 兼容协议要求每条 tool
 * 消息前面必须有对应的 assistant tool_calls。`content` 原样带过去
 * （实测成功时它是 `null`，这可能就是模型此刻的全部交代）。
 */
export function assistantToolCallsMessage(
  content: string | null,
  calls: readonly LlmToolCall[],
): LlmMessage {
  return {
    role: "assistant",
    content: content ?? null,
    // 回述时 `type: "function"` 是必填的 —— 少了它上游会拒收整个会话
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: c.argumentsJson },
    })),
  };
}

export function usageOf(payload: unknown): LlmUsage {
  const u =
    (payload as {
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        completion_tokens_details?: { reasoning_tokens?: number };
      };
    } | null)?.usage ?? {};
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/* ══════════════════════════════════════════════════════════════════
   Anthropic 兼容协议（`POST {base}/messages`）
   ══════════════════════════════════════════════════════════════════

   ★ 为什么 broker 要说两种协议：**用户自备 key 的后端没有那层服务端**。
   代管那条的路径是「客户端发 Jev 形状 → 服务端翻译 → 上游」，而 GitHub Pages
   上连 Serverless 都没有 —— 翻译只能发生在浏览器里。broker 本来就是纯函数，
   两边都能跑，缺的只是第二种协议的形状知识（见 `docs/llm-backends.md` 第零节）。

   ⚠ **下面每一处形状都来自实测**，不是照协议文档推的（本项目栽过
   「文档说一套、网关做一套」那一次）。实测环境：2026-09-21，
   Agnes 的 Anthropic 兼容端点。与技术文档的差异只有一处，且已记在下面对应位置。
*/

/** `POST {base}/xxx` 该拼哪个后缀 —— 拼错是 404，而 404 与「后端挂了」长得一样 */
const ENDPOINT_PATH: Record<LlmProtocol, string> = {
  openai: "/chat/completions",
  anthropic: "/messages",
};

/**
 * 把用户填的 base 补成真正的端点。
 *
 * **两种粘法都得能用**：填 `https://api.deepseek.com/v1`（版本根）由我们补后缀，
 * 或者直接把 `https://api.deepseek.com/v1/chat/completions` 整个粘进来。
 * 后者是很多人从文档里复制的形态 —— 重复拼一次就是 404，而那个 404
 * 会被报成「后端暂时不可用」，症状离原因很远。
 */
export function llmEndpoint(base: string, protocol: LlmProtocol): string {
  const trimmed = base.replace(/\/+$/, "");
  const path = ENDPOINT_PATH[protocol];
  return trimmed.endsWith(path) ? trimmed : trimmed + path;
}

/** 实测回包里 `content[]` 的元素。**只有这三种与本项目有关** */
export interface AnthropicTextBlock {
  readonly type: "text";
  readonly text: string;
}
export interface AnthropicToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  /** ★ **对象**，不是 JSON 字符串 —— 与 OpenAI 的 `arguments` 不是一回事 */
  readonly input: unknown;
}
export interface AnthropicToolResultBlock {
  readonly type: "tool_result";
  readonly tool_use_id: string;
  readonly content: string;
}
export type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

/**
 * ⚠ `role` 只有这两种 —— **Anthropic 协议里没有 `system` 角色**。
 * 系统提示是顶层的一个字符串参数（见 `AnthropicRequest.system`）。
 * 把它塞进 `messages` 会被当成用户消息，而模型会照做、不报错 ——
 * 症状是「提示词里的约束好像不起作用」。
 */
export interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicBlock[];
}

export interface AnthropicRequest {
  readonly model: string;
  /** ★ **顶层**，不在 `messages` 里 */
  readonly system: string;
  readonly messages: readonly AnthropicMessage[];
  /** 协议要求必填（与 OpenAI 那边可选不同），我们永远发 */
  readonly max_tokens: number;
  /**
   * 关思考。**这是 Anthropic 协议表达「关思维链」的**方式 ——
   * `reasoning_effort` 是 OpenAI 那一侧的字段，这里没有。
   *
   * 与 `LlmRequest.reasoning_effort` 一样是**可选且不支持就整项不发**：
   * 发一个上游不认识的字段，代价是整个决策请求被打掉。
   */
  readonly thinking?: { readonly type: "disabled" };
}

export interface AnthropicToolDefinition {
  /** 与 OpenAI 不同：**没有 `type: "function"` 那一层**，也没有 `function` 包装 */
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface AnthropicToolRequest extends AnthropicRequest {
  readonly tools: readonly AnthropicToolDefinition[];
  /** ★ 是**对象** `{type:"auto"}`，不是字符串 `"auto"` */
  readonly tool_choice: { readonly type: "auto" };
}

/**
 * 把收敛后的 effort 翻译成 Anthropic 协议的表达。
 *
 * **只有 `none` 有对应物**（`thinking: {type:"disabled"}`）；其余档位返回
 * `undefined` = 不发。理由：Anthropic 的思考控制是 `budget_tokens`（token 预算），
 * 而 UI 上那六档是「强度」，两者没有可换算的对应 —— 硬凑一个预算
 * 等于替用户做了它没做的决定，而那个决定会影响成本。
 *
 * ⚠ **实测的效力边界**：`thinking:{type:"disabled"}` 在 Agnes 的 Anthropic
 * 端点上回 200，但「它到底有没有真的关掉思考」**没有测出来**（n=1，
 * 挂钟 11.6s vs 不设时的 20.5s vs `chat_template_kwargs` 的 6.7s —— 单次采样
 * 说明不了问题）。所以这里**只保证形状合法、上游不拒收**，不声称它一定关得掉。
 */
function anthropicThinking(
  effort: LlmReasoningEffort | undefined,
): { readonly type: "disabled" } | undefined {
  return effort === "none" ? { type: "disabled" } : undefined;
}

/**
 * Jev 形状 → Anthropic 形状。
 *
 * 与 `toLlmRequest` 的差别集中在四处：`system` 提到顶层、没有 `response_format`
 * （Anthropic 协议里形状只能靠提示词约束）、思考控制换成 `thinking`、
 * `max_tokens` 必填。提示词正文两份**逐字一致**（见 `systemPrompt`）。
 *
 * 纯函数：不改动入参。
 */
export function toAnthropicRequest(
  model: string,
  state: unknown,
  questions: Questions,
  opts: {
    readonly upstream: string;
    /** 三态，语义与 `toLlmRequest` 完全一致（见那里的注释） */
    readonly effort?: LlmReasoningEffort | null;
    readonly maxTokens?: number;
  },
): AnthropicRequest {
  const effort = resolveEffort(opts.effort, opts.upstream);
  const thinking = anthropicThinking(effort);

  return {
    model,
    system: systemPrompt(JSON_SHAPE, opts.effort),
    messages: [{ role: "user", content: userPrompt(state, questions) }],
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/** 工具定义：把 JSON Schema 从 OpenAI 的 `function.parameters` 挪到 `input_schema` */
function anthropicAnswerTool(): AnthropicToolDefinition {
  const tool = answerTool().function;
  return { name: tool.name, description: tool.description, input_schema: tool.parameters };
}

/**
 * Jev 形状 → Anthropic 工具调用形状。
 *
 * 与 `buildToolRequest` 的差别同上，另加 `tools` 的包装层不同。**不带
 * `response_format`**（Anthropic 协议没有这个字段，形状由 schema 强制）。
 *
 * 纯函数：不改动入参。
 */
export function buildAnthropicToolRequest(
  model: string,
  state: unknown,
  questions: Questions,
  opts: {
    readonly upstream: string;
    readonly effort?: LlmReasoningEffort | null;
    readonly maxTokens?: number;
  },
): AnthropicToolRequest {
  const effort = resolveEffort(opts.effort, opts.upstream);
  const thinking = anthropicThinking(effort);

  return {
    model,
    system: systemPrompt(TOOL_SHAPE, opts.effort),
    messages: [{ role: "user", content: userPrompt(state, questions) }],
    tools: [anthropicAnswerTool()],
    tool_choice: { type: "auto" },
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(thinking === undefined ? {} : { thinking }),
  };
}

/* ══════════════ 响应侧：Anthropic 形状 → Jev 形状 ══════════════ */

interface AnthropicEnvelope {
  readonly content?: unknown;
  readonly stop_reason?: string;
}

function envelopeOf(payload: unknown): AnthropicEnvelope | null {
  if (payload === null || typeof payload !== "object") return null;
  return payload as AnthropicEnvelope;
}

/**
 * 把 `content[]` 里 `type === "text"` 的段子**原样接起来**。
 *
 * ⚠ 三件事：
 *   1. **别的块不是正文。** 开了思考时 `content` 里会有 `thinking` 之类的块，
 *      挑错块等于把推理过程当成答案送去 `JSON.parse`
 *   2. **用 `+=` 而不是 `join("\n")`** —— 插入分隔符会把跨块切开的 JSON 拆坏。
 *      实测回包里正文只有一段，所以这一条目前是防御性的
 *   3. 只有字符串才算 —— 形状不对的块静默跳过，由调用方判「空即失败」
 */
function anthropicText(blocks: readonly unknown[]): string {
  let out = "";
  for (const b of blocks) {
    const c = b as { type?: unknown; text?: unknown };
    if (c?.type === "text" && typeof c.text === "string") out += c.text;
  }
  return out;
}

/**
 * 取出正文，**空的时候抛错**。
 *
 * 与 `extractContent` 同一条纪律，只是判据换成了 `content[]`：**HTTP 200 却
 * 什么都没答**必须当失败，否则它会以一个「答案数 0」的结果流进统计，
 * 表现成「模型不行」——而真正的原因是推理把 `max_tokens` 吃光了。
 * 实测在这个协议上的表现是 `stop_reason: "max_tokens"`。
 */
export function extractAnthropicContent(payload: unknown): string {
  const env = envelopeOf(payload);
  if (env === null) throw new BrokerError("回包不是对象", true);
  if (!Array.isArray(env.content)) {
    throw new BrokerError("回包里没有 content 数组", true, env.stop_reason);
  }

  const text = anthropicText(env.content);
  if (text.trim() === "") {
    const fr = env.stop_reason ?? "未知";
    throw new BrokerError(
      fr === "max_tokens"
        ? "上游把输出预算全部用在了推理上，没有产出答案（stop_reason=max_tokens）"
        : `上游返回了空的 content（stop_reason=${fr}）`,
      true,
      fr,
    );
  }
  return text;
}

/** 一次工具调用的形状（Anthropic 版）。`input` 已经是解析好的对象 */
export interface AnthropicToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * 从回包里取出 `tool_use` 块。
 *
 * ★ **工具路径的「空正文 + 预算烧光」在这里拦**，与 `extractToolCalls` 同一条理由：
 * 工具调用成功时 `content` 里可能**一个 text 块都没有**（实测回包正是如此），
 * 所以不能拿「没有正文」当判据，得看**有没有 tool_use**。
 *
 * 三种「没有 tool_use」的情形分开报，因为它们指向完全不同的处置：
 *   1. 预算烧光（`stop_reason: "max_tokens"`）→ 重试，或把预算调大
 *   2. 模型回了一段文字（提示词没让它用工具）→ 重试也是白搭，要看提示词
 *   3. 回包结构就不对（没有 `content[]`）→ 上游或网关的问题
 * **归成一个「模型没答」就等于把三种故障混成一栏统计** —— 那是踩过的坑。
 */
export function extractAnthropicToolCalls(payload: unknown): AnthropicToolCall[] {
  const env = envelopeOf(payload);
  if (env === null) throw new BrokerError("回包不是对象", true);
  const fr = env.stop_reason ?? "未知";
  if (!Array.isArray(env.content)) {
    throw new BrokerError("回包里没有 content 数组", true, fr);
  }

  const out: AnthropicToolCall[] = [];
  for (const b of env.content) {
    const c = b as { type?: unknown; id?: unknown; name?: unknown; input?: unknown };
    if (c?.type !== "tool_use") continue;
    // 没有 id 就没法回述 tool_result（`tool_use_id` 是必填的），整条丢掉
    if (typeof c.id !== "string") continue;
    out.push({
      id: c.id,
      name: typeof c.name === "string" ? c.name : ANSWER_TOOL_NAME,
      // 实测 `input` 是对象；上游真发了字符串也原样收着，由 `answersFromToolInput` 判
      input: c.input ?? {},
    });
  }

  if (out.length > 0) return out;

  const text = anthropicText(env.content);
  if (text.trim() === "") {
    throw new BrokerError(
      fr === "max_tokens"
        ? "上游把输出预算全部用在了推理上，一个 tool_call 都没发（stop_reason=max_tokens）"
        : `上游既没有调用工具，content 也是空的（stop_reason=${fr}）`,
      true,
      fr,
    );
  }
  throw new BrokerError(
    `上游回了文字而不是工具调用（stop_reason=${fr}）：${text.slice(0, 120)}`,
    true,
    fr,
  );
}

/**
 * 从 Anthropic 回包里取出 usage。
 *
 * ⚠ **字段名与 OpenAI 那一套完全不同**：`input_tokens` / `output_tokens`
 * （不是 `prompt_tokens` / `completion_tokens`）。抄错不会报错，只会让
 * 每一栏都恒为 0 —— 而 0 看起来像「这次没花 token」。
 *
 * ⚠ **`reasoningTokens` 恒为 0，这是已知盲区。** 实测的 Anthropic 兼容回包里
 * 只有 input/output 与两个 cache 字段，**没有推理 token 这一栏**。
 * 与 `TokenUsage.reasoningTokens` 注释里那条边界是同一件事：
 * 「用了推理却不报」的后端会让这一栏显示 0 而不是「不知道」。观测到之后要重新设计。
 */
export function anthropicUsageOf(payload: unknown): LlmUsage {
  const u =
    (payload as { usage?: { input_tokens?: number; output_tokens?: number } } | null)?.usage ?? {};
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    reasoningTokens: 0,
  };
}

/**
 * 复述 assistant 那一次 `tool_use`。
 *
 * **不回述的话上游会拒收随后的 tool_result** —— 协议要求每个 `tool_result`
 * 都对应前面一条 `tool_use`。`input` 原样带回（它就是模型当时的判断）。
 */
export function anthropicAssistantMessage(
  calls: readonly AnthropicToolCall[],
): AnthropicMessage {
  return {
    role: "assistant",
    content: calls.map((c) => ({
      type: "tool_use" as const,
      id: c.id,
      name: c.name,
      input: c.input,
    })),
  };
}

/**
 * 告诉模型**还剩多少**的那条回包（Anthropic 版：`tool_result` 是 user 消息里的块）。
 *
 * ⚠ 与 `toolResultMessage` 同样的免责：**实测里它从未被用到**
 * （8/8 都是一轮答完）。保留它是因为成本极低，但不要声称它被验证过。
 */
export function anthropicToolResultMessage(
  toolUseId: string,
  accepted: readonly string[],
  remaining: number,
  remainingKeys: readonly string[],
): AnthropicMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: JSON.stringify({ accepted, remaining, remaining_keys: remainingKeys }),
      },
    ],
  };
}
