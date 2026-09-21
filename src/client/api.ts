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
 * 远端免费试用端点的地址。
 *
 * 纯静态托管（GitHub Pages、任意静态空间、file://）没有同源的服务端函数，
 * 所以「免费试用」类后端必须指向别处 —— 也就是 Vercel 上的那份部署。
 *
 * **这不是把密钥搬进静态文件**：静态页面只发请求，密钥仍在 Vercel 的函数进程里。
 * 部署到自己的域名后，把这个常量改成你的地址即可。
 *
 * ⚠ 换 Vercel 域名时必须同步改这里，否则静态版跨域调不通 —— 而失败的样子
 * 是「请求超时」，看不出跟域名有关。
 */
export const REMOTE_PROXY_BASE = "https://jev-life.vercel.app";

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
 *
 * 绝对 URL（直连各类网关）原样返回。
 */
export function resolveBase(base: string): string {
  if (!base.startsWith("/")) return base;
  if (!isStaticHosting()) return base;
  return REMOTE_PROXY_BASE.replace(/\/$/, "") + base;
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

/** 把配置里的代理路径解析成真实地址。其余字段原样透传 */
export function resolveConfig(cfg: ClientConfig): BackendTarget {
  return {
    base: resolveBase(cfg.base),
    model: cfg.model,
    apiKey: cfg.apiKey,
    timeoutMs: cfg.timeoutMs,
  };
}

/**
 * 由界面配置造一个可用的决策后端。
 *
 * M1 只有 `systemone` 一种。加 `llm-json` / `llm-tool` 时**只要在这里多一个
 * 分支** —— `channels.ts` / `decide.ts` / `core/` 一行都不用改，它们分不出
 * 对面是 Jev 还是一个被 broker 包装的 LLM。
 */
export function createBackend(cfg: ClientConfig, opts: CallOptions = {}): DecisionBackend {
  return createSystemoneBackend(resolveConfig(cfg), { id: cfg.provider, ...opts });
}
