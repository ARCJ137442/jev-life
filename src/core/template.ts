/**
 * 规则说明书的「模板 + 占位符自动填充」。
 *
 * ═══ 为什么要有这一层 ═══
 *
 * 在此之前，六项规则文本（`StateRules` 里除 `role` 之外的那六项）是**在代码里
 * 现算**的，用户能改的只有「规则说明（补充）」与「策略提示」。那个设计有它的
 * 来由（见下），代价是**用户看不到也改不了模型的说明书正文** ——
 * 而 2048 那边这六项是一张可编辑的 textarea。
 *
 * 模板把两边都给了：**措辞由用户定，数值由设置填**。
 *
 * ═══ 不能因为模板而破掉的那条 ═══
 *
 * 「数值单一来源」—— T10 不肯放一份手写副本进来，就是因为副本会与「游戏」面板
 * 里的当前设置**互相矛盾**，相当于对 Jev 说谎。模板**没有求值能力**：它只会把
 * `{{名字}}` 换成当前值，用户写死一个数字，那个数字就永远停在那儿（`template.test.ts`
 * 有一条用例专门把这条边界钉住）。所以模板只决定措辞。
 *
 * ═══ 为什么默认模板是「角色参数化」的 ═══
 *
 * 模板是**玩家级**设置（与 `ruleNote` / `strategyHint` 同级），而「复制到另一方」
 * 会把一个玩家的整份设置拷给另一个。所以默认模板里凡是与角色有关的字（「你是
 * Life」、方向的「大/小」）**必须走占位符**：写死在默认文本里的话，
 * 「复制到另一方」会把生之执那一份拷给死之执 —— 死之执会收到一份写着
 * 「你的目标是让活细胞尽可能多」的说明书，而它一句话都不会报错。
 *
 * ═══ 为什么有些占位符是「整句话」而不是一个数 ═══
 *
 * 同一项规则在单人局与双人局里**说法不同**（「你获胜」vs「生之执获胜」、
 * 「死之执获胜」vs「你落败 —— 棋盘死绝」），不设回合上限时又多一种说法。
 * 模板是一段**静态文字**，没有分支能力；所以这些随模式/设置改变措辞的整句
 * 只能由占位符产出。占位符表（`PLACEHOLDERS`）把每一个都列了出来，
 * 界面会把它们的**当前展开值**显示给用户 —— 看不到的部分只剩「代码怎么拼的」，
 * 而不再有「界面上一片空白」。
 *
 * 本是纯函数：无 DOM、无网络、无 i18n（`core/` 的红线，`tools/scan.ts` 守着）。
 * 面向用户的那句话由调用方按 `whyKey` 翻译 —— 这里只留 key，不留措辞。
 */

import type { Board, GameRules, Mode, Role, Topology } from "./types.js";

/* ══════════════════════════════════════════════════════════════════
   模板
   ══════════════════════════════════════════════════════════════════ */

/** `StateRules` 里可模板化的六项。`role` 本身不是文本，不在此列 */
export type RuleTemplateKey =
  | "role_statement"
  | "objective"
  | "horizon"
  | "termination_conditions"
  | "win_condition"
  | "topology_note";

export type RuleTemplates = Record<RuleTemplateKey, string>;

/**
 * 六项的**界面顺序**。写成常量而不是各处 `Object.keys`：顺序在这里是**数据**
 * （它决定抽屉里从上到下怎么排），不能跟着对象的写法跑。
 */
export const TEMPLATE_KEYS: readonly RuleTemplateKey[] = [
  "role_statement",
  "objective",
  "horizon",
  "termination_conditions",
  "win_condition",
  "topology_note",
];

/* ══════════════════════════════════════════════════════════════════
   占位符
   ══════════════════════════════════════════════════════════════════ */

/**
 * 一个占位符的说明。
 *
 * `whyKey` 是**缺了它模型就不知道什么**的 i18n key。删占位符不会报错、
 * 也不会让程序跑不动 —— 只会让模型玩另一个游戏，所以那句解释是这条警告的
 * 全部内容。分类是刻意的：`core/` 不许引 i18n，措辞只能留在界面层。
 */
export interface PlaceholderSpec {
  readonly name: string;
  readonly whyKey: string;
}

/**
 * 全部占位符。**与 `templateVars` 双向对齐**（有测试守着）：
 * 表里有而 `templateVars` 不产 → 用户照着填进去只会得到原样的花括号；
 * `templateVars` 产了而表里没有 → 校验会把它误报成「认不出的占位符」。
 */
