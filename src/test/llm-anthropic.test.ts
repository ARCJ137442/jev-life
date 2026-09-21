/**
 * Anthropic 兼容协议的 broker 侧 —— 第二种协议的形状翻译。
 *
 * ═══ 为什么需要它 ═══
 *
 * `docs/llm-backends.md` 第零节：用户自备 key 的那两条里，**翻译必须发生在浏览器里**
 * （GitHub Pages 上连 Serverless 都没有）。broker 本来就是纯函数，两边都能跑 ——
 * 但它过去只会说 OpenAI 兼容协议那一种形状。
 *
 * ═══ 每条断言背后的实测 ═══
 *
 * 全部来自 2026-09-21 对 `POST {base}/messages` 壳的真实调用（Agnes 的
 * Anthropic 兼容端点），**不是照协议文档推的**。原始回包见
 * `docs/llm-backends.md` 第五节的实测记录。三条最容易写错的：
 *
 *   1. `system` 在**顶层**，不在 `messages` 里（放进去会被当成用户消息）
 *   2. 正文藏在 `content[]` 里，要挑 `type === "text"` 那一段；
 *      开了思考时 `content` 里还有别的块
 *   3. 工具调用的 `input` 是**对象**，不是 OpenAI 那种 JSON 字符串 ——
 *      照抄 OpenAI 的解析会得到一句 `[object Object]`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANTHROPIC_COMPAT_UPSTREAM,
  ANSWER_TOOL_NAME,
  BrokerError,
  OPENAI_COMPAT_UPSTREAM,
  answersFromToolInput,
  anthropicAssistantMessage,
  anthropicToolResultMessage,
  anthropicUsageOf,
  buildAnthropicToolRequest,
  capabilitiesOf,
  extractAnthropicContent,
  extractAnthropicToolCalls,
  fromLlmContent,
  llmEndpoint,
  resolveEffort,
  toAnthropicRequest,
} from "../shared/llm-broker.js";
import type { Questions } from "../shared/types.js";

function noulQuestions(keys: string[]): Questions {
  const q: Questions = {};
  for (const k of keys) {
    q[k] = {
      type: "noul",
      instructions: `在 (${k}) 放置一个活细胞，是否有利？`,
      criteria: { true: "有利", false: "不利" },
    };
  }
  return q;
}

/** 实测回包：只有一段正文 */
function textPayload(text: string, stop = "end_turn"): unknown {
  return { type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: stop };
}

/* ══════════════════════════════════════════════════════════════════
   零、端点的拼法
   ══════════════════════════════════════════════════════════════════ */

