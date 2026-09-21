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
  readonly role: "system" | "user";
  readonly content: string;
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

/** 默认的输出上限。够 64 个布尔答案，又不会被无限推理拖住 */
export const DEFAULT_MAX_TOKENS = 4000;

const SYS_PREFIX =
  "你在为一个棋盘博弈做决策。你会收到一段局面描述和若干问题，" +
  "每个问题都要给出一个 0 到 1 之间的概率。";

const JSON_SHAPE =
  '只输出 JSON，形如 {"answers":[{"key":"原样的题目标识符","value":0.72}]}，' +
  "不要任何其他文字。每个问题都要给出一条，key 必须原样返回。";

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
    readonly effort?: LlmReasoningEffort;
    readonly maxTokens?: number;
  },
): LlmRequest {
  const keys = Object.keys(questions);
  const lines = keys.map((k) => `- ${k}: ${questionText(questions[k])}`);

  const user = [
    "当前局面：",
    JSON.stringify(state, null, 1),
    "",
    `请回答以下 ${keys.length} 个问题：`,
    ...lines,
  ].join("\n");

  const system = [
    SYS_PREFIX,
    opts.effort === "none" ? "直接给出答案，不要展开推理过程。" : "",
    JSON_SHAPE,
  ]
    .filter(Boolean)
    .join(" ");

  // 关思维链是**默认姿态**（实测依据见文件头）。上游不认识这个字段就**整个不发** ——
  // 不能回落到 "none"：那是在猜它能收，而猜错的代价是整个请求 400
  const effort = clampEffort(opts.effort ?? "none", opts.upstream);

  return {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
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
export function fromLlmContent(content: string, questions: Questions): Record<string, Answer> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
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
