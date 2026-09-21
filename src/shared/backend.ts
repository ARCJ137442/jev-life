/**
 * 决策后端适配层 —— 「怎么跟模型打交道」这一层的**契约与它的第一个实现**。
 *
 * ═══ 为什么需要这一层 ═══
 *
 * 搬过来的 `api.ts` 假设「所有后端共用同一种请求/响应形状」。加入 LLM 之后
 * 这个假设就破了：SystemOne 是 `{state, questions} → {answers}`，
 * 而 LLM 是 chat/messages + 结构化输出或工具调用。
 *
 * 所以把形状差异**全部收进适配器内部**，对上层（`channels.ts` / `decide.ts` /
 * `core/`）保持一个统一契约。上层的代码一行都不用改，也**分不出**对面是
 * Jev 还是一个被 broker 包装的 LLM。收益是这层 broker 本身成为一个可独立
 * 取用的产物（详见 DESIGN.md 第八节）。
 *
 * ═══ 三项一等输出 ═══
 *
 * `latencyMs` / `upstreamCalls` / `costUsd` **本身就是测量结果**，不是事后补的
 * 统计。理由很直接：Jev 的核心宣称是「并行决策 —— 单次调用可并行回答数十个
 * 独立问题，加问题几乎不增加响应时间」。这句话没有对照就不成立，而对照的
 * 单位正是秒与美元。所以它们从第一天起就在返回值里，而不是等到做跑分时
 * 再回头加 —— 那时 `channels.ts` 和 `core/` 都要跟着动。
 *
 * ═══ 分层 ═══
 *
 * 本模块不得 import `src/client/`（无头环境要跑它）。它只依赖 `fetch` /
 * `AbortSignal` / `setTimeout` —— 三者在浏览器与 Node 里都有，所以同一份
 * 实现能同时供浏览器（`client/api.ts`）与无头 CLI（`tools/play.ts`）使用。
 */
import type { Answer, JevResponse, Questions } from "./types.js";
import {
  BrokerError,
  answersFromToolArguments,
  answersFromToolInput,
  anthropicAssistantMessage,
  anthropicToolResultMessage,
  anthropicUsageOf,
  assistantToolCallsMessage,
  buildAnthropicToolRequest,
  buildToolRequest,
  extractAnthropicContent,
  extractAnthropicToolCalls,
  extractContent,
  extractToolCalls,
  fromLlmContent,
  llmEndpoint,
  toAnthropicRequest,
  toLlmRequest,
  toolResultMessage,
  usageOf,
} from "./llm-broker.js";
import type {
  AnthropicMessage,
  LlmMessage,
  LlmProtocol,
  LlmReasoningEffort,
  LlmUsage,
} from "./llm-broker.js";

/** 两个 broker 的形状不一样，但发消息、取 usage、取正文这三件事的**位置**一样 */
function isAnthropicProtocol(p: LlmProtocol): boolean {
  return p === "anthropic";
}

/**
 * CORS 那一段提示。
 *
 * ★ **为什么非有不可**：浏览器直连供应商被跨域拦下时，JS 里只会拿到一个
 * `TypeError: Failed to fetch` —— 与「模型没答」在代码里长得一模一样。
 * 不点破的话，用户看到「无法连接」会去调提示词、换模型，而真正要做的是
 * 换一个允许浏览器调用的网关。**症状与原因无关**，正是这个项目反复出现的母题。
 *
 * 光靠 JS 是**读不出**「到底是不是 CORS」的（浏览器刻意不告诉脚本），
 * 所以文案写成「可能是」并给出验证方法，而不是断言。
 */
const CORS_HINT =
  "（可能是跨域被拦：浏览器直连第三方网关时，对方必须回 Access-Control-Allow-Origin，" +
  "否则请求根本发不出去。这与「模型没答」不是一回事 —— 请求没到对面那里。" +
  "请在浏览器 DevTools 的 Console 里确认有没有 CORS 报错。）";

/* ══════════════════════════════════════════════════════════════════
   形状
   ══════════════════════════════════════════════════════════════════ */

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * 其中属于「推理 / 思维链」的部分。
   *
   * ★ **这一栏不是美化，是实测逼出来的。** 推理 token 可以占到输出的 **100%**：
   * 思维链开着时实测输出 4000 token、其中推理 4000、可用答案 **0 个**；
   * 关掉之后输出 95、推理 0、答案 1 个。不记它，就等于默认所有输出 token
   * 一样贵 —— 而计价口径通常不同（有的单独计价，有的算在输出里但量级完全不同）。
   *
   * 后果很具体：统计要按「后端 × 模型 × 调用配置」分组比成本，而**思维链开关
   * 正是最大的那个配置变量**。少了这一栏，「关思维链省了多少钱」就算不出来。
   *
   * 取值来源：OpenAI 兼容协议的 `usage.completion_tokens_details.reasoning_tokens`。
   *
   * ⚠ **上游没报这个字段时填 0，不做成 `null`。** 理由：这里「没报」与
   * 「没有推理」在实践中是一回事（没有推理就是 0）；而 `costUsd` 那边
   * 「不知道价格」与「价格是 0」是两回事，所以那里必须是 `null`。
   * 两者性质不同，不要为了形式统一把它们改成一样。
   *
   * 已知的反例风险：某个后端**真的用了推理却不报这个字段**时，这里会显示 0
   * 而不是「不知道」。目前没有观测到这种后端 —— 观测到之后这一栏要重新设计。
   */
  readonly reasoningTokens: number;
}

