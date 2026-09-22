import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ANSWER_TOOL_NAME,
  BrokerError,
  answerTool,
  answersFromToolArguments,
  assistantToolCallsMessage,
  buildToolRequest,
  capabilitiesOf,
  clampEffort,
  extractContent,
  extractToolCalls,
  fromLlmContent,
  questionText,
  toLlmRequest,
  toolResultMessage,
  usageOf,
} from "../shared/llm-broker.js";
import type { Questions } from "../shared/types.js";

/* ═══ 上下文 ═══
   这一层是四层架构里的 broker：把 Jev 形状翻译成 LLM 调用、再翻译回来。
   实测依据见 docs/llm-backends.md —— 下面每条断言都对应那里的一个结论。 */

function noulQuestions(keys: string[]): Questions {
  const q: Questions = {};
  for (const k of keys) {
    q[k] = {
      type: "noul",
      instructions: `在 (${k.split("_").slice(1).join(",")}) 放置一个活细胞并演化一代，是否有利于最终累计活细胞数？`,
      criteria: { true: "有利", false: "不利" },
    };
  }
  return q;
}

/* ═══ 一、关思维链是默认姿态 ═══ */

test("默认请求关思维链（实测：0-63% → 100%）", () => {
  const req = toLlmRequest("m", { board: [] }, noulQuestions(["flip_1_1"]), { upstream: "agnes" });
  assert.equal(req.reasoning_effort, "none");
});

test("未知上游：整个 reasoning_effort 字段不发", () => {
  // 「不认识的取值不发出去」比「猜它能收」安全 —— 猜错的代价是整个请求 400
  const req = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), { upstream: "某个没见过的上游" });
  assert.ok(
    !("reasoning_effort" in req),
    "对不认识的上游发了 reasoning_effort —— 那是在猜它能收",
  );
});

test("agnes 不收 xhigh：期望 xhigh 时字段不发（不是降级成别的档位）", () => {
  const req = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), {
    upstream: "agnes",
    effort: "xhigh",
  });
  assert.ok(!("reasoning_effort" in req), "xhigh 应收敛成「不发」，而不是原样发出去");
});

test("agnes 认识 low/medium/high/max，原样发", () => {
  for (const e of ["low", "medium", "high", "max"] as const) {
    const req = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), { upstream: "agnes", effort: e });
    assert.equal(req.reasoning_effort, e);
  }
});

test("clampEffort：不支持的取值返回 undefined，且不改语义", () => {
  assert.equal(clampEffort("none", "agnes"), "none");
  assert.equal(clampEffort("xhigh", "agnes"), undefined);
  assert.equal(clampEffort("none", "没见过的上游"), undefined);
  assert.equal(clampEffort(undefined, "agnes"), undefined);
});

test("capabilitiesOf：不在表里的上游一律不支持", () => {
  assert.equal(capabilitiesOf("没见过的上游").supportsEffort, false);
  assert.equal(capabilitiesOf("agnes").supportsEffort, true);
});

/* ═══ 二、纯函数 ═══ */

test("toLlmRequest 不改动传入的 state 与 questions", () => {
  const state = { board: [[0, 1]], turn: 3 };
  const qs = noulQuestions(["flip_1_1", "flip_1_2"]);
  const snapState = JSON.stringify(state);
  const snapQs = JSON.stringify(qs);

  toLlmRequest("m", state, qs, { upstream: "agnes" });

  assert.equal(JSON.stringify(state), snapState, "state 被改动了");
  assert.equal(JSON.stringify(qs), snapQs, "questions 被改动了");
});

/* ═══ 三、空 content 必须当失败 ═══
   这是实测观察到的**唯一**失败形态：HTTP 200、finish_reason=length、content 为空。
   「看着像成功，实际什么都没答」—— 不在这里拦住，它会以「答案数 0」流进统计，
   表现成「模型不行」，而真正的原因是推理吃光了预算。 */

test("空 content + finish_reason=length → 抛错，且点明是推理吃光了预算", () => {
  let err: unknown;
  try {
    extractContent({ message: { content: "" }, finish_reason: "length" });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof BrokerError, "空 content 没有被当成失败");
  assert.match((err as Error).message, /推理/, "错误信息没有点明真正的原因");
  assert.equal((err as BrokerError).retryable, true);
  assert.equal((err as BrokerError).finishReason, "length");
});

test("空 content + finish_reason=stop → 同样抛错（另一种什么都没答）", () => {
  assert.throws(
    () => extractContent({ message: { content: "" }, finish_reason: "stop" }),
    /空的 content/,
  );
});

