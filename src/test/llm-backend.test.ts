/**
 * 用户自备 key 的两条 LLM 后端 —— 「调 broker 组请求 → fetch 用户填的地址 →
 * 用 broker 解析回包」这条路的测试。
 *
 * ═══ 它与 `backend.test.ts` / `llm-anthropic.test.ts` 的分工 ═══
 *
 *   - `llm-broker.test.ts` / `llm-anthropic.test.ts` 测**纯函数的形状**
 *   - 本文件测**这条路由真的发出去什么、失败时说什么** —— 两者都会错，
 *     而错的后果完全不同：形状错是 400/解析失败，路由错是「浏览器里根本
 *     发不出去」或者「失败了却报成模型不行」
 *
 * ═══ 三条它非守住不可的事 ═══
 *
 *   1. ★ **CORS / 网络失败必须与「模型没答」分开报。** 浏览器直连供应商时
 *      这是最常见的失败，而它在 JS 里只表现成一个 `TypeError: Failed to fetch`
 *      —— 与「模型答不出来」长得一模一样。不在这里点破，用户会去调提示词
 *   2. ★ **状态码先看，再看回包。** 429 被算成「模型不行」是这个项目踩过的坑
 *   3. ★ **密钥不进任何错误文案。** 这条后端不经过服务端，错误文案会直接
 *      显示给用户、也会走 `console.error`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { JevError, createLlmBackend } from "../shared/backend.js";
import type { ClientConfig, FetchLike } from "../shared/backend.js";
import { ANTHROPIC_COMPAT_UPSTREAM, OPENAI_COMPAT_UPSTREAM } from "../shared/llm-broker.js";
import type { Questions } from "../shared/types.js";

/* ═══ 夹具 ═══ */

const KEY = "sk_TESTONLY_not_a_real_key_9f8e7d6c";

const CFG: ClientConfig = {
  base: "https://api.example.invalid/v1",
  model: "some-model",
  apiKey: KEY,
};

const QUESTIONS: Questions = {
  flip_1_1: { type: "noul", instructions: "这一手是否有利？", criteria: { true: "有利", false: "不利" } },
  flip_1_2: { type: "noul", instructions: "这一手是否有利？", criteria: { true: "有利", false: "不利" } },
};

const FAST = { max: 3, baseMs: 1 } as const;

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 假 fetch：把每次调用记下来，回包由调用方给 */
function recorder(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: Call = {
      url,
      headers,
      body: JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>,
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { calls, fetchImpl };
}

/** OpenAI 兼容的一次成功回包 */
function openAiText(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, ...extra },
  };
}

/** Anthropic 兼容的一次成功回包 */
function anthropicText(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 20, ...extra },
  };
}

const ANSWERS = '{"answers":[{"key":"flip_1_1","value":0.8},{"key":"flip_1_2","value":0.2}]}';

/* ══════════════════════════════════════════════════════════════════
   一、OpenAI 兼容：请求发到哪、长什么样
   ══════════════════════════════════════════════════════════════════ */

test("★ OpenAI 兼容：路径补成 /chat/completions，Authorization 带上密钥", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
  });
  const res = await backend.evaluate({ model: "m", state: { turn: 1 }, questions: QUESTIONS });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.invalid/v1/chat/completions");
  assert.equal(calls[0].headers["authorization"], `Bearer ${KEY}`);
  assert.equal(calls[0].body["model"], "m");
  assert.ok(Array.isArray(calls[0].body["messages"]));
  assert.equal(Object.keys(res.answers).length, 2);
  assert.equal(res.upstreamCalls, 1, "JSON 路径就是一次上游调用");
});

test("★ 密钥不在 URL 里 —— URL 会进日志、进错误文案，请求头不会", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
  });
  await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS });
  assert.ok(!calls[0].url.includes(KEY), calls[0].url);
});

/* ══════════════════════════════════════════════════════════════════
   二、Anthropic 兼容：三个头、顶层 system、thinking 字段
   ══════════════════════════════════════════════════════════════════ */