/**
 * 调用一个后端需要知道的全部。
 *
 * 刻意**不含 `provider`**（后端 id）：那是界面用来查 `BACKENDS` 表的键，
 * 而传输层不需要它 —— 判别值（`noul` / `boolean`）是**组题**时用的，
 * 走 `Channel.backend` 传进 `buildQuestions`，不从这里走。
 */
export interface ClientConfig {
  readonly base: string;
  readonly model: string;
  /** 仅存内存，绝不落盘。代理模式下为空字符串 */
  readonly apiKey: string;
  /**
   * 单次请求的超时（毫秒）。缺省用 `DEFAULT_TIMEOUT_MS`。
   *
   * 必须显式设：Node 的 `fetch` 默认 5 分钟才掐 headers，断网时会长时间卡在
   * 首次请求上，而且失败得毫无提示（实测踩过）。
   */
  readonly timeoutMs?: number;
}

/** 只声明用到的那两个参数，避免与 `typeof fetch` 的重载集纠缠 */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface CallHooks {
  /** 每次重试前回调，便于界面显示「第 n 次重试」 */
  onRetry?: (attempt: number, error: JevError, delayMs: number) => void;
}

/** 自动重试策略：指数退避 */
export interface RetryPolicy {
  /** 最大重试次数；null 表示无限重试 */
  readonly max: number | null;
  /** 退避基数（毫秒），实际等待 = base * 2^attempt（含 ±20% 抖动） */
  readonly baseMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { max: 3, baseMs: 800 };

/** 单次等待上限，避免指数退避涨到荒谬的时长 */
const MAX_BACKOFF_MS = 30_000;

/** 单次请求的超时上限。Jev 一次并行决策是秒级，60 秒已经很宽裕 */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * LLM 调用配置 —— 只在后端是「经 broker 包装的 LLM」时有意义。
 *
 * ═══ 它为什么在**请求体**里 ═══
 *
 * 翻译（Jev 形状 → LLM 形状）发生在服务端，而出题目的客户端才知道用户
 * 在界面上选了什么。所以这四个控件的取值必须跟着请求体走一趟 ——
 * 这是「UI 的枚举不能直接下发」那条硬性要求的前半段：客户端送**语义**，
 * 服务端按**上游能力**收敛成真正能发的值。
 *
 * ⚠ 后端不是 LLM 时这个字段**整个不出现**。Jev 协议的后端不认识它，
 * 而发一个没人看的字段等于给上游送一个未知参数。
 */
export interface LlmCallOptions {
  /**
   * 期望的思考强度。**三态，缺一不可**：
   *
   *   - 具体档位 → 期望下发它；服务端仍会过一遍能力表，收不了就不发
   *   - `null`   → **明确要求「不发这个字段」**，用上游自己的默认
   *   - 省略     → 客户端没意见，按 broker 的默认姿态（`none`，即关思维链）
   *
   * `null` 与「省略」必须分开：界面上「思考强度 = 留空」是一个**明确的
   * 选择**（实测它与 `none` 同为 3/3，而四个显式档位全部劣于不设），
   * 把它与「客户端根本没传」混成一件事，那个选项就永远送不出去。
   */
  readonly effort?: LlmReasoningEffort | null;
  /**
   * 调用策略：`json`（一次调用，形状靠提示词约束）或 `tool`（工具循环，形状靠
   * schema 强制）。
   *
   * 它只影响**服务端怎么向上游发请求**（`response_format` 还是 `tools`），
   * 所以和 `effort` 一样必须跟着请求体走一趟 —— 客户端的 `DecisionRequest`
   * 对两种策略完全一致，这正是四层架构里「中间那层必须真的兼容」要的效果。
   *
   * **省略即 `json`**：与服务端「认不出的值一律回落到 json」是同一条安全默认。
   * 这里不做三态 —— 「用哪种协议」没有「不表态」这个语义，
   * 而 `effort` 的第三态（`null` = 别发这个字段）是有实测依据的明确选择。
   */
  readonly callPolicy?: "json" | "tool";
}

export interface DecisionRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Questions;
  /** 见 `LlmCallOptions`。非 LLM 后端不传 */
  readonly llm?: LlmCallOptions;
}

/**
 * 一次决策的完整结果。
 *
 * `usage` 与 `costUsd` 都可能是 `null`，而且**两者的 null 含义相同**：
 * 上游没有告诉我们。注意这与「确实是 0」是两回事 —— 见下面 `costUsd` 的注释。
 */
export interface DecisionResult {
  readonly answers: Record<string, Answer>;
  /** 墙钟：首次请求 → 全部问题回答完成。**含重试与退避等待**，头条指标 */
  readonly latencyMs: number;
  /** 本轮发了几次上游请求：Jev 是 1，工具循环的 LLM 是 N，重试也算 */
  readonly upstreamCalls: number;
  /** 上游没有回报 usage 时是 `null`，不是 `{0, 0}` */
  readonly usage: TokenUsage | null;
  /**
   * 本次调用的美元成本。
   *
   * ★ **无法计价时必须是 `null`，绝不填 0。**
   * `0` 会被下游读成「这一次是免费的」，而那是错的 —— 一次单价未知的调用
   * 不是免费的调用。源仓库有一条同源的教训：`0` 是 falsy，被吞掉过。
   */
  readonly costUsd: number | null;
  /**
   * 原始回包。界面要能看完整的 request / response。
   *
   * ⚠ 留给接手的人一件事：回包里的 **`reasoning_content`（思维链正文）目前
   * 原样留在这里，没有被解析**。这是刻意的 —— 它属于 `llm-json` / `llm-tool`
   * 适配器的范围，而 T12 只做接口 + `systemone`。做 LLM 适配器时要决定
   * 拿它做什么（存进统计？回放给用户看？截断？），别以为它是漏掉的。
   */
  readonly raw: unknown;
}

