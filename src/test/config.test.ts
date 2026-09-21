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

import {
  DEFAULT_DUEL,
  clampOpeningId,
  coupleLlmSettings,
  defaultRole,
  desiredEffort,
  effortDegraded,
  clampRatio,
  clampSize,
  clampStreak,
  isPresetSize,
  presetFor,
  presetRulesFor,
} from "../client/config.js";
import { clampEffort } from "../shared/llm-broker.js";
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

/* ═══════════ 胜负线 ═══════════ */

test("胜负线：比例卡在 0~1，非法值回落到修改前的值（不是夹到边界）", () => {
  assert.equal(clampRatio(0.3, 0.9), 0.3);
  assert.equal(clampRatio(0, 0.9), 0, "0 是合法设置：一格都不许有");
  assert.equal(clampRatio(1, 0.9), 1, "1 也是合法设置：占满才算赢");
  assert.equal(clampRatio(1.5, 0.9), 1);
  assert.equal(clampRatio(-1, 0.9), 0);
  // 非法值回落，**不夹到边界** —— 夹边界看起来像生效了，用户会以为 200 是他自己填的
  for (const bad of [Number.NaN, "", null, undefined, "abc"]) {
    assert.equal(clampRatio(bad, 0.42), 0.42, `${String(bad)} 应当回落到 0.42`);
  }
});

test("防抖轮数：下限 1，上限 99", () => {
  assert.equal(clampStreak(3, 5), 3);
  assert.equal(clampStreak(0, 5), 1, "0 轮 = 单代越界就判胜，那正是防抖要挡掉的");
  assert.equal(clampStreak(-4, 5), 1);
  assert.equal(clampStreak(1000, 5), 99);
  for (const bad of [Number.NaN, "", null, "x"]) {
    assert.equal(clampStreak(bad, 7), 7);
  }
});

test("★ 预设的胜负线是出厂值的来源，且 4×4 与 8×8 **不共用**一条生之执线", () => {
  // 0.30 在 4×4 上只等于「≥ 5 格」，而预设开局 beacon / toad 本来就是 6 格
  // （37.5%）—— 一开局就已经越过胜负线。所以这一档单独取 0.5。
  // 这一条钉的是「4×4 不参与跨尺寸比较」那条判断，别被后人顺手合并回去
  const r4 = presetRulesFor(4, 4);
  const r8 = presetRulesFor(8, 8);
  assert.equal(r8.lifeWinRatio, 0.3);
  assert.equal(r4.lifeWinRatio, 0.5);
  assert.notEqual(r4.lifeWinRatio, r8.lifeWinRatio, "4×4 的线必须比 8×8 高");

  // 出厂值取自预设，不是另一份字面量：抄一份的话，改预设时「恢复默认」不会跟着动
  assert.equal(DEFAULT_DUEL.lifeWinRatio, r8.lifeWinRatio);
  assert.equal(DEFAULT_DUEL.deathWinRatio, r8.deathWinRatio);
  assert.equal(DEFAULT_DUEL.lifeStreak, r8.lifeStreak);
  assert.equal(DEFAULT_DUEL.deathStreak, r8.deathStreak);
});

/* ═══════════ LLM 三个思考控件的耦合与归一 ═══════════ */

/** 一份干净的玩家级设置，只覆盖关心的三个字段 */
function llm(patch: {
  chainOfThought?: boolean;
  allowThinking?: "" | "yes" | "no";
  effort?: "" | "none" | "low" | "medium" | "high" | "xhigh" | "max";
}) {
  return { ...defaultRole(), ...patch };
}

test("★ desiredEffort 的优先级：思维链关是一票否决", () => {
  // 出厂默认：思维链关 → 明确要 none（实测 3/3，且从结构上消灭了
  // 「推理吃光预算」这个失败模式）
  assert.equal(desiredEffort(defaultRole()), "none");

  // 就算强度被设成 high，思维链关着仍然是 none —— 否则界面上「思维链：关」
  // 与实际下发的东西对不上
  assert.equal(desiredEffort(llm({ chainOfThought: false, effort: "high" })), "none");
  assert.equal(desiredEffort(llm({ chainOfThought: false, allowThinking: "yes" })), "none");

  // 「是否允许思考 = 否」与 `none` 说的是同一件事
  assert.equal(desiredEffort(llm({ chainOfThought: true, allowThinking: "no" })), "none");
  assert.equal(desiredEffort(llm({ chainOfThought: true, effort: "none" })), "none");

  // 显式档位只经**期望**，收敛留给服务端的能力表
  assert.equal(desiredEffort(llm({ chainOfThought: true, effort: "xhigh" })), "xhigh");
  assert.equal(desiredEffort(llm({ chainOfThought: true, effort: "high" })), "high");

  // ★ 留空 = **明确要求「不发这个字段」**，而不是「客户端没意见」。
  //   实测留空与 none 同为 3/3，而四个显式档位全劣 —— 这个选项必须送得出去
  assert.equal(
    desiredEffort(llm({ chainOfThought: true, effort: "", allowThinking: "" })),
    null,
  );
});

