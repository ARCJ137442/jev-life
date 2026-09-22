/**
 * `shared/backend.ts`（决策后端适配层）的测试。
 *
 * 源仓库的 `api.ts` **零测试覆盖**，而它里面有三件做错了也不会报错的事：
 *
 *   1. ★ **`costUsd` 无法计价时必须是 `null`，绝不能填 0。**
 *      0 会被下游读成「免费」，而那是错的 —— 一次单价未知的调用不是免费的
 *      调用。源仓库有一条同源的教训：`0` 是 falsy，被吞掉过。
 *   2. **`upstreamCalls` 必须是真的发了几次**，不是「逻辑上算一次」。
 *      它就是「Jev 的并行决策值多少钱」那份测量的分母：把重试漏掉，
 *      测出来的就是「Jev 一次请求」，而不是「这个后端一次决策的真实代价」。
 *   3. **不能把 `content` 为空当正常回包**（这条是实测踩出来的：
 *      推理吃光 max_tokens → 回包 200 但一个答案都没有）。
 *
 * 另外两条源仓库**做不到**的事，这里必须做到：
 *
 *   - **超时**。源仓库全层没有 `AbortController`，Node 的 `fetch` 默认 5 分钟
 *     掐 headers —— 断网时会长时间卡在首次请求上，而且失败得毫无提示。
 *   - **可注入的 `fetch` 与 `rand`**。不可注入的 `Math.random` 让 `backoffDelay`
 *     在源仓库里同样测不了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RETRY,
  JevError,
  backoffDelay,
  callJev,
  createSystemoneBackend,
  isQuotaError,
} from "../shared/backend.js";
import type { ClientConfig, FetchLike, TokenUsage } from "../shared/backend.js";
import { noulDiscriminator, noulProbability } from "../shared/types.js";
import type { Questions } from "../shared/types.js";

/* ══════════════════════════════════════════════════════════════════
   夹具
   ══════════════════════════════════════════════════════════════════ */

/** 直连型后端（浏览器自己带着密钥打到网关） */
const DIRECT: ClientConfig = {
  base: "https://example.invalid/v1/evaluate",
  model: "typesafe-ai/jev",
  apiKey: "sk_TESTONLY_not_a_real_key",
};

/** 代理型后端（路径以 / 开头，密钥由服务端注入） */
const PROXY: ClientConfig = { base: "/api/evaluate", model: "typesafe-ai/jev", apiKey: "" };

/** 不花时间：退避基数 1ms，重试上限由各用例自己给 */
const FAST = { max: 3, baseMs: 1 } as const;

/** 一道最小的问题集。内容与传输无关，但**必须非空** —— 空 questions 是另一种错误 */
const QUESTIONS: Questions = {
  flip_1_2: { type: "noul", instructions: "这一手是否有利？", criteria: { true: "有利", false: "不利" } },
};

interface Recorded {
  url: string;
  init: RequestInit;
  body: unknown;
}

/**
 * 剧本里的一格。
 *
 * 存的是**回包文本**而不是 `Response` 对象 —— 一个 `Response` 的 body 只能读
 * 一次，而剧本的最后一条会被反复用到（「一直失败」那几条用例）。直接复用同一个
 * 对象会在第二次读的时候抛 `Body is unusable`，把「重试了几次」这条断言测成
 * 一个和它无关的错误。
 */
interface Reply {
  readonly status: number;
  readonly body: string;
}

