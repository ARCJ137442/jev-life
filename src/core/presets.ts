/**
 * 尺寸预设与开局库。
 *
 * ═══ 一、开局是结构定义的**组合**，不是第二份坐标表 ═══
 *
 * `patterns.ts` 的 `PATTERNS` 是结构定义的唯一来源，而且每一条都被 `lifeStep`
 * 的动态行为验证过（静物不变 / 周期 N / 飞船平移）。开局库若另抄一份坐标，
 * 就多出一份「错了没人知道」的数据 —— T8 的实现者正是在这上面栽过一次
 * （面包的 loaf 抄错一格，是测试当场抓住的）。
 *
 * 所以开局只写「哪个结构、摆在哪个角、要不要转」，坐标一律从 `PATTERNS` 取。
 * 摆的时候顺手查重叠：两个结构撞在同一格会**当场抛错**，而不是安静地叠成一个
 * 别的形状（实测中这一步真的拦下过两个配置）。
 *
 * ═══ 二、每个开局都离边缘至少 2 格 ═══
 *
 * 除非棋盘给不出 2 格（4×4 的内区是 0×0；16×16 上的脉冲星 13×13 只剩 1 格）。
 * 理由不是审美：贴边的信号灯会退化成两格然后整体死亡（`life-step.test.ts`
 * 锁着这条），边缘效应会污染掉「这个结构本来怎么演化」这件事 —— 而 T8 验证
 * 那些结构的行为时，用的全是留白充足的条件。
 *
 * ═══ 三、固定格数的开局不能跨尺寸搬 ═══
 *
 * 设计文档的基准开局是 14 个活细胞。同一个数在 8×8 上是 21.9%，
 * 在 16×16 上只有 5.5% —— 而 `deathWinRatio` 是 0.05。
 * 也就是说**同一副棋盘换个尺寸就从「死之执离得很远」变成「贴着死之执的线」**。
 * 实测：1 方块 + 1 滑翔机在 16×16 上是 9 格 = 3.5%，第 2 代就被判死之执胜
 * （什么都没做就赢了）。
 *
 * 结论：开局按尺寸各自设计，`Opening.build(cols, rows)` 的签名保持通用，
 * 但**每个开局只出现在一个尺寸上**（`presets.test.ts` 有一条测试锁这个）。
 * 密度轴（接近生之执的线 / 接近死之执的线）只在 16×16 上成立 ——
 * 8×8 的内区只有 4×4，50% 的棋盘密度 = 32 格，比整个内区还大。
 */

import { PATTERNS } from "./patterns.js";
import type { PatternDef } from "./patterns.js";
import type { GameRules, Topology } from "./types.js";

/** 相对坐标数组。patterns.ts 没有导出这个别名，这里从结构定义上取 */
type Cells = PatternDef["cells"];

/* ══════════════════════════════════════════════════════════════════
   类型
   ══════════════════════════════════════════════════════════════════ */

export interface Opening {
  readonly id: string;
  readonly nameZh: string;
  readonly nameEn: string;
  /** 返回棋盘行（`#` / `.`），长度 rows、每行 cols */
  readonly build: (cols: number, rows: number) => string[];
  /** 这个开局想测什么 */
  readonly note: string;
  /** 缩略图，供 UI 画出开局的形状（T14）。= build 在该开局所属尺寸上的实际结果 */
  readonly preview: readonly string[];
}

export interface SizePreset {
  readonly cols: number;
  readonly rows: number;
  /** 该尺寸下可选的若干开局。开局本身是被测量的变量，一个尺寸只给一种等于把变量钉死 */
  readonly openings: readonly Opening[];
  readonly rules: GameRules;
  readonly defaultTopology: Topology;
  /** 参数是否经过跑分标定。未标定的预设界面上必须显式标注 */
  readonly calibrated: boolean;
  /**
   * 是否只是退化演示（目前只有 4×4）。
   *
   * 计划里的接口没有这一项。加它的理由：`calibrated` 三档全是 false，
   * 分不出「没跑分」与「不该跑分」—— 而 4×4 的差别是后者：比例被棋盘尺寸
   * 量化到「一格 = 6.25%」，它的阈值**不参与跨尺寸比较**。界面要能把这句话
   * 显示出来，所以它必须是一个字段而不是一条注释。
   */
  readonly experimental: boolean;
}

/* ══════════════════════════════════════════════════════════════════
   摆放：坐标全部来自 PATTERNS，这里只做平移与旋转
   ══════════════════════════════════════════════════════════════════ */

