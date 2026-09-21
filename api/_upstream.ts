/**
 * Vercel Serverless Function 的共享逻辑。
 *
 * 文件名以 `_` 开头，Vercel 不会把它当成路由 —— 它只被 evaluate.ts /
 * evaluate2.ts 引用。
 *
 * 「免费试用」与「免费试用 2」是**同一套代理架构的两个实例**，
 * 区别只在「转发到哪、用哪个环境变量里的密钥」。用一张表描述，
 * 而不是把处理逻辑复制两份 —— 复制的部分迟早会走样。
 *
 * 为什么不需要「加密 token」：
 *   密钥只存在于 Vercel 的环境变量里，只在函数进程内被读取，
 *   从不进入任何响应体或客户端代码。**不下发，就不存在泄漏面。**
 */

/**
 * ⚠ 这里的 import 跨出了 `api/`。
 *
 * 先前 `api/` 刻意保持自包含（只 import 同目录兄弟），理由是「跨目录 import
 * 能不能被 Vercel 打包，本地验证不了」。**broker 是个例外，而且理由充分**：
 * 它是 200 行核心翻译逻辑、27 条测试在 `src/test/llm-broker.test.ts` 里。
 * 在 `api/` 里复制一份 = 一份**没有测试覆盖**的副本，而那正是本项目反复
 * 警告的「两处迟早走样」。
 *
 * Vercel 的 Node 构建基于 `@vercel/nft` 做依赖追踪，**会**跟着相对 import
 * 打包项目内的文件。部署工作流的冒烟测试会实测 `/api/evaluate3`，
 * 万一打包失败会在那里暴露。
 *
 * ⚠ **后缀是 `.ts` 而不是 `.js`，这不是笔误。** `src/test/normalize.test.ts`
 * 用 Node 的 type-stripping **直接运行**本文件（为了配假 fetch 抓真正发出去的
 * 请求体），而 **Node 不做 `.js` → `.ts` 的重写** —— 写 `.js` 会当场
 * `ERR_MODULE_NOT_FOUND`（与 `tools/` 那堵墙是同一堵，见 `tools/_load.ts`）。
 *
 * 能这么写的**前提**是 `llm-broker.ts` 只 import 类型（`import type`，运行期被擦除）
 * —— 它自己不 import 任何运行时代码，所以不会把 `.js` 后缀的问题带进来。
 * **将来给 broker 加运行期依赖时，这条会断，要重新想办法。**
 */
import {
  extractContent,
  fromLlmContent,
  toLlmRequest,
  usageOf,
  type LlmReasoningEffort,
} from "../src/shared/llm-broker.ts";
import type { Questions } from "../src/shared/types.js";

/** Vercel 注入的最小请求/响应形状（只声明用到的部分，避免依赖 @vercel/node） */
export interface Req {
  method?: string;
  body?: unknown;
}
export interface Res {
  status(code: number): Res;
  setHeader(name: string, value: string): void;
  json(obj: unknown): void;
  send(body: string): void;
}

export interface Upstream {
  /** 面向用户的标识，只用于健康检查与日志 */
  label: string;
  /** 真实上游地址 */
  url: string;
  /** 环境变量名 */
  envKey: string;
  /**
   * 默认模型 ID。
   * ⚠ 两家的命名空间不同：Vercel 是 `typesafe-ai/jev`，
   * OpenRouter 是 `typesafe/jev-1.13`（`typesafe/jev-latest` 和
   * `typesafe-ai/jev` 在 OpenRouter 上都会报「模型不存在」）。
   */
  model: string;
  /**
   * 这条代理**背后的真实上游**。
   *
   * ⚠ 它**不是**界面上的后端 id：那两条代管后端的 id 是 `localproxy` /
   * `openrouterproxy`，与「转发到哪」无关。判别值必须按这一个字段算 ——
   * 按客户端 id 算就是那次「默认免费后端一发就 400」的根因。
   */
  upstream: string;
  /**
   * 这条上游说的是哪种协议。
   *
   * - `"systemone"`（省略时的默认）：**Jev 协议**，`{state, questions} → {answers}`
   * - `"llm"`：**OpenAI 兼容的 chat/completions**，形状完全不同，
   *   进出一趟都要经 `../src/shared/llm-broker.js` 翻译
   */
  kind?: "systemone" | "llm";
}