/** 造一个按剧本依次返回结果的 fetch。返回它记录下来的每一次调用 */
function scripted(...results: Array<Reply | Error>): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : undefined });
    const r = results[Math.min(i, results.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return new Response(r.body, {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

function json(body: unknown, status = 200): Reply {
  return { status, body: JSON.stringify(body) };
}

/** 非 JSON 回包（网关的 HTML 错误页就是这种） */
function html(body: string, status = 200): Reply {
  return { status, body };
}

function ok(answers: Record<string, unknown>, usage?: unknown): Reply {
  return json({ answers, ...(usage === undefined ? {} : { usage }) });
}

/** 自己写 fetch 的用例要把 Reply 变成真的 Response */
function toResponse(r: Reply): Response {
  return new Response(r.body, {
    status: r.status,
    headers: { "content-type": "application/json" },
  });
}

const ANSWERS = { flip_1_2: { type: "noul", noul: 0.72 } };

/* ══════════════════════════════════════════════════════════════════
   一、一次成功的调用
   ══════════════════════════════════════════════════════════════════ */

test("成功：答案透传，upstreamCalls = 1", async () => {
  const { fetch, calls } = scripted(ok(ANSWERS, { inputTokens: 1841 }));
  const r = await callJev(DIRECT, { turn: 3 }, QUESTIONS, {
    retry: FAST,
    fetchImpl: fetch,
  });

  assert.deepEqual(r.answers, ANSWERS);
  assert.equal(r.upstreamCalls, 1);
  assert.equal(calls.length, 1);
  assert.ok(r.latencyMs >= 0, "latencyMs 不能是负数");
});

test("请求体是 {model, state, questions} 三件，state 原样透传", async () => {
  const { fetch, calls } = scripted(ok(ANSWERS));
  const state = { rules: { role: "life" }, turn: 7 };

  await callJev(DIRECT, state, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.deepEqual(calls[0].body, { model: DIRECT.model, state, questions: QUESTIONS });
  assert.equal(calls[0].url, DIRECT.base);
  assert.equal((calls[0].init.method ?? "POST"), "POST");
});

test("直连后端带上 Authorization；代理后端绝不带（密钥由服务端注入）", async () => {
  const direct = scripted(ok(ANSWERS));
  await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: direct.fetch });
  const h1 = direct.calls[0].init.headers as Record<string, string>;
  assert.equal(h1["Authorization"], `Bearer ${DIRECT.apiKey}`);

  const proxy = scripted(ok(ANSWERS));
  await callJev(PROXY, {}, QUESTIONS, { retry: FAST, fetchImpl: proxy.fetch });
  const h2 = proxy.calls[0].init.headers as Record<string, string>;
  assert.equal(h2["Authorization"], undefined, "代理模式的密钥在服务端，浏览器不该发");

  // 即便界面上残留着一个 key（用户先填了直连、又切回代理），也不能发出去 ——
  // 判据必须是「base 是不是代理路径」，不能是「有没有 key」
  const proxyWithKey = scripted(ok(ANSWERS));
  await callJev({ ...PROXY, apiKey: "sk_TESTONLY_leftover" }, {}, QUESTIONS, {
    retry: FAST,
    fetchImpl: proxyWithKey.fetch,
  });
  const h3 = proxyWithKey.calls[0].init.headers as Record<string, string>;
  assert.equal(h3["Authorization"], undefined, "代理路径下任何情况下都不发 Authorization");
});

/* ══════════════════════════════════════════════════════════════════
   二、成本：无法计价时必须是 null，绝不填 0
   ══════════════════════════════════════════════════════════════════ */

test("★ 上游没报 usage → usage 与 costUsd 都是 null，**不是 0**", async () => {
  const { fetch } = scripted(ok(ANSWERS)); // 回包里根本没有 usage 字段
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.equal(r.usage, null);
  assert.equal(
    r.costUsd,
    null,
    "填 0 会被下游读成「这一次是免费的」—— 实际情况是「不知道花没花钱」",
  );
});

test("上游报了 0 token → costUsd 是 0（「确实没花」与「不知道」是两回事）", async () => {
  const { fetch } = scripted(ok(ANSWERS, { inputTokens: 0, outputTokens: 0 }));
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
  assert.equal(r.costUsd, 0);
});

test("★ 推理 token 单独记一栏 —— 它可能占到输出的 100%", async () => {
  // 实测形态：思维链开着时推理吃光 max_tokens，输出 4000 里 4000 都是推理，
  // 可用答案是 0 个；关掉之后输出 95、推理 0、答案 1 个。
  const { fetch } = scripted(
    ok(ANSWERS, {
      inputTokens: 1841,
      outputTokens: 4000,
      completion_tokens_details: { reasoning_tokens: 4000 },
    }),
  );
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.deepEqual(r.usage, { inputTokens: 1841, outputTokens: 4000, reasoningTokens: 4000 });
});

test("上游没报推理 token → 记 0（与 costUsd 的 null 是两回事）", async () => {
  // 「没报」与「没有推理」在实践中是一回事；而 costUsd 那边
  // 「不知道价格」与「价格是 0」是两回事，所以那里必须是 null
  const { fetch } = scripted(ok(ANSWERS, { inputTokens: 10, outputTokens: 20 }));
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.equal(r.usage?.reasoningTokens, 0);
  assert.equal(typeof r.usage?.reasoningTokens, "number", "不能是 null —— 见上面那条注释");
});

test("推理 token 不影响 systemone 的成本口径（价目表按后端分别维护）", async () => {
  const plain = scripted(ok(ANSWERS, { inputTokens: 1000, outputTokens: 10 }));
  const reasoning = scripted(
    ok(ANSWERS, {
      inputTokens: 1000,
      outputTokens: 4000,
      completion_tokens_details: { reasoning_tokens: 3990 },
    }),
  );

  const a = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: plain.fetch });
  const b = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: reasoning.fetch });

  assert.equal(a.costUsd, b.costUsd, "systemone 按 input token 计价，output 不计费");
  assert.equal(b.usage?.reasoningTokens, 3990, "不参与计价不等于不用如实记录");
});

