/**
 * 占位服务器 —— T12 会用真正的服务器替换它。
 *
 * 为什么需要它：start.sh 从 T2 起就要能整条跑通，但它的后半段依赖还不存在
 * 的东西 —— `tsc -p tsconfig.server.json` 在 src/server/ 为空时报 TS18003
 * （No inputs were found），而最后一行 `node dist/server/server.js` 需要有
 * 可执行的东西。没有这个文件，管道从 T2 到 T12 之间永远是红的。
 *
 * 它**只做静态托管**：没有密钥代理、没有 /api/evaluate、没有多上游。
 * 那些全在 T12，而且依赖尚不存在的 src/server/seal.ts —— 所以这里刻意不去
 * 照搬 jev-2048 的 server.ts，免得留一份看起来能用、实际缺半边的实现。
 *
 * 用法： node dist/server/server.js [端口]
 */
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 编译产物在 dist/server/server.js，所以往上两级才是仓库根
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC_DIR = join(ROOT, "public");

const PORT = Number(process.argv[2] ?? 8787);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const server = createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  const slash = pathname.endsWith("/") ? pathname : `${pathname}/`;
  // 请求是目录还是文件，这里不探测 —— 先按目录试 index.html，再按原路径试，
  // 两条都失败才 404。占位实现不追求完备，只要求行为可预期。
  const candidates = [join(PUBLIC_DIR, slash.slice(1), "index.html"), join(PUBLIC_DIR, slash.slice(1))];

  for (const candidate of candidates) {
    // 目录穿越：`/../..` 解出来的路径会跑到 public/ 之外，必须挡在读取之前
    if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + sep)) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      res.writeHead(200, { "content-type": MIME[extname(candidate)] ?? "application/octet-stream" });
      res.end(readFileSync(candidate));
      return;
    } catch {
      /* 试下一个 */
    }
  }

  res
    .writeHead(404, { "content-type": "text/plain; charset=utf-8" })
    .end("404 —— 占位服务器只托管 public/。密钥代理与 /api/evaluate 在 T12。\n");
});

server.listen(PORT, () => {
  console.log(`  生命棋占位服务器 → http://localhost:${PORT}/`);
  console.log("  只做静态托管。密钥代理与 /api/evaluate 在 T12 落地。");
});