type Anchor = "tl" | "tr" | "bl" | "br" | "center";
type Rotation = 0 | 90 | 180 | 270;

interface Part {
  readonly name: string;
  readonly at: Anchor;
  /** 顺时针旋转。滑翔机靠它决定往哪边飞：0°→右下，90°→左下，180°→左上，270°→右上 */
  readonly turn?: Rotation;
}

/**
 * 按名字取结构定义。名字打错时**立刻抛**。
 *
 * 静默跳过更省事，但那样「开局少了一个结构」会被当成正常情况 ——
 * 少一个结构的开局看起来仍然是一副合法棋盘，测试也未必抓得住。
 */
function def(name: string): PatternDef {
  const found = PATTERNS.find((d) => d.name === name);
  if (!found) throw new Error(`PATTERNS 里没有结构「${name}」`);
  return found;
}

function extent(cells: Cells): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const [r, c] of cells) {
    rows = Math.max(rows, r + 1);
    cols = Math.max(cols, c + 1);
  }
  return { rows, cols };
}

/** 贴回左上角，保证变换之后包围盒的原点仍是 (0,0) */
function anchor(cells: Cells): Cells {
  const minR = Math.min(...cells.map(([r]) => r));
  const minC = Math.min(...cells.map(([, c]) => c));
  return cells.map(([r, c]) => [r - minR, c - minC] as const);
}

/**
 * 顺时针旋转相对坐标：`(r, c) → (c, maxR - r)`，再贴回左上角。
 *
 * 转的是**从 PATTERNS 取来的坐标**，不是另抄的一份形状 —— 这里没有第二个
 * 关于「滑翔机长什么样」的真相。
 */
function rotate(cells: Cells, deg: Rotation): Cells {
  let cur: Cells = anchor(cells);
  for (let i = 0; i < deg / 90; i++) {
    const maxR = Math.max(...cur.map(([r]) => r));
    cur = anchor(cur.map(([r, c]) => [c, maxR - r] as const));
  }
  return cur;
}

/**
 * 沿某条轴该留多少白：**能留 2 格就留 2 格**。
 *
 * 棋盘或结构大到留不出 2 格时退到能留的最大值 —— 16×16 上的脉冲星只剩 1 格，
 * 4×4 上任何结构都是 0 格。写成这样一个式子，是为了让「留白」这条规则在
 * 三档尺寸上是同一条，而不是在每档各写一个特例。
 */
function padFor(board: number, ext: number): number {
  return Math.max(0, Math.min(2, Math.floor((board - ext) / 2)));
}

function blank(cols: number, rows: number): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => "."));
}

/** 把一组结构摆到空白棋盘上。位置由「角 + 结构自身尺寸」算出，不写死坐标 */
function compose(cols: number, rows: number, parts: readonly Part[]): string[] {
  const grid = blank(cols, rows);

  for (const part of parts) {
    const cells = rotate(def(part.name).cells, part.turn ?? 0);
    const ext = extent(cells);
    const pr = padFor(rows, ext.rows);
    const pc = padFor(cols, ext.cols);

    let r0: number;
    let c0: number;
    switch (part.at) {
      case "tl":
        r0 = pr;
        c0 = pc;
        break;
      case "tr":
        r0 = pr;
        c0 = cols - ext.cols - pc;
        break;
      case "bl":
        r0 = rows - ext.rows - pr;
        c0 = pc;
        break;
      case "br":
        r0 = rows - ext.rows - pr;
        c0 = cols - ext.cols - pc;
        break;
      case "center":
        r0 = Math.floor((rows - ext.rows) / 2);
        c0 = Math.floor((cols - ext.cols) / 2);
        break;
    }

    for (const [r, c] of cells) {
      if (grid[r0 + r][c0 + c] === "#") {
        throw new Error(`开局有结构重叠：「${part.name}」在 (${r0 + r}, ${c0 + c})`);
      }
      grid[r0 + r][c0 + c] = "#";
    }
  }

  return grid.map((row) => row.join(""));
}

/* ══════════════════════════════════════════════════════════════════
   随机开局：固定 seed 的 PRNG
   ══════════════════════════════════════════════════════════════════ */