test("usage 字段名两家不同（inputTokens / input_tokens）都要认", async () => {
  const a = scripted(ok(ANSWERS, { inputTokens: 1000 }));
  const b = scripted(ok(ANSWERS, { input_tokens: 1000 }));

  const ra = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: a.fetch });
  const rb = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: b.fetch });

  assert.deepEqual(ra.usage, { inputTokens: 1000, outputTokens: 0, reasoningTokens: 0 });
  assert.deepEqual(rb.usage, ra.usage);
  assert.equal(ra.costUsd, rb.costUsd);
  assert.ok(ra.costUsd !== null && ra.costUsd > 0, "1000 token 不该算成 0 元");
});

test("output 不计费：只有 input token 影响成本", async () => {
  const a = scripted(ok(ANSWERS, { inputTokens: 1000, outputTokens: 0 }));
  const b = scripted(ok(ANSWERS, { inputTokens: 1000, outputTokens: 999999 }));

  const ra = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: a.fetch });
  const rb = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: b.fetch });

  assert.equal(ra.costUsd, rb.costUsd);
});

/* ══════════════════════════════════════════════════════════════════
   三、重试：upstreamCalls 记的是**真的发了几次**
   ══════════════════════════════════════════════════════════════════ */

test("429 → 重试；upstreamCalls = 2，而不是逻辑上的 1", async () => {
  const { fetch, calls } = scripted(
    json({ error: { message: "rate limit" } }, 429),
    ok(ANSWERS, { inputTokens: 10 }),
  );
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.deepEqual(r.answers, ANSWERS);
  assert.equal(r.upstreamCalls, 2);
  assert.equal(calls.length, 2);
});

test("5xx 与 408 都值得重试（瞬时故障）", async () => {
  for (const status of [500, 502, 503, 408]) {
    const { fetch } = scripted(json({}, status), ok(ANSWERS));
    const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });
    assert.equal(r.upstreamCalls, 2, `HTTP ${status} 应当被重试`);
  }
});

test("4xx（除 408/429）直接抛，不重试 —— 重试没有意义", async () => {
  const { fetch, calls } = scripted(json({ error: { message: "模型不存在" } }, 400));

  await assert.rejects(
    () => callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch }),
    (e: unknown) => e instanceof JevError && e.status === 400 && !e.retryable,
  );
  assert.equal(calls.length, 1, "400 只该打一次");
});

