import { test } from "node:test";
import assert from "node:assert/strict";

import { aliveCount, createBoard, lifeStep, toRows } from "../core/life.js";
import { PATTERNS, detectPatterns } from "../core/patterns.js";
import type { PatternDef } from "../core/patterns.js";
import type { Board } from "../core/types.js";

/* ══════════════════════════════════════════════════════════════════
   为什么这里用「跑给引擎看」而不是「跟坐标表比对」来验证结构定义

   坐标表是手抄的，抄错了它自己不会知道。而「方块是静物」「信号灯周期 2」
   「滑翔机 4 代平移一格」是**独立的数学事实**，与任何抄写无关。定义抄错时，
   行为测试会以不同方式失败：
     - 少写一格      → 细胞数对不上，或者结构压根不是静物
     - 挪错一格      → 结构在一两代内解体，或者根本不是振荡器
     - 形态认错了    → 周期/平移量与这个结构的已知行为不符

   唯一抓不住的是「形状对但名字错」——比如把长船写成了面包。所以每个名字都
   按 LifeWiki 公开的 RLE 解码核对过，见 patterns.ts 顶部。
   ══════════════════════════════════════════════════════════════════ */

type Grid = boolean[][];

function gridOf(cells: readonly (readonly [number, number])[]): Grid {
  const rows = Math.max(...cells.map(([r]) => r)) + 1;
  const cols = Math.max(...cells.map(([, c]) => c)) + 1;
  const g: Grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => false));
  for (const [r, c] of cells) g[r][c] = true;
  return g;
}

/** 把位图画到棋盘上。size 缺省取 16 —— 最大的一档尺寸。 */
function paint(g: Grid, r0: number, c0: number, size = 16): Board {
  const b = createBoard(size, size);
  for (let r = 0; r < g.length; r++) {
    for (let c = 0; c < g[r].length; c++) {
      if (g[r][c]) b.cells[(r0 + r) * size + c0 + c] = 1;
    }
  }
  return b;
}

/* 测试自己的一份旋转/镜像实现。刻意与 patterns.ts 里的坐标写法不同
   （那边是坐标变换，这边是位图变换），两边的错才不会互相掩护。 */

function rotCW(g: Grid): Grid {
  const rows = g.length;
  const cols = g[0].length;
  const out: Grid = Array.from({ length: cols }, () => Array.from({ length: rows }, () => false));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out[c][rows - 1 - r] = g[r][c];
  }
  return out;
}

function flipH(g: Grid): Grid {
  return g.map((row) => [...row].reverse());
}

function gridKey(g: Grid): string {
  return g.map((row) => row.map((v) => (v ? "#" : ".")).join("")).join("/");
}

/** 8 种朝向，按位图去重。对称的结构会塌成更少的几种。 */
function orientations(g: Grid): Grid[] {
  const seen = new Map<string, Grid>();
  let base = g;
  for (let m = 0; m < 2; m++) {
    let cur = base;
    for (let k = 0; k < 4; k++) {
      const key = gridKey(cur);
      if (!seen.has(key)) seen.set(key, cur);
      cur = rotCW(cur);
    }
    base = flipH(base);
  }
  return [...seen.values()];
}

function cellsOf(g: Grid, r0: number, c0: number): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (let r = 0; r < g.length; r++) {
    for (let c = 0; c < g[r].length; c++) if (g[r][c]) out.push([r0 + r, c0 + c]);
  }
  return out;
}

function cellKey(cells: readonly (readonly [number, number])[]): string {
  return cells.map(([r, c]) => `${r},${c}`).sort().join(" ");
}

function byName(name: string): PatternDef {
  const def = PATTERNS.find((d) => d.name === name);
  assert.ok(def, `PATTERNS 里没有名为 ${name} 的结构`);
  return def;
}

interface Fixture {
  readonly board: Board;
  readonly r0: number;
  readonly c0: number;
}

