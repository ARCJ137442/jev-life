# 生命棋 M1 实现计划（无头跑通 → 本地 localhost 试玩）

> **本文件是执行文档，不是设计文档。**
>
> 2026-09-21 做过一次整理：本文件里累积的**设计论证**（终局判定语义、`state` 的三块划分、
> 配置模型、四层架构、LLM 后端实测、分区判据、测量纪律）已经**提取到 `DESIGN.md`**。
>
> **遇两者冲突时以 `DESIGN.md` 为准** —— 那是"为什么"的权威来源，它每条都写了代价与
> 「什么条件下该重新审视」；本文件保留的是**执行步骤与实测原始数据**。
>
> 已实现的小节里，代码块可能仍是当初的草稿（实测发现过错处）。**标了「已实现」的以源码为准。**

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 从零建立 `jev-life` 仓库，交付「能无头打完一整局 Jev vs Jev」的规则引擎与决策管线，再到本地 localhost 的可视对局。

**Architecture:** 三层——`core/`（无 DOM、无网络，Node 可直接跑）、`client/`（浏览器 UI）、`server/`（静态托管 + 密钥代理）。`core/` 是本项目相对 `jev-2048` 的关键结构改动：2048 的 `buildState`（`main.ts:388-419`）与 `buildQuestions`（`main.ts:421-445`）住在 `main.ts` 且**直接读 DOM**（`main.ts:416`），导致无头环境跑不起来。

> ⚠ **引用 `main.ts` 时优先用函数名，别用行号。** 该文件迭代频繁——本计划基于 `a63309c` 写成，到 `9582bcf` 时它已漂移 13–31 行（实测：`buildState` 388–419、`buildQuestions` 421–445、`boot` 2045–2098、`$()` 139、`assertDom` 143、`DRAWERS` 1112、`showOverlay` 524、`pushLog` 726、`relanguage` 2013）。其余被引用的文件（`render.ts` / `decision.ts` / `types.ts` / `engine.ts` / `metrics.ts`）在同期没动过，行号仍然准。

**Tech Stack:** TypeScript 5.9（`strict`）、Node ≥ 22（type-stripping 直接跑 `tools/*.ts`）、无打包器（浏览器原生 ESM）、无运行时依赖、`node:test` + `node:assert/strict`。

**源仓库（复刻来源）:** `../jev-2048`（与本仓库同级的目录）
**新仓库:** `jev-life`（本仓库根目录）

---

## 开工前必读

**本计划与源仓库共享的约定**（照搬，不重新发明）：

- 所有命令写全 `node node_modules/typescript/bin/tsc`，**不用 `npx`/`tsc`** —— Termux 下 npm/npx 的 shebang 指向不存在的 `/usr/bin/env`
- 源码文件全小写无分隔符（`life.ts`）；`tools/` 用 kebab-case（`check-dom.ts`）
- 测试放 `src/test/<模块>.test.ts`
- 相对 import 必须带 `.js` 后缀（NodeNext 要求，浏览器原生 ESM 也要求）
- 注释解释**为什么**，不解释是什么
- 提交信息：Conventional Commits，**中文正文**，末尾附 `Co-Authored-By: Claude <noreply@anthropic.com>`

**每一步的收尾动作**：跑该步给出的验证命令 → `git add` → `git commit`。

---

## ⚠ 写计划时发现的一个问题：位并行可能比朴素实现更慢

已批准的设计计划里写了「`lifeStep` 用位并行算法」。我在写具体代码时意识到**这条的性能论据站不住**，必须修正：

- JS 的 `BigInt` 运算比整数运算慢一到两个数量级
- 棋盘最大 16×16 = 256 格。朴素实现每步约 `256 × 8 = 2048` 次整数运算；位并行每步约 `16 行 × (打包 16 + 约 10 次 BigInt 运算 + 解包 16) ≈ 700` 次 **BigInt** 运算
- **在 M1 的棋盘尺寸下，位并行大概率更慢**，不是更快

位并行真正的价值有两条，都与性能无关：**`torus` 的环绕就是一次循环移位**（朴素实现要为每个边界格子写分支），以及**为将来放大棋盘留的路**。

**处理方式（本计划的 T6）**：两个实现都写、都用差分测试锁死正确性，然后**跑基准测试，由数据决定 `lifeStep` 用哪个**，并把实测结果写进 `DESIGN.md`。这恰好是源仓库那条方法论——*用数据取代估算*——我上一轮在 noul 成本上就犯过按比例外推的错。

---

## T1 · 建仓与 TypeScript 工具链

**Files:**
- Create: `jev-life/package.json`
- Create: `jev-life/tsconfig.base.json`、`tsconfig.client.json`、`tsconfig.server.json`、`tsconfig.api.json`、`tsconfig.test.json`
- Create: `jev-life/.gitignore`
- Create: `jev-life/LICENSE`
- Create: `jev-life/src/core/placeholder.ts`（仅为让 tsc 有输入，T3 会删）

**Step 1: 建目录并初始化 git**

```bash
cd ~/projects/Jev                                     # 换成你自己的项目根目录
mkdir -p jev-life/src/{core,client,server,shared,test} jev-life/{tools,api,public}
cd jev-life && git init -b main
```

**Step 2: 写 `.gitignore`**（照搬 `jev-2048/.gitignore`，密钥路径改成本项目）

```gitignore
# 依赖
node_modules/

# 编译产物（由 ./start.sh 生成，不入库）
dist/
dist-test/
public/js/

# 密钥 —— 绝不能进仓库
../local/
local/
*.key
*.sealed
*-secret-api-key*

# git 自身的目录 —— 绝不能被提交
# 真实教训（来自 jev-2048）：.git.backup 曾不在忽略列表里，一次 git add -A
# 把整个旧 .git 提交了进去。里面的对象是 zlib 压缩的，明文正则扫描**抓不到**，
# 但任何人解压就能还原出密钥。
.git/
.git.backup/
.git*/
*.pack
*.idx

# 本地验证时的克隆残留
clone-check/
*-check/

# 编辑器 / 系统
.DS_Store
.vscode/
.idea/
*.log
```

**Step 3: 写五份 tsconfig**

`tsconfig.base.json` —— 逐字照搬 `jev-2048/tsconfig.base.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "exactOptionalPropertyTypes": false,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "declaration": false,
    "sourceMap": true,
    "removeComments": false
  }
}
```

`tsconfig.client.json`：

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": [],
    "rootDir": "src",
    "outDir": "public/js"
  },
  "include": ["src/client/**/*.ts", "src/shared/**/*.ts", "src/core/**/*.ts"]
}
```

`tsconfig.server.json`：

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/server/**/*.ts", "src/shared/**/*.ts"]
}
```

`tsconfig.api.json`：

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "noEmit": true
  },
  "include": ["api/**/*.ts"]
}
```

`tsconfig.test.json` —— **注意这里修掉了 `jev-2048` 的一处债**：源仓库用白名单逐个点名被测文件（`tsconfig.test.json:13-21`），结果是 `decision.ts` 这个「最值得动手改的地方」从未被编译过、零测试覆盖。这里改成**目录级 include**：

```json
{
  "extends": "./tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist-test",
    "sourceMap": false
  },
  "include": ["src/test/**/*.ts", "src/core/**/*.ts", "src/shared/**/*.ts", "src/server/seal.ts"]
}
```

**Step 4: 写 `package.json`**

```json
{
  "name": "jev-life",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "用 Jev 决策模型作为「生命棋」（康威生命游戏 + 回合制干预）的实验台。Jev 不生成文本，它接收 state 和带类型的 questions，返回带校准概率的结构化决策。",
  "license": "MIT",
  "author": "ARCJ137442",
  "repository": { "type": "git", "url": "git+https://github.com/ARCJ137442/jev-life.git" },
  "homepage": "https://jev-life.vercel.app",
  "bugs": { "url": "https://github.com/ARCJ137442/jev-life/issues" },
  "keywords": ["jev", "systemone", "decision-model", "game-of-life", "conway", "life-chess", "typescript"],
  "scripts": {
    "build": "node node_modules/typescript/bin/tsc -p tsconfig.client.json && node node_modules/typescript/bin/tsc -p tsconfig.server.json",
    "build:client": "node node_modules/typescript/bin/tsc -p tsconfig.client.json",
    "build:server": "node node_modules/typescript/bin/tsc -p tsconfig.server.json",
    "build:test": "node node_modules/typescript/bin/tsc -p tsconfig.test.json",
    "test": "node node_modules/typescript/bin/tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js",
    "typecheck": "node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit && node node_modules/typescript/bin/tsc -p tsconfig.api.json --noEmit",
    "start": "node dist/server/server.js"
  },
  "devDependencies": { "@types/node": "^22.20.4", "typescript": "^5.9.3" },
  "engines": { "node": ">=22" }
}
```

与源仓库的三处**刻意不同**，理由分别是：
- `engines.node` 写 `>=22` 而非 `>=20` —— 源仓库声明 `>=20`，但 `node tools/*.ts` 依赖 Node 22 的 type-stripping，声明与实际不符
- 补 `author` —— 源仓库没有，署名只在 LICENSE 里
- `keywords` 去掉 `typesafe` —— 源仓库 `6454685` 做了「去掉 TypeSafe 绑定」的品牌收窄，但 `package.json` 是唯一漏改的对外字段

**Step 5: 写 `LICENSE`** —— 照搬 MIT，改署名为本项目（`Copyright (c) 2026 ARCJ137442`）

**Step 6: 装依赖**

```bash
cd ~/projects/Jev/jev-life
node $(command -v npm) install
```

**Step 7: 验证**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.base.json --showConfig > /dev/null && echo "base OK"
node --version   # 期望 v22 以上
```

**Step 8: Commit**

```bash
git add -A
git commit -m "chore: 初始化 jev-life 仓库与 TypeScript 工具链

工具链照搬 jev-2048，三处刻意修正：
- engines.node 写 >=22：源仓库声明 >=20，但 node tools/*.ts
  依赖 Node 22 的 type-stripping，声明与实际不符
- 补 author 字段：源仓库署名只在 LICENSE 里
- keywords 去掉 typesafe：源仓库 6454685 做了品牌收窄，
  package.json 是唯一漏改的对外字段

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## T2 · 构建期检查工具与单一入口

**Files:**
- Create: `jev-life/tools/scan-secrets.ts`（照搬）
- Create: `jev-life/tools/seal-key.ts`（照搬）
- Create: `jev-life/tools/check-dom.ts`（**改造：递归 + 双向**）
- Create: `jev-life/tools/scan.ts`（新增：core 分层检查）
- Create: `jev-life/start.sh`
- Create: `jev-life/public/index.html`（**临时占位**，T14 替换）
- Create: `jev-life/src/server/server.ts`（**临时占位**，T12 替换）
- Create: `jev-life/api/placeholder.ts`（**临时占位**，T12 删除）
- Create: `jev-life/src/test/smoke.test.ts`（工具链冒烟测试）

> **第四个占位是冒烟测试**，理由同上但更隐蔽：`start.sh` 里有 `node --test dist-test/test/*.test.js`，
> 而 T2 时 `dist-test/test/` 是空的 —— bash 会把没有匹配的 glob 原样传给 node，报错退出。
> 放一个真正断言工具链的冒烟测试（比如「Node 版本 ≥ 22」），既让管道绿，它本身也是有意义的检查。

> **为什么要三个占位文件**：`start.sh` 从 T2 起就要能整条跑通，但它的后半段依赖还不存在的东西——
> `tsc -p tsconfig.server.json` 在 `src/server/` 为空时报 `TS18003: No inputs were found`；
> `node dist/server/server.js` 需要有可执行的东西；
> `check-dom.ts` 要读 `public/index.html`；
> `npm run typecheck` 里的 `tsconfig.api.json` 同样会因 `api/` 为空而报 TS18003。
>
> 这三个占位是**为了让管道从 T2 起就是绿的**。占位内容应当最小且诚实（顶部注释写明「T12/T14 会替换」），不要顺手把真实现写进去——那是 T12/T14 的事。

**Step 1: 照搬两个安全工具**

```bash
cp ../jev-2048/tools/scan-secrets.ts tools/
cp ../jev-2048/tools/seal-key.ts tools/
```

**改动点**：`seal-key.ts` 若引用了 `../src/server/seal.js`，本项目 seal.ts 稍后才建（T12），所以**先注释掉 T12 之前的调用或先放一个空的 seal.ts**。最省事的做法是在 T12 之前不跑 `seal-key.ts`，只把它放进仓库。

`scan-secrets.ts` **逐字不改** —— 它承载了源仓库最重要的一次事故复盘（三次漏检：`grep -I` 跳二进制、白名单正则带 `g` 有状态、zlib 压缩层），注释本身就是文档，改一个字都是损失。

**Step 2: 改造 `check-dom.ts` —— 递归 + 双向**

照搬 `jev-2048/tools/check-dom.ts`，改三处：

1. **`CLIENT_DIR` 改递归**：源仓库用 `readdirSync(CLIENT_DIR)`（非递归，`check-dom.ts:77`），本项目 `src/client/` 下会有子目录
2. **加反向检查**：HTML 里定义了但 TS 从未引用的 id —— 源仓库不查，导致孤儿元素长期潜伏
3. **路径常量**改成从 `import.meta.url` 推导，不硬编码

新增的反向检查输出为 **warning 而非 error**（有些 id 是纯 CSS 钩子），但打印出来：

```ts
const unused = [...htmlIds].filter((id) => !referenced.has(id)).sort();
if (unused.length) {
  console.log(`\n  ⚠ HTML 里有 ${unused.length} 个 id 没有任何 TS 引用（可能已废弃）：`);
  for (const id of unused) console.log(`      #${id}`);
}
```

**Step 3: 新增 `tools/scan.ts` —— 强制 `core/` 不得 import `client/`**

这是本项目新增的结构纪律，也是「跑分能不能在无头环境跑」的机器保证：

```ts
/**
 * 构建期检查：core/ 不得 import client/。
 *
 * 为什么需要它：
 * 跑分工具（tools/bench-step.ts）要在 Node 里跑同一个 core/。一旦 core/ 里的
 * 某个模块（哪怕间接）import 了 i18n 或 render，无头环境立刻崩 —— 而且崩在
 * 运行时，离真正的原因很远。
 *
 * jev-2048 有先例：src/shared/types.ts:34-36 的注释写着「本模块被 client 与
 * server 共用，引 i18n 会把分层搞反」—— 那条纪律当时只写在注释里，没人守。
 */