test("重试到上限就停 —— max=1 时总共只发 2 次", async () => {
  const { fetch, calls } = scripted(json({}, 500));

  await assert.rejects(
    () => callJev(DIRECT, {}, QUESTIONS, { retry: { max: 1, baseMs: 1 }, fetchImpl: fetch }),
    (e: unknown) => e instanceof JevError && e.status === 500,
  );
  assert.equal(calls.length, 2);
});

test("max = null 表示无限重试 —— 用「第 5 次成功」验证它不会提前放弃", async () => {
  const { fetch } = scripted(
    json({}, 500),
    json({}, 500),
    json({}, 500),
    json({}, 500),
    ok(ANSWERS),
  );
  const r = await callJev(DIRECT, {}, QUESTIONS, {
    retry: { max: null, baseMs: 1 },
    fetchImpl: fetch,
  });
  assert.equal(r.upstreamCalls, 5);
});

test("重试回调把「第几次、为什么、等多久」告诉界面", async () => {
  const seen: Array<[number, number]> = [];
  const { fetch } = scripted(json({}, 500), ok(ANSWERS));

  await callJev(DIRECT, {}, QUESTIONS, {
    retry: FAST,
    fetchImpl: fetch,
    hooks: { onRetry: (attempt, _err, delayMs) => seen.push([attempt, delayMs]) },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 1, "第一次重试应当报 1");
  assert.ok(Number.isFinite(seen[0][1]) && seen[0][1] >= 0);
});

/* ══════════════════════════════════════════════════════════════════
   四、超时（源仓库全层没有这条）
   ══════════════════════════════════════════════════════════════════ */

/**
 * 一个**永不回包、但响应 abort** 的假 fetch —— 测超时用。
 *
 * ⚠ 它必须自己**撑着事件循环**，否则整条用例会挂，而且报错完全指不到原因。
 *
 * `startTimeout` 的定时器是 **`unref()` 过的**（见它的注释）。生产环境里没问题：
 * 真实 `fetch` 的 I/O 撑着循环，到点就响。而这里的假 fetch 是**纯 JS**、
 * 不带任何 I/O —— 事件循环会当场空掉，那个被 unref 的定时器**再也不会响**，
 * promise 永不落定。
 *
 * 症状很容易认错：node:test 报的**不是**「超时」，而是
 * `Promise resolution is still pending but the event loop has already resolved`，
 * 并且把**同一个文件里后面所有用例**一起标成 `cancelledByParent` ——
 * 于是一条真因看起来像二十几条。
 *
 * 它还是**环境相关**的：那一刻有没有别的活撑着循环，决定了它红还是绿。
 * 真机上它就是这么在 GitHub CI（Node 22）上挂掉、本地（Node 25）却全绿的。
 */
function hangUntilAbort(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      // ★ 这个定时器**不 unref**：它唯一的任务就是让事件循环活着，
      // 好给 `startTimeout` 那个 unref 过的定时器一个响的机会。
      // 走到这里说明 abort 根本没来（超时机制整个没生效）—— 拒绝掉，别静默挂住
      const keepAlive = setTimeout(() => reject(new Error("假 fetch 等不到 abort")), 5000);
      init.signal?.addEventListener("abort", () => {
        clearTimeout(keepAlive);
        reject(new Error("aborted"));
      });
    });
}

test("★ 超时：抛 JevError、标 retryable、message 里点明是超时", async () => {
  // 永不回包的 fetch，但**必须响应 abort**，且必须自己撑着事件循环（见上）
  const hang: FetchLike = hangUntilAbort();

  await assert.rejects(
    () =>
      callJev(DIRECT, {}, QUESTIONS, {
        retry: { max: 0, baseMs: 1 },
        timeoutMs: 30,
        fetchImpl: hang,
      }),
    (e: unknown) => {
      assert.ok(e instanceof JevError, "超时必须是 JevError，不能是裸的 DOMException");
      assert.equal(e.retryable, true, "超时是瞬时故障，值得重试");
      assert.match(e.message, /超时/);
      return true;
    },
  );
});