/** mulberry32 —— 小而确定的 PRNG，与 life-diff.test.ts 里用的是同一个 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 种子噪声。活细胞只出现在内区（边距规则对随机开局同样成立：让噪声贴边，
 * 换来的只是「有的开局受边缘效应影响、有的不受」这一条不可控的差异）。
 *
 * `boardRatio` 按**整块棋盘**算（与设计文档「14 活细胞 = 21.9%」同一套口径），
 * 再折算成内区填充率。折算这一步不能省：8×8 的 50% 是 32 格，
 * 而内区一共只有 16 格。
 *
 * seed 不是随手挑的：它必须让开局撑过 20 代（`presets.test.ts` 锁着）。
 * 这不是为了让测试变绿而凑数 —— 一个第 3 代就死绝的开局不是开局，
 * 而稀疏随机图案确实**大概率**会死绝（实测：内区 14% 填充的 16×16 随机局面，
 * 40 个种子里只有 5 个撑过 20 代）。
 */
function noise(cols: number, rows: number, boardRatio: number, seed: number): string[] {
  const PAD = 2;
  const innerCols = Math.max(0, cols - 2 * PAD);
  const innerRows = Math.max(0, rows - 2 * PAD);
  const inner = innerCols * innerRows;
  const p = inner === 0 ? 0 : (boardRatio * cols * rows) / inner;

  const rand = rng(seed);
  const grid = blank(cols, rows);
  for (let r = PAD; r < PAD + innerRows; r++) {
    for (let c = PAD; c < PAD + innerCols; c++) {
      if (rand() < p) grid[r][c] = "#";
    }
  }
  return grid.map((row) => row.join(""));
}

/* ══════════════════════════════════════════════════════════════════
   开局表
   ══════════════════════════════════════════════════════════════════ */

function opening(spec: {
  id: string;
  nameZh: string;
  nameEn: string;
  note: string;
  /** 这个开局被设计在哪一档尺寸上。preview 就是它在这一档上的实际结果 */
  size: number;
  build: (cols: number, rows: number) => string[];
}): Opening {
  return {
    id: spec.id,
    nameZh: spec.nameZh,
    nameEn: spec.nameEn,
    note: spec.note,
    build: spec.build,
    // preview 从 build 现算，不另画一份 —— 缩略图与实际开局不一致，
    // 比没有缩略图更坏：UI 上显示的是「方块 + 滑翔机」，跑起来是别的形状。
    preview: spec.build(spec.size, spec.size),
  };
}

/* ── 4×4：退化演示 ──
   内区 0×0，任何结构都贴边。计划里写明这一档只作退化演示、不参与跨尺寸比较。
   只放**能活下来**的结构：方块（4 格）在这一档会撞上 repeatBlocked ——
   敲掉它任意一格都会在一代后长回原局面（2×2 的四个角都是 3 邻居），
   于是死之执一个有效落点都没有，第 1 代就按「走投无路」终局。
   实测能撑住的只有振荡器：摆动本身让后继落到新局面里。 */
const OPENINGS_4: readonly Opening[] = [
  opening({
    id: "blinker",
    nameZh: "信号灯",
    nameEn: "Blinker",
    size: 4,
    build: (cols, rows) => compose(cols, rows, [{ name: "blinker", at: "center" }]),
    note:
      "最小的振荡器（3 格，周期 2）。4×4 上它居中摆得下，且永不衰减 —— " +
      "这一档里唯一能被检测器认出来的结构（4×4 档只认 block / blinker）。",
  }),
  opening({
    id: "beacon",
    nameZh: "信标",
    nameEn: "Beacon",
    size: 4,
    build: (cols, rows) => compose(cols, rows, [{ name: "beacon", at: "center" }]),
    note:
      "6 格周期 2，但两个相位分别是 6 格与 8 格 —— 占比在 37.5% 与 50% 之间来回。" +
      "「振荡时细胞数守恒」这条规律对它是假的（patterns.ts 里专门记过这一笔）。" +
      "在 4×4 上它占满整块棋盘，是这一档里唯一有「填满」压力的开局。",
  }),
  opening({
    id: "toad",
    nameZh: "蟾蜍",
    nameEn: "Toad",
    size: 4,
    build: (cols, rows) => compose(cols, rows, [{ name: "toad", at: "center" }]),
    note:
      "6 格周期 2，两个相位之间细胞数**守恒**（都是 6）—— 与信标配成一对： " +
      "一个占比恒定、一个占比摆动。4×4 上它的竖直相位正好跨满四行。",
  }),
];