test("★ Anthropic 兼容：x-api-key + anthropic-version + 浏览器直连头，路径 /messages", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(anthropicText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmanthropic",
    protocol: "anthropic",
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
  });
  const res = await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS });

  assert.equal(calls[0].url, "https://api.example.invalid/v1/messages");
  assert.equal(calls[0].headers["x-api-key"], KEY);
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  // 官方 API 要靠这个头才允许浏览器跨域直连；缺了它回的是
  // 「CORS requests must set 'anthropic-dangerous-direct-browser-access' header」
  assert.equal(calls[0].headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.ok(!("authorization" in calls[0].headers), "Anthropic 协议不认 Authorization");
  assert.equal(typeof calls[0].body["system"], "string");
  assert.deepEqual(calls[0].body["thinking"], { type: "disabled" });
  assert.equal(Object.keys(res.answers).length, 2);
});

/* ══════════════════════════════════════════════════════════════════
   三、记账
   ══════════════════════════════════════════════════════════════════ */

test("★ 用户自备 key：单价未知，costUsd 必须是 null 而不是 0", async () => {
  const { fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
  });
  const res = await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS });
  assert.equal(
    res.costUsd,
    null,
    "0 会被读成「这次是免费的」—— 一次单价未知的调用不是免费的调用",
  );
  assert.equal(res.usage?.inputTokens, 100);
});

test("Anthropic 路径的 usage 走 input/output_tokens", async () => {
  const { fetchImpl } = recorder(() => jsonResponse(anthropicText(ANSWERS, { input_tokens: 7, output_tokens: 9 })));
  const backend = createLlmBackend(CFG, {
    id: "llmanthropic",
    protocol: "anthropic",
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
  });
  const res = await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS });
  assert.equal(res.usage?.inputTokens, 7);
  assert.equal(res.usage?.outputTokens, 9);
});

test("kind 按调用策略分组：JSON 是 llm-json，工具循环是 llm-tool", () => {
  const { fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const json = createLlmBackend(CFG, {
    id: "x", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, fetchImpl,
    llm: { callPolicy: "json" },
  });
  const tool = createLlmBackend(CFG, {
    id: "x", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, fetchImpl,
    llm: { callPolicy: "tool" },
  });
  assert.equal(json.kind, "llm-json");
  assert.equal(
    tool.kind,
    "llm-tool",
    "同一个模型走 JSON 与走工具循环是两个不同的东西，统计不能混在一起",
  );
});

/* ══════════════════════════════════════════════════════════════════
   四、★ 失败要分得清
   ══════════════════════════════════════════════════════════════════ */

test("★ 网络层失败（浏览器里就是 CORS）报得清楚，且指出它与「模型没答」不同", async () => {
  const { calls, fetchImpl } = recorder(() => {
    throw new TypeError("fetch failed");
  });
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: { max: 0, baseMs: 1 },
    fetchImpl,
  });

  await assert.rejects(
    () => backend.evaluate({ model: "m", state: {}, questions: QUESTIONS }),
    (e: unknown) => {
      assert.ok(e instanceof JevError);
      assert.equal(e.retryable, true, "网络抖动值得重试");
      assert.match(e.message, /CORS/, "不点破 CORS，用户会去调提示词");
      assert.match(e.message, /模型|答案/, "要说清它与「模型没答」不是一回事");
      assert.ok(!e.message.includes(KEY), "错误文案会显示给用户、也会进 console");
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test("★ 429 原样报成额度问题，不并进「模型没答」", async () => {
  const { calls, fetchImpl } = recorder(() =>
    jsonResponse({ error: { message: "rate limit exceeded" } }, 429),
  );
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
  });
  await assert.rejects(
    () => backend.evaluate({ model: "m", state: {}, questions: QUESTIONS }),
    (e: unknown) => {
      assert.ok(e instanceof JevError);
      assert.equal(e.status, 429);
      assert.equal(e.quotaExhausted, true);
      assert.match(e.message, /429/);
      return true;
    },
  );
  assert.equal(calls.length, 4, "429 值得重试：1 次 + max=3 次");
});

test("★ 4xx（鉴权失败 / 模型不存在）直接抛，不重试", async () => {
  const { calls, fetchImpl } = recorder(() =>
    jsonResponse({ error: { message: "invalid api key" } }, 401),
  );
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
  });
  await assert.rejects(
    () => backend.evaluate({ model: "m", state: {}, questions: QUESTIONS }),
    (e: unknown) => e instanceof JevError && e.status === 401,
  );
  assert.equal(calls.length, 1, "重试一个 401 只是把同一个错误再拿一次");
});