```

实现：从 `src/core/entry`（或扫描 `src/core/*.ts` 全部）出发做**传递闭包**，任何路径落到 `src/client/` 即报错并打印完整 import 链。

**Step 4: 写 `start.sh`**（T13 之前先注释掉还不存在的步骤）

```bash
#!/bin/sh
#
# 编译并启动 生命棋 × Jev。
#
# 不依赖 npm —— Termux 下 npm/npx 的 shebang 指向不存在的 /usr/bin/env，
# 直接调用会失败，所以这里用 node 执行 tsc 的 JS 入口绕开它。
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
```

**Step 5: 验证**

```bash
chmod +x start.sh
node tools/scan-secrets.ts && echo "密钥扫描 OK"
node tools/scan.ts && echo "分层检查 OK"
```

**Step 6: Commit**

```bash
git add -A
git commit -m "feat(tools): 构建期检查工具 + 单一启动入口

check-dom.ts 相对 jev-2048 两处加固：
- 递归子目录（源仓库用非递归 readdirSync，目录一深就漏扫）
- 加反向检查，报出 HTML 里有定义但 TS 从未引用的孤儿 id

新增 tools/scan.ts 强制 core/ 不得 import client/。这条纪律在
jev-2048 里只以注释形式存在（shared/types.ts:34-36），没人守；
本项目的跑分工具依赖它，所以做成构建期硬检查。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## T3 · 核心类型与棋盘基础操作

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/life.ts`
- Test: `src/test/life.test.ts`
- Delete: `src/core/placeholder.ts`

**Step 1: 写 `src/core/types.ts`**

```ts
/**
 * 生命棋的核心类型。
 *
 * 与 jev-2048 的一处关键差异：**棋盘尺寸不在模块级可变状态里**。
 * 2048 的 COLS/ROWS 是 ESM live binding（types.ts:17-21），好处是不用
 * 到处传宽高，代价是每个测试用例开头都要 setBoardSize(4,4) 复位，
 * 且「读到的值可能是刚才被别人改过的」这件事永远无法从代码上看出来。
 * 这里把宽高放进 Board 对象，不可变，没有全局状态。
 */

/** 边界语义 */
export type Topology = "bounded" | "torus";

/** 对局角色。短名直接用 Life / Death —— 长名 Keeper of Life 见 TERMS.md */
export type Role = "life" | "death";

/** 格子的一维索引：r * cols + c */
export type Cell = number;

export interface Board {
  readonly cols: number;
  readonly rows: number;
  /** 长度 cols*rows，取值 0 或 1 */
  readonly cells: Uint8Array;
}

/**
 * 最小棋盘尺寸。
 *
 * 下限取 4 而不是 1，因为环绕拓扑下退化尺寸的语义会变得诡异：
 * rows=2 时 r-1 与 r+1 是同一行，邻居被重复计数。与其在算法里特殊处理，
 * 不如从规则上排除。
 */
export const MIN_SIZE = 4;

/** 尺寸上限。8×8 是设计文档的推荐值；放大到 16×16 时全量 noul 会变成 256 个问题。 */
export const MAX_SIZE = 16;

export { MAX_SIZE as MAX_BOARD, MIN_SIZE as MIN_BOARD };
```

**Step 2: 写失败测试 `src/test/life.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  boardFromRows, cellAt, isAlive, flip, aliveCount, toRows,
} from "../core/life.js";

test("boardFromRows 按 . 与 # 构造棋盘", () => {
  const b = boardFromRows(["..", ".#"]);
  assert.equal(b.cols, 2);
  assert.equal(b.rows, 2);
  assert.equal(b.cells.length, 4);
  assert.equal(isAlive(b, 3), true);   // 第二行第二列
  assert.equal(isAlive(b, 0), false);
});

test("flip 是纯函数，不改动传入的 Board", () => {
  const b = boardFromRows([".#", ".."]);
  const before = Array.from(b.cells);
  const next = flip(b, 0);
  assert.equal(isAlive(next, 0), true);
  assert.deepEqual(Array.from(b.cells), before, "flip 修改了入参");
});

test("flip 两次回到原状", () => {
  const b = boardFromRows([".#", ".."]);
  assert.deepEqual(Array.from(flip(flip(b, 1), 1).cells), Array.from(b.cells));
});

test("aliveCount 数出活细胞数", () => {
  assert.equal(aliveCount(boardFromRows([".#", "##"])), 3);
});

test("toRows 与 boardFromRows 互逆", () => {
  const rows = [".#.", "#.#", "..."];
  assert.deepEqual(toRows(boardFromRows(rows)), rows);
});

test("cellAt 拒绝越界索引", () => {
  const b = boardFromRows(["..", ".."]);
  assert.throws(() => cellAt(b, 4), /越界/);
  assert.throws(() => cellAt(b, -1), /越界/);
});
```

**Step 3: 跑测试确认失败**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.test.json 2>&1 | head -20
```
期望：编译失败，提示 `../core/life.js` 找不到。

**Step 4: 写最小实现 `src/core/life.ts`**

```ts
import type { Board, Cell, Role } from "./types.js";
import { MIN_SIZE, MAX_SIZE } from "./types.js";

/**
 * 引擎纯度是硬约束 —— 与 jev-2048 的第一条红线同源。
 *
 * 那边的教训是：validMoves() 的实现是「对每个方向试着走一步，看是否移动」，
 * 一旦 moveTiles 有副作用，每次询问合法方向都会真把棋盘搅乱一次，
 * 症状是「方块跑到别的列」「动画走对角线」，而根因在引擎不在渲染。
 *
 * 这边同理：legalCells() 会被 UI 频繁调用（高亮可选格），
 * 一旦 flip 有副作用，每次高亮都会改棋盘。
 */

export function assertSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new Error(`棋盘尺寸必须是整数，收到 ${cols}×${rows}`);
  }
  if (cols < MIN_SIZE || rows < MIN_SIZE || cols > MAX_SIZE || rows > MAX_SIZE) {
    throw new Error(`棋盘尺寸须在 ${MIN_SIZE}–${MAX_SIZE} 之间，收到 ${cols}×${rows}`);
  }
}

export function createBoard(cols: number, rows: number): Board {
  assertSize(cols, rows);
  return { cols, rows, cells: new Uint8Array(cols * rows) };
}

/** 用字符串行构造棋盘，'.' = 死，'#' 或 'X' = 活。测试与开局定义用 */
export function boardFromRows(rows: string[]): Board {
  const r = rows.length;
  const c = rows[0]?.length ?? 0;
  assertSize(c, r);
  const cells = new Uint8Array(c * r);
  for (let i = 0; i < r; i++) {
    if (rows[i].length !== c) throw new Error(`第 ${i} 行长度不一致`);
    for (let j = 0; j < c; j++) {
      const ch = rows[i][j];
      if (ch === "#" || ch === "X" || ch === "o") cells[i * c + j] = 1;
    }
  }
  return { cols: c, rows: r, cells };
}

export function toRows(b: Board): string[] {
  const out: string[] = [];
  for (let r = 0; r < b.rows; r++) {
    let line = "";
    for (let c = 0; c < b.cols; c++) line += b.cells[r * b.cols + c] ? "#" : ".";
    out.push(line);
  }
  return out;
}

export function cellAt(b: Board, cell: Cell): Cell {
  if (!Number.isInteger(cell) || cell < 0 || cell >= b.cells.length) {
    throw new Error(`格子索引越界：${cell}（棋盘 ${b.cols}×${b.rows}）`);
  }
  return cell;
}

export function isAlive(b: Board, cell: Cell): boolean {
  return b.cells[cellAt(b, cell)] === 1;
}

export function aliveCount(b: Board): number {
  let n = 0;
  for (let i = 0; i < b.cells.length; i++) n += b.cells[i];
  return n;
}

/** 返回新 Board，绝不改动入参 */
export function flip(b: Board, cell: Cell): Board {
  cellAt(b, cell);
  const cells = Uint8Array.from(b.cells);
  cells[cell] = cells[cell] ? 0 : 1;
  return { cols: b.cols, rows: b.rows, cells };
}

export function sameBoard(a: Board, b: Board): boolean {
  return a.cols === b.cols && a.rows === b.rows && a.cells.every((v, i) => v === b.cells[i]);
}

/**
 * 某角色当前可以翻的格子。
 *
 * 生之执只能把死格子变活，死之执只能把活格子变死 —— 两个集合**天然互斥**。
 * 这是「同时决策」成立的数学基础：两边各发一个请求、都基于演化前的棋盘，
 * 落子永远不会撞在同一格上，不需要任何冲突消解规则。
 */
export function legalCells(b: Board, role: Role): Cell[] {
  const want = role === "life" ? 0 : 1;
  const out: Cell[] = [];
  for (let i = 0; i < b.cells.length; i++) if (b.cells[i] === want) out.push(i);
  return out;
}
```

**Step 5: 跑测试确认通过**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js
```
期望：6 个用例全 PASS。

**Step 6: Commit**

```bash
git add -A
git commit -m "feat(core): 棋盘类型与基础操作

棋盘尺寸放进不可变的 Board 对象，不用 jev-2048 那种模块级可变的
COLS/ROWS live binding —— 那边的代价是每个测试用例开头都要复位，
且「读到的值可能刚被改过」无法从代码上看出来。

legalCells 返回两个天然互斥的集合（生执取死格、死执取活格），
这是「同时决策」成立的数学基础。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## T4 · 朴素演化 + 结构不变量测试

先写朴素实现，它同时是 T5 位并行的差分基准。**两个实现必须用不同思路写** —— 源仓库的做法与理由见 `engine.test.ts:60-61`：「避免同一个思维错误在两处同时出现」。

**Files:**
- Modify: `src/core/life.ts`（追加）
- Test: `src/test/life-step.test.ts`

**Step 1: 写失败测试 `src/test/life-step.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { boardFromRows, toRows, aliveCount } from "../core/life.js";
import { referenceStep } from "../core/life.js";

/* ═══ 经典结构的演化不变量 ═══
   这些不是「随便挑几个例子」—— 每个都有独立的数学事实背书，
   实现写错时它们会以不同方式失败，覆盖不同的错误模式。 */

test("方块（Block）是静物，任何拓扑下都不变", () => {
  // 4×4 棋盘，方块放左上：任何拓扑下都必须逐代不变
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  for (const topo of ["bounded", "torus"] as const) {
    assert.deepEqual(toRows(referenceStep(b, topo)), toRows(b), `topo=${topo}`);
  }
});

test("信号灯（Blinker）周期为 2", () => {
  const b = boardFromRows(["....", ".###", "....", "...."]);
  const once = referenceStep(b, "bounded");
  const twice = referenceStep(once, "bounded");
  assert.notDeepEqual(toRows(once), toRows(b), "第一代不应等于原状（否则根本没振荡）");
  assert.deepEqual(toRows(twice), toRows(b), "两代后应回到原状");
  assert.equal(aliveCount(once), 3, "振荡器细胞数守恒");
});

test("滑翔机（Glider）4 代后平移一格", () => {
  // 放在够大的棋盘中央，避免 bounded 下撞墙
  const b = boardFromRows([
    "........",
    "..#.....",
    "...#....",
    ".###....",
    "........",
    "........",
    "........",
    "........",
  ]);
  let cur = b;
  for (let i = 0; i < 4; i++) cur = referenceStep(cur, "bounded");
  assert.deepEqual(toRows(cur), [
    "........",
    "........",
    "...#....",
    "....#...",
    "..###...",
    "........",
    "........",
    "........",
  ]);
});

test("死棋盘保持死亡", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  for (const topo of ["bounded", "torus"] as const) {
    assert.equal(aliveCount(referenceStep(b, topo)), 0);
  }
});

/* ═══ 拓扑的边界行为 ═══
   这是 bounded 与 torus 唯一必须分道扬镳的地方。 */

test("bounded：贴边的信号灯退化成两格，再一代全灭", () => {
  // 无限棋盘上的信号灯是周期 2 的振荡器；但贴在边界上时，
  // 两端格子各只剩一个界内邻居，于是只活下中间那个。
  const b = boardFromRows(["###.", "....", "....", "...."]);
  const gen1 = referenceStep(b, "bounded");
  assert.deepEqual(toRows(gen1), [".#..", ".#..", "....", "...."]);
  const gen2 = referenceStep(gen1, "bounded");
  assert.deepEqual(toRows(gen2), ["....", "....", "....", "...."], "两格结构应当整体死亡");

  // 同样的输入在 torus 下不会退化 —— 行首行尾是相邻的
  const wrapped = referenceStep(b, "torus");
  assert.notDeepEqual(toRows(wrapped), toRows(gen1), "两种拓扑给出了相同结果，说明其中一种没处理边界");
});

test("bounded 与 torus 在同样输入下给出不同结果", () => {
  // 一条横穿全宽的行：bounded 下两端不成环，torus 下成环
  const b = boardFromRows(["####", "....", "....", "...."]);
  assert.notDeepEqual(
    toRows(referenceStep(b, "bounded")),
    toRows(referenceStep(b, "torus")),
    "两种拓扑对同一输入给出了相同结果 —— 说明其中一种没真正处理边界",
  );
});

test("torus：跨越左右接缝的方块仍是方块", () => {
  // 左右两列各一个竖对：bounded 下是两条互不相邻的竖格 → 一代全灭；
  // torus 下 (0,0) 与 (0,3) 相邻、(1,0) 与 (1,3) 相邻，四格构成真正的 2×2 方块。
  // 方块是静物，所以必须**连跑三代逐代不变** —— 这条同时锁住环绕方向
  // 与「静物在环绕下仍是静物」两件事。
  const b = boardFromRows(["#..#", "#..#", "....", "...."]);

  const bounded = referenceStep(b, "bounded");
  assert.equal(aliveCount(bounded), 0, "bounded 下这两条竖格互不相邻，应当全灭");

  let cur = b;
  for (let i = 0; i < 3; i++) {
    cur = referenceStep(cur, "torus");
    assert.deepEqual(toRows(cur), toRows(b), `torus 第 ${i + 1} 代：环绕后的方块应当是静物`);
  }
});

test("referenceStep 是纯函数", () => {
  const b = boardFromRows([".##.", ".###", "....", "...."]);
  const before = Array.from(b.cells);
  referenceStep(b, "bounded");
  referenceStep(b, "torus");
  assert.deepEqual(Array.from(b.cells), before, "referenceStep 修改了入参");
});
```

> **注意**：上面第一条 `bounded 角落` 测试我写得不干净（有一句没意义的断言）。写代码时把它清理成一条明确的不变量，例如：`bounded` 下 `["###.", ...]` 的演化结果应等于把同一图案放在 4×4 棋盘中央时去掉边缘效应的结果。**别照抄我这段草稿，写清楚你要断言什么。**

**Step 2: 跑测试确认失败**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.test.json 2>&1 | head -5
```
期望：`referenceStep` 未导出。

**Step 3: 写 `referenceStep`（追加到 `src/core/life.ts`）**

```ts
import type { Topology } from "./types.js";

/**
 * B3/S23 的朴素参照实现 —— **只用于测试**。
 *
 * 刻意写成与 lifeStep 完全不同的思路（逐格双层循环 + 显式边界分支），
 * 这样两个实现不会共享同一个思维错误。jev-2048 的差分测试用的就是
 * 这个手法（engine.test.ts:60-100），理由写在那里的注释里：
 * 「避免同一个思维错误在两处同时出现」。
 *
 * 规则（B3/S23）：
 *   死细胞周围恰好 3 个活细胞 → 诞生
 *   活细胞周围 2 或 3 个活细胞 → 存活
 *   其余 → 死亡
 */