/**
 * 决策后端。
 *
 * ★ 这是四层架构里「Jev 兼容 API」那一层的契约。**上层不得知道 `kind`。**
 * `kind` 存在的唯一理由是统计要按**配置**分组而不是按模型分组 ——
 * 同一个模型走 JSON 输出与走工具循环是两个不同的东西，混在一起算平均
 * 得到的数字谁也不代表。
 */
export interface DecisionBackend {
  readonly id: string;
  readonly kind: "systemone" | "llm-json" | "llm-tool";
  evaluate(req: DecisionRequest, hooks?: CallHooks): Promise<DecisionResult>;
}

/* ══════════════════════════════════════════════════════════════════
   错误
   ══════════════════════════════════════════════════════════════════ */

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 是否属于「值得重试」的错误 */
    readonly retryable = false,
    /**
     * 是否为「额度/配额」类问题。
     *
     * 这类错误值得单独提示：用户能做的事不是「重试」，而是**换一个后端或
     * 用自己的 key**。
     */
    readonly quotaExhausted = false,
  ) {
    super(message);
    this.name = "JevError";
  }
}

/** 429 / 408 / 5xx 属于服务端或配额侧的瞬时问题，值得重试 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * 判断一条错误是否属于「额度用尽」。
 *
 * 除了 402/429 这类状态码，还要看文案 —— Gateway 在预算耗尽时
 * 返回的仍是 4xx，措辞里会带 credits / quota / budget / 余额 等字样。
 */
export function isQuotaError(status: number | undefined, message: string): boolean {
  if (status === 402) return true;
  if (status === 429) return true;
  const m = message.toLowerCase();
  return (
    m.includes("quota") ||
    m.includes("credit") ||
    m.includes("budget") ||
    m.includes("insufficient") ||
    m.includes("rate limit") ||
    m.includes("exceeded") ||
    message.includes("额度") ||
    message.includes("余额") ||
    message.includes("配额")
  );
}

/* ══════════════════════════════════════════════════════════════════
   重试与超时
   ══════════════════════════════════════════════════════════════════ */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 带抖动的指数退避：base * 2^n，加 ±20% 抖动避免同时重试。
 *
 * `rand` 可注入 —— 源仓库用的是不可注入的 `Math.random`，于是这个函数
 * （连同依赖它的整条重试路径）在源仓库里根本测不了。
 */
export function backoffDelay(attempt: number, baseMs: number, rand: () => number = Math.random): number {
  const raw = baseMs * Math.pow(2, attempt);
  const capped = Math.min(raw, MAX_BACKOFF_MS);
  const jitter = capped * 0.2 * (rand() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

export interface TimeoutGate {
  readonly signal: AbortSignal;
  /** 请求结束后必须调用 —— 否则定时器会一直挂着 */
  readonly done: () => void;
}

/**
 * 手写超时而不是直接用 `AbortSignal.timeout()`。
 *
 * ⚠ 先说一个**被实测推翻的猜想**，免得下一个人重新猜一遍：本来以为
 * `AbortSignal.timeout(60_000)` 会把 Node 的事件循环留住、让跑完一局的 CLI
 * 在原地挂 60 秒。**实测（Node v25.3.0）不是这样** —— 只挂一个 60 秒的
 * `AbortSignal.timeout`，进程 2ms 就退出了，它内部的定时器是 unref 过的。
 *
 * 真正留下这个手写版本的理由只有一条：**能显式收尾**。
 * `AbortSignal.timeout` 没有取消入口，请求 20ms 就回来时那个定时器仍会挂满
 * 60 秒（只是不阻塞退出而已）；而一局棋要发几百次请求，每次留一个定时器
 * 在堆上、每个都闭包着一整个 AbortController，是没有理由的。
 * 这里用 `clearTimeout` 在 `finally` 里收掉。
 *
 * `unref` 只有 Node 有（浏览器给的是 number），所以按能力探测再调 ——
 * 它不是正确性的前提，是「连那一秒也不想留」的余量。
 */
export function startTimeout(ms: number): TimeoutGate {
  const ac = new AbortController();
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => ac.abort(new Error("timeout")), ms);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === "function") unref.call(timer);
  return { signal: ac.signal, done: () => clearTimeout(timer) };
}

/* ══════════════════════════════════════════════════════════════════
   单次请求
   ══════════════════════════════════════════════════════════════════ */

