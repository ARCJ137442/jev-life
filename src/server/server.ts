/**
 * 生命棋 × Jev 本机服务器
 *
 * 职责：
 *   1. 托管静态页面（public/）
 *   2. 提供 /api/evaluate 与 /api/evaluate2 代理端点 —— 上游密钥只存在于本进程
 *      内存中，浏览器全程接触不到，DevTools 的 Network / Source 面板里也看不到。
 *
 * 只用 Node 内置模块，无第三方依赖。
 *
 * 来源是 `jev-2048/src/server/server.ts`（架构照搬）。相对它改了三处：
 *   - 上游请求**加了超时**。源仓库全层没有 `AbortController` —— 上游挂住时
 *     这个代理会一直占着一条连接和一份内存，而浏览器侧看到的是「一直在转」
 *   - 日志改读生命棋的问题名。源仓库读 `answers.best_move.choice`，那是 2048
 *     的问题名；生命棋一次发 N 个布尔题，没有 `best_move` 这一项
 *   - 启动横幅与提示文案换成本项目的
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unseal } from "./seal.js";
import { DEFAULT_TIMEOUT_MS, startTimeout } from "../shared/backend.js";
import { normalizeQuestionTypes } from "../shared/types.js";

/* ═══════════ 配置 ═══════════ */

// dist/server/server.js → dist/server → dist → 项目根
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = join(HERE, "public");
const LOCAL_DIR = join(HERE, "..", "local");

/**
 * 上游表。「免费试用 1」与「免费试用 2」是同一套代理架构的两个实例，
 * 区别只在「转发到哪、用哪个密钥」，所以用一张表描述而不是复制两份处理逻辑。
 *
 * ⚠ 两家的**协议命名不一致**（实测结论）：
 *   - Vercel 的布尔类型叫 `boolean`，OpenRouter 叫 `noul`，传错会被 400 拒绝
 *   - usage 字段 Vercel 是 `inputTokens`，OpenRouter 是 `input_tokens`
 *   - 模型 ID 命名空间也不同
 *
 * ★ 2048 的主流程走 `choice`，两边一致，所以那处差异它从没真的踩到过。
 * **生命棋的 noul 通道是第一次真的走这条路径** —— 它第一次真跑就撞上了那个 400：
 * 客户端组题时按界面上的后端 id 取判别值（`localproxy` → `noul`），而这条
 * 代理转发到的是 Vercel（要 `boolean`）。
 *
 * 修法不是让客户端更聪明，而是**让知道上游是谁的那一层翻译**：客户端只发
 * 语义（`noul`），下面每个上游要什么由这张表说了算 —— 见
 * `normalizeQuestionTypes` 与 `handleEvaluate` 里那一次调用。
 */
interface Upstream {
  /** 端点路径（本机服务器暴露给浏览器的） */
  route: string;
  /** 真实上游地址 */
  url: string;
  /** 环境变量名（Vercel 部署时用） */
  envKey: string;
  /** 本机密钥文件名（相对 local/） */
  keyFile: string;
  /** 默认模型 ID */
  model: string;
  /** 面向用户的标识，仅用于日志与健康检查 */
  label: string;
  /**
   * 这条代理**背后的真实上游**。判别值按它算（`normalizeQuestionTypes`）。
   *
   * ⚠ 它**不是浏览器那边的后端 id。** 界面上的「Jev 免费试用 1」id 是
   * `localproxy`，与 Vercel 毫无字面关系 —— 正是这个错位造成了那个 400。
   * 所以这一栏在这里显式声明，不靠 `route` 或 `label` 反推。
   */
  upstream: string;
}

const UPSTREAMS: Upstream[] = [
  {
    route: "/api/evaluate",
    url: "https://ai-gateway.vercel.sh/v1/evaluate",
    envKey: "VERCEL_AI_GATEWAY_KEY",
    keyFile: "vercel-secret-api-key",
    model: "typesafe-ai/jev",
    label: "free-trial",
    upstream: "vercel",
  },
  {
    route: "/api/evaluate2",
    url: "https://openrouter.ai/api/v1/systemone",
    envKey: "OPENROUTER_API_KEY",
    keyFile: "openrouter-secret-api-key",
    model: "typesafe/jev-1.13",
    label: "free-trial-2",
    upstream: "openrouter",
  },
];

const DEFAULT_PORT = 8787;
const MAX_BODY = 512 * 1024;