test("只有空白字符也算空", () => {
  assert.throws(() => extractContent({ message: { content: "   \n  " }, finish_reason: "stop" }));
});

test("没有 choices[0] → 抛错", () => {
  assert.throws(() => extractContent(undefined), /没有 choices/);
});

test("正常回包原样返回", () => {
  assert.equal(
    extractContent({ message: { content: '{"answers":[]}' }, finish_reason: "stop" }),
    '{"answers":[]}',
  );
});

/* ═══ 四、把模型的输出翻译回 Jev 形状 ═══ */

test("正常解析：answers 数组 → Jev 的答案映射", () => {
  const qs = noulQuestions(["flip_1_1", "flip_2_2"]);
  const out = fromLlmContent(
    '{"answers":[{"key":"flip_1_1","value":0.7},{"key":"flip_2_2","value":0.2}]}',
    qs,
  );
  assert.deepEqual(Object.keys(out).sort(), ["flip_1_1", "flip_2_2"]);
  assert.equal((out["flip_1_1"] as { noul?: number }).noul, 0.7);
  assert.equal((out["flip_1_1"] as { type?: string }).type, "noul");
});

test("裸数组也接受（模型偶尔不套 answers 外壳）", () => {
  const qs = noulQuestions(["flip_1_1"]);
  const out = fromLlmContent('[{"key":"flip_1_1","value":0.5}]', qs);
  assert.equal((out["flip_1_1"] as { noul?: number }).noul, 0.5);
});

test("键不在 questions 里的一律丢弃 —— 模型凭空多答会让「答案数」这个统计失真", () => {
  const qs = noulQuestions(["flip_1_1"]);
  const out = fromLlmContent(
    '{"answers":[{"key":"flip_1_1","value":0.5},{"key":"我没问过这个","value":0.9}]}',
    qs,
  );
  assert.deepEqual(Object.keys(out), ["flip_1_1"]);
});

test("值不是有限数的一律丢弃", () => {
  const qs = noulQuestions(["a", "b", "c"]);
  const out = fromLlmContent(
    '{"answers":[{"key":"a","value":"0.5"},{"key":"b","value":null},{"key":"c","value":0.3}]}',
    qs,
  );
  assert.deepEqual(Object.keys(out), ["c"]);
});

test("概率超出 0~1 时夹住，而不是丢弃（丢弃等于白跑一次调用）", () => {
  const qs = noulQuestions(["a", "b"]);
  const out = fromLlmContent('{"answers":[{"key":"a","value":1.5},{"key":"b","value":-0.2}]}', qs);
  assert.equal((out["a"] as { noul?: number }).noul, 1);
  assert.equal((out["b"] as { noul?: number }).noul, 0);
});

test("一条答案都解析不出来时抛错（而不是返回空映射）", () => {
  const qs = noulQuestions(["a"]);
  assert.throws(() => fromLlmContent('{"answers":[]}', qs), /没答出任何一道题/);
  assert.throws(() => fromLlmContent('{"answers":[{"key":"没问过","value":1}]}', qs), BrokerError);
});

test("不是合法 JSON → 抛错，并把原文截一段带上", () => {
  assert.throws(() => fromLlmContent("我觉得吧……", noulQuestions(["a"])), /不是合法 JSON/);
});

test("是 JSON 但没有 answers 数组 → 抛错", () => {
  assert.throws(() => fromLlmContent('{"result":"ok"}', noulQuestions(["a"])), /没有 answers 数组/);
});

test("题数不足是允许的，由调用方检查 —— broker 不替它决定", () => {
  // 与「一条都没有」是两回事：前者可以决策，后者必须重试
  const qs = noulQuestions(["a", "b", "c"]);
  const out = fromLlmContent('{"answers":[{"key":"a","value":0.5}]}', qs);
  assert.equal(Object.keys(out).length, 1);
});

/* ═══ 五、题面文本 ═══ */

test("布尔题的题面：把 true/false 的语义讲清楚，而不是只给个数字", () => {
  const text = questionText({
    type: "noul",
    instructions: "这一手是否有利？",
    criteria: { true: "有利", false: "不利" },
  });
  assert.match(text, /这一手是否有利？/);
  assert.match(text, /有利/);
  assert.match(text, /不利/);
});

test("choice 题的题面列出选项", () => {
  const text = questionText({
    type: "choice",
    instructions: "选哪个？",
    criteria: { up: "向上", down: "向下" },
  });
  assert.match(text, /up/);
  assert.match(text, /down/);
});

