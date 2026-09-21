/**
 * `core/template.ts` 的测试。
 *
 * 这个模块把「规则说明书」从一个**代码里生成的黑箱**变成「模板 + 占位符自动填充」。
 * 它同时引入了两类**做错了也不会报错**的问题，这个文件就是冲着它们来的：
 *
 *   1. **数值必须仍然只有设置一个来源**。模板是拿来改措辞的；一旦允许在模板里
 *      硬写「本局共 90 回合」，就退回了 2048 那条「写死可变参数相当于说谎」。
 *   2. **删掉占位符 = 对 Jev 说谎**，而它不会抛任何错 —— 模型照样会给出决策，
 *      只是它在玩另一个游戏。所以「缺了哪个占位符」必须能被查出来。
 *
 * 还有一条只有靠测试才守得住的**跨角色**性质：模板是玩家级的（两边各一份），
 * 而「复制到另一方」会把 A 的整份设置拷给 B。所以默认模板必须是**角色参数化**的
 * —— 否则把生之执那一份复制给死之执，死之执会收到一份写着「你是 Life」的说明书。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TEMPLATES,
  PLACEHOLDERS,
  TEMPLATE_KEYS,
  fillTemplate,
  renderTemplates,
  templateIssues,
  templateVars,
} from "../core/template.js";
import type { RuleTemplates, TemplateInput } from "../core/template.js";
import { boardFromRows } from "../core/life.js";
import type { Board, GameRules } from "../core/types.js";

/* ══════════════════════════════════════════════════════════════════
   夹具
   ══════════════════════════════════════════════════════════════════ */

const RULES: GameRules = {
  turnLimit: 90,
  lifeWinRatio: 0.6,
  deathWinRatio: 0.05,
  lifeStreak: 3,
  deathStreak: 3,
};

const ROWS = [
  "........",
  ".##.....",
  ".##.....",
  "........",
  "........",
  "........",
  "........",
  "........",
];

const BOARD = (): Board => boardFromRows(ROWS);

function inp(over: Partial<TemplateInput> = {}): TemplateInput {
  return {
    role: "life",
    mode: "duel",
    topology: "bounded",
    board: BOARD(),
    turn: 12,
    rules: RULES,
    ...over,
  };
}

const vars = (over: Partial<TemplateInput> = {}): Record<string, string> =>
  templateVars(inp(over));

/** 一份自定义模板：只改一项，其余取默认 */
function tpl(over: Partial<RuleTemplates> = {}): RuleTemplates {
  return { ...DEFAULT_TEMPLATES, ...over };
}

/* ══════════════════════════════════════════════════════════════════
   ① 填 充
   ══════════════════════════════════════════════════════════════════ */

test("fillTemplate：具名占位符被替换，同一个占位符出现几次就替换几次", () => {
  const v = { a: "甲", b: "乙" };
  assert.equal(fillTemplate("{{a}}/{{b}}/{{a}}", v), "甲/乙/甲");
  assert.equal(fillTemplate("没有占位符", v), "没有占位符");
});

test("fillTemplate：认不出的占位符**原样留着**，而不是被吃成空串", () => {
  // 吃成空串是本项目最该防的那种失败：用户写的半句话会**静默消失**，
  // 而送进 state 的那段文字看起来完全正常
  const out = fillTemplate("[{{nope}}]", { a: "甲" });
  assert.equal(out, "[{{nope}}]", "认不出的占位符被吞掉了 —— 用户写的字凭空少了半句");
});

test("fillTemplate：只有一半的大括号按字面留着，不会把它后面的字吞掉", () => {
  const v = { turn: "13" };
  for (const s of ["{{turn", "turn}}", "{{}}", "{ {turn}}", "{{turn} }"]) {
    const out = fillTemplate(s, v);
    assert.equal(out, s, `「${s}」被改动过 —— 残缺的花括号不该触发替换`);
  }
  // 正常的那一份照旧要填
  assert.equal(fillTemplate("第 {{turn}} 回合", v), "第 13 回合");
});

/* ══════════════════════════════════════════════════════════════════
   ② ★ 数值只有一个来源：模板只决定措辞
   ══════════════════════════════════════════════════════════════════ */

test("★ 模板只决定措辞：改设置，渲染结果必须跟着变", () => {
  const a = renderTemplates(tpl(), vars({ rules: { ...RULES, turnLimit: 90 } }));
  const b = renderTemplates(tpl(), vars({ rules: { ...RULES, turnLimit: 60 } }));

  assert.notEqual(a.horizon, b.horizon, "回合上限改了，horizon 却没变 —— 数值不是从设置来的");
  assert.match(a.horizon, /共 90 回合/);
  assert.match(b.horizon, /共 60 回合/);
  assert.match(b.termination_conditions, /60/);
});

test("★ 模板里硬写的数字**不会**被设置覆盖 —— 所以它只能是措辞，不能是参数", () => {
  // 这条不是在认可「硬写」，而是在把边界钉死：模板没有、也不该有任何求值能力。
  // 谁在模板里写死「本局共 90 回合」，改完设置之后那句话就是假的 ——
  // 这正是 2048 那条「写死可变参数相当于说谎」的教训。
  const hard = tpl({ horizon: "本局共 90 回合。" });
  const out = renderTemplates(hard, vars({ rules: { ...RULES, turnLimit: 60 } }));
  assert.equal(out.horizon, "本局共 90 回合。", "模板里的字面数字被改写了 —— 模板不该有求值能力");
});

