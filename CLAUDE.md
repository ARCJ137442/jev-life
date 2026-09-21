# CLAUDE.md

给在这个项目里工作的 AI 助手。**先读这一页再动手。**

关于「为什么这样设计」的完整推理见 `DESIGN.md`；
执行计划见 `docs/plans/2026-09-21-life-chess-m1.md`。
本文件只写**红线、命令、和容易踩的坑**。

---

## 这个项目是什么

用 Jev 决策模型作为「**生命棋**」（康威生命游戏 + 回合制干预）的实验台。
全 TypeScript，前后端统一，不用打包器。

**核心定位**：测量决策模型在**全新规则**下的适应能力，并顺带测量规则本身是否均衡。
判断任何改动是否合适，先问：*它会让测量更干净，还是更浑浊？*

它相对 `jev-2048` 的增量是两件可独立取用的产物：
1. 「**Jev 的并行决策到底值多少钱**」的测量（64 个问题一次发 vs LLM 的 N 次往返）
2. 「**LLM 转 Jev**」的 broker —— 一个 Jev 兼容的 API 层，能把任意 LLM 包成 Jev

---

## 四条红线

### 1. `core/` 不得 import `client/`

`core/` 要在**无 DOM、无网络的 Node** 里跑（`tools/` 依赖这一点）。
一旦它（哪怕间接）引到 `client/` 或 `i18n`，无头环境立刻崩，而且报错点离原因很远。

`tools/scan.ts` 有构建期硬检查，跑 `./start.sh` 会跑它。**这条是传递闭包意义上的**，
不是逐文件看 import。

### 2. 引擎必须是纯函数

`lifeStep` / `flip` / `legalCells` / `classifyTermination` … **不得修改传入的任何对象**。

`flip` 返回新 `Board`；`Uint8Array` 必须 `Uint8Array.from()` 拷一份，
**不能直接返回入参的底层数组** —— 后者能通过所有「调用前后不变」的断言，
但调用方一改返回值，入参就被污染了。

回归用例在 `src/test/life.test.ts`，用的是「同一批对象 + 快照对比」的手法。
**用 `boardFromRows` 造新棋盘的测试覆盖不到这类 bug。**

### 3. 绝不把密钥写进仓库

密钥只存在于服务端（环境变量 > `*.sealed` > 明文），**绝不下发到浏览器**。
密钥文件放 `../local/`（**在两个仓库之外**，git 够不到）。

> ⚠ `.gitignore` 里的 `../local/` 那两条规则是**空转的** —— gitignore 无法逃出仓库根目录。
> 真正的保护来自「文件物理上在仓库外」。新增密钥时，要确认**确实有一条能命中的规则**
> （`.gitignore` 里的 `local/` 与 `*-secret-api-key*` 是能命中的那两条），
> 而不是「我写过一条」。

测试 fixture 一律用**假值**。`tools/scan-secrets.ts` 会扫工作区与 git 历史。

**本仓库不附带任何 token，fork 的人必须自备**（`DEPLOY.md` 有步骤）。
未配密钥的上游回 **503**，不静默降级、不回落到任何内置凭据 —— 这是刻意的。

> ⚠ **Fork 之后必改的一处**：`src/client/api.ts` 的 `REMOTE_PROXY_BASE`。
> 保持默认值不会报错，但你的静态版会把请求发到**原作者的 Vercel 部署**上、
> 花**原作者**的额度，而你这边界面一切正常。这是「静默失败」的又一种形态。

### 4. 不许用 `git add -A`

**本轮真实踩过**：执行计划自己的收尾写法是 `git add -A`，于是把协调者刚改的文档
扫进了 feature 提交；另一次是有 agent 把别人的在途改动一起提交了。

**一律用显式路径** `git add <文件>`。提交前先看 `git status`。

---

## 常用命令

```bash
./start.sh                    # 密钥扫描 → 分层检查 → DOM 检查 → 测试 → 编译 → 启动（8787）

# 分步
node tools/scan-secrets.ts --history    # 密钥扫描（含 git 历史）
node tools/scan.ts                      # core/ 分层检查
node tools/check-dom.ts                 # HTML 与 TS 的 id 一致性
node tools/bench-step.ts                # 两个演化实现的基准（诊断工具，退出码恒 0）
npm test                                # tsc -p tsconfig.test.json && node --test dist-test/test/*.test.js
npm run typecheck                       # 五份 tsconfig
```

### 工具怎么拿到 core

`tools/*.ts` 要**运行时**用 `src/core/`，一律调 `tools/_load.ts` 的 `loadCore()`。
它检查编译产物是否存在、是否比源码旧，然后动态 import。**任何工具都不许自己 import `dist-test`。**

后缀规则（**两条路径的差异，不是风格选择**）：

| 位置 | 相对 import 的后缀 |
|---|---|
| `src/**` | `.js`（先编译再运行，`.js` 是产物的真实后缀） |
| `tools/*.ts` 之间 | `.ts`（Node 的 type-stripping 直接运行，**不做 `.js`→`.ts` 重写**） |
| `tools/` 里只要类型 | `import type ... from "../src/...js"` |

---