/**
 * 把结构摆在 16×16 棋盘的正中。
 *
 * 为什么非要留白：贴边的结构会被边界效应改掉行为 —— T4 里那条「贴边的信号灯
 * 退化成两格然后整体死亡」就是这件事。留足空白，跑出来的才是结构本身。
 *
 * 为什么固定 16 而不是「结构尺寸 + 4」：检测按棋盘尺寸分档，而档位是
 * 4 / 8 / 16。用 7×7 之类的中间尺寸会把结构挡在分档之外（7 只能拿到 4 那一档），
 * 于是测的就不是结构本身而是分档规则了。用真实预设尺寸，测的才是结构。
 *
 * 唯一凑不出 2 格留白的是脉冲星：它一个周期内的完整包围盒是 15×15
 * （第 1 代在四个角各多出 2 个火花格，包围盒从 13×13 涨到 15×15），
 * 而 MAX_SIZE 是 16 —— 最多只给得起 1 格。那 1 格是够的：偏移取 (1,1) 时，
 * 火花的包围盒是 rows 0..14 / cols 0..14，一格都不越界（测试里锁了 56 格这个数）。
 */
function fixture(def: PatternDef): Fixture {
  const g = gridOf(def.cells);
  const rows = g.length;
  const cols = g[0].length;
  const size = 16;
  const r0 = Math.floor((size - rows) / 2);
  const c0 = Math.floor((size - cols) / 2);
  return { board: paint(g, r0, c0, size), r0, c0 };
}

/* ═══════════════════════════ 定义本身 ═══════════════════════════ */

test("结构定义自洽：坐标贴到左上角、无重复，且细胞数与公开定义一致", () => {
  const known: Record<string, number> = {
    block: 4,
    blinker: 3,
    beehive: 6,
    loaf: 7,
    toad: 6,
    beacon: 6,
    eater1: 7,
    glider: 5,
    lwss: 9,
    pulsar: 48,
  };

  const seen = new Set<string>();
  for (const def of PATTERNS) {
    assert.ok(!seen.has(def.name), `结构名重复：${def.name}`);
    seen.add(def.name);

    const minR = Math.min(...def.cells.map(([r]) => r));
    const minC = Math.min(...def.cells.map(([, c]) => c));
    assert.equal(minR, 0, `${def.name} 的坐标没贴到顶边 —— 匹配时窗口会错位`);
    assert.equal(minC, 0, `${def.name} 的坐标没贴到左边 —— 匹配时窗口会错位`);

    const unique = new Set(def.cells.map(([r, c]) => `${r},${c}`));
    assert.equal(unique.size, def.cells.length, `${def.name} 里有重复坐标`);

    assert.equal(def.cells.length, known[def.name], `${def.name} 的细胞数与公开定义不符`);
  }

  assert.deepEqual(
    [...seen].sort(),
    Object.keys(known).sort(),
    "PATTERNS 收的结构与已知结构表对不上",
  );
});

/* ═══════════════════════ 动态行为：静物与振荡器 ═══════════════════════ */

test("静物（block / beehive / loaf / eater1）：演化一代后逐格不变", () => {
  for (const name of ["block", "beehive", "loaf", "eater1"]) {
    const { board } = fixture(byName(name));
    for (const topo of ["bounded", "torus"] as const) {
      assert.deepEqual(
        toRows(lifeStep(board, topo)),
        toRows(board),
        `${name} 在 ${topo} 下变了 —— 它不是静物`,
      );
    }
  }
});

