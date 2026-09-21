/**
 * 判别值归一化 —— 「客户端发 noul、服务端按**自己的上游**翻译」这条链的测试。
 *
 * ═══ 它防的是什么 ═══
 *
 * 代管代理的**客户端 id 与真实上游不是一回事**：界面上的「Jev 免费试用 1」
 * （id `localproxy`）背后是 Vercel，而 Vercel 把布尔型的判别值拼成 `boolean`。
 * 于是「按客户端 id 算判别值」必然算错，症状是默认的免费后端一发就 400：
 *
 *   questions.flip_2_2.type: Invalid discriminator value.
 *   Expected 'boolean' | 'choice' | 'score'
 *
 * 修法是**服务端在转发前归一化**（DESIGN.md 第八节：中间那层必须真的兼容）——
 * 客户端只发语义（`noul` = 这是一道布尔题），由知道上游是谁的那一层翻译。
 *
 * ═══ 为什么这里有一条「读源码」的断言 ═══
 *
 * 两个转发点（`src/server/server.ts` 与 `api/_upstream.ts`）**必须都接**，
 * 漏一处就是「本机好用、Vercel 上 400」，而那种差异极难查。两份的测法不同：
 *
 *   - `api/_upstream.ts` 可以**行为**测：它自包含（不 import 任何东西），
 *     运行时能直接 import，配一个假的 fetch 就能看见真正发出去的请求体
 *   - `src/server/server.ts` 不行 —— 它 import 即 `listen`，一 import 就占端口。
 *     所以对后者退而求其次：断言那段调用还在
 *
 * 后者是**机械守卫，不是行为测试**，这一点不藏着：它能挡的是「改了一处忘了
 * 另一处」这个真实失手，挡不住「调用写对了但参数传错」—— 参数的正确性由
 * `normalizeQuestionTypes` 的单元测试和那份上游表兜着。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeQuestionTypes } from "../shared/types.js";
import type { Question, QuestionType, Questions } from "../shared/types.js";

// 编译产物在 dist-test/test/，往上两级才是仓库根
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ══════════════════════════════════════════════════════════════════
   夹具
   ══════════════════════════════════════════════════════════════════ */

/** 一道布尔题。`type` 由调用方给 —— 它正是被测的那个字段 */
function boolQuestion(type: QuestionType): Question {
  return { type, instructions: "这一手是否有利？", criteria: { true: "有利", false: "不利" } };
}

/** 一道 choice 题。判别值四家一致，任何上游都不该动它 */
const CHOICE: Question = {
  type: "choice",
  instructions: "翻哪一格？",
  criteria: { a: "左上", b: "右下" },
};

/** 一道 score 题。同上 */
const SCORE: Question = { type: "score", instructions: "打几分？", criteria: ["低", "高"] };

function requestBody(questions: Questions): { model: string; state: unknown; questions: Questions } {
  return { model: "typesafe-ai/jev", state: { turn: 3 }, questions };
}

/** 取某一题的 type —— 断言里反复要写，收成一个函数免得四处 as */
function typeOf(body: { questions: Questions }, key: string): string {
  const q = body.questions[key] as Question | undefined;
  assert.ok(q, `回包里没有 ${key} 这一题`);
  return q.type;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const child of Object.values(v as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(v);
  }
  return v;
}

/** 非 Vercel 的上游们。归一化对它们**什么都不该做** */
const NOT_VERCEL = ["openrouter", "typesafe", "ai-ml-api", "laya", "lmstudio", "", "vercel-proxy"];

/* ══════════════════════════════════════════════════════════════════
   normalizeQuestionTypes
   ══════════════════════════════════════════════════════════════════ */

test("Vercel 上游：客户端发的 noul 被归一化成 boolean", () => {
  const body = requestBody({ flip_2_2: boolQuestion("noul") });
  const out = normalizeQuestionTypes(body, "vercel");
  assert.equal(typeOf(out, "flip_2_2"), "boolean");
});

test("非 Vercel 上游：noul 保持 noul，不被顺手改成 boolean", () => {
  for (const upstream of NOT_VERCEL) {
    const body = requestBody({ flip_2_2: boolQuestion("noul") });
    const out = normalizeQuestionTypes(body, upstream);
    assert.equal(typeOf(out, "flip_2_2"), "noul", `上游「${upstream}」不该改变 noul`);
  }
});

test("choice / score 一律不碰 —— 四家一致，没有可翻译的东西", () => {
  for (const upstream of ["vercel", "openrouter"]) {
    const body = requestBody({ pick: CHOICE, rate: SCORE });
    const out = normalizeQuestionTypes(body, upstream);
    assert.equal(typeOf(out, "pick"), "choice", `上游「${upstream}」不该动 choice`);
    assert.equal(typeOf(out, "rate"), "score", `上游「${upstream}」不该动 score`);
  }
});