test("★ 两条协议各拼各的路径 —— 拼错是 404，而 404 与「后端挂了」长得一样", () => {
  assert.equal(llmEndpoint("https://api.deepseek.com/v1", "openai"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(llmEndpoint("https://api.anthropic.com/v1", "anthropic"), "https://api.anthropic.com/v1/messages");
});

test("用户直接把完整端点粘进来时不重复拼接 —— 两种粘法都得能用", () => {
  assert.equal(
    llmEndpoint("https://api.deepseek.com/v1/chat/completions", "openai"),
    "https://api.deepseek.com/v1/chat/completions",
  );
  assert.equal(llmEndpoint("https://x/v1/messages/", "anthropic"), "https://x/v1/messages");
});

/* ══════════════════════════════════════════════════════════════════
   一、能力表：这两条是**协议族**，不是一个厂商
   ══════════════════════════════════════════════════════════════════ */

test("★ OpenAI 兼容族：none/low/medium/high/max 发，xhigh 不发（实测 400）", () => {
  const cap = capabilitiesOf(OPENAI_COMPAT_UPSTREAM);
  assert.equal(cap.supportsEffort, true);
  assert.ok(!cap.reasoningEfforts.includes("xhigh"));
  assert.equal(resolveEffort("high", OPENAI_COMPAT_UPSTREAM), "high");
  assert.equal(resolveEffort("xhigh", OPENAI_COMPAT_UPSTREAM), undefined);
});

test("★ Anthropic 兼容族：只认 none（协议里根本没有 reasoning_effort 这个字段）", () => {
  const cap = capabilitiesOf(ANTHROPIC_COMPAT_UPSTREAM);
  assert.equal(cap.supportsEffort, true, "关思维链要能表达，否则默认姿态就丢了");
  assert.deepEqual([...cap.reasoningEfforts], ["none"]);
  assert.equal(resolveEffort("none", ANTHROPIC_COMPAT_UPSTREAM), "none");
  assert.equal(resolveEffort("high", ANTHROPIC_COMPAT_UPSTREAM), undefined);
  assert.equal(resolveEffort(null, ANTHROPIC_COMPAT_UPSTREAM), undefined);
});

/* ══════════════════════════════════════════════════════════════════
   二、请求侧：Jev 形状 → Anthropic 形状
   ══════════════════════════════════════════════════════════════════ */

test("★ system 在顶层，messages 里只有 user —— 实测回包与请求都是这个形状", () => {
  const req = toAnthropicRequest("m", { turn: 1 }, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  assert.equal(typeof req.system, "string");
  assert.ok(req.system.length > 0);
  assert.equal(req.messages.length, 1);
  assert.equal(req.messages[0].role, "user");
  assert.ok(
    !req.messages.some((m) => (m as { role: string }).role === "system"),
    "system 混进 messages 会被当成用户消息",
  );
});

test("★ max_tokens 必填（协议要求），且**没有** response_format", () => {
  const req = toAnthropicRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  assert.equal(typeof req.max_tokens, "number");
  assert.ok(req.max_tokens > 0);
  assert.ok(!("response_format" in req), "Anthropic 协议没有 response_format，发出去是未知参数");
});

test("★ 默认姿态是关思考：落到 Anthropic 的 thinking:{type:disabled}", () => {
  const dflt = toAnthropicRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  assert.deepEqual(dflt.thinking, { type: "disabled" });
});

test("★ effort=null（界面选「留空」）→ 连 thinking 都不发，用上游默认", () => {
  const req = toAnthropicRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
    effort: null,
  });
  assert.ok(!("thinking" in req), "「留空」是一次明确的选择，不能被悄悄改成 disabled");
});

test("★ effort=high 在 Anthropic 族收不了 → 不发（不是降级成 disabled）", () => {
  const req = toAnthropicRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
    effort: "high",
  });
  assert.ok(
    !("thinking" in req),
    "用户要的是「多想一点」，替它改成「不许想」是在悄悄改语义",
  );
});

test("显式传 none 时提示词里才有「不要展开推理过程」", () => {
  const withNone = toAnthropicRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
    effort: "none",
  });
  const withNull = toAnthropicRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
    effort: null,
  });
  assert.ok(withNone.system.includes("不要展开推理过程"));
  assert.ok(!withNull.system.includes("不要展开推理过程"));
});

test("题面逐条列出，题数与 key 都对", () => {
  const req = toAnthropicRequest("m", {}, noulQuestions(["flip_1_1", "flip_2_2"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  const user = req.messages[0].content as string;
  assert.ok(user.includes("flip_1_1"));
  assert.ok(user.includes("flip_2_2"));
  assert.ok(user.includes("请回答以下 2 个问题"));
});

test("toAnthropicRequest 不改动传入的 state 与 questions", () => {
  const qs = noulQuestions(["a"]);
  const state = { turn: 3, nested: { x: [1, 2] } };
  const before = JSON.stringify([qs, state]);
  toAnthropicRequest("m", state, qs, { upstream: ANTHROPIC_COMPAT_UPSTREAM });
  assert.equal(JSON.stringify([qs, state]), before);
});

/* ═══ 工具路径 ═══ */

test("★ 工具定义用 input_schema（不是 OpenAI 的 function.parameters）", () => {
  const req = buildAnthropicToolRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].name, ANSWER_TOOL_NAME);
  assert.ok(!("type" in req.tools[0]), "Anthropic 的工具定义没有 type:function 那一层");
  assert.equal((req.tools[0].input_schema as { type?: string }).type, "object");
});

test("★ tool_choice 是对象 {type:auto}，不是字符串 \"auto\"", () => {
  const req = buildAnthropicToolRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  assert.deepEqual(req.tool_choice, { type: "auto" });
});

test("工具路径同样不带 response_format —— 形状由 schema 强制", () => {
  const req = buildAnthropicToolRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  assert.ok(!("response_format" in req));
});

test("工具路径沿用同一套 effort 收敛", () => {
  const dflt = buildAnthropicToolRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  const explicitNull = buildAnthropicToolRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
    effort: null,
  });
  assert.deepEqual(dflt.thinking, { type: "disabled" });
  assert.ok(!("thinking" in explicitNull));
});