/** 回包 → usage。上游根本没报时给 null（不是 {0,0}） */
function readUsage(data: JevResponse): TokenUsage | null {
  const u = data.usage;
  if (!u) return null;
  return {
    inputTokens: u.inputTokens ?? u.input_tokens ?? 0,
    outputTokens: u.outputTokens ?? u.output_tokens ?? 0,
    // 这一栏**没有 null 形态**：没报就是 0。理由见 TokenUsage 的注释。
    // 两种拼写都认：本项目的代理发驼峰，直连厂商时是 OpenAI 的嵌套形态
    reasoningTokens:
      u.reasoningTokens ?? u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

/**
 * 单次请求，不做重试。
 *
 * 所有面向用户的错误文案暂时是**中文字面量**：`client/i18n.ts` 要到 T14 才建，
 * 这里现在引不到它（引了 `shared/` 就会传递触达 `client/`，分层检查会拦下）。
 * T14 把它们接到 i18n 词条上时，**错误文案的语义不要改** —— 尤其
 * 「超时」与「连不上」必须继续分开，它们是两种不同的故障。
 */
async function callOnce(
  cfg: ClientConfig,
  state: unknown,
  questions: Questions,
  fetchImpl: FetchLike,
  timeoutMs: number,
  model: string,
  llm: LlmCallOptions | undefined,
): Promise<DecisionResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  // 代理类后端（路径以 / 开头）：密钥由服务端注入，浏览器既不持有也不发送
  const isProxy = cfg.base.startsWith("/");
  if (cfg.apiKey && !isProxy) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const url = cfg.base;
  const body: { model: string; state: unknown; questions: Questions; llm?: LlmCallOptions } = {
    model,
    state,
    questions,
    // 非 LLM 后端**整个字段不出现**（理由见 LlmCallOptions）。这里不写
    // `llm: undefined`：那在 JSON.stringify 里会消失，但在抓请求体的测试里
    // 会让人以为「字段在，只是空的」—— 两件事看起来一样、含义不同
    ...(llm === undefined ? {} : { llm }),
  };

  const dl = startTimeout(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: dl.signal,
    });
  } catch (e) {
    // 网络层失败（断网、CORS、DNS、超时）—— 一律可重试。
    // 超时与「连不上」必须分开报：前者是上游慢，后者是根本到不了。
    const msg =
      dl.signal.aborted === true
        ? `请求超时：${timeoutMs}ms 内没有拿到 ${url} 的响应`
        : `无法连接 ${url}：${(e as Error).message}`;
    throw new JevError(msg, undefined, true);
  } finally {
    dl.done();
  }

  const text = await res.text();

  let data: JevResponse & { error?: { message?: string } };
  try {
    data = JSON.parse(text) as JevResponse & { error?: { message?: string } };
  } catch {
    throw new JevError(
      `HTTP ${res.status}，但回包不是 JSON：${text.slice(0, 200)}`,
      res.status,
      isRetryableStatus(res.status),
    );
  }

  if (!res.ok) {
    const msg = data.error?.message ?? text.slice(0, 200);
    throw new JevError(
      `HTTP ${res.status}：${msg}`,
      res.status,
      isRetryableStatus(res.status),
      isQuotaError(res.status, msg),
    );
  }

  // 「200 但没有 answers」不能当正常回包 —— 实测里这正是推理吃光 max_tokens
  // 的那个失败模式，静默放行会让它一路走到决策层才炸
  if (!data.answers) {
    throw new JevError(`上游返回 200，但回包里没有 answers：${text.slice(0, 200)}`, res.status, false);
  }

  const usage = readUsage(data);
  return {
    answers: data.answers,
    latencyMs: 0, // 由 callJev 覆盖：单次请求的耗时不是要测的那个数
    // ★ 代理如实报了几次就记几次，**不硬编码 1**：工具循环的一次「尝试」
    // 内部可能已经发了 N 次上游请求（见 JevResponse.upstreamCalls）
    upstreamCalls: data.upstreamCalls ?? 1,
    usage,
    // 上游没报 usage ⟹ 无法计价 ⟹ null。**不是 0**
    costUsd: usage === null ? null : estimateCost(usage.inputTokens),
    raw: data,
  };
}

/* ══════════════════════════════════════════════════════════════════
   统一入口
   ══════════════════════════════════════════════════════════════════ */

export interface CallOptions {
  readonly retry?: RetryPolicy;
  /** 覆盖 `cfg.timeoutMs`（调用点 > 配置 > 默认） */
  readonly timeoutMs?: number;
  /** 覆盖 `cfg.model`。适配器把 `DecisionRequest.model` 从这里送进来 */
  readonly model?: string;
  /** LLM 调用配置。适配器把 `DecisionRequest.llm` 从这里送进来 */
  readonly llm?: LlmCallOptions;
  /** 注入用。测试与无头工具靠它复用同一条路径 */
  readonly fetchImpl?: FetchLike;
  readonly hooks?: CallHooks;
}

/**
 * 统一调用入口，按 `RetryPolicy` 做指数退避重试。
 *
 * 只对「瞬时故障」重试：网络错误、超时、429、408、5xx。
 * 4xx（模型不存在、参数错误、鉴权失败）会直接抛出 —— 重试没有意义。
 */
export async function callJev(
  cfg: ClientConfig,
  state: unknown,
  questions: Questions,
  opts: CallOptions = {},
): Promise<DecisionResult> {
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = opts.model ?? cfg.model;
  const fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));

  return runWithRetry(opts.retry ?? DEFAULT_RETRY, opts.hooks, async () => {
    const r = await callOnce(cfg, state, questions, fetchImpl, timeoutMs, model, opts.llm);
    return { value: r, upstreamCalls: r.upstreamCalls };
  });
}

/** 一次「尝试」的产物：结果本身，外加它内部发了几次上游请求 */
interface Attempt {
  readonly value: DecisionResult;
  readonly upstreamCalls: number;
}

/**
 * 重试与计时的**唯一一份**实现。
 *
 * ★ 抽出来是因为第二条路（`createLlmBackend`）需要**一模一样**的重试语义与
 * `upstreamCalls` 记账。各写一份，症状是「换个后端，`upstreamCalls` 的算法就
 * 变了」—— 而那个数字正是「Jev 的并行决策值多少钱」那份测量的分母，
 * 两套算法算出来的东西不可比，而且**看起来都挺对**。
 *
 * ⚠ 只认 `JevError`。别的错误（包括 broker 的 `BrokerError`）一律当成
 * **不可重试** —— 所以调用方必须先把它们翻译成 `JevError`，见
 * `createLlmBackend` 里的 `asJevError`。
 */
