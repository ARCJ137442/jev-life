/**
 * 浏览器侧的后端目录与地址解析。
 *
 * ═══ 这个文件在 T12 被**拆过一次**，理由要写清楚 ═══
 *
 * 源仓库（`jev-2048`）把「有哪些后端」「怎么解析地址」「怎么发请求」三件事
 * 塞在同一个 `client/api.ts` 里。这里前两件留在原处，第三件搬去了
 * `src/shared/backend.ts` —— 因为 `tools/play.ts` 要在**无头的 Node** 里
 * 走同一条请求路径，而 `tools/` 拿不到 `src/client/`（分层检查按传递闭包
 * 守着 `core/`，而 `tools/` 走的是 `loadCore()` 加载 `dist-test/` 产物，
 * `src/client/` 根本不在那份配置的 include 里）。
 *
 * 于是：**发请求的代码一份，放在两边都能到的地方。** 否则「CLI 跑出来的结果
 * 与浏览器跑出来的不一样」会成为一个查不出来的差异 —— 而那正是本项目最不
 * 能承受的一类 bug（测的不是同一个东西）。
 *
 * 本文件里剩下的部分都真的只对浏览器成立：`location`、静态托管的地址解析、
 * 以及给界面看的那张后端目录表。
 */
import { createLlmBackend, createSystemoneBackend } from "../shared/backend.js";
import type {
  CallOptions,
  ClientConfig as BackendTarget,
  DecisionBackend,
} from "../shared/backend.js";
import { ANTHROPIC_COMPAT_UPSTREAM, OPENAI_COMPAT_UPSTREAM } from "../shared/llm-broker.js";
import type { LlmProtocol } from "../shared/llm-broker.js";

/* ══════════════ 静态托管支持 ══════════════ */

/**
 * 远端免费试用端点的地址 —— **不在这里定义，见 `./deploy.js`**。
 *
 * ⚠ 刻意**没有默认值**。写死一个默认域名等于让别人的 fork 静默消耗
 * 原作者的额度，而靠注释提醒「请改成你的」只是君子协议 ——
 * 本项目一向的做法是**让那条路走不通，而不是请求人守规矩**。
 *
 * 顺带 re-export，调用方不必知道它住在哪。
 */
export { REMOTE_PROXY_BASE, hasRemoteProxy } from "./deploy.js";
import { REMOTE_PROXY_BASE, hasRemoteProxy } from "./deploy.js";

/**
 * 当前是否跑在「没有同源服务端」的环境里。
 *
 * 判据是 hostname 而不是探测请求：探测要等一次网络往返，
 * 而首屏就要决定后端可选列表，探测会让界面先闪一下再修正。
 */
export function isStaticHosting(): boolean {
  if (typeof location === "undefined") return false;
  if (location.protocol === "file:") return true;
  // GitHub Pages 的地址形如 <user>.github.io
  if (location.hostname.endsWith(".github.io")) return true;
  return false;
}

/**
 * 把代理路径解析成实际可用的地址。
 *
 *   /api/evaluate  →  同源部署下原样返回（本机服务器 / Vercel 自身）
 *                  →  静态托管下拼上远端前缀
 *                  →  静态托管**且没配远端前缀**时返回 `null`（走不通）
 *
 * 绝对 URL（直连各类网关）原样返回。
 *
 * ★ 返回 `null` 而不是拼出一个注定 404 的路径：那个地址根本没人配过，
 * 发出去的请求只会得到一个 404，而 404 与「后端挂了」在界面上长得一样。
 * **让它在出发之前就失败**，调用方才能给出「这条后端没配置」这样准确的提示。
 */
export function resolveBase(base: string): string | null {
  if (!base.startsWith("/")) return base;
  if (!isStaticHosting()) return base;
  if (!hasRemoteProxy()) return null;   // ← 静态托管且未配远端地址：这条路不存在
  return REMOTE_PROXY_BASE.replace(/\/$/, "") + base;
}