test("★ 200 但正文为空 + finish_reason=length → 当失败，且点明是推理吃光预算", async () => {
  const { fetchImpl } = recorder(() =>
    jsonResponse({
      choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }],
      usage: { prompt_tokens: 100, completion_tokens: 4000 },
    }),
  );
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: { max: 0, baseMs: 1 },
    fetchImpl,
  });
  await assert.rejects(
    () => backend.evaluate({ model: "m", state: {}, questions: QUESTIONS }),
    (e: unknown) => {
      assert.ok(e instanceof JevError);
      assert.equal(e.retryable, true);
      assert.match(e.message, /推理/);
      return true;
    },
  );
});

/* ══════════════════════════════════════════════════════════════════
   五、工具循环
   ══════════════════════════════════════════════════════════════════ */

/** OpenAI 形状的一次工具调用回包 */
function openAiTool(calls: { id: string; answers: { key: string; value: number }[] }[]): unknown {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: "answer_questions", arguments: JSON.stringify({ answers: c.answers }) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 10 },
  };
}

test("★ 工具循环：模型分两轮答完，upstreamCalls 如实记 2（头条指标）", async () => {
  const { calls, fetchImpl } = recorder((_c, n) => {
    if (n === 1) return jsonResponse(openAiTool([{ id: "call_1", answers: [{ key: "flip_1_1", value: 0.9 }] }]));
    return jsonResponse(openAiTool([{ id: "call_2", answers: [{ key: "flip_1_2", value: 0.1 }] }]));
  });
  const backend = createLlmBackend(CFG, {
    id: "llmopenai",
    protocol: "openai",
    upstream: OPENAI_COMPAT_UPSTREAM,
    retry: FAST,
    fetchImpl,
    llm: { callPolicy: "tool" },
  });
  const res = await backend.evaluate({
    model: "m",
    state: {},
    questions: QUESTIONS,
    llm: { callPolicy: "tool" },
  });

  assert.equal(calls.length, 2);
  assert.equal(res.upstreamCalls, 2);
  assert.equal(Object.keys(res.answers).length, 2);
  assert.equal(res.usage?.inputTokens, 100, "两轮的 token 要累加，不是只算最后一轮");
  // 回述 assistant 的 tool_calls —— 少了它上游会拒收随后的 tool 消息
  const second = calls[1].body["messages"] as { role: string }[];
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "tool"]);
});

test("★ 工具循环一轮全答完时只发一次请求（实测模型总是这样）", async () => {
  const { calls, fetchImpl } = recorder(() =>
    jsonResponse(
      openAiTool([
        { id: "call_1", answers: [{ key: "flip_1_1", value: 0.9 }, { key: "flip_1_2", value: 0.1 }] },
      ]),
    ),
  );
  const backend = createLlmBackend(CFG, {
    id: "llmopenai", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, retry: FAST, fetchImpl,
  });
  const res = await backend.evaluate({
    model: "m", state: {}, questions: QUESTIONS, llm: { callPolicy: "tool" },
  });
  assert.equal(calls.length, 1);
  assert.equal(res.upstreamCalls, 1);
});