async function runWithRetry(
  retry: RetryPolicy,
  hooks: CallHooks | undefined,
  attemptFn: () => Promise<Attempt>,
): Promise<DecisionResult> {
  // 计时从**第一次请求之前**开始：要测的是「这个后端给出一次决策要多久」，
  // 含重试与退避等待 —— 那正是用户实际感受到的墙钟时间
  const startedAt = Date.now();
  let attempt = 0;
  let calls = 0;

  for (;;) {
    try {
      const r = await attemptFn();
      // ★ **累加**而不是自增：一次「尝试」内部可能就发了 N 次上游请求 ——
      // 工具循环正是如此。这个数字是与 Jev 对比的头条指标，
      // 把它按「我发了一次 HTTP」记成 1，等于把工具循环的成本藏起来
      calls += r.upstreamCalls;
      return { ...r.value, latencyMs: Date.now() - startedAt, upstreamCalls: calls };
    } catch (e) {
      // 失败的尝试同样发出去过请求（而且可能发了好几次）。这一层数不到工具
      // 循环内部的次数 —— 只在**成功**的回包里才知道 —— 所以按 1 记。
      // 宁可少算也不虚报：上限由重试次数兜着，而少算的方向是保守的
      calls++;
      const err = e instanceof JevError ? e : new JevError(String(e), undefined, false);
      const max = retry.max;
      const canRetry = err.retryable && (max === null || attempt < max);
      if (!canRetry) throw err;

      const delay = backoffDelay(attempt, retry.baseMs);
      hooks?.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
      attempt++;
    }
  }
}

/**
 * 把 SystemOne 调用包成一个 `DecisionBackend`。
 *
 * 现在它和 `callJev` 几乎一一对应 —— 那正是这一层要的效果：将来加
 * `llm-json` / `llm-tool` 时，差异全部落在各自的 `evaluate` 里，
 * 而**这里（以及上层的 `channels` / `core`）一个字都不用改**。
 *
 * `llm-json` 与 `llm-tool` 不在 M1 范围内（它们属于跑分与对照实验那一期），
 * 但接口现在就必须定对。
 */
export function createSystemoneBackend(
  cfg: ClientConfig,
  opts: { readonly id: string } & CallOptions,
): DecisionBackend {
  return {
    id: opts.id,
    kind: "systemone",
    evaluate: (req, hooks) =>
      callJev(cfg, req.state, req.questions, {
        ...opts,
        model: req.model,
        // 请求上的配置优先于构造时的配置：同一个后端实例可能被不同玩家级
        // 设置复用，而「这一次调用怎么谈」是跟着**请求**走的
        llm: req.llm ?? opts.llm,
        hooks: hooks ?? opts.hooks,
      }),
  };
}

/* ══════════════════════════════════════════════════════════════════
   用户自备 key 的 LLM 后端（`llm-json` / `llm-tool`）
   ══════════════════════════════════════════════════════════════════

   ★ **这一条与前一条的架构差别只有一个字：broker 在客户端跑。**

   代管那条（`/api/evaluate3`）走的是「客户端只发 Jev 形状 → **服务端**翻译 →
   上游」，客户端对两种上游一视同仁。而用户自备 key 的没有那层服务端 ——
   GitHub Pages 上连 Serverless 都没有 —— 所以翻译必须发生在浏览器里。

   好在 broker 本来就是纯函数（不碰网络、不碰 DOM、不读环境变量），
   两份实现并没有分叉：**变的是谁来调它，不是它算什么。**

   ⚠ 代价是这里出现了第三个工具循环。`src/server/server.ts` 与
   `api/_upstream.ts` 各有一份（那两份是给代管后端用的，它们要显式注入密钥、
   还要把错误映射成对外的 HTTP 状态码，与这里的处境不同）。
   **三处同源**，改一处记得想想另外两处 —— 漏一处的症状是
   「本机好用、静态版不对」，而那种差异极难查。
*/

export interface LlmBackendOptions {
  /** `DecisionBackend.id`，用来查 `BACKENDS` 表 */
  readonly id: string;
  /** 说哪种协议。**决定路径、认证头、请求体形状与回包解析** */
  readonly protocol: LlmProtocol;
  /**
   * 查能力表用的键 —— **这里是协议族**（`openai-compat` / `anthropic-compat`），
   * 不是厂商。理由见 `llm-broker.ts` 的 `LlmProtocol` 注释。
   */
  readonly upstream: string;
}

/**
 * 造一个「直连用户自己那个 LLM 端点」的后端。
 *
 * 两条调用策略（JSON / 工具循环）走的是同一条路，只在「怎么问」上分岔 ——
 * 这正是四层架构里「中间那层必须真的兼容」要的效果：上层的 `channels` /
 * `core/` 分不出对面是一个被包起来的 LLM，还是一个 Jev 协议后端。
 *
 * ⚠ **`kind` 在构造时定死**（它属于 `DecisionBackend` 的契约，而契约要求
 * 统计按配置分组）。所以构造时必须把这次的调用策略传进来 ——
 * 传成默认的 `json` 会让工具循环的调用被记进 JSON 那一栏，
 * 而那两个是不同的东西（实测快 2–4 倍），混在一起算平均得到的数字谁也不代表。
 */
export function createLlmBackend(
  cfg: ClientConfig,
  opts: LlmBackendOptions & CallOptions,
): DecisionBackend {
  return {
    id: opts.id,
    kind: (opts.llm?.callPolicy ?? "json") === "tool" ? "llm-tool" : "llm-json",
    evaluate: (req, hooks) =>
      callLlm(cfg, req, opts, {
        retry: opts.retry ?? DEFAULT_RETRY,
        timeoutMs: opts.timeoutMs ?? cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        model: req.model || opts.model || cfg.model,
        fetchImpl: opts.fetchImpl ?? ((url, init) => fetch(url, init)),
        // 请求上的配置优先于构造时的配置：同一个后端实例可能被不同玩家级
        // 设置复用，而「这一次调用怎么谈」是跟着**请求**走的
        llm: req.llm ?? opts.llm,
        hooks: hooks ?? opts.hooks,
      }),
  };
}