test("超时后重试：每次尝试都有自己的超时，upstreamCalls 如实计数", async () => {
  let n = 0;
  const slowThenOk: FetchLike = async (url, init) => {
    n++;
    // 第一次让它挂到超时（同样必须自己撑着事件循环，见 `hangUntilAbort`）
    if (n === 1) return hangUntilAbort()(url, init);
    return toResponse(ok(ANSWERS, { inputTokens: 5 }));
  };

  const r = await callJev(DIRECT, {}, QUESTIONS, {
    retry: FAST,
    timeoutMs: 30,
    fetchImpl: slowThenOk,
  });
  assert.equal(r.upstreamCalls, 2);
  assert.deepEqual(r.answers, ANSWERS);
});

test("超时值确实被当成 AbortSignal 传给了 fetch", async () => {
  let seen: AbortSignal | null | undefined;
  const capture: FetchLike = async (_url, init) => {
    seen = init.signal;
    return toResponse(ok(ANSWERS));
  };

  await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, timeoutMs: 5000, fetchImpl: capture });

  assert.ok(seen instanceof AbortSignal, "没有把 signal 传下去，超时就只是文档里的一句话");
  assert.equal(seen!.aborted, false);
});

test("网络层失败（断网 / DNS / CORS）一律可重试", async () => {
  const { fetch } = scripted(new TypeError("fetch failed"), ok(ANSWERS));
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });
  assert.equal(r.upstreamCalls, 2);
});

/* ══════════════════════════════════════════════════════════════════
   五、坏回包不能当成好回包
   ══════════════════════════════════════════════════════════════════ */

test("非 JSON 回包 → 抛错，且带上截断的原文片段（否则无从排查）", async () => {
  const { fetch } = scripted(html("<html>502 Bad Gateway</html>", 200));

  await assert.rejects(
    () => callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch }),
    (e: unknown) => {
      assert.ok(e instanceof JevError);
      assert.match(e.message, /502 Bad Gateway/, "必须带上原文，不然只剩「解析失败」四个字");
      return true;
    },
  );
});

test("200 但没有 answers → 抛错，不能当正常回包", async () => {
  const { fetch } = scripted(json({ model: "x", usage: { inputTokens: 12 } }));

  await assert.rejects(
    () => callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch }),
    (e: unknown) => e instanceof JevError && !e.retryable,
  );
});

/* ══════════════════════════════════════════════════════════════════
   六、DecisionBackend 适配器
   ══════════════════════════════════════════════════════════════════ */

test("systemone 后端：kind / id 如实，evaluate 走同一条路径", async () => {
  const { fetch, calls } = scripted(ok(ANSWERS, { inputTokens: 100 }));

  const backend = createSystemoneBackend(DIRECT, {
    id: "free-trial",
    retry: FAST,
    fetchImpl: fetch,
  });

  assert.equal(backend.kind, "systemone");
  assert.equal(backend.id, "free-trial");

  const r = await backend.evaluate({ model: DIRECT.model, state: {}, questions: QUESTIONS });
  assert.deepEqual(r.answers, ANSWERS);
  assert.equal(r.upstreamCalls, 1);
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 0, reasoningTokens: 0 });
  assert.equal(calls.length, 1);
});

test("DecisionResult 的四项测量都在，且类型正确", async () => {
  const { fetch } = scripted(ok(ANSWERS, { inputTokens: 100 }));
  const backend = createSystemoneBackend(DIRECT, { id: "x", retry: FAST, fetchImpl: fetch });

  const r = await backend.evaluate({ model: DIRECT.model, state: {}, questions: QUESTIONS });
  const usage: TokenUsage | null = r.usage;

  assert.equal(typeof r.latencyMs, "number");
  assert.equal(typeof r.upstreamCalls, "number");
  assert.ok(usage !== null);
  assert.equal(typeof usage.inputTokens, "number");
  assert.equal(typeof r.costUsd, "number");
  assert.ok("raw" in r, "原始回包要留着 —— 界面要能看完整 request/response");
});