test("★ Anthropic 工具循环：续轮用 tool_result 块 + assistant 的 tool_use 块", async () => {
  const { calls, fetchImpl } = recorder((_c, n) => {
    if (n === 1) {
      return jsonResponse({
        content: [{ type: "tool_use", id: "call_1", name: "answer_questions", input: { answers: [{ key: "flip_1_1", value: 0.9 }] } }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }
    return jsonResponse({
      content: [{ type: "tool_use", id: "call_2", name: "answer_questions", input: { answers: [{ key: "flip_1_2", value: 0.1 }] } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 6 },
    });
  });
  const backend = createLlmBackend(CFG, {
    id: "llmanthropic", protocol: "anthropic", upstream: ANTHROPIC_COMPAT_UPSTREAM, retry: FAST, fetchImpl,
    llm: { callPolicy: "tool" },
  });
  const res = await backend.evaluate({
    model: "m", state: {}, questions: QUESTIONS, llm: { callPolicy: "tool" },
  });

  assert.equal(calls.length, 2);
  assert.equal(res.upstreamCalls, 2);
  assert.equal(Object.keys(res.answers).length, 2);
  assert.equal(res.usage?.inputTokens, 30);

  const msgs = calls[1].body["messages"] as { role: string; content: unknown }[];
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  const assistantBlocks = msgs[1].content as { type: string }[];
  assert.equal(assistantBlocks[0].type, "tool_use");
  const resultBlocks = msgs[2].content as { type: string; tool_use_id?: string }[];
  assert.equal(resultBlocks[0].type, "tool_result");
  assert.equal(resultBlocks[0].tool_use_id, "call_1");
});

test("★ 工具循环里一条有效答案都没进 → 报错，不原地打转", async () => {
  const { calls, fetchImpl } = recorder(() =>
    jsonResponse(openAiTool([{ id: "call_1", answers: [{ key: "没问过的题", value: 0.5 }] }])),
  );
  const backend = createLlmBackend(CFG, {
    id: "llmopenai", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, retry: { max: 0, baseMs: 1 }, fetchImpl,
  });
  await assert.rejects(
    () => backend.evaluate({ model: "m", state: {}, questions: QUESTIONS, llm: { callPolicy: "tool" } }),
    (e: unknown) => e instanceof JevError && e.retryable === true,
  );
  assert.equal(calls.length, 1);
});

/* ══════════════════════════════════════════════════════════════════
   六、effort 三态确实走到了请求体上
   ══════════════════════════════════════════════════════════════════ */

test("默认姿态：OpenAI 路径发 reasoning_effort=none", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmopenai", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, retry: FAST, fetchImpl,
  });
  await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS });
  assert.equal(calls[0].body["reasoning_effort"], "none");
});

test("★ 界面上选了「xhigh」而这条后端收不了 → 整个字段不发，不是发出去碰运气", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmopenai", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, retry: FAST, fetchImpl,
  });
  await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS, llm: { effort: "xhigh" } });
  assert.ok(
    !("reasoning_effort" in calls[0].body),
    "实测 xhigh 在这个上游上直接 400 把整个决策请求打掉",
  );
});

test("★ 界面上选「留空」= 明确要求不发这个字段（与「没传」分开）", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmopenai", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, retry: FAST, fetchImpl,
  });
  await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS, llm: { effort: null } });
  assert.ok(!("reasoning_effort" in calls[0].body));
});

test("请求上的 llm 覆盖构造时的 llm（同一个后端实例被不同设置复用）", async () => {
  const { calls, fetchImpl } = recorder(() => jsonResponse(openAiText(ANSWERS)));
  const backend = createLlmBackend(CFG, {
    id: "llmopenai", protocol: "openai", upstream: OPENAI_COMPAT_UPSTREAM, retry: FAST, fetchImpl,
    llm: { effort: "none" },
  });
  await backend.evaluate({ model: "m", state: {}, questions: QUESTIONS, llm: { effort: null } });
  assert.ok(!("reasoning_effort" in calls[0].body), "请求上的那一份才是这一次怎么谈");
});