export const PLACEHOLDERS: readonly PlaceholderSpec[] = [
  { name: "role", whyKey: "tpl.why.role" },
  { name: "codename", whyKey: "tpl.why.codename" },
  { name: "direction", whyKey: "tpl.why.direction" },
  { name: "flipAbility", whyKey: "tpl.why.flipAbility" },
  { name: "attitude", whyKey: "tpl.why.attitude" },
  { name: "objectiveMine", whyKey: "tpl.why.objectiveMine" },
  { name: "mode", whyKey: "tpl.why.mode" },
  { name: "perTurnFlips", whyKey: "tpl.why.perTurnFlips" },
  { name: "turn", whyKey: "tpl.why.turn" },
  { name: "turnLimit", whyKey: "tpl.why.turnLimit" },
  { name: "lifeWinRatio", whyKey: "tpl.why.lifeWinRatio" },
  { name: "deathWinRatio", whyKey: "tpl.why.deathWinRatio" },
  { name: "lifeStreak", whyKey: "tpl.why.lifeStreak" },
  { name: "deathStreak", whyKey: "tpl.why.deathStreak" },
  { name: "topology", whyKey: "tpl.why.topology" },
  { name: "topologyDetail", whyKey: "tpl.why.topologyDetail" },
  { name: "cols", whyKey: "tpl.why.cols" },
  { name: "rows", whyKey: "tpl.why.rows" },
  { name: "cells", whyKey: "tpl.why.cells" },
  { name: "winnerLine", whyKey: "tpl.why.winnerLine" },
  { name: "loserLine", whyKey: "tpl.why.loserLine" },
  { name: "endByWinLine", whyKey: "tpl.why.endByWinLine" },
  { name: "endByBoardFull", whyKey: "tpl.why.endByBoardFull" },
  { name: "endByStuck", whyKey: "tpl.why.endByStuck" },
  { name: "turnLimitEnd", whyKey: "tpl.why.turnLimitEnd" },
];

/* ══════════════════════════════════════════════════════════════════
   文案
   ══════════════════════════════════════════════════════════════════

   全部写死在 `core/` 里，不走翻译层（理由见 context.ts 文件头：喂给 Jev 的
   内容不随界面语言变，否则跨语言的对局不可比）。参数一律现拼，
   不出现「写死的可变参数」—— 2048 的教训：把「每次生成几个方块」
   写进规则描述，改了设置它就变成一句假话。 */

/**
 * 百分比文本。
 *
 * 不手写数字，也不直接 `ratio * 100` —— 0.6 在二进制里是 0.5999…，
 * 乘 100 之后是可打印的 60.00000000000001。修约到 4 位再转数字，
 * 输出才是人（和模型）读得懂的那个数。
 */
function percent(ratio: number): string {
  return `${Number((ratio * 100).toFixed(4))}%`;
}

const roleName = (role: Role): string => (role === "life" ? "生之执" : "死之执");

/**
 * 角色目标陈述里的方向词。
 *
 * ★ **死之执必须显式反向。** 它的目标是**最小化**活细胞数，而模型的默认直觉是
 * 「让细胞活下来」。只写「你是 Death」是不够的 —— 那测到的是模型的直觉，
 * 不是它对规则的理解。所以死之执那一份要主动否定直觉（「让细胞活着对你不利」），
 * 生之执给对称的正向表述。测试锁的是**方向词**，不是角色名。
 */
function roleDirection(role: Role): { codename: string; direction: string; flipAbility: string; attitude: string } {
  if (role === "life") {
    return {
      codename: "Life",
      direction: "大 —— 也就是让棋盘上的活细胞尽可能多",
      flipAbility: "你每回合可以翻转一个死格为活。",
      attitude: "有利",
    };
  }
  return {
    codename: "Death",
    direction: "小 —— 也就是让棋盘上的活细胞尽可能少",
    flipAbility: "你每回合可以翻转一个活格为死。",
    attitude: "不利，即使它们看起来能组成漂亮的结构",
  };
}

/* ══════════════════════════════════════════════════════════════════
   填充
   ══════════════════════════════════════════════════════════════════ */

/**
 * 占位符的语法。
 *
 * 名字取**除花括号以外的任意字符**，而不是 `[A-Za-z0-9_]+`：后者遇到
 * `{{回合}}` 时匹配不上，于是它既不会被填、也不会被报成「认不出的占位符」，
 * 只能靠「未闭合」那条兜底 —— 而它明明是闭合的，报错就报歪了。
 * 现在它是「一个名字为『回合』的占位符」，校验会说「这个占位符不认识」。
 */
const PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g;

/** 模板里出现过的占位符名（按出现顺序，重复的只留一次） */
export function placeholdersIn(tpl: string): string[] {
  const out: string[] = [];
  for (const m of tpl.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 把 `{{名字}}` 换成值。
 *
 * **认不出的占位符原样留着**，不吃成空串：用户写的半句话凭空消失是那种
 * 「不发一言的错」，而送进 state 的文字看起来完全正常。留着它，至少
 * 日志里能看见，校验也能报出来。
 */
export function fillTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(PLACEHOLDER_RE, (whole, name: string) =>
    Object.hasOwn(vars, name) ? vars[name] : whole,
  );
}

/* ══════════════════════════════════════════════════════════════════
   templateVars
   ══════════════════════════════════════════════════════════════════ */

export interface TemplateInput {
  readonly role: Role;
  /** 对局模式。规则文案在两种模式下**不一样** —— 见 `types.ts` 的 `Mode` */
  readonly mode: Mode;
  readonly topology: Topology;
  /** 尺寸与总格数从棋盘取（它才是权威，别另外传一份 cols/rows） */
  readonly board: Board;
  /** 已完成的回合数（0 起）。显示成「第 T 回合」要 +1，这个差 1 只在这里出现一次 */
  readonly turn: number;
  readonly rules: GameRules;
}

/**
 * 当前设置下的占位符取值。
 *
 * 它同时是**界面上那张「占位符 → 当前值」对照表**的数据源 —— 用户因此能看见
 * 每一项在他这份设置下到底会变成什么，而不是先保存、再开局、再看日志。
 *
 * ⚠ `turnLimit` 为 `null` 时**产出的是整句话**（「不设回合上限 —— …」），
 * 不是一个数、更不是 `null`：`null` 会一路拼进 state，而「留空 = 不设上限」
 * 是用户刚定的规则，让它变成一句乱码等于把那条规则改成了另一条。
 */
export function templateVars(i: TemplateInput): Record<string, string> {
  const { role, mode, topology, board, turn, rules } = i;
  const solo = mode === "solo";
  const total = board.cols * board.rows;

  // 「第 T 回合」而不是「第 T+1 回合」：`turn` 是**已完成的回合数**（0 起）
  const displayTurn = turn + 1;

  const horizon =
    rules.turnLimit === null
      ? "不设回合上限 —— 一直下到分出胜负、走投无路或推不动为止"
      : `共 ${rules.turnLimit} 回合，还剩 ${rules.turnLimit - turn} 回合`;

  const winnerLine = solo
    ? `你获胜：存活比例「连续」 ${rules.lifeStreak} 回合 ≥ ${percent(rules.lifeWinRatio)}。`
    : `生之执获胜：存活比例「连续」 ${rules.lifeStreak} 回合 ≥ ${percent(rules.lifeWinRatio)}。`;

  // ★ 单人局里「死之执获胜」是一句关于一个**不在场的人**的话。同一条占比线
  // 在单人局的含义是「局面自己死绝了」，措辞照实写
  const loserLine = solo
    ? `你落败：存活比例「连续」 ${rules.deathStreak} 回合 ≤ ${percent(rules.deathWinRatio)} —— 棋盘死绝。`
    : `死之执获胜：存活比例「连续」 ${rules.deathStreak} 回合 ≤ ${percent(rules.deathWinRatio)}。`;

  // 终局条件的四条。每一条都随模式 / 回合上限改说法，所以整条是一个占位符
  const endByWinLine = solo
    ? "你达成获胜条件，或棋盘死绝（存活比例连续越界达到规定回合数，详见获胜条件）。"
    : "一方达成获胜条件（存活比例连续越界达到规定回合数，详见获胜条件）。";

  // 单人：**棋盘全死不是终局**（生之执处处可翻），只有占满才结束。
  // 照搬双人那条会凭空多出一条不存在的结束方式，而模型会据此高估
  // 「棋盘被清空」的危险，甚至以为自己已经输了
  const endByBoardFull = solo
    ? "棋盘全活 —— 你把棋盘占满了，一个死格都不剩，判你获胜。" +
      "这不是「没棋可走就输」，而是你把自己的目标推到了极限。" +
      "**注意：棋盘全死不会结束对局** —— 那时你仍然可以翻转任意一个死格。"
    : "走投无路之一：棋盘全死 —— 死之执把活细胞清空了，判死之执胜；" +
      "棋盘全活 —— 生之执把棋盘占满了，判生之执胜。" +
      "这不是「没棋可走就输」，而是一方把自己的目标推到了极限。";

  const endByStuck = solo
    ? "推不动了：此后无论你怎么落子，下一回合的局面都会重复已经出现过的局面 —— " +
      `按当时的存活比例判：≥ ${percent(rules.lifeWinRatio)} 判你胜，≤ ${percent(rules.deathWinRatio)} 判你落败，` +
      "夹在两条线之间判和局。"
    : "走投无路之二：此后无论双方怎么落子，下一回合的局面都会重复已经出现过的局面（推不动了）—— " +
      `按当时的存活比例判：≥ ${percent(rules.lifeWinRatio)} 判生之执胜，≤ ${percent(rules.deathWinRatio)} 判死之执胜，` +
      "夹在两条线之间判和局。";

  // 不设上限时这一条整个换掉 —— 写「上限 ∞」等于告诉模型「还有很多回合」，
  // 那是一条凭空造出来的规则
  const turnLimitEnd =
    rules.turnLimit === null
      ? "**本局不设回合上限** —— 一直下到分出胜负、走投无路或推不动为止。"
      : `回合数达到上限 ${rules.turnLimit}：仍未分出胜负，判和局。`;

  const topologyDetail =
    topology === "bounded"
      ? "棋盘之外一律算死格 —— 界外没有邻居，一个贴着边界的活细胞在边界那一侧就是没有邻居。棋盘不会卷起来，边界是墙。"
      : "棋盘的上下边相连、左右边相连 —— 从一条边走出去的细胞会从对面那条边进来，所以每个格子都有完整的 8 个邻居，棋盘上没有墙。";

  return {
    ...roleDirection(role),
    role: roleName(role),
    objectiveMine:
      role === "life"
        ? "你是生之执：累计净增长越大越好 —— 终局时结算的就是它。"
        : "你是死之执：累计净增长越小越好 —— 终局时结算的就是它，每一代多出来的活细胞都算在你头上。",
    mode: solo ? "单人" : "双人对弈",
    perTurnFlips: solo ? "你翻一格" : "双方各翻一格",
    turn: String(displayTurn),
    turnLimit: horizon,
    lifeWinRatio: percent(rules.lifeWinRatio),
    deathWinRatio: percent(rules.deathWinRatio),
    lifeStreak: String(rules.lifeStreak),
    deathStreak: String(rules.deathStreak),
    topology: topology === "bounded" ? "有界（bounded）" : "环绕（torus）",
    topologyDetail,
    cols: String(board.cols),
    rows: String(board.rows),
    cells: String(total),
    winnerLine,
    loserLine,
    endByWinLine,
    endByBoardFull,
    endByStuck,
    turnLimitEnd,
  };
}

/* ══════════════════════════════════════════════════════════════════
   默认模板
   ══════════════════════════════════════════════════════════════════ */

/**
 * 出厂模板 —— 填出来的就是「没有这一层之前」那段文字。
 *
 * 两者必须逐字一致（`context.test.ts` 有一条对拍用例）：默认值一旦与旧文案
 * 分叉，所有既有对局的测量基线就悄悄换了，而它看起来只是「加了个功能」。
 *
 * 两个角色的默认模板**是同一份**（角色差异全在占位符里）—— 理由见文件头。
 */
export const DEFAULT_TEMPLATES: RuleTemplates = {
  role_statement:
    "{{role}}：你是 {{codename}}。你的目标是在对局结束时让累计净增长尽可能{{direction}}。" +
    "{{flipAbility}}注意：让细胞活着对你{{attitude}}。",

  objective:
    "计分方式：每回合{{perTurnFlips}}，然后棋盘演化一代；" +
    "演化后的活细胞数与上一回合相比的变化量，就是这一回合的净增长。" +
    "把各回合的净增长累加起来，得到累计净增长，记在 scores 里。{{objectiveMine}}",

  horizon: "本局{{turnLimit}}，当前是第 {{turn}} 回合。",

  termination_conditions:
    "对局在下列任一情况下立即结束：\n" +
    "1. {{endByWinLine}}\n" +
    "2. {{endByBoardFull}}\n" +
    "3. {{endByStuck}}\n" +
    "4. {{turnLimitEnd}}",

  // 防抖那一段里的两个 streak 是**字面**出现的：它们是「这条规则怎么算」的
  // 一部分，写在这里用户改得动；而获胜/落败那两行随模式改说法，只能整行占位
  win_condition:
    "存活比例 = 棋盘上的活细胞数 ÷ 总格数（{{cols}}×{{rows}} = {{cells}} 格），记在 alive_ratio 里。\n" +
    "{{winnerLine}}\n" +
    "{{loserLine}}\n" +
    "「连续」是这条规则的关键部分（防抖）：生命棋单代的涨落很大，只看一代就判胜负等于把胜负交给运气。" +
    "所以必须是连续越界满 {{lifeStreak}} / {{deathStreak}} 回合才算赢，中途只要有一回合回到两条线之间，计数就从头开始。",

  topology_note: "拓扑：{{topology}}。{{topologyDetail}}",
};

/* ══════════════════════════════════════════════════════════════════
   渲染
   ══════════════════════════════════════════════════════════════════ */

/**
 * 六项文本一起渲染。
 *
 * **空模板回落默认**（而不是渲染成空串）：一份空白的角色陈述发给模型，
 * 比没填更坏 —— 它看起来只是「这一栏没什么要说的」。回落的同时校验会照旧
 * 报「缺占位符」，所以「清空」这个动作既不会静默变成一句空规则，也不会
 * 静默消失。收 `Partial` 是因为存档与导入那两条路径送进来的可能是缺字段、
 * 甚至根本不是字符串的脏数据 —— 这里逐项兜底，是它们唯一的收敛点。
 */
export function renderTemplates(
  tpl: Partial<RuleTemplates> | undefined,
  vars: Record<string, string>,
): RuleTemplates {
  const out = {} as RuleTemplates;
  for (const key of TEMPLATE_KEYS) {
    const raw = tpl?.[key];
    const src = typeof raw === "string" && raw.trim() !== "" ? raw : DEFAULT_TEMPLATES[key];
    out[key] = fillTemplate(src, vars);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   校验：反向检查，警告但不阻止
   ══════════════════════════════════════════════════════════════════ */

export interface TemplateIssue {
  readonly key: RuleTemplateKey;
  /**
   * `missing`：默认模板里有、这份里没有 —— 模型会少知道一件事
   * `unknown`：认不出的占位符 —— 它会**原样**被送进 state
   * `unclosed`：有 `{{` 没有配对的 `}}` —— 那半句会连同花括号一起被送进 state
   */
  readonly kind: "missing" | "unknown" | "unclosed";
  readonly placeholder?: string;
}

/**
 * 列出模板里的问题。**只报，不挡** —— 用户可能是有意改写措辞。
 *
 * 判据是「默认模板里出现过、这份里没有了」，而不是一张手写的必需清单：
 * 手写清单会与默认模板各自演化，然后出现「默认模板自己就通不过校验」这种
 * 谁也不信这张表的状态。改默认模板的人本来就该同时想清楚「删掉它意味着
 * 模型少知道什么」—— 那条说明就写在 `PLACEHOLDERS` 的 `whyKey` 上。
 *
 * 这与 `tools/check-dom.ts` 的反向检查是同一种做法：构建期检查「TS 引用了
 * 但 HTML 没有」，这里检查「规则里该有的但模板里没有」。两处的判据都是
 * **「该有的」由一个别处可核对的来源定义**，而不是靠人记得。
 */
export function templateIssues(tpl: Partial<RuleTemplates> | undefined): TemplateIssue[] {
  const out: TemplateIssue[] = [];
  const known = new Set(PLACEHOLDERS.map((p) => p.name));

  for (const key of TEMPLATE_KEYS) {
    const raw = tpl?.[key];
    // 空模板与缺字段走的是「回落默认」那条路，但**照样要报**：
    // 「忘记填」与「有意清空」在界面上长得一样，而两种都值得被说一句
    const text = typeof raw === "string" ? raw : "";
    const present = placeholdersIn(text);

    for (const name of present) {
      if (!known.has(name)) out.push({ key, kind: "unknown", placeholder: name });
    }
    for (const name of placeholdersIn(DEFAULT_TEMPLATES[key])) {
      if (!present.includes(name)) out.push({ key, kind: "missing", placeholder: name });
    }
    // 每出现一个 `{{` 就该有一处匹配；多出来的那些是残缺的花括号。
    // 数的是**匹配次数**而不是出现过的名字数 —— 后者遇到 `{{turn}} … {{turn}}`
    // 会把第二次出现误报成残缺（同一个名字用了两遍本来就是合法的）
    let matched = 0;
    for (const _ of text.matchAll(PLACEHOLDER_RE)) matched++;
    const opened = text.split("{{").length - 1;
    for (let i = matched; i < opened; i++) out.push({ key, kind: "unclosed" });
  }
  return out;
}
