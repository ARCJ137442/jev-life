import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BrokerError,
  capabilitiesOf,
  clampEffort,
  extractContent,
  fromLlmContent,
  questionText,
  toLlmRequest,
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
