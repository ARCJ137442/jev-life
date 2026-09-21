/**
 * 界面国际化。
 *
 * ## 边界：什么翻译，什么不翻译
 *
 * **只覆盖界面框架文案** —— 标签、按钮、状态、错误提示、说明文字。
 *
 * 刻意**不**覆盖喂给 Jev 的请求内容：`core/context.ts` 里的
 * `role_statement` / `objective` / `win_condition` / `termination_conditions` /
 * `noulInstructions`，以及实验者填的规则说明与策略提示。那些是**实验变量** ——
 * 随界面语言变化会让跨语言的对局不可比，而本项目的定位是「测量 Jev 在全新
 * 规则下的适应能力」。
 *
 * 这条也不是纸面纪律：`tools/scan.ts` 按传递闭包守着「`core/` 不得 import
 * `client/`」，而 `core/context.ts` 的文案全部是写死的字符串常量。两边合起来，
 * 「喂给模型的内容不翻译」是被机器保证的，不靠自觉。
 *
 * ## 用法
 *
 * HTML 侧标属性，扫描后写回；TS 侧直接调 `t()`：
 *
 * | 属性 | 写回目标 |
 * |---|---|
 * | `data-i18n="key"` | `textContent` |
 * | `data-i18n-html="key"` | `innerHTML`（文案里含标签时用） |
 * | `data-i18n-title="key"` | `title` |
 * | `data-i18n-ph="key"` | `placeholder` |
 *
 * HTML 里保留中文原文，未启用 JS 时仍可读（渐进增强）。
 *
 * ## 刻意的例外：开局名称与说明
 *
 * 开局的名称与说明住在 `core/presets.ts` 的 `Opening` 里（`nameZh` / `nameEn`），
 * 不在这张表里 —— 那是**数据**而不是界面文案，而且它是实验变量的一部分
 * （开局是被测量的对象）。界面按当前语言挑一个字段显示即可，见 `main.ts` 的
 * `openingName()`。`Opening.note` 只有中文，所以英文界面下它会原样显示中文：
 * 与其在界面层另写一份会与 `presets.ts` 各自演化的英文说明，不如照实显示
 * 唯一那份真相。
 */

export type Lang = "zh" | "en";

// 注意：这里刻意不提供语言清单数组常量。tools/check-dom.ts 会把方括号包裹的
// 字符串字面量一律当作需要核对的 DOM id 列表（它扫的是全文，注释也算），
// 于是报出并不存在的 zh / en 两个 id。语言切换是 zh↔en 的对切，本就不需要遍历。

/**
 * 词条表。
 *
 * key 用点分命名空间，第一段对应界面区域（`nav` / `game` / `strategy` / `api` /
 * `log` / `archive` / `decision` / `status` / `toast` …），第二段是用途。
 *
 * `zh` 与 `en` 的 key 集合**必须完全一致** —— 漏译时 `t()` 会静默回落到中文，
 * 界面上只会出现一句突兀的中文，不会报错。两边一起改。
 */
