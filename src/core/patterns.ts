/**
 * 结构检测库。
 *
 * ═══ 为什么需要它 ═══
 *
 * Jev 没有内置的结构检测器。把棋盘原样丢过去，它看到的是一张 0/1 矩阵，
 * 「这里有一个方块」得它自己从像素里认出来 —— 那超出它的能力范围。
 * 所以识别必须在我们这一侧做完，把「棋盘上有哪些结构、在哪、朝向有没有信息」
 * 作为**事实**喂给它。留着它自己猜，它只会安静地猜错。
 *
 * ═══ 三处容易做错的地方 ═══
 *
 * 1. **结构定义以真实结构为准。** 设计文档里那条「灯塔（Lighthouse）振荡器、
 *    8 细胞、周期 2」在生命游戏的标准命名里根本不存在，已剔除；标准 p2 振荡器是
 *    blinker(3) / toad(6) / beacon(6) / clock(6)。
 *    `gosperGliderGun` 也不收 —— 36 格宽，MAX_SIZE 是 16，放不进去。
 *
 * 2. **只有「原朝向 + 8 种对称变体」是不够的。** 周期结构在一个周期里会经历
 *    几种互不相似的形状：滑翔机的 4 个相位里有 2 种，脉冲星 3 个相位里有 3 种
 *    （第 1 代四角各伸出一对火花，包围盒从 13×13 涨到 15×15）。实测把滑翔机跑
 *    一代、抠出包围盒，与它第 0 代的 8 个对称变体逐一比对，**一个都对不上**。
 *    只按单一形状匹配，棋盘上一半的滑翔机会被漏掉 —— 那正是「安静地喂假信息」。
 *    所以每个结构匹配的是它一个周期内出现过的**全部形状**，见 phaseShapes()。
 *
 * 3. **重叠。** 见 detectPatterns() 的注释。
 */

import { lifeStep } from "./life.js";
import type { Board } from "./types.js";

export type PatternKind = "still" | "oscillator" | "spaceship" | "gun" | "eater";

/** 相对坐标：以包围盒左上角为原点。 */
type Cells = ReadonlyArray<readonly [number, number]>;

export interface PatternDef {
  readonly name: string;
  readonly kind: PatternKind;
  /** 以左上角为原点的相对坐标 */
  readonly cells: Cells;
  /** 振荡周期；静物为 1，非周期结构省略 */
  readonly period?: number;
}

export interface DetectedPattern {
  readonly name: string;
  readonly kind: PatternKind;
  readonly period?: number;
  /** 棋盘上的绝对坐标 */
  readonly cells: Cells;
  /**
   * 这个图形在旋转/镜像下**是否仍与自身逐格相同**。
   *
   * false 表示朝向不携带信息（方块转 90° 还是方块、脉冲星本身四重对称）；
   * true 表示「它是横着的还是竖着的、朝哪边」是玩家能利用的事实。
   *
   * 这与「匹配到了几个变体」不是一回事：方块的全部 8 个变体都匹配，
   * 但那 8 个变体本身就是同一个图形。
   */
  readonly oriented: boolean;
}

/* ══════════════════════════════════════════════════════════════════
   结构定义

   定义写成**行字符串**，不手抄坐标表。理由是抄坐标表出错率太高：挪错一格，
   结构可能仍然是个合法的静物/振荡器，行为测试抓不到 —— 上面那条面包（loaf）
   与它的一位之差就是两个不同的 7 细胞静物。行字符串是「看一眼就知道对不对」
   的形式，下面每一条都按 LifeWiki 公开的 RLE 解码写下，并在测试里用 lifeStep
   的动态行为逐条验证（静物不变 / 周期 N / 飞船平移）。

   `#` = 活，`.` = 死。行尾的死格可以省略 —— 包围盒是从活细胞算出来的。
   ══════════════════════════════════════════════════════════════════ */

function shape(rows: readonly string[]): Cells {
  const out: Array<readonly [number, number]> = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      if (rows[r][c] === "#") out.push([r, c]);
    }
  }
  return out;
}