/* ── 8×8：设计文档的基准尺寸 ──
   内区恰好 4×4。这个数字决定了很多事：一个 2×2 的方块与一个 3×3 的滑翔机
   在内区里**必然紧邻**（分别摆对角时两者的包围盒必然交叠），而两格留白又
   排除了「把第二个结构放远一点」这条路。所以 8×8 的开局都是「单个结构」或
   「一对必然互相干扰的结构」，密度轴在这里不存在。 */
const OPENINGS_8: readonly Opening[] = [
  opening({
    id: "block-glider",
    nameZh: "方块 + 滑翔机",
    nameEn: "Block + Glider",
    size: 8,
    build: (cols, rows) =>
      compose(cols, rows, [
        { name: "block", at: "tl" },
        { name: "glider", at: "tr" },
      ]),
    note:
      "设计文档的基准开局：静物 + 飞船，9 格 = 14.1%。" +
      "⚠ 但 8×8 的内区只有 4×4，两者必然紧邻：实测滑翔机一代内就被方块拆散，" +
      "之后是一团会涨落的活跃区（9→18 格）。换句话说这里的「滑翔机」是一次性扰动，" +
      "不是真的飞船。「既有静物又有飞船」要 16×16 才成立，而这个组合固定 9 格，" +
      "在 16×16 上只有 3.5% —— 低于 deathWinRatio(5%)，实测第 2 代就被判死之执胜。" +
      "所以这一档不给它，改由 16×16 的 glider-swarm 承担「会动的东西」这条轴。",
  }),
  opening({
    id: "beacon",
    nameZh: "信标",
    nameEn: "Beacon",
    size: 8,
    build: (cols, rows) => compose(cols, rows, [{ name: "beacon", at: "center" }]),
    note:
      "占比会自己摆动的静物对：两个相位 6 格（9.4%）与 8 格（12.5%）。" +
      "防抖（lifeStreak / deathStreak = 3）正是为这种一涨一落准备的 —— " +
      "只越界一代不算赢。想验防抖有没有生效，这个开局最直接。",
  }),
  opening({
    id: "toad",
    nameZh: "蟾蜍",
    nameEn: "Toad",
    size: 8,
    build: (cols, rows) => compose(cols, rows, [{ name: "toad", at: "center" }]),
    note:
      "6 格 = 9.4%，周期 2，细胞数在两个相位之间守恒。" +
      "与信标并排看：同样是振荡，一个占比不动、一个占比摆 —— " +
      "模型要判断的「局面在变好还是变坏」在这两者上答案完全不同。",
  }),
  opening({
    id: "eater1",
    nameZh: "吞噬者",
    nameEn: "Eater",
    size: 8,
    build: (cols, rows) => compose(cols, rows, [{ name: "eater1", at: "center" }]),
    note:
      "7 格 = 10.9%，最小的**不对称**静物（8 个朝向互不相同），摆满 4×4 内区。" +
      "它是吃滑翔机的结构，但 8×8 的内区放不下第二个能独立活动的滑翔机，" +
      "这条性质在本档验证不了 —— 它的用处是给出一块「谁也动不了谁」的静止棋盘。" +
      "⚠ 注意它撑得住而单个方块撑不住：方块被敲掉一角会在一代后长回原样，" +
      "于是死之执一个有效落点都没有（第 1 代就 repeatBlocked）；" +
      "吞噬者不对称，敲掉任何一格都会走到新局面。",
  }),
];

/* ── 16×16：密度轴在这里 ── */

/**
 * 方块阵列 + 一条信号灯带。
 *
 * ⚠ 为什么阵列里必须掺振荡器：**纯方块阵列是个死局**。方块互相隔离时，
 * 敲掉任意一格都会在一代后长回原样（2×2 的四个角都是 3 邻居），
 * 于是死之执的每一个落点都落回见过的局面 —— 第 1 代就按 repeatBlocked
 * 终局，双方都还没来得及下棋。掺进信号灯带之后死之执才有真落点
 * （敲掉一格信号灯，那盏灯就消失了，局面真的变了）。
 *
 * 方块间距取 3（2 格方块 + 1 格空隙），这是「两个方块互不干扰」的最小间距：
 * 实测对角相邻的两个方块会互相拆掉彼此的内角，三代内解体成两个信号灯。
 * 也正因为间距这么紧，阵列里的方块**没法交错**（错开一格就是贴边），
 * 「交错铺开」这条在 16×16 上做不到。
 */
