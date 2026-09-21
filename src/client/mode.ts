/**
 * ★ 模式切换的**界面侧影响**，收在一张表里。
 *
 * ═══ 为什么要单开一个模块 ═══
 *
 * 逻辑侧贯穿模式很容易做对（一次请求还是两次、只跑谁、日志里有没有
 * `death_flip`、终局原因），因为那些都是「不这么做就跑不起来」的错。
 * 界面侧的错**不会跑不起来**：单人局里照样显示「死之执获胜线」、
 * 照样让用户编辑一栏永远不会被读到的设置、图例里挂着一个永远画不出来的
 * 角色 —— 每一处都渲染得很正常。这与刚修掉的 `callPolicy` 是同一类：
 * 界面上有、实际不生效，症状离原因很远。
 *
 * 散在 `syncModeUi()` 里一个个写，就只能靠**代码审查**保证不漏；而「某个
 * 新加的文案忘了分模式」这种漏，审查恰恰是看不出来的（它长得与正确的一模一样）。
 * 收成一张表之后，它可以被无头环境断言：
 *
 *   · 每个 key 都在**两份**词条表里存在（`t()` 认不出时只会静默回落成 key 本身，
 *     界面上就出现一个 `ctrl.stepTitleSolo` 这样的字符串，不报错）
 *   · 单人局那几条文案里**不出现「双方」与「死之执」**（那是双人局的说法）
 *   · 该分模式的那几项，两种模式给的是**不同的 key**（漏分时它们会相等）
 *
 * ═══ 判据：什么该分模式 ═══
 *
 * 一条规则在单人局里**说不通**，措辞就必须分：说「双方各翻一格」而场上只有
 * 一个行动方，模型/用户就会去等一个不存在的对手。反过来，与角色无关的
 * （尺寸、拓扑、动效）不分 —— 分了只会让两张表各自演化。
 */

import type { Mode } from "../core/types.js";

/**
 * 某个模式下界面该用哪一套文案、哪些东西该收起来。
 *
 * 字段是**词条 key**而不是译文：这个模块要能在无头环境里被断言，
 * 而 `t()` 依赖界面语言（且 `core/` 那条红线之外才有 i18n）。
 */
export interface ModeUi {
  readonly solo: boolean;
  /**
   * 死之执那一栏（策略 / API 两个抽屉的 roletab）**是否出现在界面上**。
   *
   * ⚠ 单人局里是「整个收起来」，不是「显示但置灰」。原先的写法是停用，
   * 理由是「藏起来会让人以为这个角色被删了，而那几项设置其实还在存档里」。
   * 用户 2026-09-21 改掉了这个判断：单人局里行动方**生死一体**、只有一个，
   * 留一个点不动的「死之执」标签是在**指一个不存在的人** —— 而那个理由
   * 成立的前提（「死之执还在场上」）已经不成立了。设置本身照旧留在存档里。
   */
  readonly deathColumnEnabled: boolean;
  /**
   * 置信度图的图例**整块**是否显示。
   *
   * ⚠ 它原本是「死之执那一项是否显示」（`deathLegendVisible`）。生死一体之后
   * 单人局只剩**一条黄色的带**，图例里没有任何一项对得上它 —— 用户 2026-09-21
   * 定的是「无需图例」。于是「某一项不显示」不再是一个独立的意思：
   * 两种模式下整块要么都在、要么都不在。留着一个更细的字段只会让两者漂移
   * （图例整块收起了，里面某一项还在被单独地设成 `display:none`）。
   */
  readonly legendVisible: boolean;
  /** 死之执那条胜负线的标签。单人局里它说的是「棋盘死绝」 */
  readonly deathWinLabel: string;
  /**
   * 生之执那条胜负线的标签。单人局里行动方叫**玩家**，所以措辞跟着换。
   *
   * 单开一项而不是复用 `deathWinLabel` 的反面：两者的**变化方向相反** ——
   * 死之执那条在单人局里说的是**局面**（棋盘死绝，那条线不再属于任何人），
   * 生之执这条说的是**同一个行动方换了称呼**。混成一项迟早会有一边写错。
   */
  readonly lifeWinLabel: string;
  /**
   * **行动方的名字**：双人局是「生之执」，单人局是「玩家」。
   *
   * ⚠ 只换「名字」，不动人称。规则说明书里那 21 处第二人称的「你」
   * （「你获胜」「你翻一格」）**照旧** —— 那是直接称呼，不是角色名，
   * 而且「你」比「玩家」更贴着一对一对话的语感（用户 2026-09-21 定）。
   *
   * 它落到的位置比看上去多：决策面板的署名、日志行、终局文案、置信度图
   * 图例、后端标识、双侧同步的提示 —— 全部经由 `roleLabel()` 一个入口。
   */
  readonly lifeLabel: string;
  /**
   * 「游戏」抽屉里模式下拉下面那段说明。
   *
   * ★ 它**跟着选中的模式走**。原先是一句写死的「单人模式没有死之执……」——
   * 无论选哪一个都显示同一段，于是在双人局下它也在讲死之执，在单人局下
   * 它用死之执去解释一个没有死之执的局面。分模式之后，选到什么就读什么。
   */
  readonly modeNote: string;
  /** 「游戏」抽屉里那句胜负线说明 */
  readonly rulesNote: string;
  readonly rulesInverted: string;
  /** 状态栏「正在请求…」 */
  readonly calling: string;
  readonly stepTitle: string;
  readonly takeoverTitle: string;
  /**
   * 「开始 / 继续」按钮的**正文字**（`takeoverTitle` 是它的 tooltip）。
   *
   * 两项都要分模式，而且必须**一起**分：它们是同一个按钮（`bToggle`）的两个
   * 状态，轮流出场。只分一个的话，按钮会在「▶ 开始对弈」与「▶ 继续游戏」
   * 之间来回跳 —— 同一场对局里两个标签用两套说法，比两边都写错更刺眼。
   *
   * 单人局里「对弈」这个词本身就不成立：对弈要有对手，而那里只有你一个。
   */
  readonly takeover: string;
  readonly resume: string;
  readonly subtitleTitle: string;
  readonly memoryDesc: string;
  /** 玩家栏停用的理由（策略 / API 两个抽屉共用同一句） */
  readonly roleHint: string;
}