/* ══════════════════════════════════════════════════════════════════
   七、边界工具
   ══════════════════════════════════════════════════════════════════ */

test("isQuotaError：402 / 429 与「额度」类文案都算，普通 400 不算", () => {
  assert.equal(isQuotaError(402, ""), true);
  assert.equal(isQuotaError(429, ""), true);
  assert.equal(isQuotaError(400, "budget exceeded"), true);
  assert.equal(isQuotaError(403, "账户余额不足"), true);
  assert.equal(isQuotaError(400, "模型不存在"), false);
  assert.equal(isQuotaError(undefined, "invalid request"), false);
});

test("backoffDelay：指数增长、封顶、非负，且 rand 可注入", () => {
  // rand()=0.5 → 抖动项恰好为 0，退避就是确定的 base * 2^n
  const mid = () => 0.5;
  assert.equal(backoffDelay(0, 100, mid), 100);
  assert.equal(backoffDelay(3, 100, mid), 800);

  // 封顶（源仓库的上限是 30 秒）
  assert.equal(backoffDelay(20, 1000, mid), 30_000);

  // 抖动不超过 ±20%，且永远非负
  for (const r of [0, 1, 0.25, 0.75]) {
    for (let n = 0; n < 12; n++) {
      const d = backoffDelay(n, 100, () => r);
      assert.ok(d >= 0, `rand=${r} attempt=${n} 给出了负延迟 ${d}`);
    }
  }
  assert.equal(backoffDelay(0, 100, () => 0), 80);
  assert.equal(backoffDelay(0, 100, () => 1), 120);
});

test("noulDiscriminator：只有 Vercel 把布尔类型叫 boolean，其余全是 noul", () => {
  assert.equal(noulDiscriminator("vercel"), "boolean");
  for (const b of ["typesafe", "openrouter", "localproxy", "openrouterproxy", "", "unknown"]) {
    assert.equal(noulDiscriminator(b), "noul", `后端 ${b || "(空)"} 的判别值应当是 noul`);
  }
});

test("noulProbability：两家键名不同，统一抹平；都没有时给 0", () => {
  assert.equal(noulProbability({ type: "noul", noul: 0.96 }), 0.96);
  assert.equal(noulProbability({ type: "boolean", probability: 0.69 }), 0.69);
  assert.equal(noulProbability({ type: "noul" }), 0);
});

test("DEFAULT_RETRY 是有限次 —— 无限重试不该是默认值", () => {
  assert.ok(DEFAULT_RETRY.max !== null && DEFAULT_RETRY.max > 0);
  assert.ok(DEFAULT_RETRY.baseMs > 0);
});

/* ══════════════════════════════════════════════════════════════════
   六、LLM 调用配置跟着**请求体**走
   ══════════════════════════════════════════════════════════════════
   翻译（Jev 形状 → LLM 形状）发生在服务端，而出题目的客户端才知道用户在界面上
   选了什么 —— 所以这四个控件的取值必须跟着请求体走一趟。这一段钉的就是那条路：
   它断了不会报错，只会让四个控件看起来「设了没用」。 */

test("★ LLM 后端：llm 字段进请求体；三态原样透传", async () => {
  for (const effort of ["none", "high", null] as const) {
    const { fetch, calls } = scripted(ok(ANSWERS));
    await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch, llm: { effort } });
    assert.deepEqual(
      calls[0].body,
      { model: DIRECT.model, state: {}, questions: QUESTIONS, llm: { effort } },
      `effort=${String(effort)} 没有原样送到请求体里`,
    );
  }
});