function blockMesh(cols: number, rows: number): string[] {
  const PAD = 2;
  const grid = blank(cols, rows);

  // 阵列不像单个结构那样有「一个角」可依托，只能逐格写。
  // 坐标仍然来自 PATTERNS —— 这里没有第二份关于「方块长什么样」的数据
  const put = (name: string, r0: number, c0: number): void => {
    for (const [r, c] of def(name).cells) {
      if (grid[r0 + r][c0 + c] === "#") {
        throw new Error(`开局有结构重叠：「${name}」在 (${r0 + r}, ${c0 + c})`);
      }
      grid[r0 + r][c0 + c] = "#";
    }
  };

  // 右侧留一条 3 格宽的带放信号灯，其余宽度给方块带。
  // 方块带与灯带的间隔至少 1 列（列距 2 就不相邻了），所以判据是 c + 3 <= blinkerCol
  const blinkerCol = cols - PAD - 3;
  for (let r = PAD; r + 1 < rows - PAD; r += 3) {
    for (let c = PAD; c + 3 <= blinkerCol; c += 3) put("block", r, c);
  }

  // 信号灯带：每盏灯的竖直相位会上下各探出一格，所以行距取 4 ——
  // 行距 3 的话相邻两盏灯探出来的格子会首尾相接，连成一条 6 格长线再慢慢烂掉
  for (let r = PAD; r < rows - PAD; r += 4) put("blinker", r, blinkerCol);

  return grid.map((row) => row.join(""));
}

/**
 * 四只滑翔机沿两条对角线相向而行：
 * 左上↔右下、右上↔左下，各自在中场撞上。
 *
 * 这里同时是**唯一**能测「移动结构」的开局 —— 其余开局要么静止（方块阵列、
 * 吞噬者），要么在原地振荡（信标、蟾蜍、脉冲星）。滑翔机是全库里仅有的
 * 「位置本身在变」的东西，而位置变化正是最需要模型提前几步看出来的事。
 * 4 只 = 20 格 = 7.8%，高于 deathWinRatio 的 12 格线，否则它们还没撞上就先判负了。
 */
const SWARM_PARTS: readonly Part[] = [
  { name: "glider", at: "tl", turn: 0 }, // 往右下飞
  { name: "glider", at: "br", turn: 180 }, // 往左上飞 —— 与上一只对撞
  { name: "glider", at: "tr", turn: 90 }, // 往左下飞
  { name: "glider", at: "bl", turn: 270 }, // 往右上飞 —— 与上一只对撞
];

const OPENINGS_16: readonly Opening[] = [
  opening({
    id: "block-mesh",
    nameZh: "方块阵列",
    nameEn: "Block Mesh",
    size: 16,
    build: blockMesh,
    note:
      "静物阵列，12 个方块（48 格）+ 3 盏信号灯 = 57 格 = 22.3%，逼近「最大化存活格子」。" +
      "生之执落点极多（199 个死格），但几乎每一个都会把旁边的方块拆掉" +
      "（实测 57 → 28 格，一代就没了两成）。" +
      "⚠ 阵列本身完全静止：不含那 3 盏灯的话，死之执的**每一个**落点都会在一代后" +
      "长回原局面，第 1 代就 repeatBlocked 终局 —— 这一档的开局里最反直觉的一条。",
  }),
  opening({
    id: "dense-random",
    nameZh: "高密度随机",
    nameEn: "Dense Random",
    size: 16,
    // p 按整盘 50% 折算到内区；seed 3 实测首代 131 格（51.2%）。
    // 挑 seed 的标准只有一个：撑得住 20 代 —— 见 noise() 的注释。
    build: (cols, rows) => noise(cols, rows, 0.5, 3),
    note:
      "内区 131 格随机铺开（51.2%）。第一代剧烈衰减（实测 131 → 39），" +
      "之后在 35–90 之间长期混沌震荡。这是离生之执的线（60%）最近的开局，" +
      "模型在这里要判断的是「这一波涨是趋势还是噪声」—— 防抖挡的就是这个。" +
      "固定 seed，所以跑分能重来一遍。",
  }),
  opening({
    id: "sparse-seed",
    nameZh: "稀疏种子",
    nameEn: "Sparse Seed",
    size: 16,
    // 内区 14.2% 填充 = 整盘 8%；seed 48 实测 25 格，且 20 代内最低 17 格，
    // 始终没跌破 deathWinRatio 的 12.8 格线。
    build: (cols, rows) => noise(cols, rows, 0.08, 48),
    note:
      "内区 25 格（整盘 9.8%），极稀疏。棋盘另一头：它离死之执的线（≤12 格）" +
      "只差一倍，随机演化里大多数种子会直接死绝（实测 40 个种子里 35 个撑不过 20 代），" +
      "所以这一档挑的是撑得住的那个种子 —— 开局第 3 代就归零不是「考验搭建能力」，" +
      "是没得玩。生之执要做的是从零把结构搭起来。",
  }),
  opening({
    id: "pulsar",
    nameZh: "脉冲星",
    nameEn: "Pulsar",
    size: 16,
    build: (cols, rows) => compose(cols, rows, [{ name: "pulsar", at: "center" }]),
    note:
      "48 格周期 3（18.8%），占比在 48 / 56 / 72 格（18.8% / 21.9% / 28.1%）之间循环。" +
      "全库唯一的**多代包围盒会变大**的结构（13×13 涨到 15×15），所以它是唯一" +
      "在 16×16 上只留得出 1 格边距的开局 —— 边距规则的例外只能给它。" +
      "它想测的是：占比按固定周期来回走时，模型会不会把相位当成趋势。",
  }),
  opening({
    id: "glider-swarm",
    nameZh: "滑翔机四机对撞",
    nameEn: "Glider Swarm",
    size: 16,
    build: (cols, rows) => compose(cols, rows, SWARM_PARTS),
    note:
      "四只滑翔机沿两条对角线相向而行（20 格 = 7.8%），约在第 10 代前后对撞。" +
      "全库唯一「位置在变」的开局：四只飞船各飞各的，碰撞点与碰撞后的残骸都不是" +
      "从当前棋盘上直接看得出来的 —— 要靠推演。撑到对撞之后仍高于死之执的线，" +
      "所以撞完的残局还能继续下。",
  }),
];

