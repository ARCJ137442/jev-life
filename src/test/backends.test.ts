/**
 * 后端目录（`BACKENDS`）的契约，以及 `createBackend` 的**分流**。
 *
 * ═══ 为什么这几条非测不可 ═══
 *
 *   1. ★ **分流点是 `protocol`，不是 `isLlm`。** 两条路的分岔很细：代管那条
 *      LLM（`llmfree`）也是 LLM，但它的翻译**必须留在服务端** —— 密钥在那边。
 *      判错了，用户自备的密钥会被发到一个不存在的代理路径上，
 *      或者代管那条的 key 会试图从浏览器直发（而浏览器根本没有它）。
 *   2. ★ **新加的两条必须 `managed: false`。** 代管 = 隐藏 Base URL、
 *      模型框写明「由本站指定」。用户自备 key 的要是被当成代管，
 *      界面上就**没有地方填地址和模型**了 —— 而那是它们唯一的存在理由
 *   3. ★ **词条 key 必须在两种语言里都有。** 少一条不会报错，只会把
 *      `backend.llmOpenai` 这串原文渲染到界面上
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { BACKENDS, createBackend, resolveConfig } from "../client/api.js";
import type { BackendId } from "../client/api.js";
import { dictFor } from "../client/i18n.js";
import { ANTHROPIC_COMPAT_UPSTREAM, OPENAI_COMPAT_UPSTREAM } from "../shared/llm-broker.js";

const ALL = Object.keys(BACKENDS) as BackendId[];

/** 用户自备 key、broker 在浏览器里跑的那两条 */
const BYO_KEY: BackendId[] = ["llmopenai", "llmanthropic"];

const cfg = (provider: BackendId) => ({
  provider,
  base: BACKENDS[provider].base,
  model: BACKENDS[provider].model,
  apiKey: "sk_TESTONLY_not_a_real_key",
});

/* ══════════════════════════════════════════════════════════════════
   一、目录本身的契约
   ══════════════════════════════════════════════════════════════════ */

test("★ 用户自备 key 的两条：要密钥、不代管、是 LLM、说得出协议", () => {
  for (const id of BYO_KEY) {
    const b = BACKENDS[id];
    assert.equal(b.needsKey, true, `${id}：自备 key`);
    assert.equal(
      b.managed,
      false,
      `${id}：代管会把 Base URL 藏起来、把模型框写成「由本站指定」—— 那这两条就没地方配了`,
    );
    assert.equal(b.isLlm, true, `${id}：不亮 LLM 那四个控件，思考强度与调用策略就没法选`);
    assert.ok(b.protocol !== undefined, `${id}：没有 protocol，createBackend 会把它当 SystemOne 发`);
    assert.ok(b.base.startsWith("http"), `${id}：直连后端的地址必须是绝对 URL，不能是代理路径`);
    assert.ok(b.model.length > 0, `${id}：要有一个可改的默认模型名`);
  }
});

test("protocol 与 llmUpstream 必须配套 —— 一个决定怎么发，一个决定收不收这个参数", () => {
  assert.equal(BACKENDS.llmopenai.protocol, "openai");
  assert.equal(BACKENDS.llmopenai.llmUpstream, OPENAI_COMPAT_UPSTREAM);
  assert.equal(BACKENDS.llmanthropic.protocol, "anthropic");
  assert.equal(BACKENDS.llmanthropic.llmUpstream, ANTHROPIC_COMPAT_UPSTREAM);
});

test("★ 反向：代管那条 LLM **不能**有 protocol，它的翻译在服务端", () => {
  const b = BACKENDS.llmfree;
  assert.equal(b.isLlm, true, "它确实是 LLM");
  assert.equal(b.managed, true);
  assert.equal(
    b.protocol,
    undefined,
    "给它填上 protocol，客户端就会绕过服务端直发 —— 而密钥在服务端，浏览器手里没有",
  );
});