test("不认识的问题类型要抛错，不能静默产出一句空话", () => {
  // 一句空话会让模型去猜，而它猜出来的东西会混进统计里、分辨不出来
  assert.throws(
    () => questionText({ type: "score" as never, instructions: "打分", criteria: ["a", "b"] }),
    /暂不支持/,
  );
});

/* ═══ 六、用量记账 ═══ */

test("usageOf：上游没报 reasoning_tokens 时是 0，不是 null", () => {
  // 与 costUsd 的语义不同：「不知道价格」和「没有推理」是两回事
  const u = usageOf({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
  assert.equal(u.reasoningTokens, 0);
  assert.equal(u.inputTokens, 10);
  assert.equal(u.outputTokens, 5);
});

test("usageOf：报了推理 token 就单独记下来（可占输出的 100%）", () => {
  const u = usageOf({
    usage: { prompt_tokens: 100, completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 4000 } },
  });
  assert.equal(u.reasoningTokens, 4000);
  assert.equal(u.outputTokens, 4000);
});

test("usageOf：整个 usage 缺失时不崩", () => {
  assert.deepEqual(usageOf(null), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
});

/* ═══ 五、三态 effort：界面「留空」必须送得出去 ═══

   界面上「思考强度 = 留空」是一次**明确的选择**（实测与 none 同为 3/3，而四个
   显式档位全部劣于不设），它对应「别发这个字段，用上游自己的默认」。
   如果它与「客户端根本没传」合并成同一个值，那个选项就永远送不出去 ——
   而它的症状是「设了跟没设一样」，看起来像开关坏了。 */

test("★ effort 三态：省略 = 默认姿态 none；null = 明确不发；档位 = 过能力表", () => {
  const omitted = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), { upstream: "agnes" });
  assert.equal(omitted.reasoning_effort, "none", "省略应当落到默认姿态 none");

  const explicitNull = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), {
    upstream: "agnes",
    effort: null,
  });
  assert.ok(
    !("reasoning_effort" in explicitNull),
    "显式 null 应当**整个不发**，而不是回落成 none —— 那是两件不同的事",
  );

  const explicit = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), {
    upstream: "agnes",
    effort: "high",
  });
  assert.equal(explicit.reasoning_effort, "high");
});

test("★ effort=null 时不去查能力表：收不了的上游同样不发（结果一致，理由不同）", () => {
  const req = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), {
    upstream: "没见过的上游",
    effort: null,
  });
  assert.ok(!("reasoning_effort" in req));
});

test("★ effort=null 时提示词里也不会出现「不要展开推理过程」", () => {
  // 那一句跟着 `effort === "none"` 走 —— null 是「用上游默认」，
  // 不该在提示词里替上游做「不许想」的决定
  const req = toLlmRequest("m", {}, noulQuestions(["flip_1_1"]), {
    upstream: "agnes",
    effort: null,
  });
  const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
  assert.ok(!sys.includes("不要展开推理过程"), sys);
});

/* ══════════════════════════════════════════════════════════════════
   七、工具循环路径（`callPolicy = "tool"`）
   ══════════════════════════════════════════════════════════════════

   实测依据见 `docs/llm-backends.md` 第三节：

   - N=1/6/12/24 各 2 次，**8/8 全成功，上游调用次数恒为 1** —— 模型总是选择
     一轮全答。所以 broker **不主动限制每轮批量**，由模型自己权衡
   - `remaining` 回包在这 8 次里**从未被用到**（循环第二轮都没进）。保留它，
     但不要声称它被验证过 —— 下面那条断言测的是**形状**，不是它的效用

   形状来自 `../llm-lab/batch.mjs`（实测脚本），不是推演出来的。
   ⚠ 那份脚本里 `parameters` 是**真的 JSON Schema**，不是 `DESIGN.md` 第七节
   那段简化示意 —— 后者是给人读的，直接发出去上游不认。 */

/** 一次成功的工具调用回包 —— 形状照抄 batch.mjs 里真正收到的那个 */
function toolPayload(
  calls: { id: string; args: unknown }[],
  extra: { content?: string | null; finish_reason?: string } = {},
): unknown {
  return {
    choices: [
      {
        message: {
          content: extra.content ?? null,
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: {
              name: ANSWER_TOOL_NAME,
              arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
            },
          })),
        },
        finish_reason: extra.finish_reason ?? "tool_calls",
      },
    ],
  };
}