const DICT: Record<Lang, Record<string, string>> = {
  zh: {
    /* ---------- 顶栏 ---------- */
    "app.subtitle": "决策由 Jev 评估模型给出",
    "app.subtitleTitle":
      "每一回合双方各翻一格，Jev 返回带校准概率的决策 —— 它不做文本生成，只回答「这一格翻不翻」",
    "nav.game": "游戏",
    "nav.gameTitle":
      "棋盘尺寸、拓扑、终局规则、开局 —— 生命棋里规则不自明，这里改任何东西都会进入 Jev 的输入，概率分布应当随之变化",
    "nav.strategy": "策略",
    "nav.strategyTitle": "上下文（影响 Jev 看到什么）与规则（影响动作如何落实）",
    "nav.apiTitle": "用哪个后端、怎么调用",
    "nav.log": "日志",
    "nav.logTitle": "每个回合的完整往返记录（双方各自的请求与回包）",
    "nav.archive": "存档",
    "nav.archiveTitle": "导入 / 导出存档：对局、策略、API 设置、调用日志",
    "nav.githubTitle": "在 GitHub 上查看源码 · 欢迎 star 与 issue",
    "nav.langTitle": "界面语言 / Interface language",
    "nav.langName": "中文",
    "ui.close": "关闭",

    /* ---------- 棋盘下方控制条 ---------- */
    "ctrl.takeover": "▶ 开始对弈",
    "ctrl.resume": "▶ 继续对弈",
    "ctrl.started": "● 已开始",
    "ctrl.pause": "⏸ 暂停",
    "ctrl.takeoverTitle": "让双方 AI 自动对弈 / 暂停（空格）",
    "ctrl.resumeTitle": "接着这一局往下走（空格）",
    "ctrl.startedTitle": "对弈进行中 —— 点一下暂停（空格）",
    "ctrl.step": "单步",
    "ctrl.stepTitle": "只走一个回合（双方同时落子，再演化一代）",
    "ctrl.new": "↺ 重开",
    "ctrl.newTitle": "重开一局，保留全部设置",
    "ctrl.clearBoard": "清空棋盘",
    "ctrl.clearBoardTitle": "把棋盘擦成空的，重新画（只在开始对弈之前可用）",
    "ctrl.drawHint": "开始对弈之前，点格子即可摆放开局（只有缩放反馈，没有粒子与选框 —— 那时还没有行动方）。开始之后棋盘锁定。",
    "ctrl.result": "终局",
    "ctrl.resultTitle": "重新打开终局结果",
    "ctrl.hint": "暂停",

    /* ---------- 步进滑块 ---------- */
    "pace.label": "步进间隔",
    "pace.title": "自动对弈的步进间隔。0 = 不等，上游多快就多快（测极限用）",
    "pace.instant": "最快",

    /* ---------- 记分板（标签固定为 ASCII，不翻译）---------- */
    "stat.aliveTitle": "当前活细胞数",
    "stat.ratioTitle": "当前活细胞占比（活细胞 ÷ 总格数）",
    "stat.turnTitle": "当前回合",
    "stat.maxTitle": "本局活细胞数的最大值",
    "stat.minTitle": "本局活细胞数的最小值",

    /* ---------- 三张图 ---------- */
    "chart.conf.title": "置信度追踪",
    "chart.conf.band": "上/下界",
    "chart.conf.median": "中位",
    "chart.conf.waiting": "等待对局数据",
    "chart.conf.note": "带宽 = 这一手概率分布有多分散；中线 = 中位概率",
    "chart.mom.title": "生死态势",
    "chart.mom.waiting": "等待对局数据",
    "chart.mom.note":
      "纵轴是活细胞占比 0→100%；绿虚线 = 生之执获胜线，红虚线 = 死之执获胜线。折线以下填绿（活细胞份额）、以上填红（死细胞份额）—— 绿区变大就是生之执在赢",
    "chart.heat.title": "本回合决策热力图",
    "chart.heat.waiting": "等待本回合决策",

    /* ---------- 决策面板 ---------- */
    "decision.title": "本回合决策",
    "decision.idle": "尚未开始",
    "decision.restored": "已恢复上一局（第 {n} 回合）",
    "decision.flip": "翻 ({row}, {col})",

    /* ---------- 游戏抽屉 ---------- */
    "game.noteInput":
      "与 2048 相反：生命棋的规则不自明，所以这里的每一项都会写进发给 Jev 的 state —— 改完之后概率分布**应当**变化；若没变，那才是 bug。",
    "game.desc":
      "这些是**对局级**设置：两边不同就不是同一个游戏。注意生命棋与 2048 相反 —— 规则不自明，所以这里改任何东西都会进入 Jev 的输入，概率分布应当随之变化。",
    "game.boardSize": "棋盘尺寸",
    "game.sizeHint":
      "三档预设各带一整套标定过的参数（规则、回合上限、开局库）；下面是自由尺寸 —— 长与宽各自 2~16，想试别的尺寸时用。",
    "game.customSize": "自定义",
    "game.colsTitle": "棋盘宽度（列数），2~16",
    "game.rowsTitle": "棋盘高度（行数），2~16",
    "game.sizeUncalibrated":
      "⚠ 该尺寸的参数未标定：回合上限与胜负线是为 4/8/16 调的，而小棋盘的分辨率粗 —— 4×4 上一格就是 6.25%，0.30 那条线落下去只等于「≥ 5 格」，预设开局本来就有 6 格，一开局就已经越线。这个尺寸上默认值会是什么效果没人知道，自己去「终局规则」里调。该尺寸也没有开局库，只能自己画。",
    "game.torusTiny":
      "⚠ 环绕拓扑 + 极小尺寸（2~3）：能算，但 rows = 2 时 r−1 与 r+1 是同一行，同一个格子会被重复计数 —— 结果是确定的，只是没有对应的几何直觉。",
    "game.mode": "对局模式",
    "game.modeDuel": "双人对弈 — 生之执与死之执各翻一格",
    "game.modeSolo": "纯生执单人 — 只有生之执在走",
    "game.modeNote":
      "单人模式没有死之执：一回合只翻一格。终局判定也跟着变 —— 「死之执无处可翻」不再是终局（那意味着棋盘全死，而那时生之执处处可翻），「推不动」只问生之执的落点；占比连续跌破死之执那条线的含义是「棋盘死绝」，不是「对手赢了」。",
    "game.topology": "边界拓扑",
    "game.topoBounded": "有界 — 棋盘之外算死格，边界是墙",
    "game.topoTorus": "环绕 — 上下边相连、左右边相连，没有墙",
    "game.rules": "终局规则",
    "game.turnLimit": "回合上限",
    "game.turnLimitHint": "到上限仍未分出胜负判和局。它会进入发给 Jev 的 state，所以改它会立即重开一局 —— 半局中改规则会让这一局的前后两半不可比。",
    "game.rulesNote":
      "胜负线：生之执 ≥ {life}% 连续 {ls} 回合；死之执 ≤ {death}% 连续 {ds} 回合。清空 / 占满棋盘、整盘推不动都会立即终局。",
    "game.rulesUncalibrated": "⚠ 这些阈值全是占位值，未经跑分标定 —— 开放它们是为了能试，不是说它们已经准了。",
    "game.rulesInverted":
      "⚠ 死之执的线不低于生之执的线：判终局时生之执那条先判，倒挂会让死之执的线实际上永远轮不到。",
    "game.turnLimitWarn": "回合上限必须是 1 以上的整数",
    "game.lifeWin": "生之执获胜线",
    "game.deathWin": "死之执获胜线",
    "game.streak": "连续",
    "game.turns": "回合",
    "game.winLineHint":
      "活细胞占比越界且连续保持这么多回合才算赢 —— 生命游戏是混沌的，只看一代等于把胜负交给运气。这四个数会写进发给 Jev 的 state，所以改完立即重开一局。",
    "game.fx": "动效",
    "game.fxAnim": "落子与演化的缩放动画",
    "game.fxParticles": "落子处的发光粒子",
    "game.flipMs": "落子相时长",
    "game.flipMsTitle":
      "「谁在哪儿落了一子」这一相演多久。演化一代在它之后才开始；粒子与选框的存续时间按同一个倍数走",
    "game.flipMsHint": "落子动画、粒子与选框的存续时间；演化一代在它之后才开始。",
    "game.opening": "开局",
    "game.openingHint": "开局库按尺寸分级 —— 先定尺寸，再选开局。改动能立即重开一局。",
    "game.customOpening": "自定义（空白棋盘）",
    "game.customOpeningNote":
      "空棋盘起步，自己画。开始对弈之前点格子即翻转；画过之后这里会一直标着「自定义」，不会谎称这局用的是某个预设。",
    "game.noOpeningLib": "该尺寸不是预设，没有开局库 —— 请从空白棋盘自己画。",
    "game.reset": "恢复默认",
    "game.resetTitle": "尺寸、拓扑、终局规则、开局、动效回到出厂值",
    "game.done": "完成",

    /* ---------- 策略抽屉 ---------- */
    "strategy.desc":
      "分两部分：上下文决定 Jev 看到什么，规则决定拿到答案后怎么落实。每一项都是**玩家级**的 —— 两边可以配得不一样。",
    "strategy.perRoleNote":
      "后端 / 模型 / 上下文都绑在单个玩家上：跨模型对照（Jev 当生执、LLM 当死执）正是靠它才配得出来。",
    "strategy.sync": "把「{from}」的设置复制给「{to}」",
    "strategy.syncTitle": "整体复制该玩家的玩家级设置（后端、模型、上下文、规则），方向由当前选中的玩家决定",
    "strategy.syncDone": "已把「{from}」的设置复制给「{to}」",
    "strategy.ctx": "上下文",
    "strategy.ctxNote": "改动会进入请求，影响 Jev 的判断 —— 效果看「概率分布」",
    "strategy.ruleNoteLabel": "规则说明（补充）→ rules.rule_note",
    "strategy.ruleNoteDesc":
      "规则正文由当前的对局设置现算（尺寸、拓扑、胜负线都在里面），所以这里只填**补充**。留空则整个字段不出现。",
    "strategy.hintLabel": "策略提示 → aids.strategy_hint",
    "strategy.hintDesc": "生命棋的知识（哪些是静物、滑翔机会飞）恰恰是这套实验想测量的东西，所以默认留空。",
    "strategy.predictLabel": "后果预测",
    "strategy.predictDesc":
      "打开后把「这一手 + 演化一代」的活细胞数变化作为**背景**写进题面。只是背景：问的自始至终是长期价值，否则等于把答案写在题面上。",
    "strategy.memoryLabel": "记忆轮数 → recent_history",
    "strategy.memoryDesc": "把最近 n 回合的「局面 + 双方落点 + 净增长」一并发给 Jev。0 = 不加入。",
    "strategy.memoryNote": "上限受模型上下文窗口约束，超出预算时会截断。",
    "strategy.max": "最大",
    "strategy.maxTitle": "在上下文预算内尽量塞满",
    "strategy.detectLabel": "自动结构识别",
    "strategy.detectDesc":
      "打开时把识别到的静物 / 振荡器 / 飞船一并发给 Jev；关掉它就是「把脚手架整个拆掉，看模型还剩多少」。默认开。",
    "strategy.rule": "规则",
    "strategy.ruleNote": "不进入请求，Jev 看不到 —— 效果看「实际走了哪一步」",
    "strategy.policy": "决策策略",
    "strategy.greedy": "贪心 — 取概率最高的合法格",
    "strategy.sample": "概率采样 — 按分布随机（有探索性）",
    "strategy.thresholdOpt": "置信度门槛 — 低于阈值时标记",
    "strategy.thresholdLabel": "置信度门槛",
    "strategy.thresholdNote": "看着侧栏的置信度追踪图来定：低于该值的回合会被标记。",
    "strategy.channel": "评估通道",
    "strategy.channelNote": "一条通道 = 一次请求，题目一次性发完、绝不循环。M1 只实现这一条。",
    "strategy.channelNoulAll": "noul-all — 每个合法格一道布尔题",
    "strategy.noHeuristic":
      "本 Demo 不含启发式兜底：拿不准时不换别的算法，而是把不确定性标出来交给你判断。",
    "strategy.reset": "恢复默认",
    "strategy.resetTitle": "当前玩家的上下文与规则回到出厂值（另一方不受影响）",
    "strategy.done": "完成",

    /* ---------- API 抽屉 ---------- */
    "api.desc":
      "怎么跟模型打交道：**选谁**（后端 / 模型 / 密钥）与**怎么谈**（重试、超时）。两者都影响 AI 玩家的表现，所以都在这一个抽屉里。",
    "api.keySafety": "密钥安全",
    "api.keyNote":
      "只有选「直连」类后端时才需要填写。密钥仅存于当前页面的内存，刷新即清除，不会写入本地存储，也不会随存档导出。",
    "api.keyHint":
      "留空 = 沿用已填的密钥（输入框每次打开都是空的 —— 密钥不回显，这是刻意的）。刷新页面即清空。",
    "api.backend": "后端",
    "api.customOnly": "只有自建 / 直连后端需要改这里",
    "api.retry": "自动重试",
    "api.retryNote":
      "只对瞬时故障重试（网络错误 / 429 / 5xx）。参数错误、鉴权失败会直接报错。 填",
    "api.retryInfNote": "表示无限重试。",
    "api.phRetryMax": "最大次数，或 inf",
    "api.phRetryBase": "退避基数 ms",
    "api.reset": "恢复默认",
    "api.resetTitle": "自动重试参数回到出厂值；后端与密钥不受影响",
    "api.cancel": "取消",
    "api.save": "保存",
    "retry.none": "不重试：失败即失败",
    "api.roleNote": "后端与模型是玩家级的 —— 两边可以不同，那正是跨模型对照的做法。",

    /* ---------- 后端目录 ---------- */
    "backend.freeTrial": "免费试用 1",
    "backend.freeTrialDesc": "本站代管的免费额度，开箱即用，不需要密钥",
    "backend.freeTrial2": "免费试用 2",
    "backend.freeTrial2Desc": "本站代管的第二份免费额度",
    "backend.llmFreeTrial": "LLM 免费试用 1",
    "backend.llmFreeTrialDesc":
      "本站代管的免费 LLM 额度。它背后是一个通用的语言模型，由 broker 包装成 Jev 兼容接口 —— 对上层完全一样，只是**慢得多、要花 token**。选中它之后 API 抽屉里会多出四个调用配置。",
    "backend.vercel": "Vercel AI Gateway 直连",
    "backend.vercelDesc": "自己带密钥，额度归你掌控。",
    "backend.typesafe": "TypeSafe 官方",
    "backend.typesafeDesc":
      "端点与协议由公开的 openapi.json 确认，本项目未持密钥实测。",
    "backend.openrouter": "OpenRouter",
    "backend.openrouterDesc": "直连 OpenRouter 的 systemone 端点。",
    "backend.laya": "本地 Laya",
    "backend.layaDesc":
      "需要自行实现 SystemOne sidecar。它与 Jev 的 confidence 不是同一尺度。",
    "backend.custom": "自建 / 本地兼容端点",
    "backend.customDesc": "任何兼容 systemone 协议的地址。",
    "backend.verified": "已实测可用。",
    "backend.unverified": "未经实测：",
    "backend.unverifiedTag": "（未实测）",
    "backend.unreachableTag": "（当前部署下不可用）",
    "backend.unreachableNote":
      "这条后端在本站根本走不通：它需要一个服务端来持有密钥，而当前是**纯静态托管**、又没有配远端地址。选一条「直连」后端并自备密钥即可继续；或者把它部署到本机 / Vercel（那两种形态下代理是同源的，不需要额外配置）。",
    "backend.modelManaged": "由本站指定",
    "backend.modelManagedHint": "该后端的模型由本站服务端决定，不可更改",
    "backend.modelPlaceholder": "留空即用默认模型 {model}",
    "backend.keyPlaceholder": "在此粘贴 API Key（只留在内存里）",
    "backend.noKeyPlaceholder": "该后端不需要密钥",
    "backend.currentTitle": "当前后端：{label} · {model}",
    "backend.currentTitleShort": "当前后端：{label}",
    "backend.remoteSuffix": "{label}（远端）",

    /* ---------- LLM 调用配置（只在选用 LLM 后端时出现）---------- */
    "api.llmTitle": "LLM 调用配置",
    "api.llmNote": "只对这一条后端生效；换回别的后端时设置仍然留着。",
    "api.cot": "思维链",
    "api.cotDesc":
      "默认关。实测两个后端都从 0–63% 升到 100%，快 5–40 倍，推理 token 归零 —— 关掉它从结构上消灭了「推理吃光预算」这个失败模式（观察到的唯一失败原因）。",
    "api.allowThink": "是否允许思考",
    "api.allowEmpty": "留空（不说）",
    "api.allowYes": "是",
    "api.allowNo": "否",
    "api.effort": "思考强度",
    "api.effortEmpty": "默认（留空）",
    "api.effortNone": "无 none",
    "api.effortLow": "低 low",
    "api.effortMedium": "中 medium",
    "api.effortHigh": "高 high",
    "api.effortXhigh": "超高 xhigh",
    "api.effortMax": "最强 max",
    "api.effortWarn":
      "实测：显式设置本项会显著降低成功率（3/3 → 0–1/3）。默认留空。",
    "api.effortDegraded":
      "⚠ 该后端不支持这一档，已降级为默认（不下发这个字段）。直接发出去会把整个决策请求打成 400。",
    "api.callPolicy": "调用策略",
    "api.policyJson": "JSON 输出",
    "api.policyTool": "工具循环",
    "api.callPolicyNote":
      "JSON 靠提示词约束形状、一次调用（实测快 2–4 倍）；工具循环靠 schema 强制形状、可多轮。两条都留着是因为**它本身就是可对照的变量**。",
    "api.effortCoupling": "「否」与 `none` 是同一件事的两种说法，界面会自动保持一致。",

    /* ---------- 页脚与状态 ---------- */
    "stats.total": "累计",
    "stats.avgCost": "均次",
    "stats.avgCostTitle": "每次成功调用的平均费用 —— 失败的调用不计入",
    "stats.latency": "延迟",
    "status.ready": "就绪",
    "status.calling": "正在请求双方决策…",
    "status.retrying": "第 {n} 次重试（{s}s 后）",
    "status.online": "已连接",
    "status.paused": "已暂停",
    "status.quota": "额度不足",
    "status.apiFail": "调用失败",
    "status.costs": "成本按 2026-09 的价目表估算",
    "status.backendUnreachable": "这条后端在当前部署下走不通",

    /* ---------- 终局 ---------- */
    "over.gameOver": "对局结束",
    "over.reason": "终局原因",
    "over.winner": "胜方",
    "over.draw": "和局",
    "over.stats": "共 {turn} 回合｜终局 {alive} 格（{ratio}）｜本局 A.MAX {max} / A.MIN {min}",
    "over.ratioLine": "生之执线 {life} · 死之执线 {death}",
    "over.ratioLineSolo": "获胜线 {life} · 死绝线 {death}",
    "over.again": "再来一局",
    "over.close": "关闭，看终局棋盘",
    "over.apiFail": "调用失败",
    "over.failBody": "{msg}\n（重试上限 {n} 次已用尽 —— 失败就是失败，不会拿旧分布顶替）",
    "over.failBodyInf": "{msg}",
    "over.retry": "重试这一回合",
    "over.skip": "跳过这一回合，继续",
    "over.backendTitle": "这条后端在当前部署下走不通",
    "over.goApi": "去设置后端",
    "over.halt": "暂停对局",

    /* ---------- 终局原因 ---------- */
    "term.lifeWinRatio": "存活占比连续 {n} 回合 ≥ {ratio} —— 生之执获胜",
    "term.deathWinRatio": "存活占比连续 {n} 回合 ≤ {ratio} —— 死之执获胜",
    "term.noLegalCellLife": "生之执把棋盘占满了（对方一格都翻不动）—— 生之执获胜",
    "term.noLegalCellDeath": "死之执把棋盘清空了（对方一格都翻不动）—— 死之执获胜",
    "term.repeatBlocked": "整盘推不动：此后任何落子组合都会走到见过的局面",
    "term.turnLimit": "到达回合上限 {n}，仍未分出胜负",
    "term.soloDiedOut":
      "活细胞占比连续 {n} 回合 ≤ {ratio} —— 棋盘死绝（单人局没有对手，「死之执获胜」不适用）",

    /* ---------- 界面上自造的错误（不来自上游）---------- */
    "err.backendUnreachable":
      "{role} 用的「{label}」需要一个服务端来持有密钥，而当前是纯静态托管、且没有配远端地址 —— 这条请求根本发不出去，所以**没有重试按钮**。换一条「直连」后端（自己带密钥）即可继续。",

    /* ---------- 决策理由（resolveDecision 的 reasonKey）---------- */
    "reason.noProb": "回包里没有概率分布，取第一个合法格",
    "reason.sampled": "从概率分布里采样得到",
    "reason.belowThreshold": "Jev 只给了 {p}%，低于 {t}% 的门槛",
    "reason.takeTop": "取概率最高的那一格",
    "reason.coerced": "Jev 的首选 ({row}, {col}) 它翻不动，改从它自己的分布里取次优合法格",
    "reason.noLegal": "分布里没有合法格，取第一个合法格",

    /* ---------- 日志 ---------- */
    "log.title": "调用日志",
    "log.desc": "每个回合一条：双方各自的请求体与回包。按回合折叠，展开看完整 JSON。",
    "log.empty": "还没有请求记录",
    "log.turnCount": "{n} 回合",
    "log.copyReq": "复制请求",
    "log.copyRes": "复制响应",
    "log.copyBoth": "复制两者",
    "log.reqLabel": "请求体 request",
    "log.resLabel": "响应 response",
    "log.noResponse": "（没有回包 —— 这次调用在拿到响应之前就失败了）",
    "log.failed": "失败",
    "log.pagedNote": "只渲染最近 {n} 回合；更早的记录仍在内存里，可用「复制全部」导出",
    "log.copyAll": "复制全部",
    "log.clear": "清空",
    "log.clearTitle": "清空全部调用日志（不可撤销）",
    "log.p": "p",
    "log.calls": "上游 {n} 次",
    "log.roleLife": "生之执",
    "log.roleDeath": "死之执",
    "log.noPayload": "（这一条是从存档恢复的，请求体没有随存档保留）",
    "log.costUnknown": "成本未知",

    /* ---------- 存档 ---------- */
    "archive.desc": "各类内容各自独立成档，可分别备份与恢复。导出的是 JSON 文件，导入时逐项校验。",
    "archive.game": "对局（棋盘与进程）",
    "archive.gameDesc": "棋盘、回合、比分、记忆、调用日志，以及尺寸 / 拓扑 / 终局规则 / 开局。",
    "archive.strategyDesc": "双方各自的上下文（规则说明、策略提示、后果预测、记忆轮数、自动结构识别）与规则（决策策略、置信度门槛）。",
    "archive.apiDesc": "自动重试参数。",
    "archive.noKey": "不含密钥",
    "archive.noKeyDesc": "—— 密钥从不落盘，因此也无法导出。",
    "archive.logDesc": "全部请求记录（含完整请求体与响应）。只支持导出 —— 日志是过程记录，导入它没有意义。",
    "archive.logExportOnly": "日志只导出，不支持导入",
    "archive.all": "整体",
    "archive.export": "导出",
    "archive.import": "导入",
    "archive.exportAll": "导出全部",
    "archive.wipe": "清空存档",
    "archive.wipeTitle": "清除本机全部存档并重新载入",
    "archive.done": "完成",

    /* ---------- 不兼容存档弹框 ---------- */
    "incompat.title": "发现不兼容的旧存档",
    "incompat.desc": "本机存有一份旧数据，但当前版本读不懂它。",
    "incompat.whyEdited": "它可能是更早版本写下的，或者已被外部修改。",
    "incompat.whyKept": "为避免丢掉你原本的进度，应用",
    "incompat.none": "没有",
    "incompat.whyDecide": "自动清理它 —— 请先决定如何处理。",
    "incompat.reason": "读取失败的原因",
    "incompat.raw": "原始数据（截断预览，大小",
    "incompat.force": "强行加载",
    "incompat.salvage":
      "会尽力从这份数据里抢救出可用的部分： 棋盘与回合数通常没问题，读不懂的字段会被丢弃并如实告知。",
    "incompat.order": "建议顺序：先「导出旧数据」留底，再决定强行加载还是重置。",
    "incompat.export": "⬇ 导出旧数据",
    "incompat.reset": "重置回默认",
    "incompat.later": "稍后再说",

    /* ---------- 额度不足弹框 ---------- */
    "quota.title": "额度不足",
    "quota.desc": "当前后端的调用额度已用尽或被限流。",
    "quota.notNetwork": "这通常不是网络问题，重试也不会恢复 —— 换个后端或用自己的 Key 即可继续。",
    "quota.serverReturned": "服务端返回",
    "quota.whatCanDo": "可以怎么做",
    "quota.step1": "1. 切到",
    "quota.gatewayBold": "Vercel AI Gateway 直连",
    "quota.gatewayHint": "，填自己的 API Key（推荐，额度归你掌控）",
    "quota.step2": "2. 换用",
    "quota.official": "TypeSafe 官方",
    "quota.or": "或",
    "quota.backendWord": "后端",
    "quota.step3": "3. 稍后再试 —— 如果是共享额度的免费试用，等它恢复",
    "quota.switch": "去切换后端",

    /* ---------- 会话读写错误 ---------- */
    "sesserr.notObject": "存档的顶层不是一个对象",
    "sesserr.badJson": "存档不是合法的 JSON",
    "sesserr.versionHigh": "存档版本 v{v} 比当前支持的 v{cur} 新（降级运行会丢字段）",
    "sesserr.noSize": "缺少棋盘尺寸",
    "sesserr.noBoard": "缺少棋盘，或棋盘行数与尺寸对不上",
    "sesserr.noTurn": "缺少回合数",
    "sesserr.notChess": "这份存档不属于生命棋（缺 app 标识或标识不符）",

    /* ---------- 抢救结果 ---------- */
    "salv.turn": "回合数归零",
    "salv.memory": "记忆已清空",
    "salv.rawGone": "原始数据已经不在了",
    "salv.exported": "旧数据已导出",
    "salv.forceFail": "这份数据连棋盘都救不回来",
    "salv.forced": "已强行加载（第 {n} 回合）",
    "salv.forcedShort": "已强行加载到第 {n} 回合",
    "salv.forcedPartial": "已强行加载：{list}",
    "salv.restoredShort": "已恢复上一局（第 {n} 回合）",

    /* ---------- 存档错误 ---------- */
    "arcerr.badJson": "不是合法的 JSON 文件",
    "arcerr.notObject": "存档内容不是一个对象",
    "arcerr.notOurs": "这不像是本应用的存档（缺少 app 标识，或标识不是 jev-life）",
    "arcerr.noVersion": "存档缺少版本号",
    "arcerr.versionHigh": "存档版本 v{v} 比当前支持的 v{cur} 新，请先升级应用再导入",
    "arcerr.unknownKind": "不认识的存档类型：{kind}",
    "arcerr.noPayload": "存档缺少 payload",
    "arcerr.logNoImport": "日志档不支持导入",
    "arcerr.readFail": "读取文件失败",

    /* ---------- 字段名与档案类型 ---------- */
    "field.gameSettings": "对局设置",
    "field.apiSettings": "API 设置",
    "field.session": "对局",
    "field.roles": "双方玩家设置",
    "kind.game": "对局",
    "kind.strategy": "策略",
    "kind.api": "API",
    "kind.log": "日志",
    "kind.all": "全部",

    /* ---------- 瞬时提示 ---------- */
    "toast.copied": "已复制",
    "toast.copyFail": "复制失败",
    "toast.exported": "已导出「{label}」",
    "toast.imported": "已导入：{list}",
    "toast.importEmpty": "这份存档里没有可应用的内容",
    "toast.importFail": "导入失败：{msg}",
    "toast.readFail": "读文件失败：{msg}",
    "toast.kindMismatch": "这份存档是「{from}」档，不能当作「{to}」导入",

    /* ---------- 二次确认 ---------- */
    "confirm.gameReset": "尺寸、拓扑、终局规则、开局、动效全部回到出厂值，并重开一局？",
    "confirm.strategyReset": "当前玩家的上下文与规则回到出厂值？（另一方不受影响）",
    "confirm.apiReset": "自动重试参数回到出厂值？（后端与密钥不受影响）",
    "confirm.logClear": "清空全部调用日志？此操作不可撤销。",
    "confirm.wipeAll": "清除本机全部存档（设置、对局、日志）并重新载入？",
    "confirm.incompatReset": "清空这份读不懂的存档并重开一局？",
    "confirm.resetDone": "已重置",
    "confirm.kept": "存档原样保留",

    /* ---------- 启动 ---------- */
    "boot.missingDom": "启动自检失败：有 {n} 个元素在 index.html 里找不到 —— {list}",
    "boot.missingDomHint":
      "\n这通常意味着 HTML 与 TS 不同步（改了 id 但只改了一边）。\n构建期可以先跑 node tools/check-dom.ts 定位。",
    "boot.failedBody": "生命棋启动失败：\n\n{msg}",

    /* ---------- 开发者控制台 ---------- */
    "dev.bootFail": "[生命棋×Jev] 启动失败：",
    "dev.bootInfo":
      "[生命棋×Jev] {cols}×{rows} {topology} 开局 {opening} 回合上限 {turnLimit} 通道 {channel}",
  },

  en: {
    /* ---------- Top bar ---------- */
    "app.subtitle": "Every decision comes from the Jev evaluation model",
    "app.subtitleTitle":
      "Each turn both sides flip one cell and Jev returns calibrated probabilities — no text generation, just whether to flip this cell",
    "nav.game": "Game",
    "nav.gameTitle":
      "Board size, topology, end rules, opening — in Life Chess the rules are not self-evident, so anything changed here enters Jev's input and the probability distribution should change with it",
    "nav.strategy": "Strategy",
    "nav.strategyTitle": "Context (what Jev sees) and rules (how an answer becomes a move)",
    "nav.apiTitle": "Which backend, and how to call it",
    "nav.log": "Log",
    "nav.logTitle": "The full round trip of every turn, for both sides",
    "nav.archive": "Archive",
    "nav.archiveTitle": "Import / export: game, strategy, API settings, call log",
    "nav.githubTitle": "View the source on GitHub · stars and issues welcome",
    "nav.langTitle": "界面语言 / Interface language",
    "nav.langName": "English",
    "ui.close": "Close",

    /* ---------- Controls under the board ---------- */
    "ctrl.takeover": "▶ Start the duel",
    "ctrl.resume": "▶ Resume the duel",
    "ctrl.started": "● In progress",
    "ctrl.pause": "⏸ Pause",
    "ctrl.takeoverTitle": "Let both AIs play automatically / pause (space)",
    "ctrl.resumeTitle": "Carry on with this game (space)",
    "ctrl.startedTitle": "The duel is running — click to pause (space)",
    "ctrl.step": "Step",
    "ctrl.stepTitle": "Play a single turn (both sides flip, then one evolution)",
    "ctrl.new": "↺ Restart",
    "ctrl.newTitle": "Start a fresh game, keeping every setting",
    "ctrl.clearBoard": "Clear board",
    "ctrl.clearBoardTitle": "Wipe the board and start drawing again (only before the duel starts)",
    "ctrl.drawHint": "Before the duel starts, click cells to set up the opening (scale feedback only — no particles, no ring: there is no acting side yet). Once it starts, the board is locked.",
    "ctrl.result": "Result",
    "ctrl.resultTitle": "Reopen the end-of-game result",
    "ctrl.hint": "pause",

    /* ---------- Pace slider ---------- */
    "pace.label": "Step interval",
    "pace.title": "How fast the two AIs play. 0 = no wait at all; whatever the upstream gives",
    "pace.instant": "Instant",

    /* ---------- Scoreboard (labels stay ASCII, untranslated) ---------- */
    "stat.aliveTitle": "Live cells right now",
    "stat.ratioTitle": "Live cells as a share of the board",
    "stat.turnTitle": "Current turn",
    "stat.maxTitle": "Highest live-cell count in this game",
    "stat.minTitle": "Lowest live-cell count in this game",

    /* ---------- The three charts ---------- */
    "chart.conf.title": "Confidence",
    "chart.conf.band": "High/low",
    "chart.conf.median": "Median",
    "chart.conf.waiting": "Waiting for game data",
    "chart.conf.note": "Band width = how spread out this move's distribution is; line = median probability",
    "chart.mom.title": "Life momentum",
    "chart.mom.waiting": "Waiting for game data",
    "chart.mom.note": "Vertical axis is the live-cell ratio, 0 → 1; green dashes = Life threshold, red dashes = Death threshold",
    "chart.heat.title": "This turn's decision heat map",
    "chart.heat.waiting": "Waiting for this turn's decision",

    /* ---------- Decision panel ---------- */
    "decision.title": "This turn's decisions",
    "decision.idle": "Not started yet",
    "decision.restored": "Restored from the previous game (turn {n})",
    "decision.flip": "flip ({row}, {col})",

    /* ---------- Game drawer ---------- */
    "game.noteInput":
      "The opposite of 2048: in Life Chess the rules are not self-evident, so everything here is written into the state sent to Jev — after a change the probability distribution *should* change; if it does not, that is the bug.",
    "game.desc":
      "These are game-level settings: if the two sides disagreed on them it would not be the same game. Note that Life Chess is the opposite of 2048 — the rules are not self-evident, so anything changed here enters Jev's input and the distribution should change.",
    "game.boardSize": "Board size",
    "game.sizeHint":
      "The three presets each come with a calibrated set of parameters (rules, turn limit, opening library). Below them are free sizes — length and width are each 2–16, for when you want to try another size.",
    "game.customSize": "Custom",
    "game.colsTitle": "Board width (columns), 2–16",
    "game.rowsTitle": "Board height (rows), 2–16",
    "game.sizeUncalibrated":
      "⚠ This size is uncalibrated: the turn limit and win lines were tuned for 4/8/16, and a small board has coarse resolution — one cell on a 4×4 is 6.25%, so a line at 0.30 means “5 cells or more”, while the preset openings already start at 6 and are past the line on turn 0. Nobody knows what the defaults do at this size; adjust them under “End-of-game rules”. There is no opening library either — draw your own.",
    "game.torusTiny":
      "⚠ Torus topology at a tiny size (2–3): it computes, but with rows = 2 the row r−1 and the row r+1 are the same row, so a cell's neighbours are counted more than once — the result is well defined, it just has no matching geometric intuition.",
    "game.mode": "Game mode",
    "game.modeDuel": "Duel — Life and Death each flip one cell",
    "game.modeSolo": "Life only — nobody else moves",
    "game.modeNote":
      "In solo mode there is no Death: a turn flips a single cell. The end conditions change with it — “Death has nothing to flip” is no longer an ending (it means the board is entirely dead, and then Life can flip anywhere), “cannot move” only asks about Life's moves, and a ratio that stays below Death's line means “the board died out”, not “the opponent won”.",
    "game.topology": "Boundary topology",
    "game.topoBounded": "Bounded — outside the board counts as dead; the edge is a wall",
    "game.topoTorus": "Torus — top wraps to bottom, left to right; no walls",
    "game.rules": "End-of-game rules",
    "game.turnLimit": "Turn limit",
    "game.turnLimitHint": "If nobody has won by then, the game is a draw. It is written into the state sent to Jev, so changing it restarts the game immediately — changing the rules mid-game would make the two halves incomparable.",
    "game.rulesNote":
      "Win lines: Life holds ≥ {life}% for {ls} turns; Death holds ≤ {death}% for {ds} turns. Emptying or filling the board, or a position that can no longer move, ends the game immediately.",
    "game.rulesUncalibrated": "⚠ These thresholds are placeholders and have not been calibrated by benchmark runs — they are editable so you can experiment, not because they are now trustworthy.",
    "game.rulesInverted":
      "⚠ Death's line is not below Life's: the Life condition is tested first, so an inverted pair means Death's line can never actually trigger.",
    "game.turnLimitWarn": "The turn limit must be an integer of at least 1",
    "game.lifeWin": "Life wins at",
    "game.deathWin": "Death wins at",
    "game.streak": "for",
    "game.turns": "turns",
    "game.winLineHint":
      "A win needs the live-cell ratio to stay beyond the line for this many turns in a row — the Game of Life is chaotic, so judging on a single generation hands the result to luck. All four numbers are written into the state sent to Jev, so changing them restarts the game immediately.",
    "game.fx": "Effects",
    "game.fxAnim": "Scale animation for flips and evolutions",
    "game.fxParticles": "Glowing particles at the flipped cell",
    "game.flipMs": "Flip phase",
    "game.flipMsTitle":
      "How long the “who flipped which cell” phase runs. The evolution phase starts after it; particle and ring lifetimes scale with it",
    "game.flipMsHint": "Lifetime of the flip animation, particles and ring; the evolution starts after it.",
    "game.opening": "Opening",
    "game.openingHint": "The opening library is per size — pick the size first, then the opening. Changing it restarts the game immediately.",
    "game.customOpening": "Custom (empty board)",
    "game.customOpeningNote":
      "Start from an empty board and draw your own. Before the duel starts a click flips a cell; once you have drawn, this entry stays marked “custom” instead of claiming the game uses some preset.",
    "game.noOpeningLib": "This size is not a preset, so there is no opening library — draw your own from an empty board.",
    "game.reset": "Reset to defaults",
    "game.resetTitle": "Size, topology, end rules, opening and effects go back to factory values",
    "game.done": "Done",

    /* ---------- Strategy drawer ---------- */
    "strategy.desc":
      "Two parts: context decides what Jev sees, rules decide what happens to its answer. Everything here is player-level — the two sides may differ.",
    "strategy.perRoleNote":
      "Backend, model and context are bound to a single player: that is the only way to configure a cross-model comparison (Jev as Life, an LLM as Death).",
    "strategy.sync": "Copy “{from}” settings to “{to}”",
    "strategy.syncTitle": "Copy every player-level setting (backend, model, context, rules); the direction follows the currently selected player",
    "strategy.syncDone": "Copied “{from}” settings to “{to}”",
    "strategy.ctx": "Context",
    "strategy.ctxNote": "Changes enter the request and affect Jev's judgement — watch the probability distribution",
    "strategy.ruleNoteLabel": "Rule notes (supplementary) → rules.rule_note",
    "strategy.ruleNoteDesc":
      "The body of the rules is computed from the current game settings (size, topology, win lines are all in there), so this field is for supplements only. Leave it empty and the field disappears entirely.",
    "strategy.hintLabel": "Strategy hint → aids.strategy_hint",
    "strategy.hintDesc": "Knowledge of Life (which shapes are still lifes, that gliders travel) is exactly what this experiment measures, so it is empty by default.",
    "strategy.predictLabel": "Outcome prediction",
    "strategy.predictDesc":
      "Adds the live-cell change of “this flip plus one evolution” to the question text as background. Background only: the question always asks about long-term value, or the answer would be printed on the question.",
    "strategy.memoryLabel": "Memory turns → recent_history",
    "strategy.memoryDesc": "Sends the last n turns (board, both flips, net growth) along with the request. 0 = leave it out.",
    "strategy.memoryNote": "Bounded by the model's context window; truncated when over budget.",
    "strategy.max": "Max",
    "strategy.maxTitle": "Fill as much as the context budget allows",
    "strategy.detectLabel": "Automatic pattern detection",
    "strategy.detectDesc":
      "When on, detected still lifes / oscillators / spaceships are sent to Jev; turning it off is “tear out the scaffolding and see how much is the model's own”. On by default.",
    "strategy.rule": "Rules",
    "strategy.ruleNote": "Does not enter the request — Jev cannot see it; watch which move was actually taken",
    "strategy.policy": "Decision strategy",
    "strategy.greedy": "Greedy — take the legal cell with the highest probability",
    "strategy.sample": "Probability sampling — random draws from the distribution",
    "strategy.thresholdOpt": "Confidence threshold — flag anything below it",
    "strategy.thresholdLabel": "Confidence threshold",
    "strategy.thresholdNote": "Read it off the confidence chart: turns below this value get flagged.",
    "strategy.channel": "Evaluation channel",
    "strategy.channelNote": "One channel = one request; every question goes out in a single batch, never a loop. Only this one exists in M1.",
    "strategy.channelNoulAll": "noul-all — one boolean question per legal cell",
    "strategy.noHeuristic":
      "No heuristic fallback: when Jev is unsure we do not quietly swap in another algorithm, we surface the uncertainty for you to judge.",
    "strategy.reset": "Reset to defaults",
    "strategy.resetTitle": "This player's context and rules go back to factory values (the other side is untouched)",
    "strategy.done": "Done",

    /* ---------- API drawer ---------- */
    "api.desc":
      "How to talk to the model: who to talk to (backend / model / key) and how (retries, timeouts). Both change how the AI player performs, so both live in this drawer.",
    "api.keySafety": "Key safety",
    "api.keyNote":
      "Only needed for direct backends. The key lives in this page's memory only, is cleared on reload, is never written to local storage and never exported with an archive.",
    "api.keyHint":
      "Leave empty to keep the key already entered (the field is always empty when reopened — the key is never echoed back, by design). Reloading the page clears it.",
    "api.backend": "Backend",
    "api.customOnly": "Only custom / direct backends need this",
    "api.retry": "Automatic retries",
    "api.retryNote":
      "Only transient failures are retried (network errors / 429 / 5xx). Bad parameters and auth failures fail immediately. Enter",
    "api.retryInfNote": "for unlimited retries.",
    "api.phRetryMax": "Max attempts, or inf",
    "api.phRetryBase": "Backoff base in ms",
    "api.reset": "Reset to defaults",
    "api.resetTitle": "Retry parameters go back to factory values; backend and key are untouched",
    "api.cancel": "Cancel",
    "api.save": "Save",
    "retry.none": "No retries: a failure is a failure",
    "api.roleNote": "The backend and model are player-level — the two sides may differ, and that is exactly how cross-model comparison is done.",

    /* ---------- Backend catalogue ---------- */
    "backend.freeTrial": "Free trial 1",
    "backend.freeTrialDesc": "A free quota hosted by this site; works out of the box, no key needed",
    "backend.freeTrial2": "Free trial 2",
    "backend.freeTrial2Desc": "A second free quota hosted by this site",
    "backend.llmFreeTrial": "LLM free trial 1",
    "backend.llmFreeTrialDesc":
      "A free LLM quota hosted by this site. Behind it is a general-purpose language model, wrapped into a Jev-compatible interface by the broker — identical from above, just far slower and metered in tokens. Selecting it adds four call settings to the API drawer.",
    "backend.vercel": "Vercel AI Gateway (direct)",
    "backend.vercelDesc": "Bring your own key; the quota is yours to control.",
    "backend.typesafe": "TypeSafe official",
    "backend.typesafeDesc":
      "Endpoint and protocol confirmed against the public openapi.json; this project has not tested it with a key.",
    "backend.openrouter": "OpenRouter",
    "backend.openrouterDesc": "Direct connection to OpenRouter's systemone endpoint.",
    "backend.laya": "Local Laya",
    "backend.layaDesc":
      "Requires you to implement a SystemOne sidecar. Its confidence is not on the same scale as Jev's.",
    "backend.custom": "Custom / local compatible endpoint",
    "backend.customDesc": "Any address speaking the systemone protocol.",
    "backend.verified": "Verified working.",
    "backend.unverified": "Not verified: ",
    "backend.unverifiedTag": " (unverified)",
    "backend.unreachableTag": " (unavailable in this deployment)",
    "backend.unreachableNote":
      "This backend cannot work here: it needs a server to hold the key, and this is a **purely static** deployment with no remote address configured. Pick a direct backend and bring your own key, or deploy to localhost / Vercel (there the proxy is same-origin and needs no extra configuration).",
    "backend.modelManaged": "chosen by this site",
    "backend.modelManagedHint": "This backend's model is chosen server-side and cannot be changed",
    "backend.modelPlaceholder": "Leave empty to use the default model {model}",
    "backend.keyPlaceholder": "Paste your API key here (kept in memory only)",
    "backend.noKeyPlaceholder": "This backend needs no key",
    "backend.currentTitle": "Current backend: {label} · {model}",
    "backend.currentTitleShort": "Current backend: {label}",
    "backend.remoteSuffix": "{label} (remote)",

    /* ---------- LLM call settings (only shown for an LLM backend) ---------- */
    "api.llmTitle": "LLM call settings",
    "api.llmNote": "These apply to this backend only; the values stay put when you switch away.",
    "api.cot": "Chain of thought",
    "api.cotDesc":
      "Off by default. Measured on two backends: success went from 0–63% to 100%, 5–40× faster, reasoning tokens to zero — turning it off structurally removes the “reasoning eats the whole budget” failure mode, the only one we ever observed.",
    "api.allowThink": "Allow thinking",
    "api.allowEmpty": "Leave empty (say nothing)",
    "api.allowYes": "Yes",
    "api.allowNo": "No",
    "api.effort": "Thinking effort",
    "api.effortEmpty": "Default (empty)",
    "api.effortNone": "None",
    "api.effortLow": "Low",
    "api.effortMedium": "Medium",
    "api.effortHigh": "High",
    "api.effortXhigh": "Extra high (xhigh)",
    "api.effortMax": "Max",
    "api.effortWarn":
      "Measured: setting this explicitly drops the success rate sharply (3/3 → 0–1/3). Leave it empty.",
    "api.effortDegraded":
      "⚠ This backend does not accept that value, so it is dropped (the field is not sent). Sending it anyway would 400 the whole decision request.",
    "api.callPolicy": "Call policy",
    "api.policyJson": "JSON output",
    "api.policyTool": "Tool loop",
    "api.callPolicyNote":
      "JSON constrains the shape through the prompt in a single call (measured 2–4× faster); the tool loop enforces it with a schema and can take several rounds. Both are kept because the difference is itself a variable worth comparing.",
    "api.effortCoupling": "“No” and `none` are two ways of saying the same thing; the UI keeps them in step.",

    /* ---------- Footer and status ---------- */
    "stats.total": "Total",
    "stats.avgCost": "Avg",
    "stats.avgCostTitle": "Average cost per successful call — failed calls are excluded",
    "stats.latency": "Latency",
    "status.ready": "Ready",
    "status.calling": "Waiting for both decisions…",
    "status.retrying": "Retry {n} (in {s}s)",
    "status.online": "Connected",
    "status.paused": "Paused",
    "status.quota": "Out of quota",
    "status.apiFail": "Call failed",
    "status.costs": "Cost estimated from the 2026-09 price list",
    "status.backendUnreachable": "This backend cannot work in this deployment",

    /* ---------- End of game ---------- */
    "over.gameOver": "Game over",
    "over.reason": "Reason",
    "over.winner": "Winner",
    "over.draw": "Draw",
    "over.stats": "{turn} turns | final {alive} cells ({ratio}) | this game A.MAX {max} / A.MIN {min}",
    "over.ratioLine": "Life line {life} · Death line {death}",
    "over.ratioLineSolo": "Win at {life} · died out at {death}",
    "over.again": "Play again",
    "over.close": "Close and inspect the final board",
    "over.apiFail": "Call failed",
    "over.failBody": "{msg}\n(the retry budget of {n} is exhausted — a failure is a failure; a stale distribution is never substituted)",
    "over.failBodyInf": "{msg}",
    "over.retry": "Retry this turn",
    "over.skip": "Skip this turn and continue",
    "over.backendTitle": "This backend cannot work in this deployment",
    "over.goApi": "Go configure a backend",
    "over.halt": "Pause the game",

    /* ---------- Termination reasons ---------- */
    "term.lifeWinRatio": "Live ratio held ≥ {ratio} for {n} turns — Life wins",
    "term.deathWinRatio": "Live ratio held ≤ {ratio} for {n} turns — Death wins",
    "term.noLegalCellLife": "Life filled the board (Death has no legal cell) — Life wins",
    "term.noLegalCellDeath": "Death emptied the board (Life has no legal cell) — Death wins",
    "term.repeatBlocked": "The position can no longer move: every combination leads back to a seen position",
    "term.turnLimit": "Reached the {n}-turn limit without a winner",
    "term.soloDiedOut":
      "The live-cell ratio stayed ≤ {ratio} for {n} turns — the board died out (there is no opponent in a solo game, so “Death wins” does not apply)",

    /* ---------- Errors invented by the UI (not from upstream) ---------- */
    "err.backendUnreachable":
      "The backend “{label}” used by {role} needs a server to hold the key, but this is a purely static deployment with no remote address configured — the request cannot even leave, which is why there is **no retry button**. Switch to a direct backend and bring your own key.",

    /* ---------- Decision reasons (resolveDecision's reasonKey) ---------- */
    "reason.noProb": "No probability distribution in the response; taking the first legal cell",
    "reason.sampled": "Sampled from the distribution",
    "reason.belowThreshold": "Jev gave only {p}%, below the {t}% threshold",
    "reason.takeTop": "Taking the highest probability",
    "reason.coerced": "Jev's first choice ({row}, {col}) is not one it can flip; taking the next best legal cell in its own distribution",
    "reason.noLegal": "No legal cell in the model's distribution; taking the first legal one",

    /* ---------- Log ---------- */
    "log.title": "Call log",
    "log.desc": "One entry per turn: both sides' request and response. Collapsed by turn; expand for the full JSON.",
    "log.empty": "No calls recorded yet",
    "log.turnCount": "{n} turns",
    "log.copyReq": "Copy request",
    "log.copyRes": "Copy response",
    "log.copyBoth": "Copy both",
    "log.reqLabel": "Request",
    "log.resLabel": "Response",
    "log.noResponse": "(no response — the call failed before one arrived)",
    "log.failed": "FAILED",
    "log.pagedNote": "Only the last {n} turns are rendered; earlier entries stay in memory and are included in “Copy all”",
    "log.copyAll": "Copy all",
    "log.clear": "Clear",
    "log.clearTitle": "Clear the whole call log (cannot be undone)",
    "log.p": "p",
    "log.calls": "{n} upstream",
    "log.roleLife": "Life",
    "log.roleDeath": "Death",
    "log.noPayload": "(restored from an archive; request bodies were not kept)",
    "log.costUnknown": "cost unknown",

    /* ---------- Archive ---------- */
    "archive.desc": "Each kind is a separate archive you can back up and restore on its own. Exports are JSON files; imports are validated field by field.",
    "archive.game": "Game (board and progress)",
    "archive.gameDesc": "Board, turn, scores, memory, call log, plus size / topology / end rules / opening.",
    "archive.strategyDesc": "Both players' context (rule notes, strategy hint, outcome prediction, memory turns, pattern detection) and rules (decision strategy, confidence threshold).",
    "archive.apiDesc": "Automatic retry parameters.",
    "archive.noKey": "No keys",
    "archive.noKeyDesc": " — keys are never written to disk, so they cannot be exported either.",
    "archive.logDesc": "Every request record, with full request and response bodies. Export only — a log is a record of what happened; importing one is meaningless.",
    "archive.logExportOnly": "Logs are export-only",
    "archive.all": "Everything",
    "archive.export": "Export",
    "archive.import": "Import",
    "archive.exportAll": "Export all",
    "archive.wipe": "Wipe archives",
    "archive.wipeTitle": "Delete every local archive and reload",
    "archive.done": "Done",

    /* ---------- Incompatible archive modal ---------- */
    "incompat.title": "An incompatible archive was found",
    "incompat.desc": "There is older data on this machine, but this version cannot read it.",
    "incompat.whyEdited": "It may have been written by an earlier version, or modified externally.",
    "incompat.whyKept": "So that your progress is not lost, the app did",
    "incompat.none": "not",
    "incompat.whyDecide": "clean it up automatically — please decide what to do first.",
    "incompat.reason": "Why reading failed",
    "incompat.raw": "Raw data (truncated preview, size",
    "incompat.force": "Force load",
    "incompat.salvage":
      "does its best to salvage what it can: the board and turn count usually survive, unreadable fields are dropped and reported honestly.",
    "incompat.order": "Suggested order: export the old data first, then decide whether to force-load or reset.",
    "incompat.export": "⬇ Export old data",
    "incompat.reset": "Reset to defaults",
    "incompat.later": "Later",

    /* ---------- Quota modal ---------- */
    "quota.title": "Out of quota",
    "quota.desc": "The current backend's quota is exhausted or rate-limited.",
    "quota.notNetwork": "This is usually not a network problem, and retrying will not fix it — switch backends or use your own key.",
    "quota.serverReturned": "The server returned",
    "quota.whatCanDo": "What you can do",
    "quota.step1": "1. Switch to",
    "quota.gatewayBold": "Vercel AI Gateway (direct)",
    "quota.gatewayHint": " and enter your own API key (recommended; the quota is yours)",
    "quota.step2": "2. Use the",
    "quota.official": "TypeSafe official",
    "quota.or": "or",
    "quota.backendWord": "backend",
    "quota.step3": "3. Try again later — if it is a shared free quota, wait for it to recover",
    "quota.switch": "Go change the backend",

    /* ---------- Session read errors ---------- */
    "sesserr.notObject": "The archive's top level is not an object",
    "sesserr.badJson": "The archive is not valid JSON",
    "sesserr.versionHigh": "Archive version v{v} is newer than the supported v{cur} (running it degraded would drop fields)",
    "sesserr.noSize": "Missing board size",
    "sesserr.noBoard": "Missing board, or its row count does not match the size",
    "sesserr.noTurn": "Missing turn count",
    "sesserr.notChess": "This archive does not belong to Life Chess (missing or wrong app marker)",

    /* ---------- Salvage ---------- */
    "salv.turn": "Turn count reset to zero",
    "salv.memory": "Memory cleared",
    "salv.rawGone": "The raw data is gone",
    "salv.exported": "Old data exported",
    "salv.forceFail": "Not even the board could be salvaged",
    "salv.forced": "Force-loaded (turn {n})",
    "salv.forcedShort": "Force-loaded up to turn {n}",
    "salv.forcedPartial": "Force-loaded: {list}",
    "salv.restoredShort": "Restored the previous game (turn {n})",

    /* ---------- Archive errors ---------- */
    "arcerr.badJson": "Not a valid JSON file",
    "arcerr.notObject": "The archive content is not an object",
    "arcerr.notOurs": "This does not look like an archive from this app (missing the app marker, or it is not jev-life)",
    "arcerr.noVersion": "The archive is missing a version number",
    "arcerr.versionHigh": "Archive version v{v} is newer than the supported v{cur}; upgrade the app before importing",
    "arcerr.unknownKind": "Unknown archive kind: {kind}",
    "arcerr.noPayload": "The archive is missing its payload",
    "arcerr.logNoImport": "Log archives cannot be imported",
    "arcerr.readFail": "Failed to read the file",

    /* ---------- Field and archive kind names ---------- */
    "field.gameSettings": "game settings",
    "field.apiSettings": "API settings",
    "field.session": "game",
    "field.roles": "both players' settings",
    "kind.game": "game",
    "kind.strategy": "strategy",
    "kind.api": "API",
    "kind.log": "log",
    "kind.all": "everything",

    /* ---------- Toasts ---------- */
    "toast.copied": "Copied",
    "toast.copyFail": "Copy failed",
    "toast.exported": "Exported “{label}”",
    "toast.imported": "Imported: {list}",
    "toast.importEmpty": "This archive has nothing to apply",
    "toast.importFail": "Import failed: {msg}",
    "toast.readFail": "Could not read the file: {msg}",
    "toast.kindMismatch": "This is a “{from}” archive and cannot be imported as “{to}”",

    /* ---------- Confirmations ---------- */
    "confirm.gameReset": "Reset size, topology, end rules, opening and effects to factory values, and restart the game?",
    "confirm.strategyReset": "Reset this player's context and rules to factory values? (the other side is untouched)",
    "confirm.apiReset": "Reset the retry parameters to factory values? (backend and key are untouched)",
    "confirm.logClear": "Clear the whole call log? This cannot be undone.",
    "confirm.wipeAll": "Delete every local archive (settings, game, log) and reload?",
    "confirm.incompatReset": "Discard this unreadable archive and start a new game?",
    "confirm.resetDone": "Reset done",
    "confirm.kept": "Archive kept as is",

    /* ---------- Boot ---------- */
    "boot.missingDom": "Startup self-check failed: {n} element(s) are missing from index.html — {list}",
    "boot.missingDomHint":
      "\nThis usually means HTML and TS are out of sync (an id changed on one side only).\nRun node tools/check-dom.ts to locate it before building.",
    "boot.failedBody": "Life Chess failed to start:\n\n{msg}",

    /* ---------- Developer console ---------- */
    "dev.bootFail": "[Life×Jev] Startup failed:",
    "dev.bootInfo":
      "[Life×Jev] {cols}×{rows} {topology} opening {opening} turn limit {turnLimit} channel {channel}",
  },
};