/**
 * 转发给上游的超时。
 *
 * 比客户端那侧（60 秒）**再宽一点**：这里是最后一道，掐早了会把一个本来能
 * 答完的慢请求变成失败；而客户端那侧的时间是从它自己发请求算起的，
 * 两道超时叠在一起时应当由客户端先超时。
 */
const UPSTREAM_TIMEOUT_MS = DEFAULT_TIMEOUT_MS + 30_000;

/** 静态文件白名单 —— 密钥文件、源码永远不会被读到 */
const ALLOWED_EXT = new Set([".html", ".js", ".css", ".ico", ".png", ".svg", ".map"]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

/* ═══════════ 密钥 ═══════════ */

/**
 * 按优先级取某个上游的密钥：
 *   1. 环境变量                          —— 最干净，密钥不落盘
 *   2. 封存文件 *.sealed                 —— 磁盘上只有密文
 *   3. 明文文件                          —— 兼容旧布置，启动时提醒
 *
 * 找不到时返回 null 而不是退出：某个上游没配密钥，不该让整个服务起不来 ——
 * 另一个「免费试用」还能用。启动时会把不可用的标记出来。
 */
function loadKey(up: Upstream): { key: string; source: string } | null {
  const env = (process.env[up.envKey] ?? "").trim();
  if (env) return { key: env, source: `环境变量 ${up.envKey}` };

  const plain = join(LOCAL_DIR, up.keyFile);
  const sealedPath = `${plain}.sealed`;

  if (existsSync(sealedPath)) {
    const key = unseal(readFileSync(sealedPath, "utf8").trim());
    if (key && key.trim()) return { key: key.trim(), source: `${up.keyFile}.sealed（已封存）` };
    console.error(`[警告] ${up.label} 的封存密钥解不开，该上游将不可用。`);
    console.error(`       口令不对或文件被改动过；换过口令就设 JEV_SEAL_PASSPHRASE。`);
    return null;
  }

  if (existsSync(plain)) {
    const key = readFileSync(plain, "utf8").trim();
    if (key) return { key, source: `${up.keyFile}（明文，建议封存）` };
  }

  return null;
}

/** 各上游的密钥与可用状态，启动时一次性解析 */
const KEYS = new Map<string, { key: string; source: string } | null>();
for (const up of UPSTREAMS) KEYS.set(up.route, loadKey(up));

function masked(key: string): string {
  return key.length > 14 ? `${key.slice(0, 7)}${"*".repeat(12)}${key.slice(-4)}` : "***";
}

/* ═══════════ 日志 ═══════════ */

/** 生命棋的布尔答案。字段名随网关变化，统一在这里抹平 */
interface NoulLike {
  readonly type?: string;
  readonly noul?: number;
  readonly probability?: number;
}

/**
 * 回包摘要。**只记决策与 token，不记请求体**（那里可能有用户的上下文）。
 *
 * ★ 源仓库这里读的是 `answers.best_move.choice` —— 2048 的问题名。生命棋
 * 一次发 N 个布尔题（每个合法格一题），没有 `best_move` 这一项；照抄会
 * 让日志永远显示 "?"，而「日志显示 ? 」与「模型真的没答」长得一模一样。
 * 所以改成报题数与最高概率那一题 —— 后者是这一回合决策的落点。
 *
 * 与 `api/_upstream.ts` 里那份是**同源的重复**：`api/` 刻意不引 `src/`
 * （理由写在那边的 UPSTREAM_TIMEOUT_MS 注释里），所以留了两份。改一处记得改另一处。
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
    : `${keys.length} 题  最高 ${bestKey}=${best.toFixed(2)}`;
}

function log(msg: string): void {
  const t = new Date().toTimeString().slice(0, 8);
  console.log(`  ${t}  ${msg}`);
}

/* ═══════════ 局域网地址 ═══════════ */

function lanIp(): string {
  // Android/Termux 下内核选路会返回应用沙箱的网桥地址，不是真实局域网地址。
  // 因此优先向 Termux WiFi API 询问。
  try {
    const out = execFileSync("termux-wifi-connectioninfo", { timeout: 5000 }).toString();
    const ip = (JSON.parse(out) as { ip?: string }).ip;
    if (ip && !ip.startsWith("127.")) return ip;
  } catch {
    /* 非 Android 或 API 不可用，走下面的回退 */
  }

  // 通用回退：读路由表里的默认出口地址
  try {
    const out = execFileSync("hostname", ["-I"], { timeout: 3000 }).toString().trim();
    const first = out.split(/\s+/)[0];
    if (first) return first;
  } catch {
    /* ignore */
  }
  return "localhost";
}

/* ═══════════ HTTP 处理 ═══════════ */

function send(res: ServerResponse, code: number, body: Buffer | string, ctype: string): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  res.writeHead(code, {
    "Content-Type": ctype,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    // 允许跨域：静态托管下的页面（GitHub Pages / file://）可能来连本机调试。
    // 与 Vercel 侧同理 —— 服务端不持有客户端任何数据，安全性不靠来源限制。
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  });
  res.end(buf);
}

