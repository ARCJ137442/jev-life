/**
 * 模式切换的界面侧影响。
 *
 * 这个文件锁的是**代码审查看不出来的那类漏**：单人局里漏改一句「双方」，
 * 界面上照样渲染得完全正常 —— 它与正确的那一句长得一模一样。
 *
 * 断言分三层：
 *   1. **词条存在**：`t()` 认不出 key 时只会把 key 本身显示出来（不报错），
 *      所以「这几个 key 在两份词条表里都有」必须显式查
 *   2. **该分的分了**：语义随模式变的那几项，两种模式给的必须是不同的 key
 *   3. **内容**：单人局的文案里不出现「双方」这类双人局的说法
 *
 * 断不了的（置灰的观感、图例收起来之后那一行的留白）只能靠人眼，报告里如实说。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { modeUi } from "../client/mode.js";
import type { ModeUi } from "../client/mode.js";
import { dictFor, t } from "../client/i18n.js";
import { TEMPLATE_KEYS } from "../core/template.js";

/** 一份 ModeUi 里所有「词条 key」字段。加字段时这里跟着加，测试才会继续管住它 */
const KEY_FIELDS = [
  "deathWinLabel",
  "lifeWinLabel",
  "lifeLabel",
  "modeNote",
  "takeover",
  "resume",
  "rulesNote",
  "rulesInverted",
  "calling",
  "stepTitle",
  "takeoverTitle",
  "subtitleTitle",
  "memoryDesc",
  "roleHint",
] as const;

const keysOf = (m: ModeUi): string[] => KEY_FIELDS.map((f) => m[f]);

/* ══════════════════════════════════════════════════════════════════
   ① 词条：key 存在、两边都有
   ══════════════════════════════════════════════════════════════════ */

test("★ 模式用到的每一个 key，在 zh 与 en 两份词条表里都必须存在", () => {
  // `t()` 缺 key 时**静默回落到 key 本身** —— 界面上会出现一个
  // `ctrl.stepTitleSolo` 这样的字符串，而它看起来只是「文案没写好」
  const zh = dictFor("zh");
  const en = dictFor("en");
  for (const mode of ["duel", "solo"] as const) {
    for (const key of keysOf(modeUi(mode))) {
      assert.ok(key in zh, `${mode} 用到的 ${key} 不在中文词条表里`);
      assert.ok(key in en, `${mode} 用到的 ${key} 不在英文词条表里`);
    }
  }
});

test("规则说明书那六项的标签（`tpl.<key>`）也在两份词条表里", () => {
  // 它们由 `t(\`tpl.${key}\`)` 现拼（`TEMPLATE_KEYS` 是唯一来源，HTML 里不写死），
  // 所以拼错一个 key 不会红、只会让抽屉里出现一行 `tpl.win_condition`
  for (const dict of [dictFor("zh"), dictFor("en")]) {
    for (const key of TEMPLATE_KEYS) {
      assert.ok(`tpl.${key}` in dict, `缺少词条 tpl.${key}`);
    }
  }
});

/* ══════════════════════════════════════════════════════════════════
   ② 该分的分了：语义随模式变的项，两套 key 必须不同
   ══════════════════════════════════════════════════════════════════ */

test("★ 会随模式改说法的项，两种模式给的必须是不同的词条", () => {
  const duel = modeUi("duel");
  const solo = modeUi("solo");
  // 这几项在单人局里说的**不是**同一件事（「双方各翻一格」/「死之执获胜」），
  // 漏分时它们会相等，而界面上看不出任何异常
  for (const f of ["deathWinLabel", "lifeWinLabel", "lifeLabel", "modeNote", "takeover", "resume", "rulesNote", "rulesInverted", "calling", "stepTitle", "takeoverTitle", "subtitleTitle", "memoryDesc", "roleHint"] as const) {
    assert.notEqual(duel[f], solo[f], `${f} 在两种模式下用了同一条词条 —— 至少有一边是错的`);
  }
});