test("周期 2 振荡器（blinker / toad / beacon）：两代回到原状，且第一代确实不同", () => {
  // 两个相位的细胞数。**不要**假设振荡时细胞数守恒 —— 信标就是最小的
  // 反例：它的两个相位分别是 6 格（两个方块各缺内角）与 8 格（两个完整方块）。
  // 这条是 LifeWiki 明写的性质，也是「定义抄错了」和「性质记错了」的分界，
  // 所以逐条写死，而不是用一条守恒断言覆盖三个结构。
  const phases: Record<string, [number, number]> = {
    blinker: [3, 3],
    toad: [6, 6],
    beacon: [6, 8],
  };

  for (const [name, [g0, g1]] of Object.entries(phases)) {
    const def = byName(name);
    const { board } = fixture(def);
    const gen1 = lifeStep(board, "bounded");
    const gen2 = lifeStep(gen1, "bounded");

    assert.notDeepEqual(
      toRows(gen1),
      toRows(board),
      `${name} 第一代与原状相同 —— 它根本没有振荡`,
    );
    assert.deepEqual(toRows(gen2), toRows(board), `${name} 两代后没回到原状 —— 周期不是 2`);
    assert.equal(aliveCount(board), g0, `${name} 第 0 代细胞数不对`);
    assert.equal(aliveCount(gen1), g1, `${name} 第 1 代细胞数不对`);
    assert.equal(aliveCount(gen2), g0, `${name} 第 2 代应当回到第 0 代的样子`);
    assert.equal(def.cells.length, g0, `${name} 的定义取的应当是第 0 代那个相位`);
  }
});

test("脉冲星（pulsar）：周期 3，且第 1 代会在四角伸出火花", () => {
  const { board } = fixture(byName("pulsar"));
  const gen1 = lifeStep(board, "bounded");
  const gen2 = lifeStep(gen1, "bounded");
  const gen3 = lifeStep(gen2, "bounded");

  assert.equal(aliveCount(board), 48, "第 0 代 48 格");
  assert.notDeepEqual(toRows(gen1), toRows(board), "第一代不应等于原状");
  assert.notDeepEqual(toRows(gen2), toRows(board), "第二代不应等于原状");
  assert.deepEqual(toRows(gen3), toRows(board), "三代后没回到原状 —— 周期不是 3");

  // 48 / 56 / 72 是脉冲星三个相位的已知细胞数。第 1 代那多出来的 8 格
  // 是四角各一对火花 —— 它们把包围盒从 13×13 撑到 15×15，这正是
  // patterns.ts 必须把「相位形状」一起收进匹配集合的原因。
  assert.equal(aliveCount(gen1), 56, "第 1 代 56 格（四角共 8 个火花）");
  assert.equal(aliveCount(gen2), 72, "第 2 代 72 格");
});

/* ═══════════════════════ 动态行为：飞船 ═══════════════════════ */

test("滑翔机（glider）：4 代后精确平移 (1,1)", () => {
  const def = byName("glider");
  const { board, r0, c0 } = fixture(def);
  const size = board.cols;

  let cur = board;
  for (let i = 0; i < 4; i++) cur = lifeStep(cur, "bounded");

  const moved = paint(gridOf(def.cells), r0 + 1, c0 + 1, size);
  assert.deepEqual(toRows(cur), toRows(moved), "4 代后应当整体平移 (1,1)");
  assert.notDeepEqual(toRows(cur), toRows(board), "平移了一格却与原状相同 —— 平移量算错了");
  assert.equal(aliveCount(cur), 5, "滑翔机细胞数守恒");
});

test("轻量太空船（lwss）：4 代后精确平移 (0,-2)", () => {
  const def = byName("lwss");
  const { board, r0, c0 } = fixture(def);
  const size = board.cols;

  let cur = board;
  for (let i = 0; i < 4; i++) cur = lifeStep(cur, "bounded");

  const moved = paint(gridOf(def.cells), r0, c0 - 2, size);
  assert.deepEqual(toRows(cur), toRows(moved), "4 代后应当整体平移 (0,-2)");
  assert.equal(aliveCount(cur), 9, "lwss 细胞数守恒");
});

/* ═══════════════════════ 检测：基本行为 ═══════════════════════ */

test("空棋盘返回空数组", () => {
  assert.deepEqual(detectPatterns(createBoard(4, 4)), []);
  assert.deepEqual(detectPatterns(createBoard(8, 8)), []);
  assert.deepEqual(detectPatterns(createBoard(16, 16)), []);
});