test("工具路径的提示词用工具名，不出现 JSON 形状那句", () => {
  const req = buildAnthropicToolRequest("m", {}, noulQuestions(["a"]), {
    upstream: ANTHROPIC_COMPAT_UPSTREAM,
  });
  assert.ok(req.system.includes(ANSWER_TOOL_NAME));
  assert.ok(!req.system.includes("只输出 JSON"));
});

/* ══════════════════════════════════════════════════════════════════
   三、响应侧：Anthropic 形状 → Jev 形状
   ══════════════════════════════════════════════════════════════════ */

test("★ 正文在 content[] 里，取 type === text 那一段", () => {
  const text = extractAnthropicContent(textPayload('{"answers":[]}'));
  assert.equal(text, '{"answers":[]}');
});

test("★ 思考块不是正文 —— 挑错块会把推理过程当成答案去解析", () => {
  // 开了思考时 content 里会有别的块，正文不在第一个位置
  const payload = {
    content: [
      { type: "thinking", thinking: "让我想想……" },
      { type: "text", text: '{"answers":[{"key":"a","value":0.5}]}' },
    ],
    stop_reason: "end_turn",
  };
  assert.equal(extractAnthropicContent(payload), '{"answers":[{"key":"a","value":0.5}]}');
});

test("★ 判据必须是 `type === \"text\"`，不是「这个块有没有 text 字段」", () => {
  // 协议规定只有 `type:"text"` 的块是正文，思考块用的是 `thinking` 字段。
  // 但**网关未必照协议来**（本项目栽过「文档说一套、网关做一套」），
  // 所以这里构造一个「推理正文也放在 text 字段里」的块：
  // 判据只要松成「有 text 就算」，推理过程就会被当成答案送去 JSON.parse，
  // 而错误会报成「模型输出的不是合法 JSON」—— 指向模型，真正的原因在解析。
  const payload = {
    content: [
      { type: "thinking", text: "让我先想想……" },
      { type: "text", text: '{"answers":[{"key":"a","value":0.5}]}' },
    ],
    stop_reason: "end_turn",
  };
  assert.equal(
    extractAnthropicContent(payload),
    '{"answers":[{"key":"a","value":0.5}]}',
    "推理块混进了正文",
  );
});

test("工具路径同样只认 type === \"text\" 的那一段", () => {
  const payload = {
    content: [
      { type: "thinking", text: "让我先想想……" },
      { type: "tool_use", id: "call_1", name: ANSWER_TOOL_NAME, input: { answers: [] } },
    ],
    stop_reason: "tool_use",
  };
  // 一个 tool_use 取回来了，说明没被那个带 text 字段的块搅乱
  assert.equal(extractAnthropicToolCalls(payload).length, 1);
});

test("多段 text 原样接起来（不插分隔符 —— 插了会把 JSON 拆坏）", () => {
  const payload = {
    content: [
      { type: "text", text: '{"answers":' },
      { type: "text", text: "[]}" },
    ],
    stop_reason: "end_turn",
  };
  assert.equal(extractAnthropicContent(payload), '{"answers":[]}');
});

test("★ 空的 content 数组当失败，错误里带上 stop_reason", () => {
  assert.throws(
    () => extractAnthropicContent({ content: [], stop_reason: "end_turn" }),
    (e: unknown) => e instanceof BrokerError && e.retryable,
  );
});

test("★ stop_reason=max_tokens 时点明是推理吃光了预算，而不是笼统的「空的 content」", () => {
  // 这是实测里唯一的失败形态：HTTP 200、看着像成功、实际什么都没答
  assert.throws(
    () => extractAnthropicContent({ content: [], stop_reason: "max_tokens" }),
    (e: unknown) => e instanceof BrokerError && /推理/.test(e.message),
  );
});

test("只有 tool_use 块、没有 text 块时 extractAnthropicContent 抛错（工具路径不该调它）", () => {
  assert.throws(
    () =>
      extractAnthropicContent({
        content: [{ type: "tool_use", id: "t1", name: ANSWER_TOOL_NAME, input: {} }],
        stop_reason: "tool_use",
      }),
    BrokerError,
  );
});

test("回包里压根没有 content 数组 → 抛错，不静默当空", () => {
  assert.throws(() => extractAnthropicContent({}), BrokerError);
  assert.throws(() => extractAnthropicContent(null), BrokerError);
});