/**
 * 双人局：全都按「两个行动方都在场」写。
 *
 * ⚠ 单人局里那几条**不是**把「双方」删掉那么简单 —— 死之执那条胜负线仍然
 * 生效，但它的含义换成了「棋盘死绝」（`TerminationReason.soloDiedOut`），
 * 所以标签与说明是**重写**而不是删词。
 */
const DUEL: ModeUi = {
  solo: false,
  deathColumnEnabled: true,
  legendVisible: true,
  deathWinLabel: "game.deathWin",
  lifeWinLabel: "game.lifeWin",
  lifeLabel: "log.roleLife",
  modeNote: "game.modeNote",
  rulesNote: "game.rulesNote",
  rulesInverted: "game.rulesInverted",
  calling: "status.calling",
  stepTitle: "ctrl.stepTitle",
  takeoverTitle: "ctrl.takeoverTitle",
  takeover: "ctrl.takeover",
  resume: "ctrl.resume",
  subtitleTitle: "app.subtitleTitle",
  memoryDesc: "strategy.memoryDesc",
  roleHint: "strategy.perRoleNote",
};

/**
 * 单人局：只有生之执在走。
 *
 * 死之执那一栏的每一项都失去消费者（后端 / 模型 / 密钥 / 上下文 / 策略 /
 * 模板 —— 它一次都不会被调用），所以整栏停用；而**胜负线不停用**，
 * 它变成「棋盘死绝」的判据，只换措辞。
 */
const SOLO: ModeUi = {
  solo: true,
  deathColumnEnabled: false,
  legendVisible: false,
  deathWinLabel: "game.deathWinSolo",
  lifeWinLabel: "game.lifeWinSolo",
  lifeLabel: "log.rolePlayer",
  modeNote: "game.modeNoteSolo",
  rulesNote: "game.rulesNoteSolo",
  rulesInverted: "game.rulesInvertedSolo",
  calling: "status.callingSolo",
  stepTitle: "ctrl.stepTitleSolo",
  takeoverTitle: "ctrl.takeoverTitleSolo",
  takeover: "ctrl.takeoverSolo",
  resume: "ctrl.resumeSolo",
  subtitleTitle: "app.subtitleTitleSolo",
  memoryDesc: "strategy.memoryDescSolo",
  roleHint: "strategy.roleHintSolo",
};

export function modeUi(mode: Mode): ModeUi {
  return mode === "solo" ? SOLO : DUEL;
}