export function referenceStep(b: Board, topo: Topology): Board {
  const { cols, rows, cells } = b;
  const next = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          let rr = r + dr;
          let cc = c + dc;
          if (topo === "torus") {
            rr = (rr + rows) % rows;
            cc = (cc + cols) % cols;
          } else if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) {
            continue;   // bounded：界外视为死
          }
          n += cells[rr * cols + cc];
        }
      }
      const alive = cells[r * cols + c];
      next[r * cols + c] = alive ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
    }
  }
  return { cols, rows, cells: next };
}
```

**Step 4: 跑测试确认通过**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js
```

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): B3/S23 朴素参照实现

刻意用与后续生产实现完全不同的思路（逐格双层循环 + 显式边界分支），
作为差分测试的独立基准 —— 两个实现不共享同一个思维错误。

测试覆盖经典结构的演化不变量（方块不变、信号灯周期 2、滑翔机
4 代平移一格），这些有独立数学事实背书，实现写错时会以不同方式失败。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## T5 · 位并行实现 + 差分测试

**Files:**
- Modify: `src/core/life.ts`（追加 `lifeStep`）
- Test: `src/test/life-diff.test.ts`

**Step 1: 写差分测试 `src/test/life-diff.test.ts`**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { referenceStep, lifeStep, toRows } from "../core/life.js";
import type { Board, Topology } from "../core/types.js";

/** mulberry32 —— 小而确定的 PRNG，失败时能凭 seed 复现 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBoard(cols: number, rows: number, p: number, rand: () => number): Board {
  const cells = new Uint8Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = rand() < p ? 1 : 0;
  return { cols, rows, cells };
}

test("lifeStep 与 referenceStep 在所有尺寸 × 两种拓扑 × 多种密度下一致", () => {
  const topologies: Topology[] = ["bounded", "torus"];
  let checked = 0;

  for (const [cols, rows] of [[4, 4], [5, 7], [6, 6], [8, 8], [8, 12], [13, 5], [16, 16]] as const) {
    for (const topo of topologies) {
      for (const p of [0.05, 0.2, 0.35, 0.5, 0.8]) {
        const rand = rng(cols * 1000 + rows * 10 + Math.round(p * 100));
        for (let trial = 0; trial < 30; trial++) {
          const b = randomBoard(cols, rows, p, rand);
          const got = toRows(lifeStep(b, topo));
          const want = toRows(referenceStep(b, topo));
          checked++;
          assert.deepEqual(
            got, want,
            `不一致：${cols}×${rows} topo=${topo} p=${p}\n` +
            `输入：\n${toRows(b).join("\n")}\n` +
            `lifeStep：\n${got.join("\n")}\n` +
            `reference：\n${want.join("\n")}`,
          );
        }
      }
    }
  }

  // 防止用例被悄悄改空 —— 源仓库的差分测试也做了同样的下限断言
  assert.ok(checked >= 2000, `比对次数过少：${checked}`);
});

test("lifeStep 是纯函数，不改动入参", () => {
  const b = randomBoard(8, 8, 0.3, rng(1));
  const before = Array.from(b.cells);
  lifeStep(b, "bounded");
  lifeStep(b, "torus");
  assert.deepEqual(Array.from(b.cells), before, "lifeStep 修改了入参");
});

test("连续 5 次 lifeStep 结果稳定（无隐藏状态）", () => {
  const b = randomBoard(6, 6, 0.3, rng(7));
  const first = toRows(lifeStep(b, "torus"));
  for (let i = 0; i < 4; i++) assert.deepEqual(toRows(lifeStep(b, "torus")), first);
});
```

**Step 2: 跑测试确认失败**（`lifeStep` 未导出）

**Step 3: 写 `lifeStep`（追加到 `src/core/life.ts`）**

```ts
/**
 * 位并行的 B3/S23（每格占 4 bit，整行打包进一个 BigInt）。
 *
 * 为什么是 4 bit：一个格子最多有 8 个活邻居，8 = 0b1000 需要 4 位才放得下，
 * 这样 8 个邻居直接**相加**就不会进位串到隔壁格子。
 *
 * 为什么选位并行：《生命棋》的棋盘尺寸可变，而 torus 拓扑的水平环绕
 * 在位表示下就是一次循环移位；朴素实现则要为每个边界格子写分支。
 * （性能上它在这个棋盘尺寸下未必更快 —— 见 T6 的基准测试，由数据说话。）
 */
export function lifeStep(b: Board, topo: Topology): Board {
  const { cols, rows, cells } = b;
  const width = BigInt(4 * cols);
  const FRAME = (1n << width) - 1n;

  // 每个 nibble 的四个位平面掩码
  let m0 = 0n, m1 = 0n, m2 = 0n, m3 = 0n;
  for (let c = 0; c < cols; c++) {
    const s = BigInt(4 * c);
    m0 |= 1n << s;
    m1 |= 1n << (s + 1n);
    m2 |= 1n << (s + 2n);
    m3 |= 1n << (s + 3n);
  }

  const packed: bigint[] = [];
  for (let r = 0; r < rows; r++) {
    let x = 0n;
    const base = r * cols;
    for (let c = 0; c < cols; c++) if (cells[base + c]) x |= 1n << BigInt(4 * c);
    packed.push(x);
  }

  const wrap = BigInt(4 * (cols - 1));
  const rollL = (x: bigint): bigint => {
    const top = (x >> wrap) & 0xfn;
    return ((x << 4n) | top) & FRAME;
  };
  const rollR = (x: bigint): bigint => {
    const bot = x & 0xfn;
    return (x >> 4n) | (bot << wrap);
  };
  const shlL = (x: bigint): bigint => (topo === "torus" ? rollL(x) : (x << 4n) & FRAME);
  const shlR = (x: bigint): bigint => (topo === "torus" ? rollR(x) : x >> 4n);

  const rowAt = (r: number): bigint => {
    if (r < 0 || r >= rows) return topo === "torus" ? packed[(r + rows) % rows] : 0n;
    return packed[r];
  };

  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const mid = packed[r];
    const up = rowAt(r - 1);
    const dn = rowAt(r + 1);

    // 8 个邻居相加。每个 nibble 的值落在 0..8，不会进位到相邻 nibble。
    const sum = shlL(up) + up + shlR(up) + shlL(mid) + shlR(mid) + shlL(dn) + dn + shlR(dn);

    // 把四个位平面全部对齐到 nibble 的最低位（4c），才能做逐格的条件判断
    const b0 = sum & m0;
    const b1 = (sum & m1) >> 1n;
    const b2 = (sum & m2) >> 2n;
    const b3 = (sum & m3) >> 3n;

    const alive = mid & m0;
    const zero = (x: bigint): bigint => m0 ^ x;   // 在 m0 掩码内取反

    // 恰好 3 个邻居：0011
    const n3 = b0 & b1 & zero(b2) & zero(b3);
    // 恰好 2 个邻居：0010
    const n2 = b1 & zero(b0) & zero(b2) & zero(b3);

    // 活细胞存活（2 或 3），死细胞诞生（恰好 3）
    const next = (alive & (n2 | n3)) | (zero(alive) & n3);

    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      if ((next >> BigInt(4 * c)) & 1n) out[base + c] = 1;
    }
  }

  return { cols, rows, cells: out };
}
```

**Step 4: 跑测试**

```bash
node node_modules/typescript/bin/tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js
```

**如果差分测试挂了**：不要改 `referenceStep` 去迁就 `lifeStep`。`referenceStep` 是基准，先确认它自己是对的（T4 的经典结构测试应该已经证明了），再查位并行。断言消息里带了完整输入/输出棋盘，可以直接粘贴成新的回归用例。

**Step 5: Commit**

```bash
git add -A
git commit -m "feat(core): 位并行的 B3/S23 实现 + 差分测试

每格占 4 bit 打包进 BigInt：8 个邻居直接相加不会进位串格。
torus 的水平环绕在位表示下就是一次循环移位。

差分测试覆盖 7 种尺寸 × 2 种拓扑 × 5 种密度 × 30 次随机，
共 2100 组比对。断言消息带完整输入/输出棋盘，失败可直接复现。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## T6 · 基准测试：由数据决定 `lifeStep` 用哪个实现

**Files:**
- Create: `tools/bench-step.ts`
- Modify: `src/core/life.ts`（按结果决定导出哪个）

**Step 1: 写基准脚本**

`tools/bench-step.ts` —— 对 `referenceStep` 与 `lifeStep` 在每个预设尺寸上各跑 N 步，报告耗时。用 `node:perf_hooks` 的 `performance.now()`。

要求：
- 每个尺寸跑足够步数（建议 ≥ 2000 步），并**丢弃前 100 步**（JIT 预热）
- 输出表格：尺寸 / 拓扑 / 朴素 µs/步 / 位并行 µs/步 / 倍数
- 退出码恒为 0（这是诊断工具不是门禁）

**Step 2: 跑**

```bash
node tools/bench-step.ts
```

**Step 3: 按结果决定并记录**

- 若位并行在 **8×8 及以上**更快 → 保持现状
- 若朴素更快 → 把导出的 `lifeStep` 改成朴素实现，位并行改名 `bitwiseStep` 保留（差分测试反向比对，仍然锁死正确性）
- **无论哪种结果，把实测表格写进 `DESIGN.md`**，并写清「当时的依据是什么、什么条件下该重新审视」

**Step 4: Commit**

```bash
git add -A
git commit -m "perf(core): 基准测试两个演化实现，按实测选定 lifeStep

实测数据（填入）：<这里贴表格>

<选中/换掉>位并行的理由是数据而不是直觉。jev-2048 的
DESIGN.md 有一条元规则：每条决策都附当时的依据，依据变了
决策也该重新审视 —— 所以阈值与条件一并写进 DESIGN.md。

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## T7 · 状态哈希、合法格与终局判定

**Files:**
- Modify: `src/core/life.ts`、`src/core/types.ts`
- Test: `src/test/life-rules.test.ts`

> ⚠ **T7 已实现（`8e9d9d1`，49 个测试全绿）。下面的测试代码是草稿，实测有 4 处错误 —— 不要照抄，以 `src/test/life-rules.test.ts` 为准。**
>
> 1. `snap()` 少 `topology` 字段 —— `GameSnapshot` 里它是必填的，照抄连编译都过不去
> 2. 整套占比用例与「当前占比由 board 现算」的语义**自相矛盾**：夹具 `.##./.##./..../....` 的实际占比是 0.25，注释里却写着「最近一回合 0.7」
> 3. 「无棋可走但占比在两线之间 → 和局」**不可构造** —— 合法集为空 ⟺ 棋盘全死或全活 ⟺ 占比恰为 0 或 1，永远落在极值。该分支只能由 `repeatBlocked` 触达
> 4. 「按角色分别判定」的前提写反了 —— 2×2 方块的**四个角被敲掉后都会长回原局面**（L 三格缺的那格恰好 3 个邻居，实测四次全部 `≡ 原局面`），所以被 `repeatBlocked` 的是死之执而不是生之执
>
> **由此提炼一条一般规则：计划里已实现的小节，代码块应当换成指向实现的指针。** 留一份过期副本，下一个人照着复核时会再踩一遍 —— 这正是源仓库「检查工具自身的盲区最难发现」那个母题的新实例，只不过这次的「工具」是计划文档本身。

**Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFromRows, boardKey, classifyTermination, lifeStep, legalCells, flip } from "../core/life.js";
import type { Board, GameRules } from "../core/types.js";

/**
 * 胜负判定已从「累计净增长的绝对阈值」改为「生死比例的界限 + 防抖」。
 *
 * 为什么换：绝对格数换个棋盘尺寸就不可比 —— 设计文档的开局是 14 个活细胞，
 * 在 8×8（64 格）上是 21.9%，在 16×16（256 格）上只有 5.5%。逼得每个尺寸
 * 都要单独标定一整套阈值。比例天然跨尺寸可比，那个麻烦基本消失。
 *
 * 净增长没有消失 —— 它不再决定胜负，但仍然是跑分 CSV 里记录的一项统计。
 *
 * ⚠ 注意 21.9% 这个数：设计文档的开局离「20% 死之执获胜」只差 1.9 个百分点。
 *   具体阈值怎么定要等 T13 跑分出来才谈得上标定，现在这些值全部是占位。
 */
const rules: GameRules = {
  turnLimit: 90,
  lifeWinRatio: 0.6,      // 活细胞占比 ≥ 60% 且连续保持 lifeStreak 回合 → 生之执胜
  deathWinRatio: 0.05,    // ≤ 5% 且连续保持 deathStreak 回合 → 死之执胜
  lifeStreak: 3,          // 防抖：只越界一代不算赢
  deathStreak: 3,
};

/** 造快照；ratioHistory 从最早到最近排列 */
function snap(board: Board, turn: number, ratioHistory: number[]) {
  return { board, turn, ratioHistory };
}

// ⚠ 所有夹具都必须 ≥ MIN_SIZE(4)。T3 实测：计划初稿用了 2×2 棋盘，
//    结果每个用例都先撞在 assertSize 上，测的根本不是被测函数。

test("boardKey 对相同棋盘稳定，对不同棋盘不同", () => {
  const a = boardFromRows([".#..", "....", "....", "...."]);
  const b = boardFromRows([".#..", "....", "....", "...."]);
  const c = boardFromRows(["#...", "....", "....", "...."]);
  assert.equal(boardKey(a), boardKey(b));
  assert.notEqual(boardKey(a), boardKey(c));
});

test("boardKey 含尺寸，尺寸不同的棋盘不会撞 key", () => {
  // 4×4 全死 与 5×5 全死：cells 都是全 0，长度不同。
  // 若 key 只编码 cells 而不带尺寸，这两者会撞在一起。
  const four = boardFromRows(["....", "....", "....", "...."]);
  const five = boardFromRows([".....", ".....", ".....", ".....", "....."]);
  assert.notEqual(boardKey(four), boardKey(five), "4×4 与 5×5 的全死棋盘撞了 key —— key 没带尺寸");
});

/* ═══ 胜负线：比例 + 防抖 ═══
   防抖的用途是挡住「一代走运就赢」—— 生命游戏是混沌的，单代涨落很大。 */

test("单次越界不足以判赢 —— 防抖生效", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  // 最近一回合 0.7 ≥ 0.6，但只持续了 1 回合，lifeStreak 是 3
  assert.equal(classifyTermination(snap(b, 10, [0.3, 0.7]), "life", rules, new Set()), null);
});

test("连续越界达到 lifeStreak 回合，生之执获胜", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.3, 0.7, 0.7, 0.7]), "life", rules, new Set()),
    { reason: "lifeWinRatio", winner: "life" },
  );
});

