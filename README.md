# 生命棋 × Jev

|**简体中文** | [English](README.en.md)|
|:-:|:-:|

> **English readers:** full English documentation → [**README.en.md**](README.en.md)
>
> An **experimental game**: write a new ruleset, then immediately watch it be played. **The Chess of Life** — named
> after Conway's *The Game of Life* — is its first ruleset: turn-based intervention on a Life board, where both sides
> flip one cell and the board then evolves. **Nobody has played it before**, so there is no opening theory and no
> human strong play to imitate, and
> [TypeSafe AI's Jev](https://www.typesafe.ai/) is both the tool for exploring the rules and their **first player** —
> one typed `boolean` per legal cell, all in a single request, with **no heuristic fallback**. Because the rules are
> not self-evident they render from editable templates with auto-filled placeholders: rewrite a rule, re-ask.
> Alongside it sits a **Jev-compatible broker** that wraps any OpenAI- or Anthropic-compatible LLM into a Jev backend,
> so the two can play the same board.

<!-- 📝徽章安排参考：https://daily.dev/blog/readme-badges-github-best-practices#organizing-badges-in-your-readme -->

![License](https://img.shields.io/badge/license-MIT-78dce8?style=for-the-badge)
![Code Size](https://img.shields.io/github/languages/code-size/ARCJ137442/jev-life?style=for-the-badge&color=78dce8)
![Language](https://img.shields.io/badge/language-TypeScript-78dce8?style=for-the-badge)
![Node](https://img.shields.io/badge/node-%E2%89%A522-78dce8?style=for-the-badge)

<!-- 面向用户 -->

试玩：

[![Online Demo](https://img.shields.io/badge/%E5%9C%A8%E7%BA%BF%E8%AF%95%E7%8E%A9-Vercel-78dce8?style=for-the-badge)](https://jev-life.vercel.app)

<!-- 面向开发者 -->

开发状态：

[![CI](https://img.shields.io/github/actions/workflow/status/ARCJ137442/jev-life/ci.yml?style=for-the-badge&label=CI)](https://github.com/ARCJ137442/jev-life/actions)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-78dce8?style=for-the-badge)](https://conventionalcommits.org)
![Last Commit](https://img.shields.io/github/last-commit/ARCJ137442/jev-life?style=for-the-badge&color=78dce8)

---

## 简介

一个**实验性游戏**：为「**写一套新规则，然后立刻看它能被怎样玩**」而做的网页实验台，全 [TypeScript](https://www.typescriptlang.org/) 编写。

「生命棋」是它的第一份规则。玩法的**起点是一个人**：**每次演化前翻转一个格子**，
定向干预康威生命游戏的演化、**创造更多的生命** —— 而演化本身你控制不了。

它**可以演变成双人对抗**，而且刻意**不对称**：**生之执**把死格翻成生、**死之执**把生格翻成死。
两个名字里的「执」取自围棋的**执子** —— 落子的那只手。不对称不只是风味：
两边的合法集**天然互斥**（生之执只能翻死格、死之执只能翻活格），所以两边同时出手
**不可能撞在同一格上**，不需要任何冲突消解规则。

规则本身、胜负线与开局库都由本仓库定义 —— 而且**规则怎么写、胜负线画在哪、开局长什么样，都是你可以改的**。

[TypeSafe AI 的「Jev」](https://www.typesafe.ai/) 在这里有两个身份：**探索规则的工具**，以及每一套新规则的**第一个玩家**。
它不生成文本：接收一段「状态」与一组带类型的「问题」，返回**带校准概率的结构化决策**。
本项目把每一次翻格都交给它决策，并把它的「概率分布」「置信度」「延迟」「token 消耗」全部摊开在界面上。

> ★ **为什么这里需要一个「第一个玩家」**
>
> 任何原创游戏在被玩明白之前，**都不存在人类先例** —— 没有棋谱、没有攻略、没有高手可模仿。
> 一套刚被写出来的规则，最缺的恰恰是「有人真的按它走一遍」。
> Jev 从**规则本身**上手，而「规则该怎么讲给它听」也是可编辑的 ——
> 于是一套新规则**能不能玩、有没有讲清楚**，在一局之内就能看到。

让「决策模型如何在全新规则下适应」变得**可见、可调、可测量**，是这件事在本项目里的落点。

它是 [`jev-2048`](https://github.com/ARCJ137442/jev-2048) 的**姊妹项目，不是它的分支** —— 骨架同源，玩法与测量的东西完全不同。
相对那一个，它有**两件可以独立取用的增量**：

- 📌 **「Jev 的并行决策到底值多少钱」的测量** —— 8×8 棋盘有 64 格，**每个合法格各一道布尔题**，
  全部**一次发出去** —— 对照 LLM 走 broker 时需要的往返次数。
  延迟、上游调用次数、成本在返回值里是一等输出，不是事后补的统计。
- 📌 **「LLM 转 Jev」的 broker** —— 一个 Jev 兼容的 API 层，能把任意 OpenAI / Anthropic 兼容的 LLM
  包成 Jev。上层的决策与评估代码一行不改，也**分不出**对面是 Jev 还是一个被包装的 LLM。

---

## 在线演示

| 部署方式 | 地址 | 说明 |
|---|---|---|
| Vercel | <https://jev-life.vercel.app> | 自带服务端函数，三条「免费试用」后端同源可用 |
| GitHub Pages | <https://arcj137442.github.io/jev-life/> | 纯静态，跨域调用上面那份的免费试用端点 |

> ✅ **两处都已部署并在跑**（`2026-09-21` 发布 `1.0.0`）。上面就是实际地址，点开即可试玩、无需配置密钥。
> 想自己部署一份也可以 —— 步骤见 [`DEPLOY.md`](DEPLOY.md)；**fork 的话要先改 `JEV_LIFE_REMOTE_BASE`**
> （那份文档的第三节说明了不改会发生什么）。

两种形态都能用到内置的「免费试用」后端，无需配置密钥即可试玩
（Pages 那份靠仓库变量 `JEV_LIFE_REMOTE_BASE` 指向 Vercel 那份，见 [`DEPLOY.md`](DEPLOY.md)）。
额度有限，用尽时会提示切换到自己的 API 密钥 —— 也可用下面「快速开始」在本地跑。

> ⚠️ **「免费试用」那份额度由原作者自费提供，请勿滥用。**
> 这几条端点**公开且无鉴权**（刻意的 —— 它们给人试玩，不是给人跑批量）。
> 额度按 token 计，用完即止；**持续或批量使用请切到「自备密钥」那几条后端** ——
> 项目本身就是为「让任意 LLM 接进来」而设计的，自带密钥反而没有配额焦虑。

> 📝 **纯静态托管怎么处理密钥？** 静态站点没有服务端函数，所以它**不持有密钥**，
> 而是跨域调用 Vercel 上的那份部署，密钥仍在 Vercel 的函数进程里。
> 远端地址由 `src/client/deploy.ts` 的 `REMOTE_PROXY_BASE` 决定 —— 它默认是**空字符串，刻意不给默认值**：
> 写死一个域名等于让别人的 fork 静默消耗原作者的额度。空值时静态版直接隐藏那几条后端，
> 而不是发一堆注定 404 的请求。

---

## 快速开始

### 前置条件

1. 安装 [**Node.js**](https://nodejs.org/)（≥ 22）
2. 准备 API 密钥（可选，仅在使用自备后端、或想在本地跑「免费试用」代理时需要）

### 尝鲜：即刻运行

```bash
git clone https://github.com/ARCJ137442/jev-life.git
cd jev-life
npm install
./start.sh
```

`start.sh` 会依次执行七步，任一步失败即中止：

```plaintext
▸ 扫描密钥…                             tools/scan-secrets.ts
▸ 检查分层（core/ 不得 import client/）…  tools/scan.ts
▸ 检查 DOM id 一致性…                    tools/check-dom.ts
▸ 运行单元测试…
▸ 编译客户端 (src/client → public/js)…
▸ 编译服务器 (src/server → dist)…
▸ 启动服务器…                            8787
```

启动后终端会打印访问地址：

```plaintext
本机访问   http://localhost:8787/
局域网访问 http://<你的局域网IP>:8787/
```

### 提供密钥

密钥按以下优先级读取（三条路径任意一条即可）：

1. 环境变量
2. `../local/<名字>.sealed`（封存后的密文）
3. `../local/<名字>`（明文，兼容旧布置）

| 后端 | 环境变量 | 本地密钥文件（`../local/`） |
|---|---|---|
| 「免费试用 1」`/api/evaluate` | `VERCEL_AI_GATEWAY_KEY` | `vercel-secret-api-key` |
| 「免费试用 2」`/api/evaluate2` | `OPENROUTER_API_KEY` | `openrouter-secret-api-key` |
| 「LLM 免费试用 1」`/api/evaluate3` | `AGNES_API_KEY` | `agens-flash-secret-api-key` |

把明文密钥封存起来：

```bash
node tools/seal-key.ts ../local/vercel-secret-api-key
# → 生成 ../local/vercel-secret-api-key.sealed，服务器会自动优先读它
# 确认服务正常后，可以删掉明文：
rm ../local/vercel-secret-api-key
```

> ⚠️ **这不是密码学保护。** 默认口令就写在 `src/server/seal.ts` 里，拿到仓库就能解开。
> 它挡的是「明文躺在磁盘上被 `cat` 到、被截图、被误提交」这类**意外暴露**，不是针对性攻击。
> 真正的密钥保护是「不下发到客户端」与「服务端环境变量」。
> 想更严一点：设 `JEV_SEAL_PASSPHRASE`，源码里就只剩一个无用的默认值。

> ⚠️ **密钥文件放在 `../local/`，也就是仓库之外。** `.gitignore` 逃不出仓库根目录，
> 所以那两条 `../local/` 规则其实是空转的 —— 真正的保护是「文件物理上在仓库外」。
> 仓库里不含任何密钥；未配密钥的上游一律回 **503**，不静默降级、不回落到任何内置凭据。

### 进阶：源码编译

```bash
# 类型检查（五份 tsconfig）
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.api.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit

# 单元测试（461 项）
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test dist-test/test/*.test.js

# 构建
node node_modules/typescript/bin/tsc -p tsconfig.client.json   # → public/js/
node node_modules/typescript/bin/tsc -p tsconfig.server.json   # → dist/
```

缩写：`npm test`、`npm run typecheck`。

> 📝 本项目**不使用打包器**。客户端用浏览器原生 ES Modules，
> tsc 直接输出带 `.js` 扩展名的 import 路径，浏览器能原生加载。
> Termux 下 `npm`/`npx` 的 shebang 指向不存在的 `/usr/bin/env`，
> 所以 `start.sh` 用 `node` 直接跑 tsc 的 JS 入口绕开它。

### 无头跑一局

不想开浏览器也可以：

```bash
# 不花额度：固定 seed 的假概率，跑完整条管线
node tools/play.ts --dry-run --size 8x8 --turns 20

# 走本机服务器（先 ./start.sh），由它注入密钥
node tools/play.ts --size 8x8 --turns 4
```

`tools/play.ts` 跑的是与界面**同一条**管线：组题 → 发一次请求 → 解析 → 决策 → 落子 → 演化 → 判终局。

---

## 项目概览

### 声明

本项目是「Jev」的一个**第三方实验台**，与 TypeSafe AI 无隶属关系。
「康威生命游戏」的规则属公有领域，本项目仅借用它作为一个有明确目标的决策场景；
在它之上定义的「生命棋」玩法属于本仓库。

### 系统模块架构

```plaintext
jev-life
├── src
│   ├── core                        ★ 无 DOM、无网络的纯函数层，Node 直接可跑
│   │   ├── types.ts:       Board / Role / Topology / GameRules / GameSnapshot / Termination
│   │   ├── life.ts:        演化 / 翻转 / 合法格 / 状态哈希 / 终局判定
│   │   ├── patterns.ts:    结构检测库（静物 / 振荡器 / 飞船 / 炮 / 吞食者）
│   │   ├── presets.ts:     尺寸预设（4 / 8 / 16）+ 分尺寸的开局库
│   │   ├── context.ts:     buildState / buildQuestions —— 棋盘 → Jev 的 state
│   │   ├── template.ts:    规则说明书的「模板 + 占位符自动填充」
│   │   ├── channels.ts:    评估通道 —— 一次请求问什么、回包怎么读 ★
│   │   └── decide.ts:      决策策略 —— 把概率分布转换成实际翻哪一格 ★
│   ├── shared
│   │   ├── types.ts:       Jev 协议类型（SystemOne）+ 判别值归一化
│   │   ├── backend.ts:     决策后端适配层（统一契约 + 各实现）
│   │   └── llm-broker.ts:  Jev–LLM broker ★ 纯函数，浏览器与 Node 两边都能跑
│   ├── client
│   │   ├── api.ts:         后端目录 BACKENDS + 地址解析
│   │   ├── deploy.ts:      远端代理地址（默认空字符串，刻意不给默认值）
│   │   ├── main.ts:        装配层：core → DOM
│   │   ├── render.ts:      Canvas 棋盘渲染 + 三种动画（落子 / 迭代 / 粒子）
│   │   ├── chart.ts:       侧栏三张图（置信度 / 生死态势 / 决策热力图）
│   │   ├── score.ts:       记分板取值 —— 一个回合的两个时刻
│   │   ├── mode.ts:        模式切换的**界面侧**影响（单人局里哪些栏是死的）
│   │   ├── config.ts:      长期设置持久化（不含密钥）
│   │   ├── session.ts:     对局持久化（支持刷新续玩）
│   │   ├── archive.ts:     存档导入导出（带 app / v / kind 三道校验）
│   │   └── i18n.ts:        界面国际化（刻意**不**翻译喂给 Jev 的正文）
│   ├── server
│   │   ├── server.ts:      本机服务器 + 三条上游的密钥代理
│   │   └── seal.ts:        密钥封存（AES-256-GCM）
│   └── test:               23 个测试文件，461 条用例
├── api:                    Vercel Serverless Functions（三条免费试用后端）
├── tools
│   ├── _load.ts:           工具拿 core 的唯一入口（并检查产物是否过期）
│   ├── check-dom.ts:       构建期 DOM id 一致性检查
│   ├── scan.ts:            分层检查：core/ 的传递闭包不得触及 client/
│   ├── scan-secrets.ts:    密钥扫描（按字节读 + zlib 解压复扫 + git 历史）
│   ├── bench-step.ts:      两个演化实现的基准（诊断工具，退出码恒 0）
│   ├── play.ts:            无头跑完一整局（--dry-run 不花额度）
│   └── seal-key.ts:        明文密钥 → 密文
├── public:                 单页界面 + 编译产物
├── docs
│   ├── ui-spec.md:         UI 规格
│   └── llm-backends.md:    LLM 后端规格与跨提供商实测记录
├── DESIGN.md:              设计决策记录（交接用，记录「为什么」）
└── ...
```

### 所用技术特性

- 📌 **纯 TypeScript，前后端统一**，不使用打包器
- 📌 **核心层无 DOM、无网络**：`src/core/` 的**传递闭包**里有 `src/client/` 就直接构建失败
  （`tools/scan.ts`，`./start.sh` 与 CI 都会跑）。跑分工具全靠这一点才能在纯 Node 里跑
- 📌 **引擎是纯函数**：`lifeStep` / `flip` / `legalCells` / `classifyTermination` 绝不修改入参。
  `flip` 返回新 `Board`，`Uint8Array` 必须拷一份 —— 直接返回入参的底层数组能通过所有
  「调用前后不变」的断言，但调用方一改返回值，入参就被污染了
- 📌 **两条独立的差分基准**：生产用的 `lifeStep` 与差分基准 `referenceStep` 是同算法的两份独立写法，
  再加上建模方式完全不同的位并行 `bitwiseStep`。三者互相对账 ——
  同一套概念模型里的两条腿会**一起瘸**，第三条腿才抓得住概念性错误
- 📌 **Canvas 渲染棋盘**：几何构造性正确（`2·pad + n·cell + (n-1)·gap` 恒等于边长），
  换任何棋盘尺寸四边都严格等距，不需要调参
- 📌 **不引入任何启发式算法**：模型不确定时不悄悄换算法，而是把「不确定性」暴露给用户
- 📌 **零凭据下发**：代理后端的 API 密钥只存在于服务端进程；自备密钥的 LLM 后端连服务端都不经过，
  密钥只在你自己那台浏览器的内存里，不落盘、不随存档导出

### 可调参数

界面分五个抽屉，顺序即一条用户动线：
**游戏 → 策略 → API → 日志 → 存档**。

配置分**两级**，判据是「**这个设置属于谁**」：

| 级别 | 项 | 判据 |
|---|---|---|
| **对局级** | 棋盘尺寸 / 拓扑 / 对局模式 / 终局规则 / 开局 | 它们是**博弈的定义**，两边不同就不是同一个游戏 |
| **玩家级** | 后端 / 模型 / 密钥 / 调用策略 / 评估通道 / 记忆轮数 / 后果开关 / 自动结构识别 / 规则说明书模板 / 策略提示 / 策略 / 置信度门槛 | 描述**这个玩家怎么想** |

「双侧同步」因此不是一个分区的属性，而是一个**动作**：把一边的玩家级设置整体复制到另一边。

> ⚠️ **2048 那条分区判据在这里失效了。**
> 那边的判据是「影响谁的输入」，结论是「游戏」项与「API」项都不影响模型的输入。这里**两项都破了**：
> 生命棋的规则**不自明**，所以每一项规则都必须写进发给 Jev 的 `state`；
> 而换一个后端 = 换一套 prompt 构造方式，也影响模型的输入。
>
> 新判据的第二条是「**改了它，该去看什么**」：

| 分区 | 改它之后该观察什么 |
|---|---|
| 游戏 | 概率分布**应该**变（与 2048 相反） |
| 策略 › 上下文 | 概率分布 |
| 策略 › 规则 | 实际走了哪一步 |
| **API** | **延迟、上游调用次数、成本** —— 只有这一分区产生这三样 |

> 📝 2048 那条判据有个很好用的副产品：「改一个游戏项，若分布变了说明有 bug」，可以直接当回归测试。
> 新判据给不出这么干净的断言，只能给出上面这张「该观察什么」的表。

其中「策略 › 上下文」的几组参数是本实验台的核心：

| 参数 | 注入位置 | 观察什么 |
|---|---|---|
| **规则说明书（六项模板）** | `state.rules` | 措辞由你定、数值由设置**自动填充**（`{{lifeWinRatio}}` 这类占位符）。⚠️ 删掉某个占位符 = 模型不知道获胜条件，界面会警告而不阻止 |
| 「规则说明（补充）」 | `rules.rule_note` | 正文由模板渲染，这里只填补充；留空则整个字段不出现 |
| 「策略提示」 | `aids.strategy_hint` | 生命棋的知识（哪些是静物、滑翔机会飞）恰恰是这套实验要测的东西，所以**默认留空** |
| 「后果预测」 | 题面背景 | 打开后把「这一手 + 演化一代」的活细胞数变化写进题面。**只是背景** —— 问的自始至终是长期价值，否则等于把答案写在题面上 |
| 「记忆轮数」 | `aids.recent_history` | 把最近 n 回合的局面、双方落点、净增长一并发过去。0 = 不加入 |
| 「自动结构识别」 | `aids.detected_patterns` | **默认开**。关掉它就是「把脚手架整个拆掉，看模型还剩多少」 |

### 关于「不使用启发式」

一旦模型不确定时悄悄换成规则算法，测量就被污染了 ——
你无法区分「这一手是 Jev 走的」还是「规则走的」。

所以本项目的做法是：把不确定性**标记**出来，交由用户判断。
置信度门槛默认 **0**，即全程逐手使用模型输出。

### 各网关的命名差异 ⚠️

同一个 Jev、同一份「SystemOne」协议，各家做了**不同的命名选择**：

| | TypeSafe 官方 | OpenRouter | AI/ML API | Vercel Gateway |
|---|---|---|---|---|
| 端点 | `/v1/systemone` | `/api/v1/systemone` | `/v1/decisions` | `/v1/evaluate` |
| 模型 ID | `jev-latest` | `typesafe/jev-1.13` | `typesafe/jev` | `typesafe-ai/jev` |
| **布尔判别值** | `noul` | `noul` | `noul` | **`boolean`** |

**Vercel 是唯一的异类** —— 它自己封装时把 `noul` 改名成了 `boolean`。
这条一度被搞反：「文档说 noul、API 实际叫 boolean」只对 Vercel 成立。

`choice` 与 `score` 四家完全一致，所以本项目主流程不受影响。
但生命棋**主流程走的正是布尔题**（每个合法格一道 `noul` 题），判别值传错会被上游直接 400 ——
所以归一化做在**服务端**：客户端只发语义（「这是一道布尔题」），代理知道自己背后是谁，翻译由它做。

> ⚠️ 这里有一个**真实踩过的坑**：代理后端的界面 id 与真实上游不是一回事 ——
> 「免费试用 1」的 id 是 `localproxy`，它背后却是 Vercel。按界面 id 推判别值必然推错，
> 症状是**默认后端一发就 400**。

### 想用本地模型跑？

**两种「本地」要分开说。**

**① 直接用 Jev：普通的 OpenAI 兼容端点接不了。**

Jev 是决策模型：接收 `state` + `questions`，返回带概率的结构化答案，
**没有 `/v1/chat/completions`**。LM Studio / vLLM / Ollama 的 OpenAI 兼容层
本质是「文本补全」，与 SystemOne 协议不匹配 —— 职责不同，不该硬凑。

正确做法是**让本地侧实现 SystemOne 协议**，把 OpenAI 兼容留在文本模型那一层。
完全离线跑 Jev 不可行 —— 官方未开放权重。

**② 用本地 LLM 冒充 Jev：这正是本项目的 broker 干的事。**

「LLM 兼容」与「Jev 兼容」之间那层翻译就是 [`src/shared/llm-broker.ts`](src/shared/llm-broker.ts) ——
它把 Jev 形状的请求翻译成 LLM 调用、再把回包翻译回 Jev 形状，**上层一行不改也分不出对面是谁**。
它是有意做成**纯函数**的：不碰 DOM、不碰网络，所以同一份代码能在浏览器里跑
（用户自备密钥那两条后端）也能在 Node 里跑（无头 CLI）。

想接一个自建端点，在「API」抽屉里选「自建 / 本地兼容端点」，填地址即可。

### 离线替代：Laya

[Laya](https://github.com/NandhaKishorM/laya)（Apache-2.0）是 Jev 的**开源替代** ——
同样是非自回归决策模型，一次前向回答全部问题，不生成文本。
它本身是 Python 包、不带 HTTP 服务，需要自己包一层 sidecar 实现 SystemOne。

```plaintext
POST /v1/systemone   请求 { state, model, questions }
                     响应 { model, answers, usage, routing }
GET  /v1/models      列出可路由的 checkpoint
GET  /healthz        健康检查
```

#### 与 Jev 的差异 ⚠️

| | 说明 |
|---|---|
| **context 窗口小得多** | 超出预算会从尾部截断 |
| **choice 选项共享预算** | 选项过多会被上游直接拒绝 |
| **confidence 不同尺度** | 为 Jev 标定的阈值**不能直接套用**，需重新标定 |
| **类型判别值是 `noul`** | 不是 Vercel 的 `boolean` |
| **零成本** | 无 key、无按 token 计费、不出网 |

> 📌 本项目的「本地 Laya」后端就是为它预留的（默认地址 `127.0.0.1:8137`），
> 界面上标着**未实测**：适配器尚未随仓库开源，需要自行实现那层 sidecar。
> 上面的协议形状转引自姊妹项目 [`jev-2048`](https://github.com/ARCJ137442/jev-2048) 的记录，
> **本项目未复测**。

### 潜在应用领域

本项目的价值不在「让模型下一盘棋」，而在于它是一台**可复现的上下文实验台**：

- 研究「提示词 / 上下文如何影响分类模型的决策质量」—— 尤其是**规则不自明**的场景
- 测量**并行决策的收益**：同样一批问题，一次发出去与分 N 次往返，差多少秒、多少钱、多少成功率
- **同台对照 Jev 与任意 LLM**：broker 让两边长得一模一样，跨模型对照不需要两套代码
- 作为「结构化决策模型」接入形态的参考实现（SystemOne 协议的完整调用封装）

---

## 贡献指南

### 项目分支情况

- `main`：目前唯一的分支，长期支持（ℹ️**PR 直接提到 `main`**）
- CI 对**所有分支**的 push 都跑（`.github/workflows/ci.yml` 里 `branches: ["**"]`）

### 贡献途径

- [GitHub Issues](https://github.com/ARCJ137442/jev-life/issues)：反馈问题、建议、bug
- [GitHub Pull Request](https://github.com/ARCJ137442/jev-life/pulls)：直接向项目贡献代码

### 提交前请确保

```bash
node tools/check-dom.ts && node tools/scan.ts && npm test
```

`./start.sh` 与 CI 跑的是同一组检查 —— 本地能过，CI 就能过，反之亦然。

---

<!-- 📝设计决策的完整理由见 DESIGN.md —— 那里记录的是「为什么这样做」，不是「做了什么」 -->
