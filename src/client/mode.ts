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
  /** 死之执那一栏（策略 / API 两个抽屉的 roletab）是否可用 */
  readonly deathColumnEnabled: boolean;
  /** 置信度图图例里「死之执」那一项是否显示 */
  readonly deathLegendVisible: boolean;
  /** 死之执那条胜负线的标签。单人局里它说的是「棋盘死绝」 */
  readonly deathWinLabel: string;
  /** 「游戏」抽屉里那句胜负线说明 */
  readonly rulesNote: string;
  readonly rulesInverted: string;
  /** 状态栏「正在请求…」 */
  readonly calling: string;
  readonly stepTitle: string;
  readonly takeoverTitle: string;
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
  deathLegendVisible: true,
  deathWinLabel: "game.deathWin",
  rulesNote: "game.rulesNote",
  rulesInverted: "game.rulesInverted",
  calling: "status.calling",
  stepTitle: "ctrl.stepTitle",
  takeoverTitle: "ctrl.takeoverTitle",
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
  deathLegendVisible: false,
  deathWinLabel: "game.deathWinSolo",
  rulesNote: "game.rulesNoteSolo",
  rulesInverted: "game.rulesInvertedSolo",
  calling: "status.callingSolo",
  stepTitle: "ctrl.stepTitleSolo",
  takeoverTitle: "ctrl.takeoverTitleSolo",
  subtitleTitle: "app.subtitleTitleSolo",
  memoryDesc: "strategy.memoryDescSolo",
  roleHint: "strategy.roleHintSolo",
};

export function modeUi(mode: Mode): ModeUi {
  return mode === "solo" ? SOLO : DUEL;
}