/**
 * 某个后端在当前环境下**能不能真的用**。
 *
 * 判据是「它的地址解析得出来吗」—— 而不是「它是否配置了密钥」，
 * 后者只有服务端知道（未配密钥时回 503，那是另一条路径上的提示）。
 *
 * 界面应当用它来决定要不要把这条后端显示出来：静态托管 + 没配远端地址时，
 * 「免费试用」那几条**根本走不通**，列出来只会让人点进去踩 404。
 */
export function isBackendReachable(base: string): boolean {
  return resolveBase(base) !== null;
}

/* ══════════════ 后端目录 ══════════════ */

/**
 * 后端标识。
 *
 * localproxy 与 openrouterproxy 是**同构的两套服务端代理** —— 它们不是
 * 「某个提供商」，而是「本站代为调用的免费额度」。界面上显示为
 * 「Jev 免费试用 1 / 2」，不暴露背后的提供商。
 */
export type BackendId =
  | "localproxy"
  | "openrouterproxy"
  | "llmfree"
  | "vercel"
  | "typesafe"
  | "openrouter"
  | "laya"
  | "lmstudio"
  | "llmopenai"
  | "llmanthropic";

export interface BackendConfig {
  /**
   * 展示名与说明文字的**词条 key**，不是成品文案。
   *
   * 存 key 而不是文本：`BACKENDS` 是模块级常量，在模块求值那一刻就把文案
   * 定死了，之后切换界面语言再也改不动。展示时用 `t(b.labelKey)`。
   */
  labelKey: string;
  noteKey: string;
  base: string;
  model: string;
  verified: boolean;
  /** 是否需要用户在浏览器中输入密钥（代理模式不需要） */
  needsKey: boolean;
  /**
   * 是否为**本站代管**的后端。
   *
   * 代管 = 端点与模型都由服务端决定，用户既改不了也不需要知道。
   * 界面上表现为：隐藏 Base URL、**禁用** Model ID（也不显示默认值）。
   *
   * 刻意不复用 needsKey 判断 —— 两者看似相关实则独立：
   * 「自建 / 本地兼容端点」不需要密钥，但它的地址与模型恰恰是用户必须填的；
   * 而两个免费试用后端同样不需要密钥，端点与模型却是本站的内部选择。
   */
  managed: boolean;
  /**
   * 这条后端**背后的协议是不是 OpenAI 兼容的 LLM**（即经 broker 包装的那条）。
   *
   * 它是「LLM 调用配置」那四个控件的**可见性判据**：思维链 / 是否允许思考 /
   * 思考强度 / 调用策略只对 LLM 有意义。做成一排点了没反应的死控件，正是本
   * 项目最该防的那种错 —— 症状与原因无关：用户会以为「关掉思维链没用」，
   * 其实那个开关根本没接线。
   */
  isLlm: boolean;
  /**
   * LLM 后端时，**真实上游**的名字 —— 只用来查 `llm-broker` 的能力表
   * （谁收 `reasoning_effort`、谁不收 `xhigh`）。
   *
   * ⚠ 它**不是**给用户看的：界面文案里永远不出现厂商名（与「免费试用」那几条
   * 同一条纪律）。放在这里是因为能力表按**上游**索引，而界面必须在**下发之前**
   * 就能标注「该后端不支持，已降级为默认」—— 等请求打完 400 再解释，
   * 报错离原因就太远了（那正是 ui-spec 第五节第 3 条记的那次）。
   */
  llmUpstream?: string;
  /**
   * 这条 LLM 后端说**哪种协议** —— 决定路径、认证头、请求体与回包解析。
   *
   * ⚠ **只有「用户自备 key 的直连 LLM」才有值。** 代管那条（`llmfree`）的
   * 翻译在服务端做（见 `/api/evaluate3`），客户端既不需要、也不该知道
   * 上游说的是哪种协议 —— 那正是四层架构里「中间那层必须真的兼容」的意思。
   *
   * 它同时是 `createBackend` 的分流判据：有值 ⟹ broker 在**浏览器里**跑。
   * 这条路的密钥不经过任何服务端（静态托管下也没有服务端可经过）。
   */
  readonly protocol?: LlmProtocol;
}

