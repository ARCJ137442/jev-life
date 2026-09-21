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
import { createSystemoneBackend } from "../shared/backend.js";
import type {
  CallOptions,
  ClientConfig as BackendTarget,
  DecisionBackend,
} from "../shared/backend.js";

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
  | "vercel"
  | "typesafe"
  | "openrouter"
  | "laya"
  | "lmstudio";

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
  },
  openrouterproxy: {
    labelKey: "backend.freeTrial2",
    base: "/api/evaluate2",
    model: "typesafe/jev-1.13",
    noteKey: "backend.freeTrial2Desc",
    verified: true,
    managed: true,
    needsKey: false,
  },
  vercel: {
    labelKey: "backend.vercel",
    base: "https://ai-gateway.vercel.sh/v1/evaluate",
    model: "typesafe-ai/jev",
    noteKey: "backend.vercelDesc",
    verified: true,
    managed: false,
    needsKey: true,
  },
  typesafe: {
    labelKey: "backend.typesafe",
    base: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    noteKey: "backend.typesafeDesc",
    verified: true,
    managed: false,
    needsKey: true,
  },
  openrouter: {
    labelKey: "backend.openrouter",
    base: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    noteKey: "backend.openrouterDesc",
    verified: true,
    managed: false,
    needsKey: true,
  },
  laya: {
    labelKey: "backend.laya",
    base: "http://127.0.0.1:8137/v1/systemone",
    model: "typed-decisions",
    noteKey: "backend.layaDesc",
    verified: false,
    managed: false,
    needsKey: false,
  },
  lmstudio: {
    labelKey: "backend.custom",
    base: "http://localhost:1234/v1/systemone",
    model: "jev-latest",
    noteKey: "backend.customDesc",
    verified: false,
    managed: false,
    needsKey: false,
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
  return createSystemoneBackend(target, { id: cfg.provider, ...opts });
}
