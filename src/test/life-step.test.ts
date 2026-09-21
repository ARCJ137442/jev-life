import { test } from "node:test";
import assert from "node:assert/strict";

import { aliveCount, boardFromRows, referenceStep, toRows } from "../core/life.js";

/* ═══ 经典结构的演化不变量 ═══
   这些不是「随便挑几个例子」—— 每个都有独立的数学事实背书，
   实现写错时它们会以不同方式失败，覆盖不同的错误模式。

   所有夹具一律 ≥ MIN_SIZE(4)：更小的棋盘会先撞在 assertSize 上，
   测到的是一条与演化无关的报错。 */

test("方块（Block）是静物，两种拓扑下都不变", () => {
  // 4×4 棋盘、方块放左上角。块是最小的静物 —— 每格恰好两个邻居，
  // 这个事实在任何拓扑下都成立，所以它同时是「拓扑不该动它」的检查。
  const b = boardFromRows([".##.", ".##.", "....", "...."]);
  for (const topo of ["bounded", "torus"] as const) {
    assert.deepEqual(toRows(referenceStep(b, topo)), toRows(b), `topo=${topo}`);
  }
});

test("信号灯（Blinker）周期为 2", () => {
  // 横三格放在第二行、右端贴边。贴边不改变周期：顶端那格越界的邻居不计，
  // 而它本来就只有一个界内邻居，结果仍是标准的竖三格。
  const b = boardFromRows(["....", ".###", "....", "...."]);
  const once = referenceStep(b, "bounded");
  const twice = referenceStep(once, "bounded");
  assert.deepEqual(toRows(once), ["..#.", "..#.", "..#.", "...."], "横三格应翻转成竖三格");
  assert.notDeepEqual(toRows(once), toRows(b), "第一代不应等于原状（否则根本没振荡）");
  assert.deepEqual(toRows(twice), toRows(b), "两代后应回到原状");
  assert.equal(aliveCount(once), 3, "振荡器细胞数守恒");
});

test("滑翔机（Glider）4 代后平移一格", () => {
  // 起点空出第 0 行与第 0 列，且棋盘右侧余量足够：4 代后滑翔机只走到列 4，
  // 全程不接触任何边界，所以这条断言在 bounded 下检验的是纯粹的演化规则
  const b = boardFromRows([
    "........",
    "..#.....",
    "...#....",
    ".###....",
    "........",
    "........",
    "........",
    "........",
  ]);
  let cur = b;
  for (let i = 0; i < 4; i++) cur = referenceStep(cur, "bounded");
  assert.deepEqual(toRows(cur), [
    "........",
    "........",
    "...#....",
    "....#...",
    "..###...",
    "........",
    "........",
    "........",
  ], "4 代后滑翔机应整体右移一列、下移一行");
});

test("死棋盘保持死亡", () => {
  const b = boardFromRows(["....", "....", "....", "...."]);
  for (const topo of ["bounded", "torus"] as const) {
    assert.equal(aliveCount(referenceStep(b, topo)), 0, `topo=${topo}`);
  }
});

/* ═══ 拓扑的边界行为 ═══
   这是 bounded 与 torus 唯一必须分道扬镳的地方。 */

test("bounded：贴边的横三格退化成竖两格，再一代全灭", () => {
  // 第一行铺满三格，右端贴边。中间那格有两个界内邻居 → 存活；
  // 两侧各只剩一个 → 死亡。竖两格的每格只有 1 个邻居 → 下一代全灭。
  // 关键在于它能死得干净 —— 若实现把界外当成活细胞，这里会留下残余。
  const b = boardFromRows(["###.", "....", "....", "...."]);
  const gen1 = referenceStep(b, "bounded");
  assert.deepEqual(toRows(gen1), [".#..", ".#..", "....", "...."]);
  const gen2 = referenceStep(gen1, "bounded");
  assert.deepEqual(toRows(gen2), ["....", "....", "....", "...."], "两格结构应当整体死亡");

  // 同样的输入在 torus 下不会退化 —— 行首行尾相邻，且末行与首行也相邻
  const wrapped = referenceStep(b, "torus");
  assert.notDeepEqual(
    toRows(wrapped),
    toRows(gen1),
    "两种拓扑给出了相同结果，说明其中一种没处理边界",
  );
});

test("bounded 与 torus 在同样输入下给出不同结果", () => {
  // 一条横穿全宽的行：bounded 下两端不成环，torus 下成环
  const b = boardFromRows(["####", "....", "....", "...."]);
  assert.notDeepEqual(
    toRows(referenceStep(b, "bounded")),
    toRows(referenceStep(b, "torus")),
    "两种拓扑对同一输入给出了相同结果 —— 说明其中一种没真正处理边界",
  );
});

test("torus：跨越左右接缝的方块是静物，bounded 下同样的输入全灭", () => {
  // 左右两列各一条竖两格。bounded 下它们是两个互不相邻的竖条，
  // 每格只有 1 个邻居 → 一代全灭。
  // torus 下 (0,0) 与 (0,3) 相邻、(1,0) 与 (1,3) 相邻 —— 四格构成一个
  // **真正的 2×2 方块**，而方块是静物，所以它必须逐代不变。
  // 这条同时锁住两件事：环绕方向正确，且静物在环绕下仍是静物。
  const b = boardFromRows(["#..#", "#..#", "....", "...."]);

  assert.deepEqual(
    toRows(referenceStep(b, "bounded")),
    ["....", "....", "....", "...."],
    "bounded 下两条竖格互不相邻，应当全灭",
  );

  let cur = b;
  for (let i = 0; i < 3; i++) {
    cur = referenceStep(cur, "torus");
    assert.deepEqual(toRows(cur), toRows(b), `torus 下第 ${i + 1} 代起方块不再是静物`);
  }
});

test("referenceStep 是纯函数", () => {
  const b = boardFromRows([".##.", ".###", "....", "...."]);
  const before = Array.from(b.cells);
  referenceStep(b, "bounded");
  referenceStep(b, "torus");
  assert.deepEqual(Array.from(b.cells), before, "referenceStep 修改了入参");
});