test("连续被打断则重新计数", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  // 末尾是 0.7 0.7，只连续 2 回合
  assert.equal(
    classifyTermination(snap(b, 10, [0.7, 0.7, 0.3, 0.7, 0.7]), "life", rules, new Set()),
    null,
  );
});

test("死之执侧同理，且两侧阈值与防抖长度可以不同", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  // 0.03 ≤ deathWinRatio(0.05)
  assert.equal(
    classifyTermination(snap(b, 10, [0.3, 0.03, 0.03]), "death", rules, new Set()), null,
    "只连续 2 回合，防抖未满",
  );
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.3, 0.03, 0.03, 0.03]), "death", rules, new Set()),
    { reason: "deathWinRatio", winner: "death" },
  );
});

test("0.1 没有越死之执的界 —— 阈值是 0.05 不是 0.2", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  assert.equal(
    classifyTermination(snap(b, 10, [0.1, 0.1, 0.1, 0.1]), "death", rules, new Set()),
    null,
    "0.1 高于 0.05，不该被判越界（这条用例是阈值从 0.2 改到 0.05 时加的回归）",
  );
});

test("到回合上限仍未越界 → 和局", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0.25, 0.25]), "life", rules, new Set()),
    { reason: "turnLimit", winner: null },
  );
});

test("胜负线优先于回合上限 —— 同一回合两者都满足时判胜负", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  assert.deepEqual(
    classifyTermination(snap(b, 90, [0.7, 0.7, 0.7]), "life", rules, new Set()),
    { reason: "lifeWinRatio", winner: "life" },
    "两者同时满足时应判胜负，而不是和局",
  );
});

/* ═══ 走投无路 ═══
   注意这是两种不同的情况，不能合并：
   - noLegalCell：该角色的可翻集合本身就是空的（全死 → 死执无处可翻）
   - repeatBlocked：可翻集合非空，但每一格翻完演化一代都会落回见过的局面 */

test("棋盘全死时，死之执无格可翻 —— 此时按占比判死之执胜", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  // 占比 0 ≤ deathWinRatio，防抖未满本来不该判赢；
  // 但游戏因为「无棋可走」而终止，此时直接按占比定胜负（见下方的规则说明）
  assert.deepEqual(
    classifyTermination(snap(b, 5, [0]), "death", rules, new Set()),
    { reason: "noLegalCell", winner: "death" },
  );
});

test("棋盘全活时，生之执无格可翻 —— 此时按占比判生之执胜", () => {
  const b = boardFromRows(["####", "####", "####", "####"]);
  assert.deepEqual(
    classifyTermination(snap(b, 5, [1]), "life", rules, new Set()),
    { reason: "noLegalCell", winner: "life" },
  );
});

test("无棋可走但占比在两条线之间 → 和局", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  // 占比 0.4：既不到 0.6，也不低于 0.2
  assert.deepEqual(
    classifyTermination(snap(b, 5, [0.4]), "death", rules, new Set()),
    { reason: "noLegalCell", winner: null },
    "占比夹在两条线之间时不该硬判一个胜方",
  );
});

/*
 * repeatBlocked —— 设计文档漏掉的那条终局原因。
 *
 * 注意这条是**对判定规则本身的单元测试**，不是「构造了一个自然死局」。
 * 我推演过：4×4 角落放一个方块并不构成死局 —— 仍有落点能改变局面
 * （例如翻转紧邻方块的死格会让方块的角因邻居超载而死亡）。
 * 自然死局要靠 `seen` 积累到把所有后继都覆盖才出现，很难在测试里手工构造。
 *
 * 所以这里直接给定一个「已包含全部后继」的 seen，验证规则按预期裁决。
 */
/** 夹具：4×4，4 个活细胞 → 占比 0.25，夹在 0.2 与 0.6 之间 */
const STUCK_BOARD = () => boardFromRows([".##.", ".##.", "....", "...."]);

test("所有候选落点都会导致重复时，判 repeatBlocked（占比居中 → 和局）", () => {
  const b = STUCK_BOARD();
  const seen = new Set([boardKey(b)]);
  for (const cell of legalCells(b, "life")) {
    seen.add(boardKey(lifeStep(flip(b, cell), "bounded")));
  }
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.25]), "life", rules, seen),
    { reason: "repeatBlocked", winner: null },
  );
});

test("只要还有一个候选能产生新状态，就不该判 repeatBlocked", () => {
  const b = STUCK_BOARD();
  const all = legalCells(b, "life");
  assert.ok(all.length > 1, "这个夹具需要至少两个候选才有意义");
  // 只把「除第一个之外」的后继塞进 seen —— 第一个仍能产生新状态
  const seen = new Set([boardKey(b)]);
  for (const cell of all.slice(1)) {
    seen.add(boardKey(lifeStep(flip(b, cell), "bounded")));
  }
  assert.equal(classifyTermination(snap(b, 10, [0.25]), "life", rules, seen), null);
});

test("两个角色的合法集不同，repeatBlocked 必须按角色分别判定", () => {
  // 同一份 seen 下，一方可能走投无路而另一方还有路
  const b = STUCK_BOARD();
  const seenForLife = new Set([boardKey(b)]);
  for (const cell of legalCells(b, "life")) {
    seenForLife.add(boardKey(lifeStep(flip(b, cell), "bounded")));
  }
  // 死之执要翻活格，它的后继和生之执不同 —— 这份 seen 里没有它自己的后继，
  // 所以死之执不该被判 repeatBlocked
  const seenForDeath = new Set([boardKey(b)]);
  for (const cell of legalCells(b, "death")) {
    seenForDeath.add(boardKey(lifeStep(flip(b, cell), "bounded")));
  }
  assert.deepEqual(
    classifyTermination(snap(b, 10, [0.25]), "life", rules, seenForLife),
    { reason: "repeatBlocked", winner: null },
  );
  assert.equal(
    classifyTermination(snap(b, 10, [0.25]), "death", rules, seenForLife),
    null,
    "死之执自己的后继不在 seen 里，不该被判走投无路",
  );
});

test("终局判定不改动入参", () => {
  const b = STUCK_BOARD();
  const ratios = [0.25, 0.25];
  const before = Array.from(b.cells);
  classifyTermination(snap(b, 10, ratios), "life", rules, new Set());
  assert.deepEqual(Array.from(b.cells), before);
  assert.deepEqual(ratios, [0.25, 0.25], "ratioHistory 被改动了");
});
```

**Step 2-4: 实现**

`boardKey`：把 `cells` 打成 hex，**必须带尺寸**（否则 4×4 全死和 2×2 全死 会撞 key，而两者是不同的局面）。每 4 格一个 hex 字符：

```ts
export function boardKey(b: Board): string {
  let out = `${b.cols}x${b.rows}:`;
  for (let i = 0; i < b.cells.length; i += 4) {
    let nib = 0;
    for (let k = 0; k < 4 && i + k < b.cells.length; k++) nib |= b.cells[i + k] << k;
    out += nib.toString(16);
  }
  return out;
}
```

**类型定义**（放 `src/core/types.ts`）：

```ts
export interface GameRules {
  /** 回合上限。到上限仍未分出胜负 → 和局 */
  readonly turnLimit: number;
  /** 活细胞占比 ≥ 此值，且**连续**保持 lifeStreak 回合 → 生之执获胜 */
  readonly lifeWinRatio: number;
  /** ≤ 此值且连续保持 deathStreak 回合 → 死之执获胜 */
  readonly deathWinRatio: number;
  /** 防抖：连续越界多少回合才算赢。两侧分开，因为博弈本身不对称 */
  readonly lifeStreak: number;
  readonly deathStreak: number;
}

export type TerminationReason =
  | "lifeWinRatio"
  | "deathWinRatio"
  | "turnLimit"
  | "noLegalCell"    // 该角色的可翻集合本身就是空的
  | "repeatBlocked"; // 可翻集合非空，但每一格翻完都会落回见过的局面

export interface Termination {
  readonly reason: TerminationReason;
  readonly winner: Role | null;   // null = 和局
}

/** 终局判定需要的不只是当前棋盘 —— 防抖要用到占比历史 */
export interface GameSnapshot {
  readonly board: Board;
  readonly topology: Topology;   // ← 算后继状态要用（repeatedBlocked 检测）
  readonly turn: number;
  /**
   * **此前各回合**的活细胞占比，从最早到最近。
   * 刻意**不含当前局面** —— 当前占比由 `aliveCount(board) / (cols * rows)` 现算，
   * 单一来源。若把当前占比也塞进来，就有了两份可以互相矛盾的真相。
   */
  readonly ratioHistory: readonly number[];
}
```

**防抖的算法**：算 `trailingRun([...ratioHistory, 当前占比], pred)` —— 从末尾往前数连续满足条件的个数。当前这一代是刚刚演化完的，所以它必须参与计数，但通过现算而不是通过历史数组。

**`seen` 由调用方构造**，`classifyTermination` 只读它。函数内部要算「当前行动方的每个合法落点的后继是否都落在 `seen` 里」，因此**必须能拿到 topology**（这就是上面加那个字段的原因）。

`classifyTermination(snap, role, rules, seen): Termination | null`。

**判定顺序有讲究，必须固定并写进注释**：

1. **连续越界 ≥ 该侧 streak** → 判该方胜。放第一位，因为这是玩家主动争取的目标
2. **当前行动方无合法动作**（`noLegalCell` 或 `repeatBlocked`）→ **按当前占比定胜负**：≥ `lifeWinRatio` 判生执胜，≤ `deathWinRatio` 判死执胜，**夹在中间则和局**
3. **回合上限** → 和局

第 2 条那半句「按当前占比定胜负」是我替你定的，规则族里没写。理由：防抖的作用是**挡住一代走运就赢**，而游戏既然已经因为别的原因要结束了，再卡防抖只会出现「棋盘全活、生之执却因为只持续了一代而判和局」这种明显说不通的结果。不同意就改成一律和局。

`repeatBlocked` 的语义：**当前行动方没有任何一格能翻**。这是**对某一方**成立的——生执和死执的合法集不同，一方走投无路时另一方可能还有路。所以 `role` 参数必不可少，`seen` 也必须按角色分别构造。

注意 `noLegalCell` 与 `repeatBlocked` **不能合并**：前者是可翻集合本身为空（棋盘全死时死执无处可翻），后者是集合非空但全部会落回见过的局面。两者都可能独立发生。

**净增长去哪了**：它不再决定胜负，但**仍然是跑分 CSV 里记录的一项统计**。别把它从 `TurnRecord` 里删掉。

**Step 5: Commit**

---

## T8 · 结构检测库 `core/patterns.ts`

**Files:**
- Create: `src/core/patterns.ts`
- Test: `src/test/patterns.test.ts`

设计文档 11.2 节说得很准：「Jev 没有内置的结构检测器。如果你在 state 中直接告诉它『当前棋盘包含一个方块，位于 (3,1)-(4,2)』，它能利用这个信息。否则它需要自己『识别』——这超出它的能力范围。」

**Step 1: 定义真实结构，不照抄设计文档的清单**

设计文档列的「灯塔（Lighthouse）振荡器，8 细胞，周期 2」——**生命游戏的标准命名里没有 `lighthouse` 这个结构**。标准 p2 振荡器是 blinker(3) / toad(6) / beacon(6) / clock(6)。以真实结构为准。

```ts
export type PatternKind = "still" | "oscillator" | "spaceship" | "gun" | "eater";

export interface PatternDef {
  readonly name: string;
  readonly kind: PatternKind;
  /** 以左上角为原点的相对坐标 */
  readonly cells: ReadonlyArray<readonly [number, number]>;
  /** 振荡周期；静物为 1，非周期结构省略 */
  readonly period?: number;
}

export const PATTERNS: readonly PatternDef[] = [ /* ... */ ];
```

**预设棋盘一律是正方形、边长取 2 的幂**，所以候选尺寸只有 **4 / 8 / 16** 三档（引擎本身仍支持矩形，那是 K 线级的通用性，不冲突）。**开局图案离边缘至少留 2 格**，除非有特殊理由——理由是切身的：贴边的信号灯会退化成两格然后整体死亡（T4 有一条测试专门锁这个），边缘效应会污染掉「这个结构本来怎么演化」这件事。

结构库因此按尺寸分档：

| 边长 | 可用内部区 | 收录 | 说明 |
|---|---|---|---|
| 4 | 0×0 | 仅 `block`(2×2) / `blinker`(3×1) | **达不到 2 格边距，属特殊状况**。仅作退化演示，界面上必须标注「实验性」 |
| 8 | 4×4 | + `glider`(3×3) `beehive`(4×3) `loaf`(4×4) `toad`(4×2) `beacon`(4×4) `eater1`(4×4) | 内部区恰好 4×4，这是设计文档的基准尺寸 |
| 16 | 12×12 | + `lwss`(5×4) `pulsar`(13×13) | pulsar 是唯一例外：13 > 12，只能给 1 格边距 |

`gosperGliderGun` **不收录** —— 36 格宽，`MAX_SIZE` 是 16，放不进去；即便提到 40 也要面对「全量 noul 变成 1600 个问题」，需要单独论证。

`detectPatterns(b)` 按 `b.cols` 查表选取子集，**调用方不需要知道分级规则**。分级表放 `patterns.ts` 顶部并写清依据。

**Step 2: 检测 API**

```ts
export interface DetectedPattern {
  readonly name: string;
  readonly kind: PatternKind;
  readonly period?: number;
  /** 棋盘上的绝对坐标 */
  readonly cells: ReadonlyArray<readonly [number, number]>;
  /** 是否只匹配到平移版本（旋转/镜像版本不匹配） */
  readonly oriented: boolean;
}

/**
 * 在棋盘上找出所有已定义结构。
 *
 * 实现：对每个 PatternDef 生成它的 8 种对称变体（4 旋转 × 2 镜像），
 * 在每个可能的位置尝试匹配。棋盘 ≤ 16×16、结构 ≤ 36 格，暴力匹配完全够用。
 *
 * torus 拓扑下不做环绕匹配 —— 一个「跨过接缝」的方块在视觉上不成立，
 * 而且会给 Jev 提供它无法利用的信息。
 */
export function detectPatterns(b: Board): DetectedPattern[];
```

**Step 3: 写清「重叠结构怎么办」**

一个格子可能同时属于多个结构（比如滑翔机的一部分恰好像别的）。规则：**按结构大小降序匹配，已占用的格子不再参与更小的结构** —— 用大白话写在注释里，并测一条重叠场景。

**Step 4: 测试**

至少覆盖：8 种对称变体都能识别同一个方块；棋盘中央放一个滑翔机能在 8 个旋转/镜像方向上都被找到；空棋盘返回空数组；检测是纯函数。

**Step 5: Commit**

---

## T9 · 尺寸预设 `core/presets.ts`

**Files:**
- Create: `src/core/presets.ts`
- Test: `src/test/presets.test.ts`

**Step 1: 定义**

```ts
import type { Board, GameRules, Topology } from "./types.js";