/** 一次 LLM 调用的全部上下文 —— 参数太多了，捆一个包免得传错顺序 */
interface LlmCallContext {
  readonly retry: RetryPolicy;
  readonly timeoutMs: number;
  readonly model: string;
  readonly fetchImpl: FetchLike;
  readonly llm: LlmCallOptions | undefined;
  readonly hooks: CallHooks | undefined;
}

/**
 * 三态 effort 的**翻译**（`LlmCallOptions.effort` → broker 的 `opts.effort`）。
 *
 * ★ 与 `server.ts` / `_upstream.ts` 里那一行是同一件事，措辞也一样：
 * **字段缺席 = 客户端没意见 → 交给 broker 的默认姿态（`none`）；
 * 显式 `null` = 明确要求不发这个字段。** 两者必须分开传 ——
 * 合并成一个值，「思考强度 = 留空」那个选项就永远送不出去，
 * 而它的症状是「设了跟没设一样」，看起来像开关坏了。
 */
function effortArg(llm: LlmCallOptions | undefined): { effort?: LlmReasoningEffort | null } {
  return llm && "effort" in llm ? { effort: llm.effort ?? null } : {};
}

/**
 * 把 broker 的错误翻译成传输层的错误。
 *
 * ⚠ **不能不翻译**：`runWithRetry` 只对 `JevError` 看 `retryable`，
 * 别的错误一律当成不可重试。broker 的「模型没答」是**值得重试**的
 * （实测是偶发的），直接抛出去会让它变成「一锤子买卖」，
 * 而症状是「偶尔失败一次就整回合失败」，与重试策略本身无关。
 */
function asJevError(e: unknown): unknown {
  if (e instanceof JevError) return e;
  if (e instanceof BrokerError) return new JevError(e.message, undefined, e.retryable);
  return e;
}

/** 一次 HTTP 回包 —— 只保留本项目要用的三样 */
interface LlmHttp {
  readonly payload: unknown;
  readonly text: string;
}

/**
 * 发一次请求并**先看状态码、再看回包**（硬性要求第 1 条）。
 *
 * `429` / `5xx` / 认证失败各有各的处置，**绝不能都归到「模型没给出答案」里** ——
 * 踩过一次：探针没看状态码，于是 429 限流被统计成了「模型答不出来」。
 * 一个「请求根本没被受理」在统计上表现成了「模型不行」。
 */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  ctx: LlmCallContext,
  signal: AbortSignal | undefined,
): Promise<LlmHttp> {
  let res: Response;
  try {
    res = await ctx.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (e) {
    // 网络层失败：断网、DNS、TLS、**CORS**、超时 —— 一律可重试。
    // 超时与「连不上」分开报：前者是上游慢，后者是根本到不了。
    const aborted = signal?.aborted === true;
    throw new JevError(
      aborted
        ? `请求超时：${ctx.timeoutMs}ms 内没有拿到 ${url} 的响应`
        : `无法连接 ${url}：${(e as Error).message}。${CORS_HINT}`,
      undefined,
      true,
    );
  }

  const text = await res.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new JevError(
      `HTTP ${res.status}，但回包不是 JSON：${text.slice(0, 200)}`,
      res.status,
      isRetryableStatus(res.status),
    );
  }

  if (!res.ok) {
    // ★ 先看状态码 —— 两种协议的 error 都嵌在 `error.message` 里
    const msg =
      (payload as { error?: { message?: string } } | null)?.error?.message ?? text.slice(0, 200);
    throw new JevError(
      `HTTP ${res.status}：${msg}`,
      res.status,
      isRetryableStatus(res.status),
      isQuotaError(res.status, msg),
    );
  }

  return { payload, text };
}

/** 请求头。两种协议的认证方式**完全不同**，不是换个名字 */
function headersFor(protocol: LlmProtocol, apiKey: string): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (isAnthropicProtocol(protocol)) {
    // Anthropic 协议：`x-api-key`，**不是** `Authorization: Bearer`
    if (apiKey) h["x-api-key"] = apiKey;
    // 版本头是必填的；发错版本会被拒
    h["anthropic-version"] = "2023-06-01";
    // ★ 官方 API 要靠这个头才允许浏览器跨域直连。缺了它，官方端点回的是
    // 「CORS requests must set 'anthropic-dangerous-direct-browser-access' header」——
    // 而这句话在浏览器里只会变成一个读不出原因的 `Failed to fetch`。
    // 这条后端**只在浏览器里跑**，所以无条件带上；第三方兼容端点不认识它时
    // 一般会忽略（实测 Agnes 的 Anthropic 端点在预检里允许任意请求头）。
    h["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (apiKey) {
    // OpenAI 协议：`Authorization: Bearer`。**空密钥时不发这个头** ——
    // 有些自建端点不需要密钥，发一个 `Bearer ` 反而会被判成鉴权失败
    h["Authorization"] = `Bearer ${apiKey}`;
  }
  return h;
}

/**
 * 工具循环里**跨轮累加**的 token 账。
 *
 * 可变是这个类型的全部意义：每轮的回包各报各的，而统计要的是整次决策的
 * 总花费。做成不可变会逼着每轮复制一次，而复制出来的东西没有任何一处要读。
 */