/** 请求体上限，防止被当成任意转发代理滥用 */
const MAX_BODY = 256 * 1024;

/**
 * 转发给上游的超时。
 *
 * 源仓库全层没有 `AbortController` —— 上游挂住时这个函数会一直占着，
 * 而调用方看到的是「一直在转」。这里用 `AbortSignal.timeout` 而不是
 * `src/shared/backend.ts` 里那个手写版本，理由有两条：
 *
 *   1. **`api/` 刻意保持自包含**（只 import `./_upstream.js` 这个同目录兄弟）。
 *      从 `../src/` 引一个文件需要 Vercel 的构建把 api/ 之外的源码也打进
 *      函数包 —— 那大概率能成，但**我没法在本地验证它**，而验证不了的东西
 *      不该悄悄依赖。多一个跨目录 import 去省六行代码不划算。
 *   2. `AbortSignal.timeout` 唯一的问题是「请求早回时定时器还挂着」，
 *      而 serverless 函数进程活得很短，这一点不构成问题（实测 Node v25 下
 *      它内部的定时器是 unref 过的，不会拖住进程）。
 */
const UPSTREAM_TIMEOUT_MS = 90_000;

/**
 * 允许跨域调用的来源。
 *
 * 为什么需要：项目可以部署在**纯静态托管**上（GitHub Pages 等），
 * 那里没有服务端函数，静态页面只能跨域调用 Vercel 上的这份。
 *
 * 安全性由服务端保证，不由来源限制保证：
 *   - 请求体里不含任何凭据（密钥在服务端注入）
 *   - 就算别的站点来调，它消耗的也只是本站的免费额度，拿不到任何数据
 * 所以这里用 `*` 而不是白名单 —— 白名单反而会在换了域名后静默失效。
 */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

function applyCors(res: Res): void {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
}

function mask(key: string): string {
  return key.length > 14 ? `${key.slice(0, 7)}${"*".repeat(12)}${key.slice(-4)}` : "***";
}

/** 从响应里取 token 数 —— 两家字段名不同 */
function tokensOf(d: unknown): number {
  const u = (d as { usage?: { inputTokens?: number; input_tokens?: number } })?.usage ?? {};
  return u.inputTokens ?? u.input_tokens ?? 0;
}

/** 生命棋的布尔答案。字段名随网关变化，统一在这里抹平 */
interface NoulLike {
  readonly noul?: number;
  readonly probability?: number;
}

/**
 * 回包摘要。
 *
 * ★ 源仓库这里读的是 `answers.best_move.choice` —— 2048 的问题名。生命棋一次
 * 发 N 个布尔题（每个合法格一题），没有 `best_move` 这一项；照抄会让日志永远
 * 显示 "?"，而「日志显示 ?」与「模型真的没答」长得一模一样。
 *
 * 与 `src/server/server.ts` 里那份是**同源的重复**：`api/` 刻意不引 `src/`
 * （理由见 UPSTREAM_TIMEOUT_MS 那段），所以这里留一份。改一处记得改另一处。
 */
function summarizeAnswers(parsed: unknown): string {
  const answers = (parsed as { answers?: Record<string, NoulLike> } | null)?.answers;
  if (!answers) return "无 answers";
  const keys = Object.keys(answers);
  if (keys.length === 0) return "0 题";

  let bestKey = "";
  let best = -1;
  for (const k of keys) {
    const a = answers[k];
    const p = a.noul ?? a.probability;
    if (typeof p === "number" && p > best) {
      best = p;
      bestKey = k;
    }
  }
  return bestKey === ""
    ? `${keys.length} 题（无概率字段）`
    : `${keys.length} 题 最高 ${bestKey}=${best.toFixed(2)}`;
}