test("只改布尔族：同一批题里有 choice / score 时，它们原样留下", () => {
  const body = requestBody({
    flip_0_0: boolQuestion("noul"),
    pick: CHOICE,
    flip_0_1: boolQuestion("noul"),
    rate: SCORE,
  });
  const out = normalizeQuestionTypes(body, "vercel");
  assert.equal(typeOf(out, "flip_0_0"), "boolean");
  assert.equal(typeOf(out, "flip_0_1"), "boolean");
  assert.equal(typeOf(out, "pick"), "choice");
  assert.equal(typeOf(out, "rate"), "score");
});

test("已经是上游要的写法时，再归一化一次结果不变（幂等）", () => {
  const body = requestBody({ flip_1_3: boolQuestion("noul") });
  const once = normalizeQuestionTypes(body, "vercel");
  const twice = normalizeQuestionTypes(once, "vercel");
  assert.equal(typeOf(twice, "flip_1_3"), "boolean");
  assert.deepEqual(twice, once);
});

test("boolean 拼写遇到要 noul 的上游时也归一化回去（判别值是同一个语义的两种拼写）", () => {
  // 这一条覆盖的是真实可达的配置：`--backend vercel` 配一个 OpenRouter 上游。
  const body = requestBody({ flip_1_3: boolQuestion("boolean") });
  const out = normalizeQuestionTypes(body, "openrouter");
  assert.equal(typeOf(out, "flip_1_3"), "noul");
});

test("★ 不改动入参：传入的对象连一个字段都不许变（本项目的纯函数红线）", () => {
  const questions: Questions = { flip_2_2: boolQuestion("noul"), pick: CHOICE };
  const body = requestBody(questions);
  const before = JSON.stringify(body);

  // 深冻结 + 严格模式：一旦实现去写 input，这里会直接抛，而不是悄悄改掉
  deepFreeze(body);

  const out = normalizeQuestionTypes(body, "vercel");

  assert.equal(JSON.stringify(body), before, "入参被改动了");
  assert.equal(JSON.stringify(questions), JSON.stringify({ flip_2_2: boolQuestion("noul"), pick: CHOICE }));
  assert.notEqual(out, body, "发生了改写时应当返回新对象");
  assert.equal(typeOf(body, "flip_2_2"), "noul", "入参那一题的判别值必须还是 noul");
});

test("没有 questions（或形状不对）时原样返回，不抛 —— 上游会给出比我们更准的错", () => {
  const cases: unknown[] = [
    {},
    { model: "m", state: {} },
    { questions: null },
    { questions: [] },
    { questions: "noul" },
    { questions: { flip_0_0: null } },
    { questions: { flip_0_0: { instructions: "没有 type" } } },
  ];
  for (const c of cases) {
    assert.deepEqual(normalizeQuestionTypes(c, "vercel"), c, `输入 ${JSON.stringify(c)} 应当原样返回`);
  }
});

test("没有题需要改时不新建对象（回包与入参同一份，便于上游层做引用比较）", () => {
  const body = requestBody({ pick: CHOICE });
  assert.equal(normalizeQuestionTypes(body, "vercel"), body);
});

/* ══════════════════════════════════════════════════════════════════
   转发点 1：api/_upstream.ts（Vercel 上的那份）
   ══════════════════════════════════════════════════════════════════ */

interface ApiUpstream {
  label: string;
  url: string;
  envKey: string;
  model: string;
  upstream: string;
}
interface ApiReq {
  method?: string;
  body?: unknown;
}
interface ApiRes {
  status(code: number): ApiRes;
  setHeader(name: string, value: string): void;
  json(obj: unknown): void;
  send(body: string): void;
}

const API_MODULE = new URL("../../api/_upstream.ts", import.meta.url).href;

/**
 * 运行时加载 `api/_upstream.ts`。
 *
 * 能这么做的前提是它**自包含**（不 import 任何东西）。它旁边的
 * evaluate.ts / evaluate2.ts 就不行：那两个用 `./_upstream.js` 后缀，
 * 而 Node 的 type-stripping **不做 .js → .ts 重写**（见 CLAUDE.md 的后缀规则表）。
 */
async function loadMakeHandler() {
  const mod = (await import(API_MODULE)) as {
    makeHandler(up: ApiUpstream): (req: ApiReq, res: ApiRes) => Promise<void>;
  };
  return mod.makeHandler;
}