let current: Lang = "zh";

const listeners: Array<() => void> = [];

/**
 * 从 BCP-47 语言标签判断用哪门界面语言：`zh` 开头一律中文（含 zh-CN / zh-Hant），
 * 其余一律英文。
 *
 * 抽成纯函数是为了可测 —— `detectLang` 依赖全局 `navigator`，在 Node 里不好造。
 */
export function langFromTag(tag: string | undefined): Lang {
  return /^zh/i.test(tag ?? "") ? "zh" : "en";
}

/** 按浏览器语言猜一个默认值。没有 navigator（如 Node）时回落到中文。 */
export function detectLang(): Lang {
  if (typeof navigator === "undefined") return "zh";
  return langFromTag(navigator.language);
}

export function getLang(): Lang {
  return current;
}

/**
 * 设置当前语言。
 *
 * 只管内存状态与广播，**不碰持久化** —— 落盘由 `main.ts` 订阅后写入 config，
 * 这样 i18n 不必反向依赖 config，避免循环引用。
 */
export function setLang(l: Lang): void {
  if (l === current) return;
  current = l;
  for (const cb of listeners) cb();
}

/** 订阅语言变更，返回取消订阅的函数 */
export function onLangChange(cb: () => void): () => void {
  listeners.push(cb);
  return () => {
    const i = listeners.indexOf(cb);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** 语言的自称，用于切换按钮的标签 —— 刻意不翻译 */
export function langName(l: Lang): string {
  return DICT[l]["nav.langName"];
}

/**
 * 取词条并做参数插值。
 *
 * 缺 key 时依次回落到中文词条、最后回落到 key 本身 —— **绝不抛异常**：
 * 界面不该因为漏翻一条就整个白屏，那正是这个项目踩过的坑
 * （见 tools/check-dom.ts 的注释）。
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const s = DICT[current][key] ?? DICT.zh[key] ?? key;
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m,
  );
}

/** 把 `data-i18n*` 属性扫一遍写回 DOM */
export function applyDom(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-html]").forEach((el) => {
    const key = el.dataset.i18nHtml;
    if (key) el.innerHTML = t(key);
  });
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
  root.querySelectorAll<HTMLInputElement>("[data-i18n-ph]").forEach((el) => {
    const key = el.dataset.i18nPh;
    if (key) el.placeholder = t(key);
  });
  // 同步 <html lang>，让浏览器按正确语言处理断行、拼写检查与朗读。
  // 先判 document 是否存在 —— 否则在 Node（测试环境）里引用 document 会直接抛错。
  if (typeof document === "undefined") return;
  if (root === document || root === document.documentElement) {
    document.documentElement.lang = current === "zh" ? "zh-CN" : "en";
  }
}

/** 词条表的只读视图，仅供测试断言用 */
export function dictFor(l: Lang): Readonly<Record<string, string>> {
  return DICT[l];
}