/** 从回包里取 choices[0] —— 与发请求那一层取法一致 */
function choiceOf(payload: unknown): Parameters<typeof extractToolCalls>[0] {
  return (payload as { choices?: unknown[] }).choices?.[0] as Parameters<
    typeof extractToolCalls
  >[0];
}

/* ═══ 工具的定义 ═══ */

test("answer_questions 的形状：name 与实测脚本一致，answers 长度 ≥ 1", () => {
  const t = answerTool();
  assert.equal(t.type, "function");
  assert.equal(t.function.name, "answer_questions");
  // 名字是实验条件的一部分：改了它等于换了一个测量对象
  assert.equal(t.function.name, ANSWER_TOOL_NAME);

  const params = t.function.parameters as {
    type: string;
    properties: { answers: { type: string; minItems: number; items: { required: string[] } } };
    required: string[];
  };
  assert.equal(params.type, "object");
  assert.equal(params.properties.answers.type, "array");
  // ≥1 而不是 1：这是「不让模型被一次一题绑住」那条设计的落点。
  // 若把 minItems/maxItems 卡成 1，24 题就是 24 次往返
  assert.equal(params.properties.answers.minItems, 1);
  assert.deepEqual(params.required, ["answers"]);
  assert.deepEqual(params.properties.answers.items.required, ["key", "value"]);
});

test("answerTool 每次返回新对象（调用方可能就地改它）", () => {
  assert.notEqual(answerTool(), answerTool());
});

/* ═══ 请求侧 ═══ */

test("★ 工具路径不带 response_format，且带 tools + tool_choice:auto", () => {
  const req = buildToolRequest("m", { board: [] }, noulQuestions(["flip_1_1"]), {
    upstream: "agnes",
  });
  // response_format 与 tools 是两条互斥的路。同时发出去，上游行为未实测 ——
  // 不拿没测过的组合去跑对照实验
  assert.ok(!("response_format" in req), "工具路径不该带 response_format");
  assert.equal(req.tools.length, 1);
  assert.equal(req.tools[0].function.name, ANSWER_TOOL_NAME);
  assert.equal(req.tool_choice, "auto");
});

test("工具路径的提示词列出题目，但不含 JSON 形状那句", () => {
  const req = buildToolRequest("m", {}, noulQuestions(["flip_3_4"]), { upstream: "agnes" });
  const sys = req.messages.find((m) => m.role === "system")?.content ?? "";
  const user = req.messages.find((m) => m.role === "user")?.content ?? "";
  assert.ok(!sys.includes("只输出 JSON"), "工具路径靠 schema 约束形状，不靠提示词");
  assert.match(user, /flip_3_4/);
  assert.equal(req.messages.length, 2, "首轮只有 system + user");
});

test("★ 工具路径沿用同一套 effort 收敛（xhigh 不发、null 不发、默认 none）", () => {
  const opt = { upstream: "agnes" };
  assert.equal(buildToolRequest("m", {}, noulQuestions(["a"]), opt).reasoning_effort, "none");
  assert.ok(
    !("reasoning_effort" in buildToolRequest("m", {}, noulQuestions(["a"]), { ...opt, effort: "xhigh" })),
    "agnes 不收 xhigh —— 直接发出去会 400 把整个请求打掉",
  );
  assert.ok(
    !("reasoning_effort" in buildToolRequest("m", {}, noulQuestions(["a"]), { ...opt, effort: null })),
    "显式 null = 明确要求不发这个字段",
  );
});

/* ═══ 回包侧：没有 tool_call 的三种情形都要当失败 ═══ */

test("★ 空 content + finish_reason=length 在工具路径同样当失败", () => {
  // 实测的**唯一**失败形态：预算被推理吃光，HTTP 200、一个 tool_call 都不发。
  // 不在这里拦住，它会以「答案数 0」流进统计，表现成「模型不行」
  assert.throws(
    () =>
      extractToolCalls(
        choiceOf(
          toolPayload([], { content: "", finish_reason: "length" }),
        ),
      ),
    (e: unknown) => e instanceof BrokerError && /推理|length/.test((e as Error).message),
  );
});

test("上游没调工具、而是直接回了一段文字 → 报错，且原文带在消息里便于排查", () => {
  assert.throws(
    () =>
      extractToolCalls(
        choiceOf(toolPayload([], { content: "我觉得 flip_1_1 是有利的", finish_reason: "stop" })),
      ),
    (e: unknown) => e instanceof BrokerError && /flip_1_1/.test((e as Error).message),
  );
});

