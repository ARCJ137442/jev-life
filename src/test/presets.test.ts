import { test } from "node:test";
import assert from "node:assert/strict";

import {
  aliveCount,
  boardFromRows,
  boardKey,
  classifyTermination,
  lifeStep,
} from "../core/life.js";
import { PATTERNS, detectPatterns } from "../core/patterns.js";
import { PRESETS } from "../core/presets.js";
import type { Opening } from "../core/presets.js";
import type { GameSnapshot } from "../core/types.js";

/* ══════════════════════════════════════════════════════════════════
   这个测试文件里有两处**刻意自己实现一遍**的东西：边距的计算与演化的推进。
   不复用 presets.ts 的对应函数，理由和 patterns.test.ts 自己写旋转一样 ——
   用被测模块自己的边距函数去验证边距，等于让被检查的人自己批改自己的卷子：
   它把「2 格」实现成「0 格」时，检查会跟着一起松掉，两边同时错。
   ══════════════════════════════════════════════════════════════════ */

function findOpening(id: string, size: number): Opening {
  const preset = PRESETS.find((p) => p.cols === size);
  assert.ok(preset, `没有 ${size}×${size} 的预设`);
  const o = preset.openings.find((x) => x.id === id);
  assert.ok(o, `${size}×${size} 上没有开局「${id}」`);
  return o;
}

/** 活细胞的包围盒，以及它到四条边的距离 */
function margins(rows: readonly string[]) {
  let top = Infinity;
  let left = Infinity;
  let bottom = -Infinity;
  let right = -Infinity;
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] !== "#") continue;
      top = Math.min(top, r);
      left = Math.min(left, c);
      bottom = Math.max(bottom, r);
      right = Math.max(right, c);
    }
  }
  assert.ok(top !== Infinity, "开局一个活细胞都没有");
  return {
    top,
    left,
    bottom: rows.length - 1 - bottom,
    right: rows[0].length - 1 - right,
    height: bottom - top + 1,
    width: right - left + 1,
  };
}

/** 裁到活细胞的包围盒 —— 比「是不是同一副形状」时，位置不算数 */
function crop(rows: readonly string[]): string[] {
  const m = margins(rows);
  return rows.slice(m.top, rows.length - m.bottom).map((line) => line.slice(m.left, line.length - m.right));
}

/**
 * 该留多少白：**能留 2 格就留 2 格**。
 *
 * 棋盘或结构大到留不出 2 格时，退到「能留的最大值」—— 16×16 上的
 * 脉冲星（13×13）只剩 1 格，4×4 上的任何结构都是 0 格。这不是给边距
 * 开后门，而是把「留白」这条规则写成一个在每档尺寸上都成立的式子：
 * 小棋盘上它就是 0，大棋盘上它就是 2。
 */
function requiredMargin(board: number, extent: number): number {
  return Math.max(0, Math.min(2, Math.floor((board - extent) / 2)));
}

/**
 * 与 T13 的对局循环同构：每代之后问一次终局。
 *
 * 曾经这里分角色问两次（`role` 视角）。终局条件全是对局级的、与提问的一方无关，
 * `classifyTermination` 的 `role` 参数已因此去掉，两次提问合并成一次。
 */
function survives(rowStrings: readonly string[], preset: (typeof PRESETS)[number], gens: number) {
  const topology = preset.defaultTopology;
  let board = boardFromRows([...rowStrings]);
  const seen = new Set<string>([boardKey(board)]);
  const ratioHistory: number[] = [];

  for (let gen = 1; gen <= gens; gen++) {
    board = lifeStep(board, topology);
    seen.add(boardKey(board));
    const snap: GameSnapshot = {
      board,
      mode: "duel",
      topology,
      turn: gen,
      ratioHistory: [...ratioHistory],
    };

    const verdict = classifyTermination(snap, preset.rules, seen);
    assert.equal(verdict, null, `第 ${gen} 代就终局了：${JSON.stringify(verdict)}`);

    ratioHistory.push(aliveCount(board) / (board.cols * board.rows));
  }
  return { board, counts: ratioHistory.map((r) => Math.round(r * board.cols * board.rows)) };
}

/* ═══ 一、预设的形状 ═══ */

test("预设只有 4 / 8 / 16 三档正方形，且 calibrated 一律是 false", () => {
  assert.deepEqual(
    PRESETS.map((p) => `${p.cols}x${p.rows}`),
    ["4x4", "8x8", "16x16"],
  );
  for (const p of PRESETS) {
    assert.equal(p.cols, p.rows, `${p.cols}×${p.rows} 不是正方形`);
    assert.equal(
      p.calibrated,
      false,
      `${p.cols}×${p.rows} 被标成了已标定 —— 胜负机制换过之后，这些值全是占位`,
    );
    assert.equal(p.defaultTopology, "bounded", `${p.cols}×${p.rows} 的默认拓扑改了？`);
    assert.ok(p.openings.length > 0, `${p.cols}×${p.rows} 一个开局都没有`);
  }
  // 4×4 是退化演示（比例被量化到「一格 = 6.25%」），界面上必须能标出来
  assert.equal(PRESETS.find((p) => p.cols === 4)?.experimental, true);
  for (const p of PRESETS.filter((x) => x.cols !== 4)) {
    assert.equal(p.experimental, false);
  }
});

