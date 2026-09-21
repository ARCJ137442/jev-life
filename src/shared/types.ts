/**
 * 前后端共享的类型定义。
 *
 * 这里的 Jev 协议类型全部来自实测（继承自 `jev-2048` 的同一份文件），
 * 与部分公开文档不一致的地方已标注。
 *
 * ═══ 这个文件是怎么来的 ═══
 *
 * `core/context.ts` 里**曾经暂住**着这里的 Jev 协议最小集与 `TurnRecord`，
 * 那时 `src/shared/` 还没建。现在搬过来了，原地**一份副本都不留** ——
 * 两份类型定义迟早会各自演化（`jev-2048` 的 `Strategy` 就被定义了两遍），
 * 而类型不一致的后果是「编译期看着没问题、运行时对不上」。
 *
 * ═══ 分层约束 ═══
 *
 * 本模块被 `core/`（context / channels）、`client/`、`server/`、`tools/` 四方共用，
 * 所以**不得 import `src/client/` 下的任何东西** —— 哪怕只是类型。引一下 i18n，
 * 无头环境立刻崩，而且崩在运行时、离真正的原因很远。`tools/scan.ts` 按传递闭包
 * 守着这条（core → shared → client 同样算违规）。
 *
 * 它也不做任何 I/O：这里只有形状与几个纯函数。
 */

import type { Board, Cell } from "../core/types.js";

/* ══════════════════════════════════════════════════════════════════
   Jev 协议
   ══════════════════════════════════════════════════════════════════ */

/**
 * 问题类型判别值。
 *
 * ⚠ **各网关的取值不一致**，实测结论：
 *
 *   TypeSafe 官方   noul | choice | score
 *   OpenRouter      noul | choice | score
 *   AI/ML API       noul | choice | score
 *   Vercel Gateway  boolean | choice | score   ← 唯一的异类
 *
 * Vercel 自己封装时把 `noul` 改名成了 `boolean`。所以「文档写 noul、
 * API 实际叫 boolean」这句话**只对 Vercel 成立** —— 它一度被误当成通例。
 *
 * ★ **`noul` 在本项目里是第一次真的走。** `jev-2048` 定义了判别函数，
 * 但它的主流程走的是 `choice`，所以 `noulDiscriminator()` 在那里是死代码。
 * 生命棋的 noul 通道（每格一个布尔问题）是它的第一次实测 ——
 * 传错判别值会被上游直接 400。
 */
export type NoulType = "noul" | "boolean";
export type QuestionType = NoulType | "choice" | "score";

/**
 * 某个**网关**对布尔型判别值的实际拼写。默认（含认不出的网关）取 noul。
 *
 * ⚠ 参数是**网关本身**，不是「界面上选了哪个后端」。两者在直连时恰好相同，
 * 在代管代理上**不是一回事** —— 免费试用 1 的后端 id 是 `localproxy`，
 * 它背后的网关却是 Vercel。传错的样子是一个 400，见 `normalizeQuestionTypes`。
 */
export function noulDiscriminator(gateway: string): NoulType {
  // Vercel 的封装使用了 boolean，其余（官方 / OpenRouter / AI-ML-API）都是 noul
  return gateway === "vercel" ? "boolean" : "noul";
}

/**
 * 把请求体里 `questions[*].type` 归一化成**本上游要的那个写法**。
 *
 * ═══ 为什么由服务端做 ═══
 *
 * DESIGN.md 第八节那条约束：**中间那层必须真的兼容**。代理知道自己的上游是谁，
 * 翻译就该由它做 —— 客户端只发**语义**（`noul` = 这是一道布尔题），不猜上游
 * 怎么拼这个值。反过来说客户端也猜不了：代管代理的客户端 id 与真实上游不是
 * 一回事，按 id 推判别值必然推错。
 *
 * 实测过一次，症状是**默认的免费试用后端一发就 400**：
 *
 *   questions.flip_2_2.type: Invalid discriminator value.
 *   Expected 'boolean' | 'choice' | 'score'
 *
 * ═══ 客户端发什么 → 上游收到什么 ═══
 *
 *   ┌─────────────────┬──────────────────────────┬──────────┬──────────┐
 *   │ 界面上的后端     │ 真实上游                  │ 客户端发 │ 转发后   │
 *   ├─────────────────┼──────────────────────────┼──────────┼──────────┤
 *   │ 免费试用 1       │ Vercel AI Gateway        │ noul     │ boolean  │
 *   │ 免费试用 2       │ OpenRouter               │ noul     │ noul     │
 *   │ 官方 / AI-ML-API │ 同左（目前无代管）         │ noul     │ noul     │
 *   └─────────────────┴──────────────────────────┴──────────┴──────────┘
 *
 * **这个函数只在服务端用**：直连后端（浏览器带着自己的密钥打到网关那份）没有
 * 中间层，客户端算出来的判别值就是最终值，不经过这里。
 *
 * ═══ 只动布尔族 ═══
 *
 * `choice` / `score` 四家拼写一致，没有可翻译的东西，一律不碰（别顺手改）。
 * 布尔族那两种拼写（`noul` / `boolean`）是**同一个语义的两个名字**，所以两个
 * 方向都归一化 —— 于是「已经是上游要的写法」时本函数是恒等的，重复调用无害。
 *
 * 纯函数：**不改动入参**。有新值时返回新对象，没有时原样返回入参本身。
 */