export const PATTERNS: readonly PatternDef[] = [
  // ── 最小档：方块与信号灯。两个都能塞进 4×4，但 4×4 给不出任何留白 ──
  //    b2o$2o! / 3o!
  { name: "block", kind: "still", period: 1, cells: shape(["##", "##"]) },
  { name: "blinker", kind: "oscillator", period: 2, cells: shape(["###"]) },

  // ── 8×8 档 ──
  //    b2o$o2bo$b2o! —— 6 细胞静物，也可以看作两个浴缸焊在一起
  { name: "beehive", kind: "still", period: 1, cells: shape([".##.", "#..#", ".##."]) },
  //    b2o$o2bo$bobo$2bo! —— 7 细胞静物。它是最常见的 7 细胞静物，
  //    仅次于它的是长船 —— 两者都合法，所以命名只能靠 RLE 核对，行为测试区分不了
  { name: "loaf", kind: "still", period: 1, cells: shape([".##.", "#..#", ".#.#", "..#."]) },
  //    b3o$3o! —— 6 细胞 p2 振荡器，两排错开一格
  { name: "toad", kind: "oscillator", period: 2, cells: shape([".###", "###."]) },
  //    2o2b$o3b$3bo$2b2o! —— 两个对角相邻的方块，6 细胞 p2。
  //    这里用的是**细胞数为 6 的那个相位**（LifeWiki 记的就是 6）。
  //    它是「最小的细胞数不守恒的振荡器」：两个相位分别是 6 格与 8 格，
  //    于是「振荡时细胞数守恒」这条对它是**假的**，测试里单独写清楚
  {
    name: "beacon",
    kind: "oscillator",
    period: 2,
    cells: shape(["##..", "#...", "...#", "..##"]),
  },
  //    2o$obo$2bo$2b2o! —— 吞噬者 1（鱼钩），7 细胞静物。
  //    最小的**不对称**静物，所以它的 8 个朝向互不相同
  { name: "eater1", kind: "eater", period: 1, cells: shape(["##..", "#.#.", "..#.", "..##"]) },
  //    bo$2bo$3o! —— 滑翔机，5 细胞，4 代平移 (1,1)
  { name: "glider", kind: "spaceship", period: 4, cells: shape([".#.", "..#", "###"]) },

  // ── 16×16 档 ──
  //    bo2bo$o4b$o3bo$4o! —— 9 细胞，4 代平移 (0,-2)
  { name: "lwss", kind: "spaceship", period: 4, cells: shape([".#..#", "#....", "#...#", "####."]) },
  //    2b3o3b3o2b2$o4bobo4bo$o4bobo4bo$o4bobo4bo$2b3o3b3o2b2$2b3o3b3o2b
  //    $o4bobo4bo$o4bobo4bo$o4bobo4bo2$2b3o3b3o! —— 48 细胞 p3 振荡器
  {
    name: "pulsar",
    kind: "oscillator",
    period: 3,
    cells: shape([
      "..###...###..",
      ".............",
      "#....#.#....#",
      "#....#.#....#",
      "#....#.#....#",
      "..###...###..",
      ".............",
      "..###...###..",
      "#....#.#....#",
      "#....#.#....#",
      "#....#.#....#",
      ".............",
      "..###...###..",
    ]),
  },
];

/**
 * 按尺寸分档收哪些结构。
 *
 * 预设棋盘一律是正方形、边长取 2 的幂，所以候选只有 4 / 8 / 16 三档
 * （引擎本身仍支持矩形，那是通用性，不冲突）。
 *
 * | 边长 | 可用内部区 | 收录 | 说明 |
 * |---|---|---|---|
 * | 4  | 0×0  | block / blinker | **达不到 2 格留白**，属特殊状况，界面上要标「实验性」 |
 * | 8  | 4×4  | + glider / beehive / loaf / toad / beacon / eater1 | 内部区恰好 4×4 |
 * | 16 | 12×12| + lwss / pulsar | 脉冲星的多代包围盒 15×15，是唯一放不进 12×12 的 |
 *
 * `detectPatterns` 按棋盘尺寸查这张表，**调用方不需要知道分级规则**。
 * 分级按 min(cols, rows) 取（矩形棋盘下短边才是约束）。
 */
const TIERS: ReadonlyArray<readonly [number, readonly string[]]> = [
  [4, ["block", "blinker"]],
  [8, ["glider", "beehive", "loaf", "toad", "beacon", "eater1"]],
  [16, ["lwss", "pulsar"]],
];

/* ══════════════════════════════════════════════════════════════════
   几何：全是对相对坐标数组的纯变换
   ══════════════════════════════════════════════════════════════════ */