/** 一个只记录发生了什么的假 res */
function recorder(): { code: () => number; body: () => string; res: ApiRes } {
  const seen = { code: 0, body: "" };
  const res: ApiRes = {
    status(code) {
      seen.code = code;
      return res;
    },
    setHeader() {
      /* 测试不关心响应头 */
    },
    json(obj) {
      seen.body = JSON.stringify(obj);
    },
    send(b) {
      seen.body = b;
    },
  };
  return { code: () => seen.code, body: () => seen.body, res };
}

interface Forwarded {
  url: string;
  body: Record<string, any>;
}

/** 跑一次 handler，把**真正发给上游的那个请求**截下来 */
async function forwarded(up: ApiUpstream, questions: Questions): Promise<Forwarded> {
  const makeHandler = await loadMakeHandler();
  const handler = makeHandler(up);

  process.env[up.envKey] = "vck_TESTONLY_not_a_real_key";

  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const realError = console.error;
  let captured: Forwarded | null = null;
  // 日志静音：handler 正常时会写一行摘要，失败时会把上游原文打到 stderr。
  // 测试输出要保持干净，否则「有噪声」会变成常态、真出问题时反而看不见
  console.log = () => {};
  console.error = () => {};
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    captured = { url: String(url), body: JSON.parse(String(init?.body)) as Record<string, any> };
    return new Response(JSON.stringify({ answers: {}, usage: { inputTokens: 1 } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { code, res } = recorder();
    await handler({ method: "POST", body: requestBody(questions) }, res);
    assert.equal(code(), 200, "假上游返回 200，handler 不该报错");
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    console.error = realError;
  }

  assert.ok(captured, "handler 没有发出任何请求");
  return captured as Forwarded;
}

const VERCEL_UP: ApiUpstream = {
  label: "free-trial",
  url: "https://ai-gateway.vercel.sh/v1/evaluate",
  envKey: "VERCEL_AI_GATEWAY_KEY",
  model: "typesafe-ai/jev",
  upstream: "vercel",
};

const OPENROUTER_UP: ApiUpstream = {
  label: "free-trial-2",
  url: "https://openrouter.ai/api/v1/systemone",
  envKey: "OPENROUTER_API_KEY",
  model: "typesafe/jev-1.13",
  upstream: "openrouter",
};

test("api 转发点（免费试用 1 → Vercel）：noul 在转发前被转成 boolean", async () => {
  const { url, body } = await forwarded(VERCEL_UP, { flip_2_2: boolQuestion("noul") });
  assert.equal(url, VERCEL_UP.url, "转发地址必须来自上游表");
  assert.equal(body["questions"]["flip_2_2"].type, "boolean", "Vercel 上游收到的必须是 boolean");
  // 只动判别值：题面与 criteria 原样
  assert.equal(body["questions"]["flip_2_2"].instructions, "这一手是否有利？");
  assert.deepEqual(body["questions"]["flip_2_2"].criteria, { true: "有利", false: "不利" });
});

test("api 转发点（免费试用 2 → OpenRouter）：noul 原样发出", async () => {
  const { url, body } = await forwarded(OPENROUTER_UP, { flip_2_2: boolQuestion("noul") });
  assert.equal(url, OPENROUTER_UP.url);
  assert.equal(body["questions"]["flip_2_2"].type, "noul", "OpenRouter 上游不该收到 boolean");
});

test("api 转发点：模型仍由服务端说了算，且模型名不跟着判别值走", async () => {
  const { body } = await forwarded(VERCEL_UP, { flip_2_2: boolQuestion("noul") });
  assert.equal(body["model"], "typesafe-ai/jev", "模型必须是上游表里的那个，不是客户端传的");
});

/* ══════════════════════════════════════════════════════════════════
   转发点 2：src/server/server.ts（本机那份）
   ══════════════════════════════════════════════════════════════════ */

test("本机 server.ts 的转发路径也接了归一化 —— 漏一处就是「本机好用、Vercel 上 400」", () => {
  const src = readFileSync(join(ROOT, "src", "server", "server.ts"), "utf8");

  // 用 test() 而不是 assert.match()：后者失败时会把整个文件倾进报告里
  assert.ok(
    /normalizeQuestionTypes\s*\(/.test(src),
    "server.ts 没有调用 normalizeQuestionTypes —— 本机这条转发路径没接上归一化",
  );
  // 第二个参数必须是**上游自己的标识**（上游表里那一条），不是客户端的路由名或后端 id
  assert.ok(
    /normalizeQuestionTypes\([^)]*up\.upstream/.test(src),
    "server.ts 调用了归一化，但传的不是 up.upstream（上游表里的真实上游）",
  );
});
