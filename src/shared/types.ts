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

/** 某后端下布尔类型的实际判别值。默认（含未知后端）取 noul */
export function noulDiscriminator(backend: string): NoulType {
  // Vercel 的封装使用了 boolean，其余（官方 / OpenRouter / AI-ML-API）都是 noul
  return backend === "vercel" ? "boolean" : "noul";
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
  };
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
  /** 本回合双方各自翻的格。落点必然不同格 —— 两边的合法集天然互斥 */
  readonly lifeFlip: Cell;
  readonly deathFlip: Cell;
  readonly aliveCount: number;
  /** 本回合的净增长 = 演化后活细胞数 − 演化前活细胞数 */
  readonly netGrowth: number;
}
