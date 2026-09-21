# 生命棋 M1 实现计划（无头跑通 → 本地 localhost 试玩）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 从零建立 `jev-life` 仓库，交付「能无头打完一整局 Jev vs Jev」的规则引擎与决策管线，再到本地 localhost 的可视对局。

**Architecture:** 三层——`core/`（无 DOM、无网络，Node 可直接跑）、`client/`（浏览器 UI）、`server/`（静态托管 + 密钥代理）。`core/` 是本项目相对 `jev-2048` 的关键结构改动：2048 的 `buildState`（`main.ts:388-419`）与 `buildQuestions`（`main.ts:421-445`）住在 `main.ts` 且**直接读 DOM**（`main.ts:416`），导致无头环境跑不起来。

> ⚠ **引用 `main.ts` 时优先用函数名，别用行号。** 该文件迭代频繁——本计划基于 `a63309c` 写成，到 `9582bcf` 时它已漂移 13–31 行（实测：`buildState` 388–419、`buildQuestions` 421–445、`boot` 2045–2098、`$()` 139、`assertDom` 143、`DRAWERS` 1112、`showOverlay` 524、`pushLog` 726、`relanguage` 2013）。其余被引用的文件（`render.ts` / `decision.ts` / `types.ts` / `engine.ts` / `metrics.ts`）在同期没动过，行号仍然准。

**Tech Stack:** TypeScript 5.9（`strict`）、Node ≥ 22（type-stripping 直接跑 `tools/*.ts`）、无打包器（浏览器原生 ESM）、无运行时依赖、`node:test` + `node:assert/strict`。

**源仓库（复刻来源）:** `/data/data/com.termux/files/home/A137442/projects/Jev/jev-2048`
**新仓库:** `/data/data/com.termux/files/home/A137442/projects/Jev/jev-life`

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
cd /data/data/com.termux/files/home/A137442/projects/Jev
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
cd /data/data/com.termux/files/home/A137442/projects/Jev/jev-life
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
cp /data/data/com.termux/files/home/A137442/projects/Jev/jev-2048/tools/scan-secrets.ts tools/
cp /data/data/com.termux/files/home/A137442/projects/Jev/jev-2048/tools/seal-key.ts tools/
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
 * 跑分工具（tools/bench.ts）要在 Node 里跑同一个 core/。一旦 core/ 里的
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
#!/data/data/com.termux/files/usr/bin/bash
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
  const block = [[".##.", ".##.", "....", "...."]];  // 4×4
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