export interface SizePreset {
  readonly cols: number;
  readonly rows: number;
  /** 该尺寸下可选的若干开局。开局本身是被测量的变量，一个尺寸只给一种等于把变量钉死 */
  readonly openings: readonly Opening[];
  readonly rules: GameRules;   // 定义在 types.ts，见 T7
  readonly defaultTopology: Topology;
  /** 参数是否经过跑分标定。未标定的预设界面上必须显式标注 */
  readonly calibrated: boolean;
}
```

**Step 2: 8×8 的默认值**

```ts
{
  cols: 8, rows: 8,
  openings: [ /* 见 Step 4 与 Step 5 */ ],
  rules: {
    turnLimit: 90,
    lifeWinRatio: 0.6,
    deathWinRatio: 0.05,
    lifeStreak: 3,
    deathStreak: 3,
  },
  defaultTopology: "bounded",
  calibrated: false,   // ← 注意是 false
}
```

**为什么 `calibrated: false` 而不是像设计文档那样标成已定**：`turnLimit: 90` 确实来自设计文档 12.2，但**胜负判定的整套机制换掉了**（从「累计净增长 > 22」换成「比例界限 + 防抖」），设计文档那套参数对新机制不再适用。比例、防抖长度这套值现在全部是占位，等 T13 的跑分出来才谈得上标定。

**关于 0.05 这个值**：设计文档的 `minAlive = 2` 换算成 8×8 的比例是 **3.1%**，所以 5% 与它同量级 —— 比早先设想的 20% 更接近原始设计的意图。用 20% 时有个明显问题：开局是 14 个活细胞 = **21.9%**，离 20% 只差 1.9 个百分点，死之执几乎一开局就贴着获胜线。改成 5% 后这个压力消失了（要到 ≤3 格才算越界）。

代价是另一个方向：**死之执现在离获胜线很远，可能反过来偏弱**。这正是 T13 跑分要回答的问题，不要靠猜。

**Step 3: 其余尺寸留未标定标记**

**预设只用正方形、边长取 2 的幂：4 / 8 / 16。** 对 4×4 与 16×16 给出**结构上合理但未经实测**的默认值，`calibrated: false`。

> ⚠ **4×4 需要单独定阈值，或者干脆不作为可玩尺寸。** 比例在意图上跨尺寸可比，但**被棋盘尺寸量化了**：
>
> | 棋盘 | 单格占比 | `deathWinRatio = 0.05` 意味着 |
> |---|---|---|
> | 4×4 | 6.25% | 活细胞 **≤ 0 格**（1 格就已经超线） |
> | 8×8 | 1.56% | ≤ 3 格 |
> | 16×16 | 0.39% | ≤ 12 格 |
>
> 也就是说在 4×4 上，5% 这条线比格子还细，实际退化成「把棋盘清空」。这与 T8 那条「4×4 达不到 2 格边距、属特殊状况」是同一个结论的两个侧面。**建议 4×4 只作退化演示，界面上必须标注「实验性」，且它的阈值不参与跨尺寸比较。**

**每个开局都必须满足「离边缘 ≥ 2 格」**（pulsar 是唯一例外，见 T8）。写一条测试把这条规则钉死：

```ts
test("每个开局都离边缘至少 2 格（pulsar 例外）", () => {
  for (const p of PRESETS) {
    for (const o of p.openings) {
      const rows = o.build(p.cols, p.rows);
      assert.ok(hasMargin(rows, 2) || o.id === "pulsar", `${o.id} 贴边了`);
    }
  }
});
```

开局局面还必须用 `lifeStep` 跑几十步确认不会立刻崩溃或填满：

```ts
test("每个未标定预设的开局至少能撑 20 步而不终止", () => {
  for (const p of PRESETS) {
    let b = boardFromRows(p.opening);
    for (let i = 0; i < 20; i++) {
      b = lifeStep(b, p.defaultTopology);
      assert.ok(aliveCount(b) > p.rules.minAlive, `${p.cols}×${p.rows} 第 ${i} 步就死了`);
    }
  }
});
```

**Step 4: 开局预设库 —— 不止「一个静物 + 一个滑翔机」**

设计文档只给了「1 方块 + 1 滑翔机」这一种开局。这不够：**不同类型的开局会把博弈推向完全不同的区域**，而开局本身就是一个应该被测量的变量。

`presets.ts` 里定义 `OPENINGS` 表，每个尺寸配若干个。结构：

```ts
export interface Opening {
  readonly id: string;            // "block-glider" / "block-mesh" / ...
  readonly nameZh: string;
  readonly nameEn: string;
  readonly build: (cols: number, rows: number) => string[];   // 返回棋盘行
  readonly note: string;          // 这个开局想测什么
  /** 缩略图，供 UI 呈现（见下） */
  readonly preview: readonly string[];
}
```

M1 至少要有这四类（每类一个具体局面）：

| id | 想测什么 |
|---|---|
| `block-glider` | 设计文档的基准开局。既有静物又有飞船 |
| `block-mesh` | **静物阵列**：交错铺开的方块，逼近「最大化存活格子」。生执落点极多、死执目标极多，与基准开局完全不同的博弈 |
| `dense-random` | **高密度随机**（约 50% 填充）。第一代剧烈衰减，考验模型在混沌中的判断 |
| `sparse-seed` | **极稀疏**（约 8%）。活细胞大多会死光，考验"从零搭建"的能力 |

**允许你（实现者）再补 1–3 个觉得有意思的新开局** —— 比如「整行全活」「对角线条纹」「两个滑翔机相向而行」。加进 `OPENINGS` 并在 `note` 里写清它想测什么，**后续再讨论选取哪些留作最终预设库**。

**Step 5: UI 要能画出开局形状，不能只有名字**

`Opening.preview` 是为这个准备的：一个短字符串数组，UI 用 `#` / `.` 渲染成缩略图。M1 的 T14 只需要在开局面板里把选中项的 `preview` 画出来即可（用 monospace 字符网格，不必用 canvas）。**开局选择器的完整交互留到 M2。**

**Step 6: Commit**

---

## T10 · 上下文组装 `core/context.ts`

**Files:**
- Create: `src/core/context.ts`
- Test: `src/test/context.test.ts`

**这是本项目与 2048 差异最大的一个模块。** 三条必须写进 `state` 的东西，设计文档 7.2 的示例 state 全都没有：

```ts
export interface StateInput {
  readonly board: Board;
  readonly role: Role;
  readonly topology: Topology;
  readonly rules: GameRules;
  readonly turn: number;
  readonly scores: { life: number; death: number };
  readonly history: readonly TurnRecord[];
  readonly context: RoleContext;   // 规则说明 + 策略提示 + 后果开关 + 记忆轮数
}
```

**Step 1: `buildState` 的必含字段**

**`state` 分成三块，其中前两块的边界是有实质意义的**（理由见上面「规则会被模型塑形」一节）：

```ts
{
  /* ── ① 游戏规则：可移植。人类玩家拿到的说明书就应该是这些 ── */
  rules: {
    role,                   // "life" | "death"
    role_statement,         // 见 Step 2 —— 角色的目标陈述
    objective,              // 计分方式
    horizon,                // "本局共 90 回合，当前第 12 回合"
    termination_conditions, // 由 GameRules 生成的完整文字
    win_condition,          // 描述「连续越界 N 回合判胜」的完整规则
    topology_note,          // 界外算死 / 环绕，必须讲清楚
  },

  /* ── ② 给 AI 玩家的辅助：绑定到这个特定玩家，不是规则的一部分 ── */
  aids: {
    board,                  // 二维 0/1 网格
    board_legend,           // "0=死格，1=活格"
    valid_cells,            // 合法格坐标列表
    detected_patterns,      // ★ 人自己会看棋盘认出方块，不需要这个
    recent_history,         // 受记忆预算约束
    strategy_hint,          // 用户可编辑的实验变量
  },

  /* ── ③ 客观状态 ── */
  turn, alive_count, alive_ratio, scores,
}
```

**为什么值得这么分**：`aids` 这一整块是**我们喂给 AI 玩家的脚手架**。人类玩家不需要"0=死格 1=活格"的图例，也不需要别人告诉他"当前棋盘包含一个方块，位于 (3,1)-(4,2)"。

分出这一层带来两个立刻可用的东西：

1. **一条可执行的测定**：把 `aids` 整个关掉，看 Jev 的表现掉多少。这正是 2048 那张「上下文层级 → 平均得分」阶梯表的生命棋版，而且这里的对照更干净——它不是"少给一点信息"，而是"**把脚手架整个拆掉，看还剩多少是模型自己的**"
2. **规则的可移植性可被检查**：将来要把生命棋的规则文档给别人用，`rules` 那块就是完整的说明书；`aids` 那块明确标注为「本实验台的 AI 玩家专享」

`strategy_hint` 放 `aids` 而不是 `rules`，是因为它是**实验变量**（2048 里就是这么用的：提示词不随界面语言变，因为改了就不叫对照实验）。

**Step 2: `role_statement` 必须显式反向**

死之执最容易出错的地方：它的目标是**最小化**活细胞数，但 Jev 的默认直觉是"让细胞活下来"。必须写死：

```
生之执：你是 Life。你的目标是在对局结束时让累计净增长尽可能大 ——
        也就是让棋盘上的活细胞尽可能多。你每回合可以翻转一个**死格**为活。

死之执：你是 Death。你的目标是在对局结束时让累计净增长尽可能小 ——
        也就是让棋盘上的活细胞尽可能少。你每回合可以翻转一个**活格**为死。
        注意：让细胞活着对你**不利**，即使它们看起来能组成漂亮的结构。
```

英文预设同理（`prompt` 语言是 T13 的实验变量）。

**Step 3: `buildQuestions` —— 三条通道的分发**

```ts
export type Channel =
  | { kind: "noul-all" }
  | { kind: "choice-all" }
  | { kind: "choice-filtered"; filter: FilterId };

export function buildQuestions(channel: Channel, ctx: StateInput): Questions;
```

**一条通道 = 一个请求**（这是硬约束）：返回值是**完整的 `Questions` record**，调用方把它一次性发出去，绝不循环。

`noul-all` 的措辞 —— **注意这里有一个陷阱**：`noul` 的 criteria 只能是 `{true,false}`，所以「后果预测」放不进 criteria，只能进 instructions。而如果 instructions 直接问单步后果并把答案写进去，等于把答案写在题面上：

```ts
// 后果预测关：
"flip_3_4": {
  type: noulDiscriminator(backend),
  instructions: "在 (3,4) 放置一个活细胞并演化一代，是否有利于最终累计活细胞数？",
  criteria: { true: "有利", false: "不利" },
}

// 后果预测开：单步后果作为**背景**，问的仍是长期价值
"flip_3_4": {
  type: noulDiscriminator(backend),
  instructions:
    "在 (3,4) 放置一个活细胞。本代演化后活细胞数将从 8 变为 10。" +
    "这一手是否有利于最终累计活细胞数？",
  criteria: { true: "有利", false: "不利" },
}
```

**Step 4: 写一条「分区反转」的回归测试**

这是设计计划里那个反转的可执行版本：

```ts
test("改回合上限后，state 必须变化 —— 游戏项影响 Jev 的输入", () => {
  const a = buildState({ ...base, rules: { ...rules, turnLimit: 90 } });
  const b = buildState({ ...base, rules: { ...rules, turnLimit: 60 } });
  assert.notDeepEqual(a, b, "改回合上限后 state 没变 —— 终局规则没进 state，Jev 不知道自己在玩什么");
});

test("改策略提示后，state 必须变化", () => { /* ... */ });
```

**Step 5: Commit**

---

## T11 · 决策层 `core/decide.ts`

**Files:**
- Create: `src/core/decide.ts`
- Test: `src/test/decide.test.ts`

**从 `jev-2048/src/client/decision.ts` 泛化。** 那个模块的全部 import 只有 `shared/types.js` 的类型和 `i18n`（`decision.ts:13`）——**零 2048 依赖**，是全仓库通用性最高的模块。本项目把它移进 `core/` 并去掉 i18n 依赖（返回值改成 key，由 UI 层翻译）。

三处改动：
1. `Direction` → `Cell`
2. 加 `role` 参数（合法集依赖角色）
3. `reason` 从已翻译的字符串改成 `reasonKey` + `reasonParams`，翻译交给 UI 层

**保留的设计原则，一个字都不改**（`decision.ts:5-11`）：

```
设计原则：**只测量 Jev，不引入任何启发式算法。**
因此这里没有规则兜底、没有启发式接管。当 Jev 不确定时，正确的做法不是
悄悄换成别的算法（那会污染测量），而是**把不确定性暴露给用户**。
```

**测试要点**（源仓库这个模块**零测试覆盖**，是本项目要还的债）：
- 首选合法 → 直接取
- 首选非法 → **只在 Jev 自己的分布内**取次优合法项，标记 `coerced: true`，**不引入外部规则**
- 分布为空 → 取 `legal[0]` 并标记
- `threshold` 策略下 `topProb` 低于阈值 → 标记 `belowThreshold`，但**动作不变**
- `sample` 策略：注入固定 rand 后可确定性测试（源仓库这里用了不可注入的 `Math.random`，导致无法测——本项目把 `rand` 提为参数）

**Commit**

---

## T12 · 搬运 API 层与服务端骨架

**Files:**
- Create: `src/client/api.ts` ← 照搬 `jev-2048/src/client/api.ts`
- Create: `src/shared/types.ts` ← 照搬 Jev 协议段（`jev-2048/src/shared/types.ts:109-206`）
- Create: `src/server/seal.ts` ← 照搬
- Create: `src/server/server.ts` ← 骨架照搬
- Create: `api/_upstream.ts`、`api/evaluate.ts`、`api/evaluate2.ts` ← 照搬

**必须改的只有四处：**

1. `src/client/api.ts:35` 的 `REMOTE_PROXY_BASE` → `https://jev-life.vercel.app`
2. `src/server/server.ts:277` 的日志里读 `answers.best_move.choice` → 改成读生命棋的问题名
3. **加超时** —— 源仓库全层无 `AbortController`（`api.ts:236`），断网时可能长时间卡在首次请求。用 `AbortSignal.timeout(ms)`，超时值进配置
4. `src/shared/types.ts` 的 Jev 协议段**逐字照搬** —— 尤其 `noulDiscriminator()`（`types.ts:133-136`）与四网关判别值差异的那段注释（Vercel 用 `boolean`，其余用 `noul`）。**这个函数在 2048 里是死代码**（主流程只走 `choice`），本项目是它第一次被真正需要。

**5. ★ 引入 `DecisionBackend` 适配接口（本任务里只做接口 + systemone 实现）**

这是本任务里唯一一处**结构性改动**，不是搬运。理由见上面「多提供商对照」一节 —— `api.ts` 现在假设所有后端共用同一种请求/响应形状，加入 LLM 后这个假设就破了。**必须在 T12 定下来，不能等做 LLM 适配器时再回头改**，否则 `channels.ts`、`core/` 全要跟着动。