/* ══════════════════════════════════════════════════════════════════
   ★ 代码围栏：Anthropic 协议**没有** response_format，模型爱套围栏
   ══════════════════════════════════════════════════════════════════

   实测（2026-09-21，Agnes 的 Anthropic 兼容端点，真 key）：同一份提示词，
   OpenAI 那边因为带了 `response_format: {type:"json_object"}`，回的是**裸 JSON**；
   Anthropic 这边没有那个字段可发，回的是

       ```json
       {"answers":[…]}
       ```

   于是 JSON 路径（**默认**的调用策略）在这条协议上原本是 100% 失败 ——
   而失败文案是「上游输出的不是合法 JSON」，看上去像模型不听话，
   真正的原因在协议少了一个字段。这条是**端到端跑真 key 才发现的**，
   纯函数的形状测试全绿。 */

test("★ 整段被 ```json 围栏包住时照样能解析（Anthropic 协议没有 response_format）", () => {
  const out = fromLlmContent('```json\n{"answers":[{"key":"a","value":0.6}]}\n```', noulQuestions(["a"]));
  assert.equal((out["a"] as { noul?: number }).noul, 0.6);
});

test("不带语言标记的围栏、以及围栏后面还跟了一句话，都要认", () => {
  const plain = fromLlmContent('```\n{"answers":[{"key":"a","value":0.6}]}\n```', noulQuestions(["a"]));
  assert.equal(Object.keys(plain).length, 1);
  const trailing = fromLlmContent(
    '```json\n{"answers":[{"key":"a","value":0.6}]}\n```\n以上。',
    noulQuestions(["a"]),
  );
  assert.equal(Object.keys(trailing).length, 1);
});

test("★ 围栏前面还有一段话时不猜 —— 容错是刻意收窄的，不是「差不多就行」", () => {
  // 往前找 JSON 等于在替模型猜哪一段才是答案，而猜出来的东西会混进统计。
  // 这条边界是刻意的：要放宽，先有实测依据说明放宽能救回多少
  assert.throws(
    () => fromLlmContent('好的，答案如下：\n```json\n{"answers":[{"key":"a","value":0.6}]}\n```', noulQuestions(["a"])),
    BrokerError,
  );
});

test("围栏里装的不是合法 JSON 时，仍然按解析失败报", () => {
  assert.throws(() => fromLlmContent("```json\n不是 JSON\n```", noulQuestions(["a"])), BrokerError);
});

/* ═══ 工具调用 ═══ */

/** 实测回包：content 里一个 tool_use 块 */
function toolPayload(calls: { id: string; input: unknown; name?: string }[], extra: { text?: string; stop?: string } = {}): unknown {
  const content: unknown[] = calls.map((c) => ({
    type: "tool_use",
    id: c.id,
    name: c.name ?? ANSWER_TOOL_NAME,
    input: c.input,
  }));
  if (extra.text !== undefined) content.unshift({ type: "text", text: extra.text });
  return { content, stop_reason: extra.stop ?? "tool_use" };
}

test("★ tool_use 的 input 是**对象**，不是 JSON 字符串（照抄 OpenAI 会拿到 [object Object]）", () => {
  const calls = extractAnthropicToolCalls(
    toolPayload([{ id: "call_1", input: { answers: [{ key: "a", value: 0.4 }] } }]),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "call_1");
  assert.deepEqual(calls[0].input, { answers: [{ key: "a", value: 0.4 }] });
});

test("多个 tool_use 一次取回，顺序与 id 原样保留（实测一轮回过 4 条）", () => {
  const calls = extractAnthropicToolCalls(
    toolPayload([
      { id: "call_a", input: { answers: [{ key: "a", value: 0.1 }] } },
      { id: "call_b", input: { answers: [{ key: "b", value: 0.2 }] } },
    ]),
  );
  assert.deepEqual(calls.map((c) => c.id), ["call_a", "call_b"]);
});

test("没有 id 的 tool_use 丢掉 —— tool_result 要靠它配对，没有 id 就回不了话", () => {
  const payload = {
    content: [{ type: "tool_use", name: ANSWER_TOOL_NAME, input: {} }],
    stop_reason: "tool_use",
  };
  assert.throws(() => extractAnthropicToolCalls(payload), BrokerError);
});

test("★ 一个 tool_use 都没有时按三种情形分开报", () => {
  // 1. 预算烧光
  assert.throws(
    () => extractAnthropicToolCalls({ content: [], stop_reason: "max_tokens" }),
    (e: unknown) => e instanceof BrokerError && /推理/.test(e.message),
  );
  // 2. 回了一段文字（提示词没让它用工具）
  assert.throws(
    () => extractAnthropicToolCalls(toolPayload([], { text: "我觉得该翻。", stop: "end_turn" })),
    (e: unknown) => e instanceof BrokerError && /文字/.test(e.message),
  );
  // 3. 结构就不对
  assert.throws(() => extractAnthropicToolCalls({}), BrokerError);
});