## Termux 环境坑（**每一条都真踩过**）

| 坑 | 症状 | 绕法 |
|---|---|---|
| `npm` / `npx` / `tsc` 的 shebang 指向不存在的 `/usr/bin/env` | 直接执行报 `bad interpreter` | `node $(command -v npm) ...` / `node node_modules/typescript/bin/tsc ...` |
| **`grep` 被一个坏掉的 shell 函数覆盖** | 报 `-G: error while loading shared libraries` | 用 `command grep` |
| **`find` 同样被覆盖** | 报 `-S: error while loading shared libraries` | 用 `command find` |
| `/tmp` 不可写 | `Permission denied`，脚本静默没跑 | 临时文件写 `$HOME` |
| `./start.sh` 末行会 `exec` 阻塞 | 前台跑会挂住 | 后台跑 + `sleep 8` + `kill %1` |

---

## 结构

`✓` = 已有，`⏳` = 计划中但**还没建**（括号里是负责它的任务号）。

```
src/core/                ★ 无 DOM、无网络，Node 直接可跑
  types.ts               ✓ Board / Role / Topology / GameRules / GameSnapshot / Termination
  life.ts                ✓ 演化 / 翻转 / 合法格 / 状态哈希 / 终局判定
  patterns.ts            ✓ 结构检测库（按棋盘尺寸分级收录）
  presets.ts             ✓ 尺寸预设 + 开局库
  context.ts             ✓ buildState / buildQuestions（★ 见下方「T12 必须做的一次搬迁」）
  decide.ts              ⏳ 概率分布 → 动作（T11）
  channels.ts            ⏳ 三条评估通道（T13）
src/shared/types.ts      ⏳ 共享类型；`src/shared/` 目录已存在但为空
src/client/              ⏳ 浏览器 UI（**目录尚未创建**，T12 起）
src/server/server.ts     ✓ 静态托管的**占位实现**（T12 换成带密钥代理的正式版）
src/test/                ✓ 8 个测试文件，100 条用例
tools/                   ✓ _load / bench-step / check-dom / scan-secrets / scan / seal-key
docs/plans/              ✓ 执行计划（M1 全部任务）
docs/ui-spec.md          ✓ UI 规格（T14–T15 的定稿）
docs/llm-backends.md     ✓ LLM 后端规格（**文档先行**，等时机到了再交给 subagent 实现）
```

### ⚠ T12 必须做的一次搬迁

`context.ts` 里**暂时**住着 Jev 协议的最小集（`NoulType` / `Criteria` / `Question` /
`Questions` / `noulDiscriminator`）与 `TurnRecord`。**T12 建好 `src/shared/types.ts` 后
必须把它们搬过去并删掉原地的副本** —— 否则同一个类型会有两份，而两份类型定义迟早会
各自演化（`jev-2048` 的 `Strategy` 类型就被定义了两遍）。

### ⚠ `tools/seal-key.ts` 现在跑不了

它 import 的 `src/server/seal.ts` 要到 T12 才建，因此被排除在 `tsconfig.tools.json` 之外。
T12 建出 `seal.ts` 后要把那行 exclude 删掉。

---

## 约定

- **提交信息**用 Conventional Commits，**中文正文**，写**为什么**不写做了什么
- **注释解释「为什么」**，不解释「是什么」
- 改 `src/client/` 后**必须**跑 `check-dom.ts`；改 `.ts` 后**必须**跑 typecheck
- 新增 UI 元素时同步更新 `boot()` 里的 `assertDom([...])` 白名单
- **断言消息里带可复现的输入**（棋盘、seed、实现名），失败时能直接粘成回归用例

### 测试纪律

- **变异测试**：写完实现后故意改坏关键逻辑，确认测试真的会失败。
  **改之前先 `grep` 确认改动生效** —— 协调者与多个 agent 都因 `sed` 没匹配上而
  **测了没改过的代码**，得出了假结论
- **等价变异如实报告**，不要假装它红了
- **差分测试要有下限断言**（`checked >= N`），且**逐实现**成立 ——
  总数达标可能是被另一条腿撑起来的

---

## 发布前的流程

**任何仓库推成公开之前，先由一个无上下文 subagent 独立复核。**

用新 agent，不要复用已经知道问题在哪的那个 —— 那只能算复验，不算双盲。
提示词里要明确要求它**用自己的方法独立验证**，不能只信仓库自带的工具。

理由是实际教训：`jev-2048` 的扫描工具曾连续漏检三次，每一次都是**工具自身的盲区**。
独立视角的价值不在于更仔细，而在于**没有共同的盲区**。

---

## 已知边界

完整清单见 `DESIGN.md` 第十二节。最要紧的几条：

| 项 | 状态 |
|---|---|
| 胜负阈值与预设参数 | **全是占位值**，未经跑分标定 |
| 思维链对决策质量的影响 | **完全未测** |
| 免费 LLM 额度的具体配额 | 只知道「按 token 计」，阈值未测 |
| LLM 单次成功率 | **波动极大**，别引用任何单次采样得出的百分比 |
| `bitwiseStep` | 不参与生产，身份是独立差分基准，**别删** |