本任务只做两件事：

- 定义 `DecisionBackend` / `DecisionResult`（含 `latencyMs`、`upstreamCalls`、`costUsd`）
- 把现有的 SystemOne 调用包成一个 `systemone` 实现

**`llm-json` 与 `llm-tool` 两个实现不在 M1 范围**（它们属于跑分与对照实验那一期），但接口现在就要定对——`latencyMs` 与 `upstreamCalls` 是**一等输出**，不是事后加的统计。

`costUsd` 的语义要写清楚：**无法计价时必须是 `null`，绝不填 0**。填 0 会被下游读成「免费」，而那是错的。（源仓库有一条同源的教训：`0` 是 falsy，被吞掉过。）

**Commit**

---

## T13 · 三条通道 + 无头 CLI 对局 ← **关卡一**

**Files:**
- Create: `src/core/channels.ts`
- Create: `tools/play.ts`
- Test: `src/test/channels.test.ts`

**Step 1: `channels.ts` —— 请求组装与响应解析**

```ts
/** 把一条通道的答案统一解析成「每格一个概率」 */
export type CellProbabilities = ReadonlyMap<Cell, number>;

export function parseAnswers(channel: Channel, answers: Record<string, Answer>, board: Board, role: Role): CellProbabilities;
```

- `noul-all`：键名 `flip_r_c`，取 `noulProbability(a)`（`shared/types.ts:187-189` 那个抹平函数）
- `choice-all` / `choice-filtered`：取 `probabilities` 映射，键是 `"r,c"` 格式
- **解析失败要抛出可诊断的错误**，而不是静默返回空映射

**Step 2: `tools/play.ts` —— 无头打完一整局**

这是关卡一的验收物，同时是 `tools/bench-step.ts` 的雏形。要求：

- 每回合**并发发出两个请求**（`Promise.all`），都基于演化前的棋盘
- 逐步打印：棋盘 ASCII、`boardKey`、双方各自的 `probabilities` 前 5 名、`usage`
- 终局时打印终局原因、双方累计净增长、最终棋盘
- 支持 `--dry-run`：用固定 seed 的**假概率**跑完全程，**不花额度**

```
第 12 回合  boardKey=8x8:a3f0...
  ····#···
  ··#·#···
  ·#··#···    活 14  净增长 +3  拓扑 bounded
  ········

  Life  选 (3,4)  p=0.41  conf=0.22   次优 (2,5) 0.18 | (4,4) 0.11
  Death 选 (1,2)  p=0.33  conf=0.19   次优 (2,3) 0.20 | (3,3) 0.15
  usage: in=1841 out=0
```

**Step 3: 跑 `--dry-run` 验证管线**

```bash
node tools/play.ts --dry-run --size 8x8 --turns 20
```

**Step 4: 用真额度跑一局短局**

```bash
node tools/play.ts --size 6x6 --turns 10
```
**这一局是 `noulDiscriminator()` 的首次实测** —— 四个网关对布尔型问题的判别值不一致，2048 从未走过这条路径。若报协议错误，错误信息要能直接指出是哪个后端、期望什么判别值。

**Step 5: Commit**

---

## T14 · 本地 localhost 可视试玩（前端骨架）← **关卡二（上）**

**Files:**
- Create: `public/index.html` ← 从 `jev-2048/public/index.html` 改造
- Create: `src/client/main.ts` ← 骨架照搬
- Create: `src/client/i18n.ts` ← 机制照搬，文案重写
- Create: `src/client/config.ts`、`session.ts`、`archive.ts` ← 骨架照搬，字段换

**照搬的 UI 骨架**（一字不改的部分，按函数名找，别按行号）：`$()`（`main.ts:139`）、`assertDom`（`:143`，调用点 2047）、`boot()`（`:2045-2098`）与它后面的 `try { boot() } catch` 兜底 —— 兜底用**手写内联样式的固定 div**，不走 toast（因为 toast 本身可能失效）；抽屉 + scrim（`DRAWERS` 在 `:1112`、`openDrawer` 在 `:1114`）、`toast`、`showOverlay`（`:524`）、`pushLog`（`:726`）、`relanguage`（`:2013`）。

**关卡二的验收标准**（对应计划第 5–8 条）：
1. `./start.sh` 后在 `localhost:8787` 能开一局并看完整个过程
2. 抽屉开合、调参数、切速度、看完整 request/response
3. 终局模态显示终局原因，关闭后能看到最终棋盘并**重新打开**
4. 改「游戏」项（回合上限 90→60）后重开，概率分布必须变化

**Commit**

---

## T15 · 渲染与动画 ← **关卡二（下）**

**Files:**
- Create: `src/client/render.ts` ← 从 `jev-2048/src/client/render.ts` 改造
- Create: `src/client/chart.ts` ← 照搬

**保留的骨架**（源仓库这部分写得对，别重写）：
- `Map<id, Visual>` 目标值模型（`render.ts:44-55`）—— 视觉层自带 `x/y/scale/alpha` 与目标值，与逻辑状态解耦
- 指数逼近补间：`k = 1 - Math.pow(1 - EASE, dt)`（`render.ts:374`）—— **按实际帧间隔归一化**，这个写法是对的
- 懒启动的 rAF（空闲时把 `raf` 置 0 停止循环）
- DPR 夹到 2.5（`render.ts:178`）
- `GUTTER_K` 几何（`render.ts:100`，注释解释了为什么 pad 与 gap 必须相等）
- 粒子积分的透明度/缩放曲线

**删掉的**：`SCALE` 橙色阶（`render.ts:25-38`）、`GLYPH` 方向箭头（`:102`）、按位数分档的字号（`:470-472`）。

**新增的三种动画**：

| 动画 | 触发 | 表现 |
|---|---|---|
| 落子 | 任一行动方翻转一格 | 格子 0→1 缩放，**ease-out（快起慢收）**；外加发光选框淡出，Life 绿 / Death 红 |
| 迭代 | 演化一代 | 状态改变的格子缩放淡入淡出，**无发光选框** |
| 粒子 | 落子处 | 复用 `burst` 骨架（`render.ts:312-344`） |

**配色**：深色底 + 白色活细胞。

**三张图**（`chart.ts` 的 `ConfidenceChart` 骨架可复用，但仍要改造）：

**① Jev 决策的历史置信度** —— 沿用 2048 的带状面积图（top / bottom / median 三标量）。
双人对弈模式下**两组合并进同一张图**：

- 生之执的面积用**绿**，死之执的用**红**
- 两块面积的**交集区域渲染成黄色**
- 中值折线各跟随各自玩家的颜色

**② 生死态势图** —— 新增，放在 ① 的**下方**（它是游戏的客观状态，不是模型的输出）。

纵轴是活细胞占比 0~1（**下 0 上 1**）。画面里有四条水平元素：

| 元素 | 含义 | 样式 |
|---|---|---|
| **生之执界限** | `lifeWinRatio`（默认 0.6） | **绿**色虚线 |
| **0.5 参考中线** | 二分线 | 中性虚线 |
| **死之执界限** | `deathWinRatio`（默认 0.05） | **红**色虚线 |
| **实际值折线** | 每回合的活细胞占比 | 描边颜色**随高度渐变**：低处红 → 中段黄 → 高处绿 |

- 实际值折线在两条界限之间穿梭；它与 0.5 中线围成的面积就是「优势面积」——折线在 0.5 以上时填**绿**，以下时填**红**
- **越界时在线头画一个圆点**，颜色与该方界限匹配，圆内显示**已连续越界多少轮**。这让「离赢还有多远」一眼可见，而不用去读数字
- **单人模式原封不动保留** —— 纯生执模式下它同样有信息量

> 配色口径已纠正：是「**上生绿、下死红**」（按图表默认的下 0 上 1）。此前记录的「下生绿上死红」是说反了，它与此前那句「越上越绿越下越红」的矛盾也由此解开 —— 两句本来就是一回事。

**③ 棋盘热力图**：`noul-all` 会返回 N² 个概率，**直接画在对应格子上**（透明度或色调）。2048 只有 4 个概率，只能退而画带状面积图；生命棋可以把概率编码到每一格。

**Commit**

---

## 完成 M1 的验证清单

```bash
cd ~/projects/Jev/jev-life

# 单一入口（密钥扫描 → 分层检查 → DOM 检查 → 测试 → 编译 → 启动）
./start.sh

# 逐项
node tools/scan-secrets.ts --history
node tools/scan.ts
node tools/check-dom.ts
node tools/bench-step.ts
npm test
npm run typecheck

# 无头一整局（不花额度）
node tools/play.ts --dry-run --size 8x8 --turns 90

# 真额度短局（验证 noulDiscriminator 首次实测）
node tools/play.ts --size 6x6 --turns 10
```

浏览器打开 `http://localhost:8787`，逐条对照 T14 的四条验收标准。

---

## Jev 在本项目中的地位（`DESIGN.md` 的开篇素材）

**观察**：相比 2048，生命棋「探索游戏」的成分偏多、「呈现 Jev」的成分偏少。

这个观察成立，而且原因不在我们，在**载体自带**：

| | jev-2048 | 生命棋 |
|---|---|---|
| 规则 | 既定的、成熟的 | **我们自己定的，且未验证** |
| 目标函数 | 天然的（最大化分数，无路可走结束） | **人为设计的**，且「生执与死执是否均衡」本身是开放问题 |
| 待标定的参数 | 少，且社区有共识 | 回合上限、两条胜负线、两个防抖长度、开局局面、拓扑 —— **全都要标定** |
| 对手 | 没有 | 有，且非对称 |

2048 的规则不需要探索。生命棋的规则如果不探索，就只是拍脑袋。

### Jev 的地位是双重的

**一、作为工具 —— 让规则标定从直觉变成实验**

双人对弈靠真人测成本极高：规则烧脑、一局 90 回合、需要两个会玩的人。Jev 把它变成几分钟跑几百局。

这一层顺带解释了 2048 那份「对照实验」为什么始终停留在设想：**2048 是单人对局，「跑分」就是得分本身，没有值得对照的第二组。** 生命棋的零和结构天然需要大样本，于是自动化从「锦上添花」变成「不做就没法玩」。

**对外呈现的顺序**（用户定）：上 awesome 类列表时，**先讲「对 Jev 的利用」**（并行决策能力 + 第一个玩家），**再讲「新规则适应性」**。理由很实在——后者用 LLM Agent 也能做，不构成差异；前者才是这个项目独有的。

**二、作为被测对象 —— 测量的比 2048 更深**

| 能测的 | 为什么 2048 测不了 |
|---|---|
| **大动作空间下的并行决策** —— 全量 noul 是 64 个独立问题一次发出 | 2048 只有 4 个动作，压不到这条。而「并行回答数十个独立问题、加问题几乎不增加响应时间」正是 Jev 的核心宣称 —— **生命棋是它的一次真实负载检验** |
| 同一模型扮演对立双方的一致性 | 2048 没有对手 |
| 适应成本（换拓扑 / 提示词 / 语言，性能各掉多少） | 2048 只有一种拓扑、一种载体 |

### 一个必须写进文档的风险

若只用 Jev 来标定游戏参数，标出来的就是「**对 Jev 而言均衡**」的参数，而不是「对任意决策者均衡」的。换个模型接入，这套阈值大概率不再合适。

这不是缺陷，但不能不说 —— 否则会有人拿这套参数去横向比较不同模型，而那正是「凡混合则不可归因」的变体。**文档里必须写明：参数与标定它的那个模型绑定。**

### 另一条容易被忽略的价值

用户提出：**AI 自动化让人类在最初学习时没有太多心理负担**。

生命棋规则烧脑、学习曲线陡。全 AI 对局让人可以先「看两局」再下场，把学习成本从「先学会规则」推迟到「看懂了再玩」。这在 UI 上对应的是**对局要能完整回放** —— 决策日志本来就记录了每一步的完整 request/response，回放是顺带的。

---

## Jev 对「探索游戏规则」的加速作用

### 问题的结构

用弱玩家评估深游戏，得到的结论是「**弱玩家不会玩**」，不是「规则不好」。围棋让没下过的人玩，结论会是"随机性太大、没意思"。

所以评估规则需要强玩家。但**游戏还不存在的时候没有强玩家**——没人玩过，没有定式，没有训练数据。这是个鸡生蛋问题。

Jev 绕开它的方式：**它不需要"学过"这个游戏就能当玩家。** 没有记忆、没有搜索、逐回合独立判断——它的"棋力"来自通用推理 + 你给的上下文，而不是对生命棋的训练。

迭代周期因此从**周/月**变成**分钟**。

### 但它只加速「机械属性」，不加速「体验属性」

跑分给出的是数字：胜率、平均回合数、进入周期的比例、净增长曲线。这些回答的是规则的**机械后果**——

- 死之执是不是必胜？角色不对称到什么程度？
- 对局是不是大段时间在振荡器里空转？
- 阈值从 5% 改到 20%，胜率从 90/10 变成 55/45 了吗？

**这些是设计规则的工程师会问的问题，而它们本来没有便宜的答案。** 但它们不告诉你游戏好不好玩。

所以：**Jev 把规则设计从「靠感觉调参」推进到「靠数据调参」，调的却是机械属性；体验属性仍然需要人。** 与「AI 自动化让人类学习没有心理负担」那条是分工关系，不是替代。

### LLM Agent 也能做 —— 差异在哪

**(a) 成本**：这是「并行决策」的推论。跑 200 局 × 90 回合 = 18000 次决策；工具循环的 LLM 是 18000 × 64 次调用。

**(b) 它可能是更干净的「规则探针」** —— ⚠ **这是可测的假设，不是已知事实**：

LLM 有大量先验，很可能"记得"方块、滑翔机、Gosper 枪并直接调用。**这对规则探索恰恰是问题**——你想测「规则本身丰富不丰富」，而模型在背它见过的游戏时，你分不清它玩得好是因为规则好还是因为它背过。

Jev 的结构（无搜索、无记忆、逐回合独立判断）让它更依赖 state/questions 而非语料里的游戏知识。

**测法很便宜，且不需要额外工作**：给 Jev 与 LLM 同一个局面、同一套规则说明，比决策分布。若 LLM 一上来就摆教科书式结构而 Jev 不是，即是先验在起作用的证据。

### ★ 一个反向风险：规则会被模型塑形

**如果规则是「用 Jev 调出来的」，它会长成 Jev 擅长的样子。**

具体到生命棋：我们计划把 `detected_patterns` 喂给 Jev（设计文档 11.2 说得对——**Jev 没有内置的结构检测器**）。但这就意味着**规则的一部分变成了「Jev + 我们喂给它的结构检测器」**，而不是一个自足的规则。

人类玩家自己会看棋盘认出方块，不需要我们喂。

**所以必须把「游戏规则」与「给 AI 玩家的辅助」分开记录**——前者可移植，后者绑定到这个特定玩家。这是「参数与标定它的模型绑定」的加强版：**不只是参数，连规则本身都可能被模型塑形。**

