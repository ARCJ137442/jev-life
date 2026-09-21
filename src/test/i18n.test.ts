/**
 * 词条表本身的两条不变量。
 *
 * 它们与「某个模式下该说什么」无关（那些在 `mode.test.ts`），只关于这张表
 * 作为一张**表**是否自洽 —— 而不自洽的后果全都是「界面上看起来正常」那一类。
 *
 * `t()` 的失效方式是这个文件存在的原因：认不出 key 时它**静默回落到 key 本身**，
 * 于是界面上出现一个 `ctrl.stepTitleSolo` 这样的字符串 —— 那看起来只是
 * 「文案没写好」，不报错、不抛异常、没有源头的线索。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { dictFor } from "../client/i18n.js";

test("★ zh 与 en 的 key 集合必须完全一致 —— 缺一边时 t() 会静默回落", () => {
  // 两边一起改是写在 `i18n.ts` 文件头里的规矩，但在此之前**没有任何东西守着它**。
  // 漏译的症状：中文界面切到英文后，那一句仍然是中文 —— 而它混在英文里
  // 看起来像是「这句还没翻」，不是「这个 key 漏了」
  const zh = Object.keys(dictFor("zh")).sort();
  const en = Object.keys(dictFor("en")).sort();

  const onlyZh = zh.filter((k) => !en.includes(k));
  const onlyEn = en.filter((k) => !zh.includes(k));

  assert.deepEqual(onlyZh, [], `这些 key 只有中文：${onlyZh.join(", ")}`);
  assert.deepEqual(onlyEn, [], `这些 key 只有英文：${onlyEn.join(", ")}`);
});

test("★ 词条的值里不许出现 markdown 标记 —— 它们会原样显示成星号", () => {
  // `applyDom()` 对 `data-i18n` 写的是 `textContent`，而 `data-i18n-html`
  // **全仓一次都没用过**（`public/index.html` 里 0 处）。所以 `**加粗**` 与
  // `` `代码` `` 在用户眼里就是字面的星号与反引号 —— 2026-09-21 那次，
  // 中文 17 条、英文 11 条词条带着这种标记上了线，没有一个人发现，
  // 因为它**渲染得完全正常**（只是多了几个字符，不像坏掉）。
  //
  // 想要强调就写进 HTML（`data-i18n-html` + `<b>`），别在词条里写 markdown
  for (const lang of ["zh", "en"] as const) {
    for (const [key, val] of Object.entries(dictFor(lang))) {
      assert.doesNotMatch(val, /[*`]/, `${lang} 的 ${key} 里含 markdown 标记：${val}`);
    }
  }
});

test("词条的格式位（{name}）两张表里要成对出现", () => {
  // `t(key, params)` 少传一个参数时，替换不上的 `{name}` 会**原样留在界面上**。
  // 中英两边用的参数名必须一致，否则「英文界面少一个数」这种差异没人查得出来
  const placeholdersOf = (s: string): string[] =>
    [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  const zh = dictFor("zh");
  const en = dictFor("en");
  for (const [key, val] of Object.entries(zh)) {
    assert.deepEqual(
      placeholdersOf(en[key]),
      placeholdersOf(val),
      `${key} 的两份译文用的参数名不一致`,
    );
  }
});