test("★ 非 LLM 后端：llm 字段**整个不出现**，不是出现一个空对象", async () => {
  const { fetch, calls } = scripted(ok(ANSWERS));
  await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });
  assert.deepEqual(calls[0].body, { model: DIRECT.model, state: {}, questions: QUESTIONS });
  assert.ok(
    !("llm" in (calls[0].body as Record<string, unknown>)),
    "没配 LLM 的后端不该多出一个字段 —— 那是在给上游送未知参数",
  );
});

test("★ 适配器：请求上的 llm 优先于构造时的 llm（同一后端实例会被不同设置复用）", async () => {
  const { fetch, calls } = scripted(ok(ANSWERS));
  const backend = createSystemoneBackend(DIRECT, {
    id: "llmfree",
    retry: FAST,
    fetchImpl: fetch,
    llm: { effort: "low" },
  });
  await backend.evaluate({ model: DIRECT.model, state: {}, questions: QUESTIONS, llm: { effort: "max" } });
  assert.deepEqual((calls[0].body as { llm: unknown }).llm, { effort: "max" });
});

/* ══════════════════════════════════════════════════════════════════
   三·补：代理如实报的 upstreamCalls 与 reasoningTokens
   ══════════════════════════════════════════════════════════════════

   本节是「工具循环」那条线在客户端这一侧的落点。

   工具循环的一次决策会向上游发 **N 次**请求，而客户端在应用层只看得见
   「我发了一次 HTTP」。代理把真实次数放在回包的 `upstreamCalls` 里 ——
   这一栏不认，「工具循环比 JSON 贵多少」就永远算不出来，而那正是这个
   项目要实现工具循环的理由之一。 */

test("★ 代理报了几次就记几次：工具循环的一次「尝试」报了 3，upstreamCalls 就是 3", async () => {
  const { fetch } = scripted(json({ answers: ANSWERS, upstreamCalls: 3, usage: { inputTokens: 300 } }));
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.equal(r.upstreamCalls, 3, "把工具循环的 3 次上游调用记成了 1 —— 成本被藏起来了");
});

test("★ 重试与循环叠加：失败的那次按 1 记，成功的那次按它自报的 2 记 → 共 3", async () => {
  const { fetch, calls } = scripted(
    json({ error: { message: "rate limit" } }, 429),
    json({ answers: ANSWERS, upstreamCalls: 2, usage: { inputTokens: 20 } }),
  );
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  // 第一次尝试失败了，数不到它内部的次数 → 按 1 记（保守）。
  // 宁可少算也不虚报，而少算的那部分由「重试了几次」这条独立的统计兜着
  assert.equal(r.upstreamCalls, 3, `期望 1（失败的尝试）+ 2（成功那次），实际 ${r.upstreamCalls}`);
  assert.equal(calls.length, 2);
});

test("代理没报 upstreamCalls 时按 1 算 —— 老代理 / 直连厂商的回包不该变成 0", async () => {
  const { fetch } = scripted(ok(ANSWERS, { inputTokens: 10 }));
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });
  assert.equal(r.upstreamCalls, 1);
});

test("★ 代理以驼峰报的 reasoningTokens 要读出来（下划线那套是直连厂商的形态）", async () => {
  const { fetch } = scripted(
    json({
      answers: ANSWERS,
      usage: { inputTokens: 100, outputTokens: 4000, reasoningTokens: 4000 },
    }),
  );
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });

  assert.equal(r.usage?.reasoningTokens, 4000, "推理 token 丢了 —— 「关思维链省了多少钱」就算不出来");
  assert.equal(r.usage?.outputTokens, 4000);
});

test("两种拼写同时出现时以驼峰为准（代理是转发链上更近的那一环）", async () => {
  const { fetch } = scripted(
    json({
      answers: ANSWERS,
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        reasoningTokens: 7,
        completion_tokens_details: { reasoning_tokens: 999 },
      },
    }),
  );
  const r = await callJev(DIRECT, {}, QUESTIONS, { retry: FAST, fetchImpl: fetch });
  assert.equal(r.usage?.reasoningTokens, 7);
});