test("★ 三处状态说的是同一件事，耦合函数把它们对齐（三个方向各管各的）", () => {
  // 强度选 none → 「是否允许思考」显示否、思维链显示关
  let s = coupleLlmSettings(llm({ chainOfThought: true, effort: "none" }), "effort");
  assert.equal(s.allowThinking, "no");
  assert.equal(s.chainOfThought, false);

  // 强度拨到别的档位 → 「否」自动解除、思维链打开
  s = coupleLlmSettings(llm({ chainOfThought: false, allowThinking: "no", effort: "none" }), "effort");
  s.effort = "high";
  s = coupleLlmSettings(s, "effort");
  assert.equal(s.allowThinking, "", "拨到显式档位之后「否」应当自动解除");
  assert.equal(s.chainOfThought, true);

  // 「是否允许思考 = 否」→ 强度落到 none
  s = coupleLlmSettings(llm({ chainOfThought: true, effort: "high" }), "allow");
  s.allowThinking = "no";
  s = coupleLlmSettings(s, "allow");
  assert.equal(s.effort, "none");
  assert.equal(s.chainOfThought, false);

  // 「是否允许思考 = 是」→ 思维链打开，并把原先的 none 解除
  s = coupleLlmSettings(llm({ chainOfThought: false, allowThinking: "no", effort: "none" }), "allow");
  s.allowThinking = "yes";
  s = coupleLlmSettings(s, "allow");
  assert.equal(s.chainOfThought, true);
  assert.equal(s.effort, "", "「是」要解除 none，否则状态自相矛盾");

  // 「留空」是「不说」，不该顺手改掉已经说过的
  s = coupleLlmSettings(llm({ chainOfThought: true, effort: "high" }), "allow");
  s.allowThinking = "";
  s = coupleLlmSettings(s, "allow");
  assert.equal(s.effort, "high", "留空不该把用户已经选好的档位清掉");
  assert.equal(s.chainOfThought, true);

  // 关思维链 → 强度与「是否允许思考」一起回到留空
  s = coupleLlmSettings(llm({ chainOfThought: true, effort: "high", allowThinking: "yes" }), "cot");
  s.chainOfThought = false;
  s = coupleLlmSettings(s, "cot");
  assert.equal(s.effort, "");
  assert.equal(s.allowThinking, "");
  assert.equal(desiredEffort(s), "none", "关掉之后下发的一定是 none");

  // 打开思维链 → 原先那些「不许想」的表达一并解除
  s = coupleLlmSettings(llm({ chainOfThought: false, allowThinking: "no", effort: "none" }), "cot");
  s.chainOfThought = true;
  s = coupleLlmSettings(s, "cot");
  assert.equal(s.allowThinking, "");
  assert.equal(s.effort, "");
  assert.equal(desiredEffort(s), null, "开思维链 + 留空 = 用上游默认，不是 none");
});

test("★ 降级提示：收不了的档位要在下发**之前**就说出来", () => {
  // 实测 agnes 的合法值是 none|low|medium|high|max，**没有 xhigh**
  assert.equal(effortDegraded(llm({ chainOfThought: true, effort: "xhigh" }), "agnes"), true);
  assert.equal(effortDegraded(llm({ chainOfThought: true, effort: "high" }), "agnes"), false);
  // 「留空」不算降级：那本来就是「不发这个字段」
  assert.equal(effortDegraded(llm({ chainOfThought: true, effort: "" }), "agnes"), false);
  // 不认识的上游：整个字段不发，那是保守的默认而不是「降级」
  assert.equal(effortDegraded(llm({ chainOfThought: true, effort: "high" }), "没见过的上游"), true);
});

test("clampEffort 与界面的期望一致：收不了就不发，且不改语义", () => {
  assert.equal(clampEffort("xhigh", "agnes"), undefined);
  assert.equal(clampEffort("max", "agnes"), "max");
  assert.equal(clampEffort("max", "没见过的上游"), undefined);
});