test("protocol 只在「是 LLM」时才出现 —— 别给 Jev 协议的后端顺手加上", () => {
  for (const id of ALL) {
    const b = BACKENDS[id];
    if (b.protocol !== undefined) assert.equal(b.isLlm, true, `${id}：非 LLM 不该有 protocol`);
    if (b.managed) assert.equal(b.protocol, undefined, `${id}：代管后端不该有 protocol`);
  }
});

test("词条 key 在两种语言里都查得到 —— 少了只会渲染出一串 key 原文", () => {
  const zh = dictFor("zh");
  const en = dictFor("en");
  for (const id of ALL) {
    for (const key of [BACKENDS[id].labelKey, BACKENDS[id].noteKey]) {
      assert.ok(zh[key] !== undefined, `zh 缺 ${key}（后端 ${id}）`);
      assert.ok(en[key] !== undefined, `en 缺 ${key}（后端 ${id}）`);
      assert.ok(zh[key].length > 0 && en[key].length > 0, `${key} 是空的`);
    }
  }
});

test("★ 自备密钥那两条的说明里写清了「key 只在你浏览器里」", () => {
  // 语义与代管那几条**不同**：代管的 key 在本站服务端，用户既看不到也管不着；
  // 这两条的 key 是用户自己的、只在本地内存。文案混了，用户就不知道自己
  // 把密钥交给了谁
  for (const id of BYO_KEY) {
    const zh = dictFor("zh")[BACKENDS[id].noteKey];
    const en = dictFor("en")[BACKENDS[id].noteKey];
    assert.match(zh, /浏览器/, `${id} 的中文说明没说清 key 在哪`);
    assert.match(en, /browser/i, `${id} 的英文说明没说清 key 在哪`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   二、createBackend 的分流
   ══════════════════════════════════════════════════════════════════ */

test("★ 有 protocol → 造 LLM 后端；kind 随调用策略变", () => {
  // ⚠ 调用策略走**第二参数**（`CallOptions.llm`），不是塞进 ClientConfig ——
  // 塞错了不会报错（那个字段压根没人读），只会让 `kind` 恒为 llm-json，
  // 而症状是「工具循环的调用被记进 JSON 那一栏」
  assert.equal(createBackend(cfg("llmopenai"))?.kind, "llm-json");
  assert.equal(createBackend(cfg("llmopenai"), { llm: { callPolicy: "tool" } })?.kind, "llm-tool");
  assert.equal(createBackend(cfg("llmanthropic"))?.kind, "llm-json");
  assert.equal(
    createBackend(cfg("llmanthropic"), { llm: { callPolicy: "tool" } })?.kind,
    "llm-tool",
  );
});

test("★ 没有 protocol → 走原来的那条路（含代管的那条 LLM）", () => {
  // 代管 LLM 在客户端**就是一条 SystemOne 上游**：翻译在服务端做掉了。
  // 这条断言守的是「别哪天顺手给它加个 protocol」
  assert.equal(createBackend(cfg("llmfree"))?.kind, "systemone");
  assert.equal(createBackend(cfg("localproxy"))?.kind, "systemone");
  assert.equal(createBackend(cfg("typesafe"))?.kind, "systemone");
});

test("直连后端的地址原样透传，不会被解析成代理路径", () => {
  // 解析成代理路径意味着请求（连同密钥）会发到「同源服务端」——
  // 而静态托管下那里根本没有人
  const target = resolveConfig(cfg("llmopenai"));
  assert.equal(target?.base, BACKENDS.llmopenai.base);
  assert.equal(target?.apiKey, "sk_TESTONLY_not_a_real_key");
});

test("id 与 provider 一致 —— 统计按它分组，错位了两次调用会被算成同一个后端", () => {
  assert.equal(createBackend(cfg("llmopenai"))?.id, "llmopenai");
  assert.equal(createBackend(cfg("llmanthropic"))?.id, "llmanthropic");
});