/**
 * 把请求体里 `questions[*].type` 归一化成**本上游要的那个写法**。
 *
 * ═══ 为什么由服务端做 ═══
 *
 * DESIGN.md 第八节那条约束：**中间那层必须真的兼容**。代理知道自己的上游是谁，
 * 翻译就该由它做 —— 客户端只发**语义**（`noul` = 这是一道布尔题），不猜上游
 * 怎么拼这个值。反过来说客户端也猜不了：代管后端的 id（`localproxy`）与它
 * 背后的真实上游（Vercel）不是一回事，按 id 推判别值必然推错。
 *
 * 实测过一次，症状是**默认的免费试用后端一发就 400**：
 *
 *   questions.flip_2_2.type: Invalid discriminator value.
 *   Expected 'boolean' | 'choice' | 'score'
 *
 * ═══ 客户端发什么 → 上游收到什么 ═══
 *
 *   免费试用 1 → Vercel        客户端发 noul → 转发 boolean
 *   免费试用 2 → OpenRouter    客户端发 noul → 转发 noul
 *
 * ⚠ 与 `src/shared/types.ts` 的 `normalizeQuestionTypes` 是**同源的重复**：
 * `api/` 刻意不引 `src/`（理由见 UPSTREAM_TIMEOUT_MS 那段），所以这里留一份。
 * **改一处记得改另一处** —— `src/test/normalize.test.ts` 对两份都做了测试
 * （这一份是行为级的：配一个假 fetch，直接看真正发出去的请求体）。
 *
 * 纯函数：不改动入参。只动布尔族（`noul` / `boolean` 是同一语义的两种拼写），
 * `choice` / `score` 四家一致，一律不碰。
 */