这条决定了本项目产出的「游戏规则」能否被别人独立使用，**必须写进 `DESIGN.md`**。

---

## LLM 对照后端的实测档案（agnes-ai flash）

**这是一次快速侦察，不是严谨测量** —— 下面的延迟都是单次采样，只够定性，不够下结论。

### 接入信息

| 项 | 值 |
|---|---|
| Base | `https://apihub.agnes-ai.com/v1` |
| OpenAI 兼容 | `POST /chat/completions` ✓ |
| Anthropic 兼容 | `POST /messages`（**同一个 host，不是"改改才能试出来"**） ✓ |
| 密钥 | `../local/agens-flash-secret-api-key`（51 字符） |
| 额度 | 无账户额度，**仅 flash 系列免费** |
| 文本类 flash | `agnes-3.0-flash` / `agnes-2.5-flash` / `agnes-2.0-flash` |

### ★ 它们是**推理模型**，这直接决定适配器怎么写

普通对话回包长这样：

```json
{
  "content": "\n\n收到",
  "reasoning_content": "用户要求我回复"收到"。这是一个简单的确认性回复…",
  "usage": {
    "completion_tokens": 71,
    "completion_tokens_details": { "reasoning_tokens": 68, "text_tokens": 3 }
  }
}
```

**踩到的坑**：`max_tokens: 20` 时 20 个 token 全被思维链吃掉，`content` 返回**空字符串**、`finish_reason: "length"` —— HTTP 200，看起来像成功，实际什么都没答。

> **适配器硬性要求**：`max_tokens` 必须给足推理预算，且**不能把 `content` 为空当成正常回包**。要检查 `finish_reason === "length"` 并当作失败重试或报错。
>
> 这又是一次「HTTP 200 + 空结果」的静默失败 —— 与源仓库那三次扫密钥漏检是同一个母题的实例：**看起来成功了，其实是空的。**
>
> 另外 `reasoning_tokens` 要单独记账。跨模型比成本时把它算进去，否则会低估推理模型的真实开销。

### 实测延迟（单次采样，仅定性）

| 模型 | 请求 | 耗时 |
|---|---|---|
| `agnes-3.0-flash` | "Say OK" | **141.7 s** |
| `agnes-3.0-flash` | "回复：收到" | **28.4 s** |
| `agnes-2.5-flash` | 同上 | **0.55–0.72 s** |
| `agnes-2.0-flash` | 同上 | **1.65 s** |
| `agnes-2.5-flash` | JSON 输出 | 1.67 s |
| `agnes-2.5-flash` | 工具调用 | 1.62 s |

**3.0-flash 比 2.5-flash 慢 40–250 倍。** 这不是网络问题，是思维链长度差异。对我们的用处：

- **日常对照用 `agnes-2.5-flash`**（快、免费、能力够）
- **`agnes-3.0-flash` 本身就是一个有价值的被测量对象** —— 它演示了「推理模型的延迟方差能有多大」，而这正是项目要测的东西

### 能力确认

| 能力 | 结论 |
|---|---|
| `response_format: {type:"json_object"}` | ✓ 可用，回包 `{"p": 0.5}` |
| `tools` + `tool_choice` | ✓ 可用，`tool_calls` 正常返回 |
| 工具参数正确性 | ⚠ 首测把「翻转(3,4)」解析成了 `key="翻转", value=34` —— **是提示词问题不是能力问题**，tool schema 的 description 要写清楚 |

### 一个会让成本估算失真的细节

trivial prompt 的 `prompt_tokens` 是 **287**，其中 `cached_tokens: 256`。也就是说**每次调用有个不小的固定开销**。工具循环模式下 64 次调用 = 64 × 最低 prompt 开销 —— 这正是「Jev 一次调用答完 64 题」要对比的东西，记账时不要漏掉。

### 顺带发现：`../local/` 那两条 `.gitignore` 规则是**空转的**

两个仓库的 `.gitignore` 里都写了 `../local/`。但 **gitignore 的规则无法逃出仓库根目录**，`git check-ignore` 的回应是「outside repository」。密钥真正的保护来自它**物理上位于两个仓库之外**，而不是那条规则。

所以：**保护是有效的（git 够不到），但那两条规则给的是虚假的安全感。** 若哪天有人把 `local/` 挪进仓库内，那两条 `../local/` 不会生效 —— 好在 `.gitignore` 里另有 `local/` 与 `*-secret-api-key*` 两条能兜住。新增密钥时必须确认**确实有一条能命中的规则**，不能只看"我写过一条"。

---

## 工具调用的实测：失败不是机制问题，是推理量爆炸

**用户要求「真的测过」工具调用这一块，这里是实测结果。**

对照实验（`agnes-2.5-flash`，每格 3 次）：

| 场景 | 成功调用工具 | 耗时 | 推理 token |
|---|---|---|---|
| 平凡问题（无棋盘）`auto` | **3/3** | 1.0–3.8 s | 21–28 |
| 平凡问题 `forced` | **3/3** | 1.0–1.9 s | 21–25 |
| 加 8×8 棋盘上下文 | 2/3 | 1.8–3.9 s | **122–339** |
| 完整生命棋提示（棋盘 + 规则 + 6 题） | **1/4** | 10.8–39.3 s | **599–4000（全烧光）** |

**结论：工具调用机制本身可靠（3/3、1 秒内）。失败是「推理量随上下文复杂度爆炸」的结果。**

链条是：**上下文变复杂 → 思维链变长 → 推理吃光 `max_tokens` → `content` 为空、工具调用为零 → 静默失败。**

### 两种失败模式，都要处理

1. `finish_reason: "length"` + `content` 空 —— 预算被思维链吃光
2. `finish_reason: "stop"` + 无工具调用 —— 模型觉得自己答完了，其实什么都没答

**强制 `tool_choice` 无效**：实测 5/5 仍失败，比 `auto` 还差。别在这上面花时间。

### 一条被我推翻的假说（留作教训）

我一度以为「预算给小反而容易答出来」（首次 800 成功、2000 失败）。**重复验证推翻了它**：800 四次成功一次、2000 四次成功一次 —— 成功率一样，与预算无关。

这是**从 n=1 推规律**的错误，与我在 noul 成本上按问题数线性外推是同一类。预算真正影响的是**耗时**（800 → ~11.5 s，2000 → ~19.8 s，6000 → 68.6 s），因为模型似乎**总会把预算用满**。

### 对 broker 的硬性要求

1. **必须把「无有效工具调用」当失败并重试**，两种 `finish_reason` 都要覆盖
2. **重试次数与最终成功率要记账** —— 它们是「LLM 作为决策后端」与**延迟、成本并列的第三条指标**，而且很可能是最有区分度的那条
3. **上下文越短越可靠** —— 这给「一次答 1 个还是答 N 个」补了一个额外的权衡维度：答得少不但省往返的不确定性，还降低单次失败率
4. **Node 的 `fetch` 默认 5 分钟掐 headers**，必须显式设超时；否则长推理会以 `UND_ERR_HEADERS_TIMEOUT` 静默失败（实测 `max_tokens=32000` 时两个 flash 模型都栽在这上面）

> 第 2 条正是四层架构存在的理由之一：**broker 把 75% 的失败率藏在 Jev 兼容 API 后面**，上层永远看不到。但「藏」不等于「不存在」——重试次数是必须外露的统计量。

---

## 关掉思维链：目前最有效的一把杠杆

用户提议试关思维链。**测了六种写法，两种真的管用。**

| 写法 | HTTP | 耗时 | 推理 token | 判定 |
|---|---|---|---|---|
| 基线（不传） | 200 | 2.8 s | **108** | — |
| **`reasoning_effort: "none"`** | 200 | **0.5 s** | **无字段** | ✅ 真关掉了 |
| **`chat_template_kwargs: {enable_thinking: false}`** | 200 | **0.7 s** | **无字段** | ✅ 也有效 |
| `enable_thinking: false` | 200 | 2.2 s | 60 | ⚠ 只是变少 |
| `thinking: {type: "disabled"}` | 200 | 3.6 s | 175 | ❌ 被忽略 |
| `reasoning_effort: "minimal"` | **400** | — | — | ❌ 枚举校验不过 |

**效果（6 题 × 4 次，同一份提示）**：

| | 成功率 | 耗时 | 推理 token |
|---|---|---|---|
| 基线 | 4/4 | 5.8–41.1 s | 239–2856 |
| **关思维链** | 4/4 | **2.0–7.5 s** | **0** |

**快 5 倍以上，推理 token 归零。**

### 我之前的「~50% 成功率」是小样本噪声，不可靠

同一份提示、同一个模型，我在不同轮次测到过 **0/4、1/4、2/4、4/4**。所以**「单次成功率约五成」这个说法不成立** —— 它本身就是个波动极大的量。（这已经是我第三次在同一类错误上栽：用少量采样当规律。）

**真正稳定的是这两条**：
1. **关掉思维链后延迟降 5 倍、推理 token 归零** —— 多次重复一致
2. **关掉思维链从结构上消灭了「推理吃光预算」这个失败模式** —— 那是我观察到的唯一失败原因（`finish_reason: length` + 空 content）。不是「可能更可靠」，是机制上不可能再发生

### 决定性对照：关思维链 8/8，基线 5/8

同一份提示（8×8 棋盘 + 6 题 + B3/S23），各 8 次：

| | 成功率 | 耗时 | 推理 token |
|---|---|---|---|
| 基线 | **5/8（63%）** | 16.6–64.0 s | 1212–**4000**（两次烧满） |
| **关思维链** | **8/8（100%）** | **1.1–4.9 s** | **0** |

基线的 3 次失败已逐条核对：2 次 `finish=length`（推理烧满预算）+ 1 次「JSON 形状不对」。**没有一次是限流**，所以这组对照是干净的。

关掉之后不仅全中，延迟还**低一个数量级且稳定得多**（1.1–4.9 s vs 16.6–64.0 s）。

### ★★ 免费额度有限流，而我的探针把它误记成了「模型答不出来」

诊断 `agnes-2.0-flash` 那些「0.2–0.7 秒瞬时空响应」时抓到了原始回包：

```json
{"error":{"message":"You've reached the API rate limit for free users. ..."}}
HTTP 429  0.386s
```

**是限流，不是模型失败。**

而**我的探针有 bug**：它用 `j.choices?.[0]?.message?.content` 取内容，**没有先看 HTTP 状态码** —— 于是 429 被记成了「空 content」，统计上表现成「模型答不出来」。

> 这是本项目那个母题的又一次实例：**现象与真正的原因毫无关联**（源仓库的 `CLAUDE.md` 里对「棋盘空白、点一下直接判负」也是这么写的）。只不过这次的「检查工具」是我自己的探针。

**对 broker 的硬性要求（新增一条）**：

1. **必须先看 HTTP 状态码**，再看回包内容。`429` / `5xx` / 认证失败各有各的处置，绝不能都归到「模型没给出答案」里
2. **限流要单独计时并退避**，不能当成「重试就能过」的普通失败 —— 立即重试只会继续 429
3. **跑分统计要把「限流」单列一栏**，否则免费额度下的成功率会被限流稀释，得出「模型不行」的错误结论

> 这也意味着：**我前面那些小样本结论（0/4、1/4、2/4）很可能被限流污染过**，不能当成模型的真实表现。只有上面那组逐条核对过的 8 次对照是可信的。

### 限流很可能是按 **token** 计的，不是按请求数

实测对照：

| 负载 | 结果 |
|---|---|
| **14 次轻请求**（关思维链，约 60 token/次）连发，31 秒内 | **14/14 成功，零限流** |
| 约 40–50 次**重请求**（开思维链，4000 token 预算）分散在半小时内 | 多次 429 |

所以不是每秒请求数限制。**重请求烧配额快得多。**

这与「关思维链」那条汇到一处：关掉之后不仅快 5 倍、成功率 100%，**每次请求的 token 消耗还降到百分之一量级** —— 限流的暴露面跟着大幅收窄。

**`tools/bench-step.ts` 的含义**：跑分规模受限于 token 配额而非请求数，所以
- **默认关思维链**在跑分场景里几乎是必需的（否则几百局就会撞墙）
- 统计页必须把「限流次数」单列（见上）
- 具体配额没测（再压就得刻意打限流，不划算），按「跑一轮看撞不撞」实测推进

### ★ 后端是 SGLang，枚举是**后端专属的**

**从 400 的报错栈里看到的**：`/usr/local/lib/python3.12/dist-packages/sglang/srt/entrypoints/http_server.py`。所以 agnes-ai 是自托管的开源推理框架（SGLang），不是专有网关 —— 这解释了它的推理行为，也意味着「模型名 agnes-2.5-flash」是个 rebrand。

**它的 `reasoning_effort` 合法枚举**（原文）：

```
Input should be 'none', 'low', 'medium', 'high' or 'max'
```

**没有 `xhigh`。** 实测逐个发：

| 值 | 结果 |
|---|---|
| `none` | 200，推理 token **无字段**（真关掉） |
| `low` / `medium` / `high` / `max` | 200 |
| **`xhigh`** | **400，请求被拒** |
| `minimal` / `ultra` | 400 |

### UI 规格（用户定）

| 控件 | 取值 |
|---|---|
| **是否允许思考** | 是 / 否 / 留空 |
| **思考强度** | 无 none / 低 low / 中 medium / 高 high / 超高 xhigh / 最强 max / 默认（留空） |

**⚠ 但 UI 的选项集合不能直接当作下发的枚举。** 上面这份列表是**并集**（为了将来兼容别的后端），而任何单个后端只支持其中一个子集 —— 这个后端就不认 `xhigh`，直接发出去会 **400 把整个请求打掉**。

所以 broker 必须有一张**后端能力表**，并规定降级行为：

1. 该后端**支持**这个值 → 原样下发
2. **不支持** → **不要发**（留空，用后端默认），并在 UI 上标注「该后端不支持，已降级为默认」
3. **绝不**把用户选的原始字符串直接塞进请求体

第 3 条是要害：一个 UI 选项把整个决策请求打成 400，属于**界面能选但一选就坏**，而且报错离原因很远（400 来自请求体字段校验）。

**另外**：`是否允许思考` 与 `思考强度` 里的 `none` 语义重叠。建议的耦合是——`是否允许思考 = 否` 时，把强度**置灰并显示为 `none`**；强度选 `none` 时，是否允许思考自动显示「否」。两者最终都归一到同一个下发字段（`reasoning_effort`），或按后端能力分别落到 `reasoning_effort` 与 `chat_template_kwargs.enable_thinking`。

### 建议：默认关，并且把它本身当成实验变量

理由不依赖成功率：
- 延迟与成本都是数量级的差别
- 它移除了一个已知的、静默的失败模式