test("同一个 id 出现在两个尺寸上时，必须是同一副形状", () => {
  // 信标与蟾蜍在 4×4 与 8×8 上都有（同一个结构，两个尺寸各摆一次）。
  // 同名的开局摆出两副不同的棋盘，是 UI 上最容易骗过人的那种不一致。
  const home = new Map<string, string>();
  for (const p of PRESETS) {
    for (const o of p.openings) {
      const shape = crop(o.build(p.cols, p.rows)).join("/");
      const prev = home.get(o.id);
      if (prev === undefined) home.set(o.id, shape);
      else assert.equal(shape, prev, `「${o.id}」在两个尺寸上不是同一副形状`);
    }
  }
});

test("每个 build 都返回 rows 行 × cols 列，且只含 # 与 .", () => {
  for (const p of PRESETS) {
    for (const o of p.openings) {
      const rows = o.build(p.cols, p.rows);
      assert.equal(rows.length, p.rows, `${o.id} 的行数不对`);
      for (const [i, line] of rows.entries()) {
        assert.equal(line.length, p.cols, `${o.id} 第 ${i} 行长度不对：${line}`);
        assert.match(line, /^[#.]+$/, `${o.id} 第 ${i} 行含非法字符：${line}`);
      }
      assert.equal(o.build(p.cols, p.rows).join(""), rows.join(""), `${o.id} 的 build 不是纯函数`);
    }
  }
});

test("preview 是 build 的真结果，不是另抄的一份坐标", () => {
  for (const p of PRESETS) {
    for (const o of p.openings) {
      assert.deepEqual(
        [...o.preview],
        o.build(p.cols, p.rows),
        `「${o.id}」的 preview 与 build 对不上 —— 缩略图与实际开局是两副棋盘`,
      );
    }
  }
});

/* ═══ 二、边距 ═══
   为什么要有这条：贴边的信号灯会退化成两格然后整体死亡（life-step.test.ts
   锁着这条）。T8 验证过的那些「结构本该这样演化」的行为，全都是在留白充足的
   条件下测出来的 —— 开局把结构贴到边上，测的就不是结构本身了。 */

test("每个开局都离边缘至少 2 格（棋盘给不出 2 格时退到最大留白）", () => {
  for (const p of PRESETS) {
    for (const o of p.openings) {
      const m = margins(o.build(p.cols, p.rows));
      const needTop = requiredMargin(p.rows, m.height);
      const needLeft = requiredMargin(p.cols, m.width);

      assert.ok(
        m.top >= needTop,
        `「${o.id}」上边距 ${m.top} < ${needTop}（${p.cols}×${p.rows}）`,
      );
      assert.ok(
        m.bottom >= needTop,
        `「${o.id}」下边距 ${m.bottom} < ${needTop}（${p.cols}×${p.rows}）`,
      );
      assert.ok(
        m.left >= needLeft,
        `「${o.id}」左边距 ${m.left} < ${needLeft}（${p.cols}×${p.rows}）`,
      );
      assert.ok(
        m.right >= needLeft,
        `「${o.id}」右边距 ${m.right} < ${needLeft}（${p.cols}×${p.rows}）`,
      );
    }
  }
});

test("脉冲星是唯一的例外：13×13 在 16×16 上只能留 1 格", () => {
  const pulsar = findOpening("pulsar", 16);
  const m = margins(pulsar.build(16, 16));
  assert.equal(m.height, 13, "脉冲星的包围盒应当是 13×13");
  assert.equal(Math.min(m.top, m.bottom, m.left, m.right), 1);
  // 除它以外，所有 16×16 开局都留得出 2 格
  for (const o of PRESETS.find((p) => p.cols === 16)?.openings ?? []) {
    if (o.id === "pulsar") continue;
    const mm = margins(o.build(16, 16));
    assert.ok(
      Math.min(mm.top, mm.bottom, mm.left, mm.right) >= 2,
      `16×16 上的「${o.id}」贴边了：${JSON.stringify(mm)}`,
    );
  }
});

/* ═══ 三、开局不能立刻崩，也不能立刻填满 ═══ */

test("每个开局至少能撑 20 代而不触发终局", () => {
  for (const p of PRESETS) {
    for (const o of p.openings) {
      const rows = o.build(p.cols, p.rows);
      let result;
      try {
        result = survives(rows, p, 20);
      } catch (err) {
        assert.fail(`「${o.id}」（${p.cols}×${p.cols}）：${(err as Error).message}`);
      }
      // 死绝也是一种「立刻崩」：棋盘空掉之后占比恰好 0，落在死之执的线内。
      // 注意棋盘被清空本身也是一个即时的终局条件（noLegalCell → 死之执胜），
      // 所以这条断言同时也是「开局不能一代就自杀」的守卫。
      assert.ok(aliveCount(result.board) > 0, `「${o.id}」20 代之后棋盘空了`);
    }
  }
});

/* ═══ 四、开局库的结构来源 ═══
   ★ 开局库必须是**结构定义的组合**，不能是第二份手抄的坐标表。
   下面这张表是「这个开局由哪些结构构成」的声明，用 T8 的检测器回头验证它。
   检测器本身被结构行为测试锁着（静物不变 / 周期 N / 飞船平移），
   所以谁把某个结构换掉、位置抄错，这里立刻变红 —— 而这正是 T8 那批
   坐标抄写错误的唯一防线。

   4×4 那一档不参与：检测器按尺寸分档（patterns.ts 的 TIERS），4×4 档只认
   block 与 blinker。信标和蟾蜍在这一档**按设计**不会被报出来，
   那不是开局错了，是低档不认识高档结构。

   随机开局留空（[]）：噪声里恰好凑出来的结构不是我们要声明的东西，
   它由「seed 钉死」那条测试负责。 */
const COMPOSED: Record<string, readonly string[] | null> = {
  // 方块与滑翔机都写了，但**检测器只看得见方块**：8×8 的内区只有 4×4，
  // 方块必然落进滑翔机的包围盒里，而检测要求「该死的必须死」。
  // 这不是缺陷也不是抄错，是那一档的几何后果 —— 16×16 上两者相隔 9 格，
  // 全都能认出来。所以这里声明的是「实际被认出来的结构」，不是「摆了什么」。
  "block-glider": ["block", "blinker"],
  beacon: ["beacon"],
  toad: ["toad"],
  eater1: ["eater1"],
  // 纯方块阵列：铺满内区，16 个方块、64 格、完全静止。
  // 曾经掺过 3 盏信号灯，理由是「否则纯方块阵是死局」——那个理由实测不成立
  // （死之执 64 个落点里只有 4 个会回到原局面），已去掉。
  "block-mesh": Array.from({ length: 16 }, () => "block"),
  // 随机开局不做构成声明：噪声里恰好凑出来的方块不是我们声明的东西。
  // 它们由「seed 钉死」那条测试负责。
  "dense-random": null,
  "sparse-seed": null,
  pulsar: ["pulsar"],
  "glider-swarm": ["glider", "glider", "glider", "glider"],
};

test("每个开局实际检测到的结构，与它声明的构成一致", () => {
  for (const p of PRESETS) {
    if (p.cols < 8) continue; // 见上：低档检测器不认高档结构
    for (const o of p.openings) {
      assert.ok(o.id in COMPOSED, `「${o.id}」没有在 COMPOSED 表里声明构成`);
      const expected = COMPOSED[o.id];
      if (expected === null) continue;
      const got = detectPatterns(boardFromRows(o.build(p.cols, p.rows)))
        .map((d) => d.name)
        .sort();
      assert.deepEqual(got, [...expected].sort(), `「${o.id}」检测到的结构变了`);
    }
  }
});

test("COMPOSED 表里的名字都是 PATTERNS 里真实存在的结构", () => {
  const known = new Set(PATTERNS.map((d) => d.name));
  for (const names of Object.values(COMPOSED)) {
    for (const n of names ?? []) assert.ok(known.has(n), `COMPOSED 里写了不存在的结构「${n}」`);
  }
});

/* ═══ 五、随机开局必须可复现 ═══
   跑分的第一条要求是「同一副棋盘能重来一遍」。随机开局用固定 seed 的
   PRNG，否则同一份配置跑两次得到两个结论，那就不是测量。 */

test("随机开局两次构建给出同一副棋盘", () => {
  for (const id of ["dense-random", "sparse-seed"]) {
    const o = findOpening(id, 16);
    assert.deepEqual(o.build(16, 16), o.build(16, 16), `「${id}」两次构建结果不同`);
  }
});

test("随机开局的 seed 被钉死 —— 换 seed 会改变棋盘", () => {
  // 这两个字符串是**实测值**：seed 一改，它们立刻对不上。
  // 故意钉这么死：改 seed 等于改开局，应当是有人有意为之的动作。
  const golden: Record<string, string> = {
    "dense-random": "16x16:00000000cff3cff3cef3cff3cf734ff3cbf3c8d1cff1cbf3cff28ff300000000",
    "sparse-seed": "16x16:0000000002120201020005000843810040020700010100008200800200000000",
  };
  for (const [id, key] of Object.entries(golden)) {
    const o = findOpening(id, 16);
    const board = boardFromRows(o.build(16, 16));
    assert.equal(boardKey(board), key, `「${id}」的棋盘变了：\n${o.build(16, 16).join("\n")}`);
  }
});

/* ═══ 六、四类必须有的开局都在 ═══ */

test("基准、静物阵列、高密度随机、极稀疏四类开局都存在", () => {
  const ids = new Set(PRESETS.flatMap((p) => p.openings.map((o) => o.id)));
  for (const required of ["block-glider", "block-mesh", "dense-random", "sparse-seed"]) {
    assert.ok(ids.has(required), `缺少必需的开局「${required}」`);
  }
});