/* ══════════════════════════════════════════════════════════════════
   ③ ★ turnLimit = null：不能渲染成 null / NaN
   ══════════════════════════════════════════════════════════════════ */

test("★ 不设回合上限时，占位符产出「不设回合上限」这类文字，不是 null", () => {
  const v = templateVars(inp({ rules: { ...RULES, turnLimit: null } }));
  assert.equal(v.turnLimit, "不设回合上限 —— 一直下到分出胜负、走投无路或推不动为止");

  const out = renderTemplates(tpl(), vars({ rules: { ...RULES, turnLimit: null } }));
  for (const key of TEMPLATE_KEYS) {
    const text = out[key];
    assert.doesNotMatch(text, /null|undefined|NaN/, `「${key}」里出现了空值 —— 用户刚定的「留空=不设上限」变成了一句乱码`);
  }
  assert.match(out.horizon, /不设回合上限/);
  assert.match(out.termination_conditions, /不设回合上限/);
  // 不设上限时不能再说「回合数达到上限 N」—— 那是一条凭空造出来的规则
  assert.doesNotMatch(out.termination_conditions, /达到上限/);
});

test("★ 不设回合上限时，六个字段里不出现三位数以上的数字（那个位置本该是空的）", () => {
  const out = renderTemplates(tpl(), vars({ rules: { ...RULES, turnLimit: null }, turn: 12 }));
  // 「第 13 回合」里的数字不算 —— 那说的是当前回合，与上限无关
  for (const key of TEMPLATE_KEYS) {
    const stripped = out[key].replace(/第 \d+ 回合/g, "");
    assert.doesNotMatch(stripped, /\d{3,}/, `「${key}」里有个三位数：${out[key]}`);
  }
});

/* ══════════════════════════════════════════════════════════════════
   ④ ★ 跨角色：同一份默认模板必须渲染出各自的说明书
   ══════════════════════════════════════════════════════════════════ */

test("★ 同一份默认模板，两个角色渲染出各自的角色陈述", () => {
  const life = renderTemplates(DEFAULT_TEMPLATES, vars({ role: "life" }));
  const death = renderTemplates(DEFAULT_TEMPLATES, vars({ role: "death" }));

  assert.notEqual(life.role_statement, death.role_statement);
  assert.match(life.role_statement, /你是 Life/);
  assert.match(death.role_statement, /你是 Death/);
  assert.doesNotMatch(death.role_statement, /Life/);
  // 方向词：只断言角色名是测不到「反向」的（context.test.ts 记着这条）
  assert.match(death.role_statement, /尽可能小/);
  assert.match(death.role_statement, /不利/);

  // 死之执那一份**不能**出现生之执的目标（「复制到另一方」会把这份模板拷来拷去）
  assert.doesNotMatch(death.objective, /越大越好/);
  assert.match(death.objective, /越小越好/);
});

test("★ 把生之执那一栏的默认模板整份复制给死之执，仍然是对的", () => {
  // 「复制到另一方」是一个整体动作（`syncRoleSettings`），模板也在其中。
  // 只要默认模板是角色参数化的，复制就不会产出一份写着「你是 Life」的死之执说明书
  const copied = renderTemplates(DEFAULT_TEMPLATES, vars({ role: "death" }));
  assert.match(copied.role_statement, /死之执/);
  assert.doesNotMatch(copied.role_statement, /生之执/);
});

/* ══════════════════════════════════════════════════════════════════
   ⑤ ★ 缺占位符 / 认不出的占位符 / 未闭合
   ══════════════════════════════════════════════════════════════════ */

test("★ 默认模板本身不能缺任何占位符 —— 否则满屏警告，警告就不再是警告", () => {
  assert.deepEqual(templateIssues(DEFAULT_TEMPLATES), []);
});

test("★ 删掉一个占位符要被查出来，并说清是哪一项、缺的是谁", () => {
  const issues = templateIssues(tpl({ termination_conditions: "对局在下列任一情况下立即结束：\n1. 谁先撑不住谁输。" }));
  const missing = issues.filter((i) => i.kind === "missing");

  assert.ok(missing.length > 0, "把终局条件整个换掉之后一条警告都没有 —— 这正是「对 Jev 说谎」");
  assert.ok(
    missing.every((m) => m.key === "termination_conditions"),
    `警告串到别的模板上去了：${JSON.stringify(issues)}`,
  );
  assert.ok(
    missing.some((m) => m.placeholder === "turnLimitEnd"),
    `没报出缺的是哪一个占位符：${JSON.stringify(missing)}`,
  );
});

test("警告**只针对改坏的那一项**，别的项照旧干净", () => {
  const issues = templateIssues(tpl({ win_condition: "谁多谁赢。" }));
  assert.ok(issues.length > 0);
  assert.deepEqual([...new Set(issues.map((i) => i.key))], ["win_condition"]);
});