export function normalizeQuestionTypes<T>(body: T, upstream: string): T {
  const target = noulDiscriminator(upstream);

  // 形状不对就原样放行 —— 上游给出的「expected record, received array」比
  // 我们在这里编一句更准，而且这一层没有资格替上游做校验
  const questions = (body as { questions?: unknown } | null | undefined)?.questions;
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) return body;

  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, question] of Object.entries(questions as Record<string, unknown>)) {
    const type = (question as { type?: unknown } | null | undefined)?.type;
    if ((type === "noul" || type === "boolean") && type !== target) {
      out[key] = { ...(question as Record<string, unknown>), type: target };
      changed = true;
    } else {
      out[key] = question;
    }
  }

  if (!changed) return body;
  return { ...(body as Record<string, unknown>), questions: out } as T;
}

/**
 * choice 的 criteria 是 map；score 是有序数组；布尔类型是 `{true,false}`。
 *
 * ⚠ 布尔类型的 criteria **只有两个键**，所以「后果预测」这类补充信息
 * 放不进 criteria，只能进 instructions —— 而如果 instructions 直接把答案
 * 写进去，就等于把答案写在题面上（`context.ts` 的 `noulInstructions` 记了这笔）。
 */
export type Criteria =
  | Record<string, string>
  | string[]
  | { true: string; false: string };

export interface Question {
  readonly type: QuestionType;
  readonly instructions: string;
  /** 必填。缺失时上游直接 400：expected record, received undefined */
  readonly criteria: Criteria;
}

/** questions 是 record（映射），不是数组。传数组报 expected record, received array */
export type Questions = Record<string, Question>;

export interface ChoiceAnswer {
  readonly type: "choice";
  readonly choice: string;
  readonly probabilities: Record<string, number>;
  /** 分布集中度 0~1，与最高项概率不是一回事 */
  readonly confidence: number;
}

/**
 * 布尔答案。字段名随网关变化：
 *   Vercel             {"type":"boolean","probability":0.69}
 *   OpenRouter / 官方   {"type":"noul","noul":0.96}
 * 两者都是 0~1 的概率，语义相同，只是键名不同。
 * 注意：**没有 confidence 字段** —— 概率本身就是置信度。
 */
export interface BooleanAnswer {
  readonly type: NoulType;
  /** Vercel 用这个键 */
  readonly probability?: number;
  /** OpenRouter / 官方用这个键 */
  readonly noul?: number;
}

export interface ScoreAnswer {
  readonly type: "score";
  readonly score: number;
  readonly probabilities: Record<string, number>;
  readonly confidence: number;
}

export type Answer = ChoiceAnswer | BooleanAnswer | ScoreAnswer;

/** 从布尔答案里取概率 —— 两家键名不同，统一在这里抹平 */
export function noulProbability(a: BooleanAnswer): number {
  return a.noul ?? a.probability ?? 0;
}

export interface JevRequest {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Questions;
}

export interface JevResponse {
  readonly model?: string;
  readonly answers: Record<string, Answer>;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    /** 两家的命名空间不同：Vercel 用驼峰，OpenRouter / 官方用下划线 */
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    /**
     * OpenAI 兼容协议的推理 token 明细。
     *
     * 实测：思维链开着时这一项可以等于全部 output token（4000 / 4000），
     * 而可用答案是 0 个。不记它就没法算「关掉思维链省了多少钱」——
     * 见 `shared/backend.ts` 的 `TokenUsage.reasoningTokens`。
     */
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
    /**
     * 本项目的代理回给浏览器时的驼峰写法（`src/server/server.ts` 与
     * `api/_upstream.ts` 都发这一栏）。与上面那个下划线形态是**同一个语义的
     * 两种拼写** —— 上游厂商之间不一致，所以两道都留着。
     */
    readonly reasoningTokens?: number;
  };
  /**
   * 这次决策**真的发了几次上游请求**。
   *
   * ★ 只有本项目的代理会报（`callJev` 省略时按 1 算）。它存在的理由是
   * **工具循环**：一次决策可能发 N 次上游请求，而客户端在应用层只看得见
   * 「我发了一次 HTTP」。不报的话，`upstreamCalls` 会把 N 次记成 1 ——
   * 而那个数字正是「工具循环比 JSON 贵多少」的唯一来源。
   */
  readonly upstreamCalls?: number;
  readonly providerMetadata?: Record<string, unknown>;
}

/* ══════════════════════════════════════════════════════════════════
   对局记录
   ══════════════════════════════════════════════════════════════════ */

/**
 * 一个回合的完整记录。
 *
 * 双方同时各翻一格、再演化一代，所以一回合**只有一个**净增长 —— 按玩家
 * 拆分是拆不出来的（两边同时落子），这也是它不再决定胜负之后仍然要留下的
 * 原因：跑分 CSV 里它是一项统计。
 */
export interface TurnRecord {
  readonly turn: number;
  /** 回合结束（双方落子 + 演化一代）后的棋盘 */
  readonly board: Board;
  /** 本回合**生之执**翻的格 */
  readonly lifeFlip: Cell;
  /**
   * 本回合**死之执**翻的格。
   *
   * ⚠ **可选，因为单人模式没有对手那一手**（`Mode = "solo"`）。
   * 早先它是必填，于是单人模式只能编一个数填进去 —— 而一个编出来的格号
   * 会一路流进 `recent_history`（喂给模型的记忆）与跑分 CSV，看起来与真的一模一样。
   *
   * `undefined` = **这一手不存在**。别把它读成「第 0 格」或「没记录」：
   * 前者是一个真实的落点，后者是数据缺失，三者含义各不相同。
   */
  readonly deathFlip?: Cell;
  readonly aliveCount: number;
  /** 本回合的净增长 = 演化后活细胞数 − 演化前活细胞数 */
  readonly netGrowth: number;
}