test("★ 单人局必须**收起**死之执那一栏，并收起它的图例", () => {
  const duel = modeUi("duel");
  const solo = modeUi("solo");

  assert.equal(duel.deathColumnEnabled, true);
  assert.equal(solo.deathColumnEnabled, false, "单人局里死之执那一栏的设置一项都不会被用到，却仍然可编辑");
  assert.equal(duel.legendVisible, true);
  assert.equal(
    solo.legendVisible,
    false,
    "单人局只有一条黄带，图例里没有任何一项对得上它 —— 用户定的是「无需图例」",
  );

  assert.equal(duel.syncVisible, true);
  assert.equal(
    solo.syncVisible,
    false,
    "单人局里没有另一方 —— 留着「复制到另一方」会弹出「复制给死之执」，而那一栏根本不在界面上",
  );
  assert.equal(solo.solo, true);
  assert.equal(duel.solo, false);
});

/* ══════════════════════════════════════════════════════════════════
   ③ 内容：单人局的文案里不许出现双人局的说法
   ══════════════════════════════════════════════════════════════════ */

test("★ 单人局的文案里不出现「双方」—— 场上只有一个行动方", () => {
  const solo = modeUi("solo");
  for (const key of keysOf(solo)) {
    assert.doesNotMatch(t(key), /双方/, `单人局的 ${key} 里还写着「双方」：${t(key)}`);
  }
});

test("★ 单人局里行动方叫「玩家」—— 名字随模式走，颜色不随", () => {
  const zh = dictFor("zh");
  assert.equal(zh[modeUi("solo").lifeLabel], "玩家");
  assert.equal(zh[modeUi("duel").lifeLabel], "生之执");
  // 配色不动是刻意的（用户定：单人局仍沿用前二者的配色），所以这里只钉名字 ——
  // `ROLE_META` 里的颜色与这条断言无关，谁也别顺手把颜色也「统一」掉
});

test("★ 单人局的**每一条**文案里都不出现「生之执」「死之执」", () => {
  // 这条锁的是用户 2026-09-21 那条要求：单人局里统一成「玩家」。
  // 逐条查而不是抽查：模式表里的任何一个 key 走漏一个，界面上就会冒出
  // 一个单人局里不存在的角色名 —— 而它渲染得完全正常，看不出异常
  const zh = dictFor("zh");
  for (const key of keysOf(modeUi("solo"))) {
    assert.doesNotMatch(
      zh[key],
      /生之执|死之执/,
      `单人局的 ${key} 里还留着角色名：${zh[key]}`,
    );
  }
});

test("★ 死之执那条线在单人局里换了说法（棋盘死绝），不再是「对手赢了」", () => {
  const solo = modeUi("solo");
  // 标签本身：它说的是**局面**，不是某个人
  assert.doesNotMatch(t(solo.deathWinLabel), /死之执/, "单人局的死绝线还挂着死之执的名字");
  assert.match(t(solo.deathWinLabel), /死绝/);
  // 而双人局那一栏照旧
  assert.match(t(modeUi("duel").deathWinLabel), /死之执/);
});

test("双人局的文案里不出现「单人局」这种自我说明", () => {
  const duel = modeUi("duel");
  for (const key of keysOf(duel)) {
    assert.doesNotMatch(t(key), /单人/, `双人局的 ${key} 里跑进了单人局的说法：${t(key)}`);
  }
});

test("★ 英文侧同样成立（漏译时 t() 会静默回落到中文，界面上只会突然冒出一句中文）", () => {
  for (const key of keysOf(modeUi("solo"))) {
    const zh = dictFor("zh")[key];
    const en = dictFor("en")[key];
    assert.notEqual(en, zh, `${key} 的英文与中文一模一样 —— 多半是漏译`);
    assert.doesNotMatch(en, /[一-鿿]/, `${key} 的英文里混着汉字：${en}`);
  }
});