/* ══════════════════════════════════════════════════════════════════
   预设
   ══════════════════════════════════════════════════════════════════ */

/**
 * 8×8 与 16×16 共用同一套阈值。
 *
 * 比例在意图上跨尺寸可比，代价是**被棋盘尺寸量化**：
 *
 * | 棋盘  | 单格占比 | deathWinRatio = 0.05 意味着 |
 * |-------|---------|------------------------------|
 * | 4×4   | 6.25%   | 活细胞 ≤ 0 格（1 格就已经超线） |
 * | 8×8   | 1.56%   | ≤ 3 格                        |
 * | 16×16 | 0.39%   | ≤ 12 格                       |
 *
 * 所以同一副 9 格的开局在 8×8 上离死之执的线很远（14.1%），
 * 在 16×16 上却已经越线（3.5%）—— 这不是阈值定错了，是「格数固定」与
 * 「比例可比」这两件事本来就冲突。开局库按尺寸各配一套就是在绕开它。
 */
const RULES_8: GameRules = {
  turnLimit: 90,
  lifeWinRatio: 0.6,
  deathWinRatio: 0.05,
  lifeStreak: 3,
  deathStreak: 3,
};

const RULES_16: GameRules = { ...RULES_8 };

/**
 * 4×4 的规则是**单独给的**，且不参与跨尺寸比较。
 *
 * - `deathWinRatio` 保持 0.05，但它在 4×4 上的含义是「清空棋盘」：
 *   单格就占 6.25%，0.05 与 0 在这块棋盘上是同一条线
 * - `lifeWinRatio` 0.6 同理落到「≥ 10 格」
 * - `turnLimit` 取 30 而不是 90：16 格的棋盘几代内就进入周期，
 *   90 回合只是把同一个周期重复 45 遍。这是一个有理由的占位，不是实测值
 */
const RULES_4: GameRules = {
  turnLimit: 30,
  lifeWinRatio: 0.6,
  deathWinRatio: 0.05,
  lifeStreak: 3,
  deathStreak: 3,
};

export const PRESETS: readonly SizePreset[] = [
  {
    cols: 4,
    rows: 4,
    openings: OPENINGS_4,
    rules: RULES_4,
    defaultTopology: "bounded",
    calibrated: false,
    experimental: true,
  },
  {
    cols: 8,
    rows: 8,
    openings: OPENINGS_8,
    rules: RULES_8,
    defaultTopology: "bounded",
    calibrated: false,
    experimental: false,
  },
  {
    cols: 16,
    rows: 16,
    openings: OPENINGS_16,
    rules: RULES_16,
    defaultTopology: "bounded",
    calibrated: false,
    experimental: false,
  },
];