test("bounded：角落格子的界外邻居算死", () => {
  // 三个活细胞排满第一行 —— bounded 下这是 Blinker 的退化形态，
  // 因为界外不算邻居；torus 下则完全不同。
  const b = boardFromRows(["###.", "....", "....", "...."]);
  const n = referenceStep(b, "bounded");
  assert.deepEqual(toRows(n), [".....", ...].slice(0, 0) as never ?? toRows(n));
  // 具体断言见下一条测试，这里只确认不抛异常
  assert.equal(n.cols, 4);
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

test("torus：单行活细胞横向环绕成环", () => {
  // 整行全活不是有效测试；用两个活细胞隔一列，环绕后它们成为相邻
  const b = boardFromRows([".#.#", "....", "....", "...."]);
  const n = referenceStep(b, "torus");
  // 环绕后 (0,0) 与 (0,3) 相邻，(0,1) 与 (0,2) 相邻，四个格子各有两个水平邻居
  assert.ok(aliveCount(n) > 0, "环绕拓扑下应有细胞存活");
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
- Modify: `src/core/life.ts`
- Test: `src/test/life-rules.test.ts`

**Step 1: 写失败测试**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardFromRows, boardKey, classifyTermination, lifeStep, legalCells, flip } from "../core/life.js";
import type { GameRules } from "../core/types.js";

const rules: GameRules = {
  turnLimit: 90,
  netGrowthThreshold: 22,
  minAlive: 2,
  maxAlive: 51,
};

test("boardKey 对相同棋盘稳定，对不同棋盘不同", () => {
  assert.equal(boardKey(boardFromRows([".#", ".."])), boardKey(boardFromRows([".#", ".."])));
  assert.notEqual(boardKey(boardFromRows([".#", ".."])), boardKey(boardFromRows(["#.", ".."])));
});

test("boardKey 不含尺寸，尺寸不同的棋盘不会撞 key", () => {
  // 4×4 全死 与 2×2 全死 的 cells 都是 0 填充但长度不同
  assert.notEqual(boardKey(boardFromRows(["....", "....", "....", "...."])), boardKey(boardFromRows(["..", ".."])));
});

test("活细胞降到 minAlive 及以下时终局", () => {
  const b = boardFromRows(["....", ".#..", "....", "...."]);   // 1 个活细胞
  assert.deepEqual(classifyTermination(b, rules, 10, new Set()), { reason: "minAlive" });
});

test("活细胞升到 maxAlive 及以上时终局", () => {
  const rows = Array(8).fill("########");
  rows[7] = "#######.";                                        // 63 = 51 以上
  const b = boardFromRows(rows);
  assert.deepEqual(classifyTermination(b, rules, 10, new Set()), { reason: "maxAlive" });
});

test("达到回合上限时终局", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  assert.deepEqual(classifyTermination(b, rules, 90, new Set()), { reason: "turnLimit" });
});

test("无合法动作时终局 —— 这是设计文档漏掉的一条", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  // 构造：所有候选翻转都会导致重复
  const seen = new Set([boardKey(b)]);
  for (const cell of legalCells(b, "life")) {
    const after = lifeStep(flip(b, cell), "bounded");
    seen.add(boardKey(after));
  }
  // 全部候选都落在 seen 里 → repeatBlocked
  assert.deepEqual(classifyTermination(b, rules, 10, seen), { reason: "repeatBlocked" });
});

test("终局判定不改动入参", () => {
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  const before = Array.from(b.cells);
  classifyTermination(b, rules, 10, new Set());
  assert.deepEqual(Array.from(b.cells), before);
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

`classifyTermination(b, rules, turn, seen)` 的判定顺序**有讲究**：先查立即终局条件（minAlive / maxAlive），再查回合上限，最后查重复。顺序影响原因归属，必须固定并写进注释。

`repeatBlocked` 的语义：**当前行动方没有任何一格能翻**（每一格翻完演化一代后都会落进 `seen`）。注意这是**对某一方**成立——生执和死执的合法集不同，可能一方走投无路而另一方还有路。所以实际签名是 `classifyTermination(b, role, rules, turn, seen)`，**加 `role` 参数**。

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

**结构库按棋盘尺寸分级**，不是一张固定的表。判据是「棋盘边长至少是结构包围盒的 1–2 倍」——放不下的结构收录进来只会在每回合白算一遍，还会给 Jev 提供它用不上的信息。

| 棋盘边长 | 收录 | 理由 |
|---|---|---|
| 5–6 | `block`(2×2) `blinker`(3×1) `glider`(3×3) | 6×6 只放得下这些；滑翔机 3×3 已是边长的 1/2 |
| 8 | + `beehive`(4×3) `loaf`(4×4) `toad`(4×2) `beacon`(4×4) `eater1`(4×4) | 4 格宽恰是 8 的 1/2 |
| 12 | + `lwss`(5×4) | |
| 16 | + `pulsar`(13×13) | 13/16 ≈ 0.81，是唯一一个贴到边的；再小就放不下 |

`gosperGliderGun` **不收录** —— 它 36 格宽、9 格高，`MAX_SIZE` 是 16，放不进去。若将来要支持，得先把 `MAX_SIZE` 提到 40 以上，届时全量 noul 会变成 1600 个问题，需要单独论证。

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
import type { Board, Topology } from "./types.js";

export interface GameRules {
  /** 回合上限 */
  readonly turnLimit: number;
  /** 生之执获胜所需的累计净增长 */
  readonly netGrowthThreshold: number;
  /** 活细胞数 ≤ 此值时立即终局 */
  readonly minAlive: number;
  /** 活细胞数 ≥ 此值时立即终局 */
  readonly maxAlive: number;
}

export interface SizePreset {
  readonly cols: number;
  readonly rows: number;
  readonly opening: readonly string[];   // 开局局面，'.' / '#'
  readonly rules: GameRules;
  readonly defaultTopology: Topology;
  /** 参数是否经过跑分标定。未标定的预设界面上必须显式标注 */
  readonly calibrated: boolean;
}
```

**Step 2: 8×8 用设计文档 12.2 的值**

```ts
{
  cols: 8, rows: 8,
  opening: [ /* 1 个方块 + 1 个滑翔机，共 14 活细胞 —— 具体坐标见设计文档 12.2 */ ],
  rules: { turnLimit: 90, netGrowthThreshold: 22, minAlive: 2, maxAlive: 51 },
  defaultTopology: "bounded",
  calibrated: true,
}
```

**Step 3: 其余尺寸留未标定标记**

对 5×5 / 6×6 / 10×10 / 12×12 给出**结构上合理但未经实测**的默认值，`calibrated: false`。开局局面必须用 `lifeStep` 跑几十步确认不会立刻崩溃或填满——写一条测试做这件事：

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

```ts
{
  board,                    // 二维 0/1 网格（人能直接读）
  board_legend,             // "0=死格，1=活格；棋盘 8×8；边界：有界（界外视为死）"
  role,                     // "life" | "death"
  role_statement,           // 见 Step 2 —— 角色的目标陈述
  objective,                // 计分规则的文字描述
  horizon,                  // "本局共 90 回合，当前第 12 回合"
  termination_conditions,   // 由 rules 生成的完整文字
  win_condition,            // "累计净增长 > 22 即生之执获胜"
  topology, topology_note,  // 环绕/有界的文字说明（Jev 需要知道边界怎么算）
  alive_count, turn, scores,
  valid_cells,              // 合法格坐标列表
  detected_patterns,        // 来自 T8
  strategy_hint,            // 用户可编辑的实验变量
  recent_history,           // 受记忆预算约束
}
```

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

这是关卡一的验收物，同时是 `tools/bench.ts` 的雏形。要求：

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

**新的可视化机会**：`noul-all` 会返回 N² 个概率，**直接画成棋盘热力图**。2048 只有 4 个概率，只能退而画 `chart.ts` 的带状面积图；生命棋可以把概率画在对应格子上。

**Commit**

---

## 完成 M1 的验证清单

```bash
cd /data/data/com.termux/files/home/A137442/projects/Jev/jev-life

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