function normalizeQuestionTypes<T>(body: T, upstream: string): T {
  const target = upstream === "vercel" ? "boolean" : "noul";

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
 * 生成一个处理函数。两个 evaluate*.ts 各自导出一个实例。
 */
export function makeHandler(up: Upstream) {
  return async function handler(req: Req, res: Res): Promise<void> {
    res.setHeader("Cache-Control", "no-store");
    applyCors(res);

    // 浏览器的跨域预检：不带凭据，直接放行
    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method === "GET") {
      // 健康检查：只回显「配没配」与脱敏形态。
      // 不回上游名称 —— 部署冒烟测试只需要知道这个后端能不能用。
      const key = process.env[up.envKey] ?? "";
      res.status(200).json({
        ok: Boolean(key),
        backend: up.label,
        key: key ? mask(key) : null,
      });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: { message: `不支持的方法：${req.method}` } });
      return;
    }

    const key = process.env[up.envKey];
    if (!key) {
      // ⚠ 面向用户的错误**只说他能做什么**。
      // 实现细节（是哪个上游、缺哪个环境变量）只进服务端日志 ——
      // 写进响应体等于把「免费试用背后是某某提供商」直接告诉用户，
      // 而界面上那些隐藏（禁用模型字段、藏 Base URL）就白做了。
      // 错误信息恰恰是用户最会仔细读的地方。
      console.error(`[${up.label}] 未配置：缺少环境变量 ${up.envKey}`);
      res.status(503).json({
        error: {
          message: "该免费后端暂时不可用。请稍后重试，或在「API」设置里改用其他后端或自备密钥。",
        },
      });
      return;
    }

    const body = req.body;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: { message: "请求体为空或非法" } });
      return;
    }
    if (JSON.stringify(body).length > MAX_BODY) {
      res.status(413).json({ error: { message: "请求体过大" } });
      return;
    }

    // 模型与凭据一律由服务端决定，忽略客户端传来的任何认证信息。
    const isLlm = up.kind === "llm";
    const questions = (body as { questions?: Questions }).questions;

    let outgoing: unknown;
    if (isLlm) {
      // ★ Jev 形状 → LLM 形状：客户端的「有哪些题、每题问什么」在这里被拼成一段提示词。
      // 客户端全程不知道对面是 LLM —— 它发的是 Jev 形状，翻译发生在本层
      if (!questions || typeof questions !== "object") {
        res.status(400).json({ error: { message: "这条上游需要 questions 字段" } });
        return;
      }
      // ★ 思考强度由客户端给出（界面上那四个控件），但**收敛发生在这里** ——
      // 谁能收哪些值取决于本代理背后的真实上游，那是服务端的知识。
      // 客户端送语义（并集里的某一档，或 null = 「别发这个字段」），
      // 由 broker 的 clampEffort 按能力表决定发什么、还是不发。
      // 与 `src/server/server.ts` 是同源的重复，**改一处记得改另一处**
      const llmOpts = (body as { llm?: { effort?: LlmReasoningEffort | null } }).llm;
      outgoing = toLlmRequest(up.model, (body as { state?: unknown }).state, questions, {
        upstream: up.upstream,
        // 字段缺席 = 客户端没意见 → toLlmRequest 的默认姿态（none）；
        // 显式 null = 明确要求不发这个字段。两者必须分开传
        ...(llmOpts && "effort" in llmOpts ? { effort: llmOpts.effort ?? null } : {}),
      });
    } else {
      // 判别值在这里归一化 —— 客户端发的是语义（noul），拼成什么样由**本上游**决定
      outgoing = normalizeQuestionTypes(
        { ...(body as Record<string, unknown>), model: up.model },
        up.upstream,
      );
    }

    const gate = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    try {
      const upstream = await fetch(up.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,   // ← 密钥只在这一行出现，永不外泄
          "Content-Type": "application/json",
        },
        body: JSON.stringify(outgoing),
        signal: gate,
      });

      const text = await upstream.text();

      if (upstream.status !== 200) {
        console.log(`[${up.label}] ${upstream.status}`);
        console.error(`[${up.label}] ${upstream.status} 上游原文：${text.slice(0, 500)}`);
        res.status(upstream.status).json({ error: { message: publicError(upstream.status) } });
        return;
      }

      // ★ LLM 分支：把上游回包翻译回 **Jev 形状**，让客户端完全看不出区别。
      // 失败**值得重试** —— 实测唯一的失败形态是「推理吃光 max_tokens →
      // content 为空 + finish_reason=length」，HTTP 200 看着像成功、实际什么都没答
      if (isLlm) {
        try {
          const d = JSON.parse(text) as { choices?: unknown[] };
          const content = extractContent(d.choices?.[0] as Parameters<typeof extractContent>[0]);
          const answers = fromLlmContent(content, questions as Questions);
          const u = usageOf(d);
          console.log(
            `[${up.label}] 200 → ${Object.keys(answers).length} 题 ` +
              `${u.inputTokens}in/${u.outputTokens}out（推理 ${u.reasoningTokens}）`,
          );
          res.status(200);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.send(
            JSON.stringify({
              answers,
              usage: { inputTokens: u.inputTokens, outputTokens: u.outputTokens },
            }),
          );
        } catch (e) {
          const msg = (e as Error).message;
          console.error(`[${up.label}] 502 broker 翻译失败：${msg}`);
          res.status(502).json({ error: { message: `上游没有给出可用的答案：${msg}` } });
        }
        return;
      }

      // 日志里只记决策与 token，不记请求体（可能含用户上下文）
      try {
        const d = JSON.parse(text);
        console.log(`[${up.label}] 200 → ${summarizeAnswers(d)} ${tokensOf(d)} tok`);
      } catch {
        console.log(`[${up.label}] 200（响应解析失败）`);
      }

      res.status(200);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.send(text);
    } catch (e) {
      if (gate.aborted) {
        console.error(`[${up.label}] 上游超过 ${UPSTREAM_TIMEOUT_MS}ms 没有响应`);
        res.status(504).json({ error: { message: "上游响应超时，请稍后重试。" } });
        return;
      }
      res.status(502).json({
        error: { message: `无法连接上游：${(e as Error).message}` },
      });
    }
  };
}

/**
 * 免费后端出错时给浏览器看的文案。
 *
 * 刻意不含模型名、端点或上游厂商 —— 那些是本站的内部选择。
 * 但 429 / 402 时保留「额度」字样：前端 `isQuotaError` 除了状态码也会看文案，
 * 少了它，「额度用尽」就会被笼统地报成「后端不可用」。
 */
export function publicError(status: number): string {
  return status === 429 || status === 402
    ? "该免费后端的额度已用尽或被限流。请稍后重试，或在「API」设置里改用其他后端。"
    : "该免费后端暂时不可用。请稍后重试，或在「API」设置里改用其他后端。";
}