test("同一结构的 8 种朝向都能被识别，且报出的格子恰好是画上去的那些", () => {
  for (const def of PATTERNS) {
    const g = gridOf(def.cells);
    const os = orientations(g);
    assert.ok(os.length >= 1);

    for (const o of os) {
      const found = detectPatterns(paint(o, 1, 1, 16));
      const mine = found.filter((d) => d.name === def.name);
      assert.equal(
        mine.length,
        1,
        `${def.name} 的一个朝向没被识别出来（或同一处被报了多次），实得 ${found.map((d) => d.name).join(",") || "空"}`,
      );
      assert.equal(
        cellKey(mine[0].cells),
        cellKey(cellsOf(o, 1, 1)),
        `${def.name} 报出的格子与画上去的不一致`,
      );
    }
  }
});

test("每个结构在它自己周期内的每一个相位上都能被识别", () => {
  for (const def of PATTERNS) {
    const period = def.period ?? 1;
    const f = fixture(def);
    let cur = f.board;

    for (let gen = 0; gen < Math.max(period, 1); gen++) {
      const found = detectPatterns(cur);
      const mine = found.filter((d) => d.name === def.name);

      assert.equal(
        mine.length,
        1,
        `${def.name} 的第 ${gen} 代没被识别出来（相位形状缺失），实得 ${found.map((d) => d.name).join(",") || "空"}`,
      );
      assert.equal(
        mine[0].cells.length,
        aliveCount(cur),
        `${def.name} 第 ${gen} 代：报出的格子数应当等于棋盘上全部活细胞数`,
      );

      cur = lifeStep(cur, "bounded");
    }
  }
});

test("完全对称的结构不会被重复报成 8 次；同一个结构出现两次就报两次", () => {
  const block = paint(gridOf(byName("block").cells), 3, 3, 8);
  assert.deepEqual(detectPatterns(block).map((d) => d.name), ["block"]);

  const two = createBoard(8, 8);
  const g = gridOf(byName("block").cells);
  for (const [r, c] of cellsOf(g, 1, 1)) two.cells[r * 8 + c] = 1;
  for (const [r, c] of cellsOf(g, 1, 5)) two.cells[r * 8 + c] = 1;
  assert.deepEqual(
    detectPatterns(two).map((d) => d.name),
    ["block", "block"],
    "两处独立的方块应当各报一次（左上角那块先报，顺序按行优先）",
  );
});

test("去重后的朝向数与形状的已知对称性一致", () => {
  // 这些数字是形状自己的对称性，不是抄来的：
  //   - 方块四重对称、脉冲星八重对称 → 8 个变体全同，只剩 1 种
  //   - 信号灯/蜂巢/信标 → 2 种（横竖之分）
  //   - 面包沿对角线有镜像对称、蟾蜍有 180° 旋转对称 → 各 4 种
  //   - 吞噬者 1（最小的不对称静物）、滑翔机、lwss → 8 种，两两不同
  const expected: Record<string, number> = {
    block: 1,
    blinker: 2,
    beehive: 2,
    loaf: 4,
    toad: 4,
    beacon: 2,
    eater1: 8,
    glider: 8,
    lwss: 8,
    pulsar: 1,
  };
  for (const def of PATTERNS) {
    assert.equal(
      orientations(gridOf(def.cells)).length,
      expected[def.name],
      `${def.name} 的去重朝向数不对`,
    );
  }
});

/* ═══════════════════════ 检测：分级 ═══════════════════════ */

test("分级：4×4 的棋盘只收录 block / blinker", () => {
  // 滑翔机几何上塞得进 4×4，但这一档不收录它 —— 4×4 给不出任何留白，
  // 边界效应会把结构本身的行为改掉，界面上要标「实验性」。
  const glider = paint(gridOf(byName("glider").cells), 0, 0, 4);
  const names = detectPatterns(glider).map((d) => d.name);
  assert.ok(!names.includes("glider"), `4×4 上不该报出 glider，实得 ${names.join(",") || "空"}`);

  const block = paint(gridOf(byName("block").cells), 1, 1, 4);
  assert.deepEqual(detectPatterns(block).map((d) => d.name), ["block"]);
});