interface UsageTally {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function addUsage(into: UsageTally, u: LlmUsage): void {
  into.inputTokens += u.inputTokens;
  into.outputTokens += u.outputTokens;
  into.reasoningTokens += u.reasoningTokens;
}

/**
 * 一次调用：JSON 路径一次往返，工具路径 N 次。**重试由 `runWithRetry` 罩着。**
 */
async function callLlm(
  cfg: ClientConfig,
  req: DecisionRequest,
  opts: LlmBackendOptions & CallOptions,
  ctx: LlmCallContext,
): Promise<DecisionResult> {
  const policy = ctx.llm?.callPolicy ?? "json";
  return runWithRetry(ctx.retry, ctx.hooks, async () => {
    try {
      return policy === "tool"
        ? await toolAttempt(cfg, req, opts, ctx)
        : await jsonAttempt(cfg, req, opts, ctx);
    } catch (e) {
      throw asJevError(e);
    }
  });
}

async function jsonAttempt(
  cfg: ClientConfig,
  req: DecisionRequest,
  opts: LlmBackendOptions & CallOptions,
  ctx: LlmCallContext,
): Promise<Attempt> {
  const url = llmEndpoint(cfg.base, opts.protocol);
  const shared = { upstream: opts.upstream, ...effortArg(ctx.llm) };
  const body = isAnthropicProtocol(opts.protocol)
    ? toAnthropicRequest(ctx.model, req.state, req.questions, shared)
    : toLlmRequest(ctx.model, req.state, req.questions, shared);

  const dl = startTimeout(ctx.timeoutMs);
  let http: LlmHttp;
  try {
    http = await postJson(url, headersFor(opts.protocol, cfg.apiKey), body, ctx, dl.signal);
  } finally {
    dl.done();
  }

  // ★ 回包形状的判据是**协议**，不是「有没有 choices」—— 拿 OpenAI 的路径去
  // 读 Anthropic 的回包会得到一个「回包里没有 choices[0]」，
  // 而那句话把人指向网关，真正的原因在协议上
  const content = isAnthropicProtocol(opts.protocol)
    ? extractAnthropicContent(http.payload)
    : extractContent(
        (http.payload as { choices?: unknown[] }).choices?.[0] as Parameters<
          typeof extractContent
        >[0],
      );

  const answers = fromLlmContent(content, req.questions);
  const usage = isAnthropicProtocol(opts.protocol)
    ? anthropicUsageOf(http.payload)
    : usageOf(http.payload);

  return {
    value: {
      answers,
      latencyMs: 0, // 由 runWithRetry 覆盖
      upstreamCalls: 1, // JSON 路径恒为 1
      usage,
      // ★ **单价未知，所以是 `null`，不是 0。** `estimateCost` 那张价目表
      // 是按代管后端的实测价格维护的，而用户自己填的端点（DeepSeek、
      // Anthropic、某个自建网关）价格各不相同。填 0 会被下游读成
      // 「这一次是免费的」—— 一次单价未知的调用不是免费的调用。
      costUsd: null,
      raw: http.payload,
    },
    upstreamCalls: 1,
  };
}

/**
 * 工具循环。**与 `src/server/server.ts` 的 `runToolLoop` 同源**（见文件头的说明）。
 *
 * 实测依据（`docs/llm-backends.md` 第三节）：模型**总是选择一轮全答** ——
 * N=1/6/12/24 各 2 次，8/8 全成功、上游调用次数恒为 1。所以这里
 * **不主动限制每轮批量**，只做三件实测要求的事：
 *
 *   1. 每轮**先看状态码**再看回包（429 不能被算成「模型没答」）
 *   2. 空正文 + 预算烧光当失败 —— 模型可能把预算全烧在推理上，
 *      一个 tool_call 都不发（`extractToolCalls` / `extractAnthropicToolCalls` 里拦）
 *   3. `upstreamCalls` 与 token **如实累加** —— 循环是 N 次，
 *      那正是与 Jev 对比的头条数字
 */
/** 一轮里收下的一道答案 —— 两种协议取出来之后的**统一形状** */
interface RoundCall {
  readonly id: string;
  readonly answers: Record<string, Answer>;
}

interface ToolRoundResult {
  readonly id: string;
  readonly accepted: readonly string[];
  readonly remaining: number;
  readonly remainingKeys: readonly string[];
}

/**
 * 两种协议的**会话差异只在这一个小接口里**。
 *
 * 循环本身（轮次上限、零进展检测、pending 记账、token 累加）对两种协议逐字相同，
 * 硬塞进 if/else 会让那份逻辑有两份 —— 而它正是最容易出错、也最值得只写一遍的部分。
 * 「协议怎么拼历史」是协议知识，「循环怎么转」不是。
 */
interface ToolWire {
  /** 带上当前会话历史的请求体 */
  body(): unknown;
  /** 回包 → 这一轮的工具调用。取不出时报错（含「预算烧光」「回了文字」两种） */
  read(payload: unknown): RoundCall[];
  /**
   * 复述 assistant 那一次调用 + 逐条回 tool 的结果。
   *
   * 只收 `results` 不收 `roundCalls` —— 复述要用的是**上游原文**，
   * 而工厂自己留着那一份（`lastCalls`）。让调用方再传一遍，
   * 迟早会出现「传进来的和实际回包不是同一批」。
   */
  append(results: readonly ToolRoundResult[]): void;
}

function openAiWire(built: ReturnType<typeof buildToolRequest>, questions: Questions): ToolWire {
  const messages: LlmMessage[] = [...built.messages];
  let lastCalls: Parameters<typeof assistantToolCallsMessage>[1] = [];
  return {
    body: () => ({ ...built, messages }),
    read: (payload) => {
      lastCalls = extractToolCalls(
        (payload as { choices?: unknown[] }).choices?.[0] as Parameters<typeof extractToolCalls>[0],
      );
      return lastCalls.map((tc) => ({
        id: tc.id,
        answers: answersFromToolArguments(tc.argumentsJson, questions),
      }));
    },
    append: (results) => {
      // 复述 assistant 那一次 tool_calls —— 少了它上游会拒收随后的 tool 消息
      messages.push(assistantToolCallsMessage(null, lastCalls));
      for (const r of results) {
        messages.push(toolResultMessage(r.id, r.accepted, r.remaining, r.remainingKeys));
      }
    },
  };
}

function anthropicWire(
  built: ReturnType<typeof buildAnthropicToolRequest>,
  questions: Questions,
): ToolWire {
  const messages: AnthropicMessage[] = [...built.messages];
  let lastCalls: Parameters<typeof anthropicAssistantMessage>[0] = [];
  return {
    body: () => ({ ...built, messages }),
    read: (payload) => {
      lastCalls = extractAnthropicToolCalls(payload);
      return lastCalls.map((tc) => ({
        id: tc.id,
        // ★ Anthropic 的 `input` 已经是对象 —— 走 OpenAI 那条 JSON.parse 会抛
        answers: answersFromToolInput(tc.input, questions),
      }));
    },
    append: (results) => {
      messages.push(anthropicAssistantMessage(lastCalls));
      for (const r of results) {
        messages.push(anthropicToolResultMessage(r.id, r.accepted, r.remaining, r.remainingKeys));
      }
    },
  };
}

async function toolAttempt(
  cfg: ClientConfig,
  req: DecisionRequest,
  opts: LlmBackendOptions & CallOptions,
  ctx: LlmCallContext,
): Promise<Attempt> {
  const anthropic = isAnthropicProtocol(opts.protocol);
  const url = llmEndpoint(cfg.base, opts.protocol);
  const headers = headersFor(opts.protocol, cfg.apiKey);
  const shared = { upstream: opts.upstream, ...effortArg(ctx.llm) };
  const wire = anthropic
    ? anthropicWire(buildAnthropicToolRequest(ctx.model, req.state, req.questions, shared), req.questions)
    : openAiWire(buildToolRequest(ctx.model, req.state, req.questions, shared), req.questions);

  const pending = new Set(Object.keys(req.questions));
  const answers: Record<string, Answer> = {};
  const usage: UsageTally = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  let calls = 0;
  let last: unknown = null;

  // 轮次上限。实测从没进过第二轮，所以它是一个**防死循环的保险**而不是策略：
  // 模型给回一堆坏参数时，「一条都没收下」会让循环原地打转。
  // 下面还有一条更直接的零进展检测，两者都要有 —— 上限挡的是「每轮收一条但收不完」
  const maxRounds = Math.max(1, pending.size) + 4;

  // ★ 显式超时**罩住整个循环**，不是每轮一份：客户端那侧的时间是从它发请求
  // 算起的，若这里每轮各给一份，N 轮就能拖到客户端早就超时之后
  const gate = startTimeout(ctx.timeoutMs);
  try {
    for (let round = 0; round < maxRounds && pending.size > 0; round++) {
      const http = await postJson(url, headers, wire.body(), ctx, gate.signal);
      calls++;
      last = http.payload;
      addUsage(usage, anthropic ? anthropicUsageOf(http.payload) : usageOf(http.payload));

      const roundCalls = wire.read(http.payload);

      const before = pending.size;
      const results: ToolRoundResult[] = [];
      for (const tc of roundCalls) {
        const accepted: string[] = [];
        for (const [k, v] of Object.entries(tc.answers)) {
          // 已经答过的键不再收 —— 模型重复答同一题时，第一次的那个才是它的判断
          if (!pending.has(k)) continue;
          pending.delete(k);
          answers[k] = v;
          accepted.push(k);
        }
        results.push({ id: tc.id, accepted, remaining: pending.size, remainingKeys: [...pending] });
      }

      if (pending.size === 0) break;

      // 零进展：这一轮一条有效答案都没收下。再问下去只会把同样的坏参数再拿一次
      if (pending.size === before) {
        throw new BrokerError(
          `这一轮 ${roundCalls.length} 条 tool_call 没有给出任何有效答案，还剩 ${pending.size} 题`,
          true,
        );
      }

      wire.append(results);
    }
  } catch (e) {
    // 整个循环超时要与「上游回了个错误」分开 —— 前者值得重试，后者要看状态码
    if (gate.signal.aborted) {
      throw new JevError(`请求超时：${ctx.timeoutMs}ms 内没有跑完工具循环`, undefined, true);
    }
    throw e;
  } finally {
    gate.done();
  }

  if (pending.size > 0) {
    throw new BrokerError(`工具循环达到轮次上限（${maxRounds}），仍有 ${pending.size} 题没答`, true);
  }

  return {
    value: {
      answers,
      latencyMs: 0,
      upstreamCalls: calls,
      usage,
      costUsd: null, // 同上：用户自备的端点，单价未知
      raw: last,
    },
    upstreamCalls: calls,
  };
}

/* ══════════════════════════════════════════════════════════════════
   价格
   ══════════════════════════════════════════════════════════════════ */

/**
 * 实测：$0.042 / 1M input tokens，output 不计费。
 *
 * ⚠ 这是**一张会过期的表**。价格变了它不会自己发现，所以界面上展示成本时
 * 必须带上这个数字的日期；真要做跨提供商对照，价目表要按后端分别维护。
 */
export const PRICE_PER_TOKEN = 0.042 / 1e6;

export function estimateCost(tokens: number): number {
  return tokens * PRICE_PER_TOKEN;
}
