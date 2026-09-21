#!/usr/bin/env bash
#
# 编译并启动 生命棋 × Jev。
#
# 不依赖 npm —— Termux 下 npm/npx 的 shebang 指向不存在的 /usr/bin/env，
# 直接调用会失败，所以这里用 node 执行 tsc 的 JS 入口绕开它。
#
# ↑ 那个坑只在**调用 npm 时**成立，与本文件自己的 shebang 无关。
#   这里一度写着 `#!/data/data/com.termux/files/usr/bin/bash`（Termux 的
#   私有路径），于是任何 Linux/macOS 上第一次 clone 的人执行 README 的
#   「快速开始」，拿到的都是 bad interpreter —— 而 CI 跑的是逐条命令、
#   从不调用本文件，所以这条路径**永远不会被 CI 暴露**。
#   走 /usr/bin/env 是两台机器上都成立的那一种。
#
# 用法： ./start.sh [端口]
#
set -euo pipefail
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
node "$TSC" -p tsconfig.test.json
node --test dist-test/test/*.test.js || { echo "✗ 测试未通过，已中止启动"; exit 1; }

echo "▸ 编译客户端 (src/client → public/js)…"
node "$TSC" -p tsconfig.client.json

echo "▸ 编译服务器 (src/server → dist)…"
node "$TSC" -p tsconfig.server.json

echo "▸ 启动服务器…"
exec node dist/server/server.js "${1:-8787}"