test("分级：8×8 收录 glider，但不收录 lwss / pulsar", () => {
  const glider = paint(gridOf(byName("glider").cells), 2, 2, 8);
  assert.deepEqual(detectPatterns(glider).map((d) => d.name), ["glider"]);

  const lwss = paint(gridOf(byName("lwss").cells), 1, 1, 8);
  const names = detectPatterns(lwss).map((d) => d.name);
  assert.ok(!names.includes("lwss"), `8×8 上不该报出 lwss，实得 ${names.join(",") || "空"}`);
});

test("分级：16×16 收录 lwss 与 pulsar", () => {
  const lwss = paint(gridOf(byName("lwss").cells), 1, 1, 16);
  assert.deepEqual(detectPatterns(lwss).map((d) => d.name), ["lwss"]);

  const pulsar = paint(gridOf(byName("pulsar").cells), 1, 1, 16);
  assert.deepEqual(detectPatterns(pulsar).map((d) => d.name), ["pulsar"]);
});

/* ═══════════════════════ 检测：重叠 ═══════════════════════ */

test("重叠：先匹配大的 —— 蟾蜍里那条横向信号灯不会被单独报出来", () => {
  // 蟾蜍的上排「.###」本身就是一条完整的横向信号灯。不按大小降序的话，
  // 信号灯会被先匹配走、把格子占掉，蟾蜍反而报不出来。
  const board = paint(gridOf(byName("toad").cells), 2, 2, 8);
  assert.deepEqual(detectPatterns(board).map((d) => d.name), ["toad"]);
});

test("重叠：信标里的两个方块不会被各报一次", () => {
  // 信标的两个相位，一个 6 格、一个 8 格。8 格那个相位**就是两个完整的方块** ——
  // 不按大小降序匹配的话，会先报出两个 block，把格占掉，信标反而报不出来。
  for (const topo of ["bounded"] as const) {
    const phase0 = fixture(byName("beacon")).board;
    const phase1 = lifeStep(phase0, topo);
    assert.equal(aliveCount(phase0), 6);
    assert.equal(aliveCount(phase1), 8, "信标的另一个相位是两个完整的方块");

    assert.deepEqual(detectPatterns(phase0).map((d) => d.name), ["beacon"]);
    assert.deepEqual(
      detectPatterns(phase1).map((d) => d.name),
      ["beacon"],
      "8 格相位是两个方块拼的，但报出来的应当只有一个 beacon",
    );
  }
});

/* ═══════════════════════ 检测：oriented 与纯度 ═══════════════════════ */

test("oriented：朝向不携带信息的结构为 false，携带信息的为 true", () => {
  const block = detectPatterns(paint(gridOf(byName("block").cells), 3, 3, 8));
  assert.equal(block.length, 1);
  assert.equal(block[0].oriented, false, "方块四重对称，转与不转是同一个图形");

  const glider = detectPatterns(paint(gridOf(byName("glider").cells), 3, 3, 8));
  assert.equal(glider.length, 1);
  assert.equal(glider[0].oriented, true, "滑翔机 8 个朝向互不相同，朝向是有信息的");

  const blinker = detectPatterns(paint(gridOf(byName("blinker").cells), 3, 3, 8));
  assert.equal(blinker.length, 1);
  assert.equal(blinker[0].oriented, true, "横着的信号灯与竖着的是两个图形");

  const pulsar = detectPatterns(paint(gridOf(byName("pulsar").cells), 1, 1, 16));
  assert.equal(pulsar.length, 1);
  assert.equal(pulsar[0].oriented, false, "脉冲星四重对称，朝向没有信息");
});

test("detectPatterns 是纯函数，不改动传入的 Board", () => {
  // 「查询合法方向却真的把棋盘搅乱一次」在 jev-2048 那边出过一次，
  // 这里同理：检测会在每回合被调用，一旦有副作用，棋盘会被越查越乱。
  const board = paint(gridOf(byName("toad").cells), 2, 2, 8);
  const before = JSON.stringify(Array.from(board.cells));
  detectPatterns(board);
  assert.equal(
    JSON.stringify(Array.from(board.cells)),
    before,
    "detectPatterns 改动了传入的 Board",
  );
});