function sendJson(res: ServerResponse, code: number, obj: unknown): void {
  send(res, code, JSON.stringify(obj), "application/json; charset=utf-8");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** 解析静态文件路径，拒绝任何越界访问 */
function resolveStatic(urlPath: string): string | null {
  const rel = urlPath === "/" || urlPath === "" ? "index.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;      // 路径穿越
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  if (!ALLOWED_EXT.has(extname(full))) return null;   // 白名单
  return full;
}

async function handleEvaluate(
  up: Upstream,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const cred = KEYS.get(up.route);
  if (!cred) {
    // 同 api/_upstream.ts：面向用户的错误不暴露上游与环境变量名，
    // 细节只写本地日志（本机运行时用户就是管理员，看日志即可）。
    log(`✗ [${up.label}] 未配置：缺 ${up.envKey} 或本地密钥文件`);
    sendJson(res, 503, {
      error: {
        message: "该免费后端暂时不可用。请稍后重试，或在「API」设置里改用其他后端或自备密钥。",
      },
    });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    const raw = await readBody(req);
    if (!raw) {
      sendJson(res, 400, { error: { message: "请求体为空" } });
      return;
    }
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    sendJson(res, 400, { error: { message: `请求体无效：${(e as Error).message}` } });
    return;
  }

  // 关键：模型与密钥一律由服务器决定，忽略浏览器传来的任何认证信息。
  // 模型 ID 的命名空间两家不同（typesafe-ai/jev vs typesafe/jev-1.13），
  // 所以取上游表里的值而不是客户端的。
  payload.model = up.model;

  // 判别值同理，而且更隐蔽：客户端按界面上的后端 id 取（免费试用 1 → noul），
  // 而这条代理真正的上游是 Vercel（要 boolean）。翻译在这里做 —— 客户端不该
  // 知道、也无从知道代理转发到哪。漏掉这一行，症状是默认的免费后端一发就 400，
  // 而错误原文被下游刻意挡掉，浏览器侧只剩一句「后端暂时不可用」。
  payload = normalizeQuestionTypes(payload, up.upstream);

  const t0 = Date.now();
  let status = 502;
  let body = "";

  // 上游超时。没有这一条，一个挂住的上游会一直占着这条连接；
  // 而客户端那侧只会看到「一直在转」，看不出是上游还是本机的问题
  const gate = startTimeout(UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(up.url, {
      method: "POST",
      headers: {
        // ← 密钥在这里注入，永不外泄给浏览器
        Authorization: `Bearer ${cred.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: gate.signal,
    });
    status = upstream.status;
    body = await upstream.text();
  } catch (e) {
    if (gate.signal.aborted) {
      sendJson(res, 504, { error: { message: "上游响应超时，请稍后重试。" } });
      log(`✗ [${up.label}] 504  上游超过 ${UPSTREAM_TIMEOUT_MS}ms 没有响应`);
      return;
    }
    // Node 的 fetch 失败时 message 只有笼统的 "fetch failed"，
    // 真正的原因藏在 cause 里（DNS / TLS / 超时 / 连接被拒各不相同）。
    // 不打出来就没法排查。
    const err = e as Error & { cause?: { code?: string; message?: string } };
    const detail = err.cause?.code ?? err.cause?.message ?? "";
    const msg = detail ? `${err.message}（${detail}）` : err.message;
    sendJson(res, 502, { error: { message: `无法连接上游：${msg}` } });
    log(`✗ [${up.label}] 502  连接失败：${msg}`);
    return;
  } finally {
    gate.done();
  }

  const ms = Date.now() - t0;

  if (status === 200) {
    try {
      const d = JSON.parse(body) as {
        usage?: { inputTokens?: number; input_tokens?: number };
      };
      // usage 字段命名两家不同：Vercel 用 inputTokens，OpenRouter 用 input_tokens
      const u = d.usage ?? {};
      const tok = u.inputTokens ?? u.input_tokens ?? 0;
      log(`✓ [${up.label}] 200  ${summarizeAnswers(d)}  ${tok} tok  ${ms}ms`);
    } catch {
      log(`✓ [${up.label}] 200  (响应解析失败)  ${ms}ms`);
    }
  } else {
    log(`✗ [${up.label}] ${status}  ${ms}ms`);
  }

  // 非 200 一律**不透传上游原文** —— 那里面可能带模型名、端点、账号信息，
  // 直接送到浏览器就等于把上游选型泄露给使用者。原文留在服务端日志里备查。
  if (status === 200) {
    send(res, status, body, "application/json; charset=utf-8");
  } else {
    log(`    上游原文：${body.slice(0, 300)}`);
    sendJson(res, status, { error: { message: publicError(status) } });
  }
}

/**
 * 免费后端出错时给浏览器看的文案。
 *
 * 刻意不含模型名、端点或上游厂商 —— 那些是本站的内部选择，用户既改不了
 * 也不需要知道。但 429 / 402 时保留「额度」字样：前端 `isQuotaError`
 * 除了状态码也会看文案，少了它，「额度用尽」会被笼统地报成「后端不可用」。
 */
function publicError(status: number): string {
  return status === 429 || status === 402
    ? "该免费后端的额度已用尽或被限流。请稍后重试，或在「API」设置里改用其他后端。"
    : "该免费后端暂时不可用。请稍后重试，或在「API」设置里改用其他后端。";
}

/* ═══════════ 启动 ═══════════ */

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  // 跨域预检
  if (req.method === "OPTIONS") {
    send(res, 204, "", "text/plain");
    return;
  }

  if (req.method === "GET" && path === "/api/health") {
    // 只回显脱敏形态与「哪个上游可用」，绝不返回密钥本身
    sendJson(res, 200, {
      ok: true,
      backends: UPSTREAMS.map((up) => {
        const cred = KEYS.get(up.route);
        return {
          route: up.route,
          label: up.label,
          available: Boolean(cred),
          key: cred ? masked(cred.key) : null,
        };
      }),
    });
    return;
  }

  const up = UPSTREAMS.find((u) => u.route === path);
  if (req.method === "POST" && up) {
    void handleEvaluate(up, req, res);
    return;
  }

  // 早期版本只有 /api/evaluate，健康检查的字段名也变了。
  // 保留一个 GET 的兜底说明，避免旧前端拿到 404 后一脸茫然。
  if (req.method === "GET" && UPSTREAMS.some((u) => u.route === path)) {
    sendJson(res, 405, { error: { message: `${path} 只接受 POST` } });
    return;
  }

  if (req.method === "GET") {
    const file = resolveStatic(path);
    if (!file) {
      send(res, 404, "Not Found", "text/plain; charset=utf-8");
      return;
    }
    const ext = extname(file);
    send(res, 200, readFileSync(file), MIME[ext] ?? "application/octet-stream");
    return;
  }

  sendJson(res, 404, { error: { message: `未知端点：${req.method} ${path}` } });
});

const port = (() => {
  const arg = process.argv[2];
  if (!arg) return DEFAULT_PORT;
  const n = Number(arg);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    console.error(`[致命] 端口无效：${arg}`);
    process.exit(1);
  }
  return n;
})();

server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(`[致命] 端口 ${port} 已被占用。换一个：node dist/server/server.js ${port + 1}`);
  } else {
    console.error(`[致命] 服务器错误：${e.message}`);
  }
  process.exit(1);
});

server.listen(port, "0.0.0.0", () => {
  const ip = lanIp();

  const backendLines = UPSTREAMS.flatMap((up) => {
    const cred = KEYS.get(up.route);
    if (!cred) {
      return [`  ✗ ${up.label.padEnd(12)} 未配置（缺 ${up.envKey} 或本地密钥文件）`];
    }
    return [
      `  ✓ ${up.label.padEnd(12)} ${up.route}`,
      `     密钥 ${masked(cred.key)}   来源 ${cred.source}`,
      `     上游 ${up.url}`,
      `     模型 ${up.model}`,
    ];
  });

  console.log(
    [
      "",
      "═".repeat(62),
      "  生命棋 × JEV  —  决策仪器已启动",
      "═".repeat(62),
      ...backendLines,
      "",
      `  本机访问   http://localhost:${port}/`,
      `  局域网访问 http://${ip}:${port}/`,
      "",
      "  在浏览器上打开上面任一地址即可开始。",
      "  Ctrl+C 停止服务。",
      "═".repeat(62),
      "",
    ].join("\n"),
  );
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log("\n  已停止。");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