test("认不出的占位符会被单独报出来（它会被原样送进 state）", () => {
  const issues = templateIssues(tpl({ horizon: "本局{{turnLimit}}，{{回合}}数 {{turn}}。" }));
  const unknown = issues.filter((i) => i.kind === "unknown");
  assert.deepEqual(unknown.map((u) => u.placeholder), ["回合"], "全角/非法名字没被报出来");
  // 而合法的 {{turn}} 不该被误报
  assert.equal(unknown.some((u) => u.placeholder === "turn"), false);
});

test("未闭合的 {{ 要被报出来（它的后半句会连同花括号一起送进 state）", () => {
  const issues = templateIssues(tpl({ objective: "计分方式：每回合{{perTurnFlips，然后演化一代。" }));
  const unclosed = issues.filter((i) => i.kind === "unclosed");
  assert.equal(unclosed.length, 1);
  assert.equal(unclosed[0].key, "objective");
  // 但已经闭合的那一半不该被一起算进去
  assert.equal(issues.some((i) => i.kind === "missing" && i.placeholder === "objectiveMine"), true);
});

test("同一个占位符用两遍不算「未闭合」（数的是匹配次数，不是出现过的名字数）", () => {
  const issues = templateIssues(
    tpl({ horizon: "第 {{turn}} 回合（本局{{turnLimit}}，当前第 {{turn}} 回合）。" }),
  );
  assert.deepEqual(
    issues.filter((i) => i.kind === "unclosed"),
    [],
    "同一个名字用了两遍被误报成残缺的花括号 —— 那会让「未闭合」这条提示变得不可信",
  );
  assert.deepEqual(issues, [], `这一项本来是干净的：${JSON.stringify(issues)}`);
});

test("模板为空 → 回落默认措辞，而不是把一条空规则发给模型", () => {
  const half: RuleTemplates = { ...DEFAULT_TEMPLATES, win_condition: "   " };
  const out = renderTemplates(half, vars());

  assert.equal(out.win_condition, renderTemplates(DEFAULT_TEMPLATES, vars()).win_condition);
  assert.ok(out.win_condition.trim().length > 0, "空模板被原样发了出去 —— 模型看不到获胜条件");
  // 空模板同样要**报**出来：它是「忘记填」和「有意清空」都长得一样的一种状态
  assert.ok(templateIssues(half).some((i) => i.kind === "missing"));
});

test("renderTemplates 收得下缺字段 / 脏数据（存档与导入那两条路径都会送进来）", () => {
  const dirty = { horizon: 42, win_condition: null } as unknown as Partial<RuleTemplates>;
  const out = renderTemplates(dirty, vars());
  assert.equal(out.horizon, renderTemplates(DEFAULT_TEMPLATES, vars()).horizon, "认不出的值没有回落默认");
  assert.equal(out.win_condition, renderTemplates(DEFAULT_TEMPLATES, vars()).win_condition);
});

/* ══════════════════════════════════════════════════════════════════
   ⑥ 占位符表：与 vars 双向一致，且每个都有「为什么重要」的说法
   ══════════════════════════════════════════════════════════════════ */

test("★ 占位符表与 vars 必须**双向**对得上", () => {
  const produced = new Set(Object.keys(vars()));
  const declared = new Set(PLACEHOLDERS.map((p) => p.name));

  // 表里有、vars 不产 → 用户照着填进去，得到的是原样的花括号
  const dead = [...declared].filter((n) => !produced.has(n));
  assert.deepEqual(dead, [], `这些占位符在表里、却填不出值：${dead.join(", ")}`);

  // vars 产了、表里没有 → 校验会把它报成「认不出的占位符」，默认模板自己就先红了
  const undocumented = [...produced].filter((n) => !declared.has(n));
  assert.deepEqual(undocumented, [], `这些值没有对应的占位符说明：${undocumented.join(", ")}`);
});

test("★ 默认模板里出现的每一个占位符，都要有「缺了它模型就不知道什么」的说法", () => {
  for (const key of TEMPLATE_KEYS) {
    for (const m of DEFAULT_TEMPLATES[key].matchAll(/\{\{([a-zA-Z0-9_]+)\}\}/g)) {
      const spec = PLACEHOLDERS.find((p) => p.name === m[1]);
      assert.ok(spec, `默认模板 ${key} 用了 {{${m[1]}}}，占位符表里却没有它`);
      assert.ok(spec.whyKey.length > 0, `{{${m[1]}}} 没有 whyKey —— 警告时说不出它为什么重要`);
    }
  }
});

test("占位符名不能与模板里的花括号语法打架（只收 [A-Za-z0-9_]）", () => {
  for (const p of PLACEHOLDERS) {
    assert.match(p.name, /^[A-Za-z0-9_]+$/, `占位符名 ${p.name} 含非法字符 —— 它会永远填不出值`);
  }
  // 重名会让「填哪一个」取决于表里的顺序
  const names = PLACEHOLDERS.map((p) => p.name);
  assert.equal(new Set(names).size, names.length, "占位符表里有重名");
});
