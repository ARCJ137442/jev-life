/**
 * 设置归一化里**能被断言的那部分**：尺寸与开局。
 *
 * ═══ 为什么这几条非测不可 ═══
 *
 * `clampSize` / `clampOpeningId` 都在**安静**地改用户的值。改错了不会报错，
 * 只会让棋盘变成另一个尺寸、让开局变成另一个形状 —— 而那时用户看到的
 * 是一副「看起来正常」的棋盘，没有任何线索指向设置层。
 *
 * 这里全是纯函数（`load()` 会碰 localStorage，那部分由手工验证），
 * 所以在 Node 里直接跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { clampOpeningId, clampSize, isPresetSize, presetFor } from "../client/config.js";
import { MAX_SIZE, MIN_SIZE } from "../core/types.js";
import { PRESETS } from "../core/presets.js";

test("尺寸：合法范围是 2~16，与「是不是预设」是两件事", () => {
  // 预设
  for (const p of PRESETS) {
    assert.equal(isPresetSize(p.cols, p.rows), true, `${p.cols}×${p.rows} 应当是预设`);
    assert.deepEqual(clampSize(p.cols, p.rows), { cols: p.cols, rows: p.rows });
  }

  // 非预设但合法：**必须原样留下**，不能悄悄凑到预设上
  assert.equal(isPresetSize(7, 11), false, "7×11 不是预设");
  assert.deepEqual(
    clampSize(7, 11),
    { cols: 7, rows: 11 },
    "7×11 是合法尺寸，不该被改成 8×8 —— 用户填的值消失且不报错",
  );
  assert.deepEqual(clampSize(2, 16), { cols: 2, rows: 16 }, "长宽各自可设，不要求相等");

  // 越界 / 非整数：回落到默认档（8×8），而不是夹到边界值
  for (const bad of [
    [1, 8],
    [8, 1],
    [17, 8],
    [8, 17],
    [0, 0],
    [Number.NaN, 8],
    [8, Number.NaN],
    ["", 8],
    [null, 8],
  ]) {
    assert.deepEqual(
      clampSize(bad[0], bad[1]),
      { cols: 8, rows: 8 },
      `${String(bad[0])}×${String(bad[1])} 应当回落到 8×8`,
    );
  }

  // 小数会被取整，取整后合法就留下
  assert.deepEqual(clampSize(7.4, 11.6), { cols: 7, rows: 12 });
});

test("尺寸边界与 MIN_SIZE / MAX_SIZE 同源", () => {
  assert.deepEqual(clampSize(MIN_SIZE, MIN_SIZE), { cols: MIN_SIZE, rows: MIN_SIZE });
  assert.deepEqual(clampSize(MAX_SIZE, MAX_SIZE), { cols: MAX_SIZE, rows: MAX_SIZE });
  assert.deepEqual(
    clampSize(MIN_SIZE - 1, MIN_SIZE),
    { cols: 8, rows: 8 },
    "底下一格就该回落 —— 边界是闭区间",
  );
  assert.deepEqual(clampSize(MAX_SIZE + 1, MAX_SIZE), { cols: 8, rows: 8 });
});

test("开局：非预设尺寸下没有任何开局，一律落到「自定义」", () => {
  // ★ 这一条是那处真实故障的回归：`presetFor(7, 11)` 会降级返回 8×8 那档，
  //    照着它去 `opening.build(7, 11)` 会让两个结构撞在同一格上，
  //    `compose()` 当场抛「开局有结构重叠」—— 报错离真正的原因很远
  assert.equal(
    clampOpeningId("block-glider", 7, 11),
    "",
    "7×11 没有开局库，任何一个开局 id 在这里都不该被认下",
  );
  assert.equal(
    clampOpeningId("block-glider", 4, 4),
    "blinker",
    "4×4 不认 8×8 的开局，回落到**该尺寸**的第一项",
  );
  assert.equal(clampOpeningId("blinker", 4, 4), "blinker");
  assert.equal(clampOpeningId("block-glider", 8, 8), "block-glider");

  // 空串是「自定义」这个状态本身，不该被当成「没填」而顶替掉
  assert.equal(clampOpeningId("", 8, 8), "", "空串 = 自定义，不能被回落成某个预设");
  assert.equal(clampOpeningId(null, 8, 8), "block-glider", "真没填才回落到该尺寸第一项");
  assert.equal(clampOpeningId("不存在的开局", 8, 8), "block-glider", "认不出的 id 回落到第一项");
});

test("presetFor 对非预设尺寸降级返回一个预设 —— 所以调用方必须配 isPresetSize", () => {
  // 这不是「对」的行为，是一条**必须被知道**的降级：规则总得有个值。
  // 界面的责任是把「该尺寸的参数未标定」显示出来，见 main.ts 的 syncGameUi
  assert.equal(presetFor(7, 11).cols, 8);
  assert.equal(isPresetSize(7, 11), false);
});
