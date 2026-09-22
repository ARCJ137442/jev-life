#!/bin/sh
#
# 编译并启动 生命棋 × Jev。
#
# 不依赖 npm —— Termux 下 npm/npx 的 shebang 指向不存在的 /usr/bin/env，
# 直接调用会失败，所以这里用 node 执行 tsc 的 JS 入口绕开它。
#
# ── 为什么 shebang 是 /bin/sh，而不是 /usr/bin/env bash ─────────────
#
# 上面那条「/usr/bin/env 不存在」**对本文件自己同样成立** —— Termux 上
# env 在 `$PREFIX/bin/env`，`/usr/bin/env` 根本没有。于是三种写法：
#
#   #!/data/data/com.termux/files/usr/bin/bash   → 只在 Termux 上成立
#   #!/usr/bin/env bash                         → 在 Termux 上直接坏掉
#   #!/bin/sh                                   → 两边都成立 ✓
#
# `/bin/sh` 是 POSIX 保证存在的路径，Android（Termux）/ Linux / macOS 上都有。
# 代价是本文件必须守住 POSIX：正文里没有管道，所以 `set -o pipefail` 本来就
# 是惰性的；而 dash（Debian/Ubuntu 的 /bin/sh）认不出这个选项，留着反而会在
# 那些系统上当场崩。所以它被删掉了，不是「忘了加回来」。
#
# ⚠ CI 不会替你发现 shebang 的问题：ci.yml 跑的是 npm ci + 逐条命令，
#   从不调用本文件。这条路径**只有「别人第一次 clone」时才走到**。
#
# 用法： ./start.sh [端口]
#
set -eu
cd "$(dirname "$0")"

TSC="node_modules/typescript/bin/tsc"

if [ ! -f "$TSC" ]; then
  echo "✗ 缺少 TypeScript。请先安装依赖："
  echo "    node \$(command -v npm) install"
  exit 1
fi

echo "▸ 扫描密钥…"
node tools/scan-secrets.ts || { echo "✗ 发现明文密钥，已中止启动"; exit 1; }

echo "▸ 检查分层（core/ 不得 import client/）…"
node tools/scan.ts || { echo "✗ 分层被破坏，已中止启动"; exit 1; }

echo "▸ 检查 DOM id 一致性…"
node tools/check-dom.ts || { echo "✗ HTML 与 TS 不同步，已中止启动"; exit 1; }

echo "▸ 运行单元测试…"
# ⚠ 下面两条与 `package.json` 的 `test` 脚本**是同一件事**，改了记得两边都改。
#   这里不能直接调 `npm test` —— Termux 下 npm 的 shebang 指向不存在的
#   /usr/bin/env（见文件头的说明），所以只能把命令抄一遍。
#   ci.yml / pages.yml 走的是 `npm test`，它们不抄。
node "$TSC" -p tsconfig.test.json
# api/ 的产物：normalize.test.ts 测的是编译后的入口（与 Vercel 加载的是同一份）。
# 少了这一步，那条用例会因为找不到 dist-api/ 而红 —— 而它正是用来抓
# 「api/ 的 import 在 Vercel 上解析不了」那类错的
node "$TSC" -p tsconfig.api.json
node --test dist-test/test/*.test.js || { echo "✗ 测试未通过，已中止启动"; exit 1; }

echo "▸ 编译客户端 (src/client → public/js)…"
node "$TSC" -p tsconfig.client.json

echo "▸ 编译服务器 (src/server → dist)…"
node "$TSC" -p tsconfig.server.json

echo "▸ 启动服务器…"
exec node dist/server/server.js "${1:-8787}"