/* ═══ usage ═══ */

test("★ usage 用 input_tokens / output_tokens（与 OpenAI 的 prompt/completion 不是一套）", () => {
  const u = anthropicUsageOf({ usage: { input_tokens: 437, output_tokens: 114 } });
  assert.equal(u.inputTokens, 437);
  assert.equal(u.outputTokens, 114);
});

test("没报 usage 时是 0，不是崩 —— 与 costUsd 的 null 是两回事", () => {
  assert.deepEqual(anthropicUsageOf({}), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
});

test("★ Anthropic 的 usage 里没有推理 token 那一栏 —— 记 0，并知道这是个已知盲区", () => {
  // 实测的 Anthropic 兼容回包只有 input/output 与两个 cache 字段。
  // 「用了推理却不报」的后端会让这一栏恒为 0 —— 与 TokenUsage 注释里那条
  // 已知边界是同一件事，不是新问题
  const u = anthropicUsageOf({ usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 } });
  assert.equal(u.reasoningTokens, 0);
});

/* ══════════════════════════════════════════════════════════════════
   四、工具参数 → 答案（对象形态）
   ══════════════════════════════════════════════════════════════════ */

test("★ answersFromToolInput 直接收对象（Anthropic 的 input 已经是解析好的）", () => {
  const qs = noulQuestions(["a", "b"]);
  const out = answersFromToolInput({ answers: [{ key: "a", value: 0.72 }, { key: "b", value: 1.5 }] }, qs);
  assert.equal((out["a"] as { noul?: number }).noul, 0.72);
  assert.equal((out["b"] as { noul?: number }).noul, 1, "越界夹住而不是丢弃");
});

test("没问过的键、非数值一律丢掉，不抛", () => {
  const qs = noulQuestions(["a"]);
  assert.deepEqual(answersFromToolInput({ answers: [{ key: "别的", value: 0.5 }] }, qs), {});
  assert.deepEqual(answersFromToolInput({ answers: [{ key: "a", value: "高" }] }, qs), {});
  assert.deepEqual(answersFromToolInput({}, qs), {});
  assert.deepEqual(answersFromToolInput(null, qs), {});
  assert.deepEqual(answersFromToolInput("字符串", qs), {});
});

test("answersFromToolInput 不改动入参", () => {
  const qs = noulQuestions(["a"]);
  const input = { answers: [{ key: "a", value: 0.3 }] };
  const before = JSON.stringify([qs, input]);
  answersFromToolInput(input, qs);
  assert.equal(JSON.stringify([qs, input]), before);
});

/* ══════════════════════════════════════════════════════════════════
   五、两条要发回去的消息
   ══════════════════════════════════════════════════════════════════ */

test("★ 复述 assistant 的 tool_use 块 —— 不回述，上游会说「tool_result 没有对应的 tool_use」", () => {
  const calls = extractAnthropicToolCalls(
    toolPayload([{ id: "call_1", input: { answers: [{ key: "a", value: 0.5 }] } }]),
  );
  const m = anthropicAssistantMessage(calls);
  assert.equal(m.role, "assistant");
  const blocks = m.content as unknown as { type: string; id?: string; input?: unknown }[];
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "tool_use");
  assert.equal(blocks[0].id, "call_1");
  assert.deepEqual(blocks[0].input, { answers: [{ key: "a", value: 0.5 }] });
});

test("★ tool_result 走 user 消息里的块，用 tool_use_id 配对（不是 OpenAI 的 role:tool）", () => {
  const m = anthropicToolResultMessage("call_1", ["a"], 5, ["b", "c"]);
  assert.equal(m.role, "user");
  const blocks = m.content as { type: string; tool_use_id?: string; content?: string }[];
  assert.equal(blocks[0].type, "tool_result");
  assert.equal(blocks[0].tool_use_id, "call_1", "配不上对的 tool_result 上游直接拒收");
  const body = JSON.parse(blocks[0].content as string) as Record<string, unknown>;
  assert.deepEqual(body["accepted"], ["a"]);
  assert.equal(body["remaining"], 5);
  assert.deepEqual(body["remaining_keys"], ["b", "c"]);
});