/** 平移到「最小行 = 最小列 = 0」并按行、列排序。形状的规范表示。 */
function anchor(cells: Cells): Cells {
  const minR = Math.min(...cells.map(([r]) => r));
  const minC = Math.min(...cells.map(([, c]) => c));
  return cells
    .map(([r, c]) => [r - minR, c - minC] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function shapeKey(cells: Cells): string {
  return cells.map(([r, c]) => `${r},${c}`).join(" ");
}

/**
 * 顺时针转 90°：(r, c) → (c, 最高行 - r)，再贴回左上角。
 *
 * 「贴回左上角」这一步不能省：不对称的形状转完之后在包围盒里会偏出去，
 * 不归一化的话同一个图形会被当成两个不同的变体。
 */
function rotateCw(cells: Cells): Cells {
  const maxR = Math.max(...cells.map(([r]) => r));
  return anchor(cells.map(([r, c]) => [c, maxR - r] as const));
}

function flipH(cells: Cells): Cells {
  const maxC = Math.max(...cells.map(([, c]) => c));
  return anchor(cells.map(([r, c]) => [r, maxC - c] as const));
}

/** 原朝向 + 8 种对称变体（4 旋转 × 2 镜像），按形状去重。 */
function symmetries(cells: Cells): Cells[] {
  const seen = new Map<string, Cells>();
  let base = anchor(cells);
  for (let m = 0; m < 2; m++) {
    let cur = base;
    for (let k = 0; k < 4; k++) {
      const a = anchor(cur);
      const key = shapeKey(a);
      if (!seen.has(key)) seen.set(key, a);
      cur = rotateCw(cur);
    }
    base = flipH(base);
  }
  return [...seen.values()];
}

/**
 * 一个结构在一个周期内出现过的**其余**形状（不含基础形状本身）。
 *
 * 为什么要跑而不是手写：滑翔机 4 个相位里有 2 种互不相似的形状，脉冲星 3 个
 * 相位里有 3 种（第 1 代四角各多出一对火花格）。手写这些形状既长又容易抄错；
 * 跑一遍就全有了，用的还是本项目里被差分测试锁死的那个 lifeStep。
 */
function phaseShapes(def: PatternDef): Cells[] {
  const period = def.period ?? 1;
  if (period <= 1) return [];

  // 这块棋盘只在本模块内部用来让结构在隔离环境里演化，不参与对局，
  // 所以不受 MAX_SIZE 约束 —— 脉冲星的多代包围盒是 15×15，四周各留 2 格需要 19 格。
  // （对局棋盘的上限 16 是给玩家看的；这里算的是一个结构自身的定义。）
  const rows = Math.max(...def.cells.map(([r]) => r)) + 1;
  const cols = Math.max(...def.cells.map(([, c]) => c)) + 1;
  const pad = 2;
  const size = Math.max(rows, cols) + 2 * pad;
  const board: Board = { cols: size, rows: size, cells: new Uint8Array(size * size) };
  for (const [r, c] of def.cells) board.cells[(r + pad) * size + c + pad] = 1;

  const seen = new Set<string>([shapeKey(anchor(def.cells))]);
  const out: Cells[] = [];
  let cur = board;
  for (let gen = 1; gen < period; gen++) {
    cur = lifeStep(cur, "bounded");

    const alive: Array<readonly [number, number]> = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (cur.cells[r * size + c]) alive.push([r, c]);
    }
    if (alive.length === 0) break; // 结构在留白里都活不下来，没有相位可言

    const a = anchor(alive);
    const key = shapeKey(a);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════
   匹配表：结构 × 全部相位形状 × 8 种对称变体
   ══════════════════════════════════════════════════════════════════ */

interface Variant {
  readonly cells: Cells;
  readonly rows: number;
  readonly cols: number;
  /** 包围盒大小的 0/1 位图，用于逐格比对 */
  readonly mask: Uint8Array;
  /** 该图形在旋转/镜像下仍与自身逐格相同（朝向不携带信息） */
  readonly symmetric: boolean;
}

interface Entry {
  readonly def: PatternDef;
  readonly variants: readonly Variant[];
}

function variantOf(cells: Cells): Variant {
  const rows = Math.max(...cells.map(([r]) => r)) + 1;
  const cols = Math.max(...cells.map(([, c]) => c)) + 1;
  const mask = new Uint8Array(rows * cols);
  for (const [r, c] of cells) mask[r * cols + c] = 1;
  return { cells, rows, cols, mask, symmetric: symmetries(cells).length === 1 };
}

function indexOf(def: PatternDef): Entry {
  const seen = new Map<string, Variant>();
  for (const base of [def.cells, ...phaseShapes(def)]) {
    for (const s of symmetries(base)) {
      const key = shapeKey(s);
      if (!seen.has(key)) seen.set(key, variantOf(s));
    }
  }
  return { def, variants: [...seen.values()] };
}

/** 模块加载时算一次。棋盘最大 16×16，全部结构的变体加起来也只几十个。 */
const INDEX: readonly Entry[] = PATTERNS.map(indexOf);

/** 按尺寸分档挑出候选，并按结构大小降序 —— 匹配顺序就是重叠时的优先级。 */
function entriesFor(b: Board): Entry[] {
  const usable = Math.min(b.cols, b.rows);
  const names = new Set<string>();
  for (const [tier, list] of TIERS) {
    if (tier <= usable) for (const name of list) names.add(name);
  }
  return INDEX.filter((e) => names.has(e.def.name)).sort(
    (a, b) => b.def.cells.length - a.def.cells.length,
  );
}

/**
 * 在棋盘上找出所有已定义结构。
 *
 * ═══ 怎么匹配 ═══
 *
 * 对每个结构、它的每个相位形状、每个对称变体，在棋盘每个位置滑一遍窗口，
 * 要求窗口内的活细胞与位图**逐格相同**：该活的必须活，该死的必须死。
 *
 * 「该死的必须死」这一条不能省。只查「该活的都是活的」，脉冲星里随便一条
 * 三连就会被当成信号灯报出去。
 *
 * ═══ 重叠怎么办 ═══
 *
 * 一个格子可能同时属于多个结构：蟾蜍的上排本身就是一条完整的横向信号灯，
 * 信标就是两个对角相邻的方块，脉冲星里横竖都是三连。规则是**按结构大小降序
 * 匹配，已经被大结构占掉的格子不再参与小结构** —— 蟾蜍先占走自己 6 格，
 * 那条信号灯就没机会再报一次；信标先占走 6 格，两个方块也不会各报一次。
 *
 * 反过来的后果是：小结构挨着大结构放时可能被吞掉。这是刻意的取舍 ——
 * 「一个结构被报成它内部的零件」比「漏报一个贴着别人的小结构」错得更明显。
 *
 * ═══ 拓扑 ═══
 *
 * torus 下不做跨接缝的匹配：一个「跨过边界才算完整」的方块在视觉上不成立，
 * 而且会给 Jev 提供它没法利用的信息（它看到的是画出来的那块棋盘）。
 *
 * 本函数不改动入参（引擎纯度的硬约束，理由见 life.ts 文件头）。
 */
export function detectPatterns(b: Board): DetectedPattern[] {
  const claimed = new Uint8Array(b.cols * b.rows);
  const found: DetectedPattern[] = [];

  for (const entry of entriesFor(b)) {
    for (let r0 = 0; r0 < b.rows; r0++) {
      for (let c0 = 0; c0 < b.cols; c0++) {
        const hit = entry.variants.find((v) => matchesAt(b, v, r0, c0, claimed));
        if (!hit) continue;

        const cells = hit.cells.map(([r, c]) => [r0 + r, c0 + c] as const);
        for (const [r, c] of cells) claimed[r * b.cols + c] = 1;
        found.push({
          name: entry.def.name,
          kind: entry.def.kind,
          period: entry.def.period,
          cells,
          oriented: !hit.symmetric,
        });
      }
    }
  }
  return found;
}

function matchesAt(b: Board, v: Variant, r0: number, c0: number, claimed: Uint8Array): boolean {
  if (r0 + v.rows > b.rows || c0 + v.cols > b.cols) return false;

  for (let r = 0; r < v.rows; r++) {
    for (let c = 0; c < v.cols; c++) {
      const want = v.mask[r * v.cols + c];
      const at = (r0 + r) * b.cols + c0 + c;
      if (b.cells[at] !== want) return false;
      if (want === 1 && claimed[at] === 1) return false;
    }
  }
  return true;
}