export const BACKENDS: Record<BackendId, BackendConfig> = {
  localproxy: {
    labelKey: "backend.freeTrial",
    base: "/api/evaluate",
    model: "typesafe-ai/jev",
    noteKey: "backend.freeTrialDesc",
    verified: true,
    managed: true,
    needsKey: false,
    isLlm: false,
  },
  openrouterproxy: {
    labelKey: "backend.freeTrial2",
    base: "/api/evaluate2",
    model: "typesafe/jev-1.13",
    noteKey: "backend.freeTrial2Desc",
    verified: true,
    managed: true,
    needsKey: false,
    isLlm: false,
  },
  llmfree: {
    // 「LLM 免费试用 1」—— 与上面两条**协议不同**，不是同一套转发逻辑的实例。
    // 上面两条说的是 Jev 协议（SystemOne），这条说的是 OpenAI 兼容协议，
    // 所以进出都要在服务端过 `llm-broker` 翻译。
    //
    // ⚠ 它背后的提供商**不对外暴露**（与上面两条同一条纪律）：界面只显示
    // 「LLM 免费试用 1」，健康检查只回后端标识，错误文案不含厂商名。
    // `llmUpstream` 是唯一的例外，而它只用于本地查能力表，不进任何文案。
    labelKey: "backend.llmFreeTrial",
    base: "/api/evaluate3",
    model: "agnes-2.5-flash",
    noteKey: "backend.llmFreeTrialDesc",
    verified: false,
    managed: true,
    needsKey: false,
    isLlm: true,
    llmUpstream: "agnes",
  },
  vercel: {
    labelKey: "backend.vercel",
    base: "https://ai-gateway.vercel.sh/v1/evaluate",
    model: "typesafe-ai/jev",
    noteKey: "backend.vercelDesc",
    verified: true,
    managed: false,
    needsKey: true,
    isLlm: false,
  },
  typesafe: {
    labelKey: "backend.typesafe",
    base: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    noteKey: "backend.typesafeDesc",
    verified: true,
    managed: false,
    needsKey: true,
    isLlm: false,
  },
  openrouter: {
    labelKey: "backend.openrouter",
    base: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    noteKey: "backend.openrouterDesc",
    verified: true,
    managed: false,
    needsKey: true,
    isLlm: false,
  },
  laya: {
    labelKey: "backend.laya",
    base: "http://127.0.0.1:8137/v1/systemone",
    model: "typed-decisions",
    noteKey: "backend.layaDesc",
    verified: false,
    managed: false,
    needsKey: false,
    isLlm: false,
  },
  lmstudio: {
    labelKey: "backend.custom",
    base: "http://localhost:1234/v1/systemone",
    model: "jev-latest",
    noteKey: "backend.customDesc",
    verified: false,
    managed: false,
    needsKey: false,
    isLlm: false,
  },

  /* ── 用户自备 key 的两条：broker 在**浏览器里**跑 ──
   *
   * ★ 与上面 `llmfree` 的关键差别不在「谁付钱」，而在**翻译发生在哪一层**：
   * 代管那条有服务端可代劳，这两条没有（静态托管下连 Serverless 都没有）。
   * 于是同一个纯函数 broker 被搬到了客户端 —— 见 `shared/backend.ts` 的
   * `createLlmBackend` 与 `docs/llm-backends.md` 第零节。
   *
   * ⚠ **密钥语义与代管那几条不同，文案要写清**：这里的 key 是**用户自己的**、
   * 只存在于**他自己这台浏览器**的内存里，我们既不代管也不转发。
   */
  llmopenai: {
    labelKey: "backend.llmOpenai",
    // 预置一个**实测跑通过**的端点，用户改成任何 OpenAI 兼容的服务都行。
    // 直连类后端本来就在界面上写明是谁（与代管的免费额度那条纪律不同）——
    // 藏着不说，用户就不知道这个框该填什么
    base: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    noteKey: "backend.llmOpenaiDesc",
    // 实测：这条端点用真 key 直连跑通过（协议形状、CORS 头都验过）。
    // 但用户改填别的地址之后，那就不再是这里验过的东西了
    verified: true,
    managed: false,
    needsKey: true,
    isLlm: true,
    llmUpstream: OPENAI_COMPAT_UPSTREAM,
    protocol: "openai",
  },
  llmanthropic: {
    labelKey: "backend.llmAnthropic",
    base: "https://api.anthropic.com/v1",
    model: "claude-opus-5",
    noteKey: "backend.llmAnthropicDesc",
    // ⚠ **未实测。** Anthropic 协议的形状本身验过了（在一家兼容端点上，
    // 用真 key 打的真请求），但**官方 api.anthropic.com 没验过** ——
    // 本项目没有 Anthropic 的 key，而且从开发环境发出的预检请求被挡在
    // 403，连「能不能浏览器直连」都没能实测。所以这条不敢标「已实测可用」
    verified: false,
    managed: false,
    needsKey: true,
    isLlm: true,
    llmUpstream: ANTHROPIC_COMPAT_UPSTREAM,
    protocol: "anthropic",
  },
};