**但它同时是一个值得测的变量**：关掉思维链会不会降低决策质量？少了推理，模型在生命棋上的判断可能变差 —— 而「**思维链对决策质量的增益 vs 它的延迟/可靠性代价**」正是这个项目应该测的东西，而且是 Jev 与 LLM 对比里一个天然的维度（Jev 本来就没有思维链）。

所以就按用户说的：**加一个「关闭思维链」的选项，默认开**（即默认关思维链），后端不支持该参数时静默忽略。

---

## 「统计」页面（后续，用户提出）

用户提出：**各 AI 配置的统计信息（如平均成功率）也应作为模型实验的指标**，后续做一个专门页面装这些统计。

这一页该装什么，基本上是这轮实测一条条逼出来的：

| 指标 | 为什么非有不可 |
|---|---|
| **单次成功率** | 必须与「重试后的成功率」分开，否则看不出模型的真实能力 |
| **重试 N 次后的成功率** | 决定「配几次重试才够用」 |
| **重试次数分布** | 平均值会掩盖「一半一次过、一半要五次」 |
| **★ 限流比例（429）** | 不单列就会被算进「模型不行」——这轮已经栽过一次 |
| **延迟的分位数**（中位 / p90）而非平均 | 推理模型的延迟方差极大，实测见过 1.1 s 与 190.9 s；平均值没有意义 |
| **推理 token 占比** | 关思维链前后是 0% 与 90%+，是最大的单一变量 |
| **成本** | 且**必须标注价目表的日期**（价格会变） |
| 按「思维链开关 × 思考强度」分组 | 本轮找到的最大变量 |

### 一条关键设计：统计要按「配置」分组，不是按「模型」分组

同一个模型在「关思维链」与「开思维链」下**是两个不同的东西**（实测 100% vs 63%）。把它俩混在一起算平均，得到的数字谁也不代表。

所以分组的键是 **`后端 × 模型 × 调用配置`**，其中「调用配置」至少含：思维链开关、思考强度、协议（JSON / 工具）、问题数。

### 可重置（用户已定）

必须能重置——否则跑完一轮对照，第二轮的数据会被第一轮污染。

---

## 多提供商对照：把 Jev 的并行决策放进对照实验

**用户的提议**：加入 Anthropic / OpenAI 兼容 API，把「答题」适配成两种形态——

- **JSON 输出**：一次调用，要求模型吐出符合 `answers` 形状的 JSON
- **工具循环**：提供一个 `answer_question` 工具，让 Agent 反复运行直到全部问题答完

然后与 Jev 比**性能**（速度 & 价格）与**效能**（智能 / 正确率）。

### 为什么这件事比看起来重要

它把项目最有价值的那条测量补全了。

Jev 的核心宣称是「并行决策：单次调用可并行回答数十个独立问题，加问题几乎不增加响应时间」。**这句话需要对照才能成立** —— LLM Agent 天然是顺序的，必须一个问题一个问题地答。

于是「64 个 noul 问题」这组负载有了三边对照：

| 后端 | 上游请求次数 | 期望 |
|---|---|---|
| Jev / SystemOne | **1** | 延迟几乎不随问题数增长 |
| LLM + JSON 输出 | 1 | 一次要吐 N 个答案，可靠性存疑 |
| LLM + 工具循环 | **N** | 延迟随问题数线性增长 |

**这就是「Jev 的并行到底值多少钱」的直接测量，单位是秒和美元。**

而且它是 2048 那份「对照实验」设想的**真正落地**——那边之所以一直没做，是因为单人对局没有第二组。

### ★ 四层架构：把「LLM 转 Jev」做成可独立取用的产物

用户定的分层：

```
游戏态势
   │   Jev 形状的请求：{ model, state, questions }
   ▼
Jev 兼容 API          ← 契约层。对上层完全等同于 SystemOne
   │
   ▼
Jev–LLM API broker    ← 把 Jev 形状翻译成 LLM 调用，再把回包翻译回 Jev 形状
   │
   ▼
LLM 提供商（agnes-ai / Anthropic / OpenAI …）
```

**关键约束：「Jev 兼容 API」这一层必须真的兼容。** 上层的 `channels.ts` / `decide.ts` / `core/` 一行都不用改，也**分不出**对面是 Jev 还是一个被 broker 包装的 LLM。

收益不只是本项目能用 —— **broker 本身就是一个可独立取用的产物**：任何人想「用 LLM 冒充 Jev」都能直接拿它走，而我们的对照实验就是它的验证用例。这是项目相对 awesome-jev 多出来的第二件交付物（第一件是「并行决策值多少钱」那份测量）。

### 工具调用的形状：一次可答 ≥1 个，且形状一致

**放宽「一次一个问题」的限制**：允许 LLM 一次回答**不少于一个**问题，且**答一个与答多个的 API 形状完全一致**。

```jsonc
// 工具定义
{
  "name": "answer_questions",
  "description": "回答一个或多个问题。可以一次只答一个，也可以一次答多个。",
  "parameters": {
    "answers": [ { "key": "flip_3_4", "value": 0.72 } ]   // 长度 ≥ 1
  }
}
```

**回包必须告诉它还剩多少**，这样模型自己知道没答完：

```jsonc
{ "accepted": ["flip_3_4"], "remaining": 5, "remaining_keys": ["flip_2_2", "..."] }
```

形状一致是为了让模型能在**省往返**（一次答完）与**稳妥**（一次一个，避免一条坏参数毁掉整批）之间自己权衡 —— **而这个权衡本身就是要测的东西之一**。

### ★ 配置模型：对局级 vs 玩家级（修正设计计划 P8 的分法）

设计计划 P8 把配置分成「共通项（可镜像）/ 角色项（各自独立）」，判据是「这设置两边共享吗」。**这个分法是错的** —— 它把「后端 / 模型」归进了共通项，而跨模型对照恰恰要求两边能选**不同**的后端（Jev 当生执、agnes-LLM 当死执）。后端若是全局一份，这个配置根本配不出来。

改成两级：

| 级别 | 项 | 判据 |
|---|---|---|
| **对局级** | 棋盘尺寸 / 拓扑 / 终局规则 / 开局 | 它们是**博弈的定义**。两边不同就不是同一个游戏 |
| **玩家级** | 后端 / 模型 / 密钥来源 / **调用策略** / 评估通道 / 记忆轮数 / 后果开关 / 自动结构识别 / 规则说明 / 策略提示 / 策略 / 阈值 | 它们描述**这个玩家怎么想** |

「双侧同步配置」因此**不是一个分区的属性，而是一个动作**：把 A 的玩家级设置整体复制到 B。Jev vs Jev 时开着省事，Jev vs LLM 时关掉做对照。**两个方向都要有**（生执 → 死执、死执 → 生执）。

### UI 配置项的呈现规则

| 配置项 | 位置 | 可见性 | 持久化 |
|---|---|---|---|
| **调用策略**（工具循环 / JSON 输出） | **API 抽屉** | 仅选用 LLM 后端时出现 | **要**（换回 Jev 再换回来，设置还在） |
| 自动结构识别 | 策略 | 始终出现，**默认开** | 要 |

**调用策略放 API 抽屉的理由**（用户定，比我原先的判据更实在）：**「模型」本身也影响 AI 玩家的表现，而它本来就在 API 抽屉里。**

所以 API 抽屉的心智模型应当被明确写成「**怎么跟模型打交道**」，而不是「网络参数」—— 它包含**选谁**（后端 / 模型 / 密钥）与**怎么谈**（调用策略 / 重试 / 超时），而这些**都**影响表现。

**「自动结构识别」默认开**是为了开箱即用；可关是为了做对照实验 —— 关掉它就是「**把脚手架拆干净，看模型还剩多少**」，与 `state` 分成 `rules` / `aids` 是同一件事的两面。

### 分区判据在生命棋里要换掉

2048 那条「影响谁的输入」判据在这里**已经不够用**：生命棋里「游戏」项**也**影响输入（规则不自明），「API」项**也**影响输入（换后端 = 换一套完全不同的 prompt 构造方式）。判据破了就得换。

新判据是上面那条两级分法，外加一条「改了它，该去看什么」：

| 分区 | 改它之后该观察什么 |
|---|---|
| 游戏 | 概率分布**应该**变（生命棋的反转） |
| 策略 › 上下文 | 概率分布 |
| 策略 › 规则 | 实际走了哪一步 |
| **API** | **延迟、上游调用次数、成本** —— 只有这一分区产生这三样 |

### 提供商命名

| 显示名 | 背后 | 备注 |
|---|---|---|
| **Jev 免费试用 1 / 2** | 现有的两个代管后端 | 原名「免费试用」「免费试用 2」，**加前缀** |
| **LLM 免费试用 1** | agnes-ai flash | 新增 |

前缀区分「Jev 协议的原生后端」与「经 broker 包装的 LLM 后端」—— 那正是四层架构在 UI 上的投影。

> 另：`../local/` 那两条空转的 `.gitignore` 规则**本次不动**（已确认密钥物理上在仓库外，保护有效）。

### 架构含义（必须在 T12 之前定，不能事后补）

`api.ts` 现在的假设是「所有后端共用同一种请求/响应形状」。加入 LLM 后这个假设破了：SystemOne 是 `{state, questions} → {answers}`，而 LLM 是 chat/messages + 结构化输出或工具调用。

所以要引入一层适配接口，并**把延迟与调用次数提升为一等输出**——它们本身就是测量结果，不是副作用：

```ts
export interface DecisionBackend {
  readonly id: string;
  readonly kind: "systemone" | "llm-json" | "llm-tool";
  evaluate(req: DecisionRequest, hooks?: CallHooks): Promise<DecisionResult>;
}

export interface DecisionResult {
  readonly answers: Record<string, Answer>;
  /** 墙钟：首次请求 → 全部问题回答完成。头条指标 */
  readonly latencyMs: number;
  /** 本轮发了几次上游请求：Jev 是 1，工具循环的 LLM 是 N */
  readonly upstreamCalls: number;
  readonly usage: { inputTokens: number; outputTokens: number };
  /** 无法计价时必须为 null，绝不填 0 —— 0 会被读成「免费」 */
  readonly costUsd: number | null;
}
```

形状差异全部收进适配器内部，**`channels.ts` 与 `core/` 一行都不用改**。

### 一个必须先回答的问题：效能怎么衡量

「正确率」在生命棋里**没有天然定义**——局面混沌，没有标准答案。所以只能二选一或并用：

- **（主）对局胜负**：两个模型各执一方跑 N 局比胜率。零和博弈里，赢就是正确。这条 `bench-step.ts` 现成就能出
- **（辅）一致率**：在 noul 通道上，选一个慢而可靠的基准（全量 noul 的加权聚合？更深的搜索？），比各模型与它的一致程度

**我倾向以对局胜负为主**：它是**契约性的**（有确定结果、不可争议），而一致率取决于你选谁当参考——那又把「参考者的偏见」引了回来，正是「凡混合则不可归因」要防的东西。

### UI 与统计

- **平均延迟**进「API」设置页，定义就是「首次调用 → 全部问题回答完成」的墙钟时间
- **模型统计数据必须可重置**——否则跑完一轮对照，第二轮会被第一轮的数据污染
- 成本需要**价目表**，且**必须标注日期**（价格会变，写死的表会悄悄过期）

### 写进功能介绍

这给项目加了一条对外的、可验证的卖点：**它不只测「模型会不会玩新规则」，还测「不同模型做结构化决策时的速度、价格与效能」**——后者对任何要挑决策后端的人都有用。

---

## 开工后发现的问题（留待写进 `DESIGN.md`）

这两条都是**同一个母题的实例**：*检查工具自身的盲区*。jev-2048 的密钥事故（`grep -I` → 白名单正则带 `g` → zlib 层）是它的第一组样本，这两条是新的。写 `DESIGN.md` 时应当把它们归到同一节。

### 1. `tools/scan.ts` 曾经 fail-open（已在 `b6ecfdb` 修）

初版的分层检查在「import 解析不到磁盘上的文件」时执行 `continue`，注释写的理由是「交给 tsc 报」。但这条路径造出的效果是：

| `src/client/api.ts` | 同样的 `import ... from "../client/api.js"` | 判定 |
|---|---|---|
| 存在 | 探针文件 | ✗ 抓到 |
| **不存在** | **同一个探针文件** | ✓ 报「没有触及 client/」 |

**判据依赖了「此刻磁盘上有没有这个 `.ts`」**。而且 `continue` 还切断了传递闭包——那条 import 后面的整棵子树都不再被遍历，所以一个还没建出来的文件遮蔽的不止它自己。

修法两条：分层判定只用**纯路径运算**（含 `.js`→`.ts` 映射，完全不看磁盘），存在性判定另走一路；解析不到的 import **记账并打印**，措辞明说「没参与判定」。后者的原则是——**一条「没查」的检查必须说自己在哪儿没查，否则「绿」是个假承诺。**

### 2. `tools/` 从未被类型检查过（顺带发现的上游问题）

`tools/*.ts` 不在任何 tsconfig 的 `include` 里，而 Node 的 type-stripping **只擦类型不校验**。所以这四个脚本的类型错误只会在运行时炸。

**这在 `jev-2048` 同样成立**，且一开检查就抓到真东西：`tools/scan-secrets.ts` 里的 `readRaw()`（`jev-2048/tools/scan-secrets.ts:63-65`）是从未被调用的死代码。已核实其**字节读取的保证完好**——工作区遍历走的是 `readFileSync(full)` → `Buffer` → `scanWithInflate` → `data.toString("latin1")`，那段注释说的「保证任何字节都不会丢失或被跳过」由 inline 实现承载，`readRaw` 只是个没人调用的包装。本仓库删掉了它（注释一行未动）并记入文件头。

**注意**：`jev-2048` 那边**仍在**带着这 4 行死代码，且它的 `tools/` 也仍未被类型检查覆盖。值得回去修一次 —— 那是个安全工具，它自己的正确性没有机器保证。

---

## 已知的坑（写代码时会撞上）

| 坑 | 症状 | 处理 |
|---|---|---|
| `lifeStep` 的 `zero()` 依赖 `m0` 掩码 | 忘记 `& m0` 时 BugInt 的 `~` 是无符号无限位，结果跑到 frame 外 | 所有取反都在 `m0` 掩码内做，断言里加一条 frame 外必须为 0 |
| `noul` 的 criteria 只能是 `{true,false}` | 把后果预测写进 criteria 会 400 | 后果进 `instructions`，且**答案不能写在题面里** |
| `questions` 是 record 不是数组 | 传数组报 `expected record, received array` | 别用 `map()` 生成 |
| 两个请求必须并发 | 顺序 await 结果一样，但代码结构会误导人以为死执能看到生执的落子 | `Promise.all` |
| 无头环境没有 `localStorage` | `config.ts` / `session.ts` 一 import 就崩 | `core/` 不碰存储，配置以参数传入 |
| NodeNext 要求 `.js` 后缀 | 相对 import 漏后缀则编译过了运行时报 `ERR_MODULE_NOT_FOUND` | 所有相对 import 带 `.js` |