test("回包里连 choices[0] 都没有 → 报错", () => {
  assert.throws(() => extractToolCalls(choiceOf({})), BrokerError);
});

test("没有 tool_calls 字段（undefined）也当失败，不静默返回空数组", () => {
  // 返回空数组会让上层以为「这一轮答了 0 个」而继续循环 —— 死循环的入口
  assert.throws(
    () => extractToolCalls({ message: { content: "好的" }, finish_reason: "stop" }),
    BrokerError,
  );
});

test("多个 tool_call 一次取回，id 与参数原样保留", () => {
  const tcs = extractToolCalls(
    choiceOf(
      toolPayload([
        { id: "call_a", args: { answers: [{ key: "flip_1_1", value: 0.7 }] } },
        { id: "call_b", args: { answers: [{ key: "flip_1_2", value: 0.2 }] } },
      ]),
    ),
  );
  assert.equal(tcs.length, 2);
  assert.deepEqual(tcs.map((t) => t.id), ["call_a", "call_b"]);
  assert.equal(tcs[0].name, ANSWER_TOOL_NAME);
});

/* ═══ 工具参数 → Jev 答案 ═══ */

test("工具参数解析成 answers，越界的概率夹住而不是丢弃", () => {
  const qs = noulQuestions(["flip_1_1", "flip_1_2", "flip_1_3"]);
  const out = answersFromToolArguments(
    JSON.stringify({
      answers: [
        { key: "flip_1_1", value: 0.72 },
        { key: "flip_1_2", value: 1.5 },
        { key: "flip_1_3", value: -0.2 },
      ],
    }),
    qs,
  );
  assert.equal((out["flip_1_1"] as { noul?: number }).noul, 0.72);
  assert.equal(
    (out["flip_1_2"] as { noul?: number }).noul,
    1,
    "越界要夹住 —— 丢弃等于白跑一次调用",
  );
  assert.equal((out["flip_1_3"] as { noul?: number }).noul, 0);
});

test("没问过的键、非数值、坏 JSON 一律丢掉，不抛", () => {
  const qs = noulQuestions(["flip_1_1"]);
  assert.deepEqual(
    answersFromToolArguments(JSON.stringify({ answers: [{ key: "别的题", value: 0.5 }] }), qs),
    {},
  );
  assert.deepEqual(
    answersFromToolArguments(JSON.stringify({ answers: [{ key: "flip_1_1", value: "高" }] }), qs),
    {},
  );
  // 坏参数按实测脚本的处理：忽略这一条，不炸掉整轮
  assert.deepEqual(answersFromToolArguments("{不是 JSON", qs), {});
  assert.deepEqual(answersFromToolArguments(JSON.stringify({ 没有answers: [] }), qs), {});
});

test("answersFromToolArguments 不改动入参", () => {
  const qs = noulQuestions(["flip_1_1"]);
  const before = JSON.stringify(qs);
  answersFromToolArguments(JSON.stringify({ answers: [{ key: "flip_1_1", value: 0.3 }] }), qs);
  assert.equal(JSON.stringify(qs), before);
});

/* ═══ 两条要发回去的消息 ═══ */

test("★ 工具回包如实告诉模型还剩多少", () => {
  const m = toolResultMessage("call_a", ["flip_3_4"], 5, ["flip_2_2", "flip_2_3"]);
  assert.equal(m.role, "tool");
  assert.equal(m.tool_call_id, "call_a");
  const body = JSON.parse(m.content as string) as Record<string, unknown>;
  assert.deepEqual(body["accepted"], ["flip_3_4"]);
  assert.equal(body["remaining"], 5);
  assert.deepEqual(body["remaining_keys"], ["flip_2_2", "flip_2_3"]);
});

test("assistant 消息复述 tool_calls —— 不回述的话上游会拒收随后的 tool 消息", () => {
  const tcs = extractToolCalls(
    choiceOf(toolPayload([{ id: "call_a", args: { answers: [{ key: "a", value: 0.5 }] } }])),
  );
  const m = assistantToolCallsMessage(null, tcs);
  assert.equal(m.role, "assistant");
  assert.equal(m.content, null);
  assert.equal(m.tool_calls?.length, 1);
  assert.equal(m.tool_calls?.[0].id, "call_a");
  assert.equal(m.tool_calls?.[0].type, "function");
  assert.equal(m.tool_calls?.[0].function.name, ANSWER_TOOL_NAME);
});