/**
 * 界面上的后端配置。
 *
 * 比传输层多一个 `provider` —— 那是查 `BACKENDS` 表用的键，同时也是
 * **组题时的判别值来源**（`noulDiscriminator(provider)`）。判别值刻意不在这里
 * 出场：它属于「怎么问」，走 `Channel.backend` 传到 `buildQuestions`，
 * 而不是跟着网络参数走 —— 否则「同一局棋换个后端」会变成两个不同的 state。
 */
export interface ClientConfig extends BackendTarget {
  readonly provider: BackendId;
}

/**
 * 把配置里的代理路径解析成真实地址。其余字段原样透传。
 *
 * **走不通时返回 `null`**（静态托管 + 未配远端地址）—— 调用方必须处理，
 * 不能悄悄退回一个连不上的地址。
 */
export function resolveConfig(cfg: ClientConfig): BackendTarget | null {
  const base = resolveBase(cfg.base);
  if (base === null) return null;
  return {
    base,
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
  };
}

/**
 * 由界面配置造一个可用的决策后端。
 *
 * **地址走不通时返回 `null`**（静态托管 + 未配远端地址）—— 调用方据此提示
 * 「这条后端在当前部署下不可用」，而不是发一个注定 404 的请求。
 *
 * ⚠ `createSystemoneBackend` 同时服务于**两种上游**：Jev 协议的直连后端，
 * 以及经 `/api/evaluate3` 包装的 LLM 后端。后者对客户端而言**就是一条
 * SystemOne 上游** —— 翻译发生在服务端（见 `src/shared/llm-broker.ts`）。
 * 所以这里不需要为 LLM 加分文，客户端也分不出区别。这正是 `DESIGN.md`
 * 第八节那条「中间那层必须真的兼容」要的效果。
 */
export function createBackend(
  cfg: ClientConfig,
  opts: CallOptions = {},
): DecisionBackend | null {
  const target = resolveConfig(cfg);
  if (target === null) return null;

  // ★ **分流点：这条后端说不说协议，决定 broker 在哪一层跑。**
  //
  // 有 `protocol` ⟹ 用户自备 key、直连自己的端点 ⟹ 没有服务端可代劳
  // ⟹ 翻译在浏览器里做（`createLlmBackend`）。
  // 没有 ⟹ 要么是 Jev 协议，要么是代管的那条 LLM（翻译在服务端做掉之后，
  // 它在客户端**就是一条 SystemOne 上游**）。
  //
  // 判据用 `protocol` 而不是 `isLlm`：代管那条也是 `isLlm: true`，
  // 但它的翻译必须继续留在服务端 —— 密钥在那边，形状知识也在那边。
  const meta = BACKENDS[cfg.provider];
  if (meta.protocol !== undefined) {
    return createLlmBackend(target, {
      id: cfg.provider,
      protocol: meta.protocol,
      // 能力表按**协议族**索引，不是按厂商 —— 见 `llm-broker.ts` 的 `LlmProtocol`
      upstream: meta.llmUpstream ?? "",
      ...opts,
    });
  }
  return createSystemoneBackend(target, { id: cfg.provider, ...opts });
}
