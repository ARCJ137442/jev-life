import type {
  Board,
  Cell,
  GameRules,
  GameSnapshot,
  Role,
  Termination,
  Topology,
} from "./types.js";
import { MAX_SIZE, MIN_SIZE } from "./types.js";

/**
 * 引擎纯度是硬约束 —— 与 jev-2048 的第一条红线同源。
 *
 * 那边的教训是：validMoves() 的实现是「对每个方向试着走一步，看是否移动」，
 * 一旦 moveTiles 有副作用，每次询问合法方向都会真把棋盘搅乱一次，
 * 症状是「方块跑到别的列」「动画走对角线」，而根因在引擎不在渲染。
 *
 * 这边同理：legalCells() 会被 UI 频繁调用（高亮可选格），
 * 一旦 flip 有副作用，每次高亮都会改棋盘。
 *
 * 所以本模块所有的 Board 变换一律**返回新对象**，绝不写回入参的 cells。
 */

export function assertSize(cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    throw new Error(`棋盘尺寸必须是整数，收到 ${cols}×${rows}`);
  }
  if (cols < MIN_SIZE || rows < MIN_SIZE || cols > MAX_SIZE || rows > MAX_SIZE) {
    throw new Error(`棋盘尺寸须在 ${MIN_SIZE}–${MAX_SIZE} 之间，收到 ${cols}×${rows}`);
  }
}

export function createBoard(cols: number, rows: number): Board {
  assertSize(cols, rows);
  return { cols, rows, cells: new Uint8Array(cols * rows) };
}

/** 用字符串行构造棋盘，'.' = 死，'#' 或 'X' 或 'o' = 活。测试与开局定义用 */
export function boardFromRows(rows: string[]): Board {
  const r = rows.length;
  const c = rows[0]?.length ?? 0;

  // 先查行长一致，再查尺寸。反过来的话，「第 3 行少了一列」这种错会先撞上
  // 尺寸下限，报出「棋盘尺寸须在 4–16 之间」—— 而 4×4 的棋盘恰好合法，
  // 真正的原因（某一行少打了一个点）被一条无关的报错盖掉了。
  for (let i = 0; i < r; i++) {
    if (rows[i].length !== c) {
      throw new Error(`第 ${i} 行长度不一致（期望 ${c} 列，实得 ${rows[i].length} 列）`);
    }
  }
  assertSize(c, r);

  const cells = new Uint8Array(c * r);
  for (let i = 0; i < r; i++) {
    for (let j = 0; j < c; j++) {
      const ch = rows[i][j];
      if (ch === "#" || ch === "X" || ch === "o") cells[i * c + j] = 1;
    }
  }
  return { cols: c, rows: r, cells };
}

export function toRows(b: Board): string[] {
  const out: string[] = [];
  for (let r = 0; r < b.rows; r++) {
    let line = "";
    for (let c = 0; c < b.cols; c++) line += b.cells[r * b.cols + c] ? "#" : ".";
    out.push(line);
  }
  return out;
}

/**
 * 校验并归一化一个格子索引。
 *
 * 非整数必须一并拒绝：`cells[1.5]` 在 Uint8Array 上读得到 undefined（不是报错），
 * 于是 `isAlive` 会安静地返回 false —— 一个越界的坐标看起来就像一格死细胞。
 */
export function cellAt(b: Board, cell: Cell): Cell {
  if (!Number.isInteger(cell) || cell < 0 || cell >= b.cells.length) {
    throw new Error(`格子索引越界：${cell}（棋盘 ${b.cols}×${b.rows}）`);
  }
  return cell;
}

export function isAlive(b: Board, cell: Cell): boolean {
  return b.cells[cellAt(b, cell)] === 1;
}

export function aliveCount(b: Board): number {
  let n = 0;
  for (let i = 0; i < b.cells.length; i++) n += b.cells[i];
  return n;
}

/** 返回新 Board，绝不改动入参 */
export function flip(b: Board, cell: Cell): Board {
  cellAt(b, cell);
  const cells = Uint8Array.from(b.cells);
  cells[cell] = cells[cell] ? 0 : 1;
  return { cols: b.cols, rows: b.rows, cells };
}

export function sameBoard(a: Board, b: Board): boolean {
  return a.cols === b.cols && a.rows === b.rows && a.cells.every((v, i) => v === b.cells[i]);
}

/**
 * 某角色当前可以翻的格子。
 *
 * 生之执只能把死格子变活，死之执只能把活格子变死 —— 两个集合**天然互斥**。
 * 这是「同时决策」成立的数学基础：两边各发一个请求、都基于演化前的棋盘，
 * 落子永远不会撞在同一格上，不需要任何冲突消解规则。
 *
 * 两个集合的并集恰是全部格子（每格非死即活），所以双方合起来覆盖整个棋盘 ——
 * 不会有某一格两个角色都落不了子。
 */
export function legalCells(b: Board, role: Role): Cell[] {
  const want = role === "life" ? 0 : 1;
  const out: Cell[] = [];
  for (let i = 0; i < b.cells.length; i++) if (b.cells[i] === want) out.push(i);
  return out;
}

/**
 * B3/S23 的朴素参照实现 —— **只用于测试**。
 *
 * 刻意写成与 lifeStep 完全不同的思路（逐格双层循环 + 显式边界分支），
 * 这样两个实现不会共享同一个思维错误 —— 若两边用同一套循环写边界，
 * 一个错的对齐会在两处同时出现，差分测试就永远抓不到它。
 * jev-2048 的差分测试用的就是这个手法（engine.test.ts 的 reference()）。
 *
 * 它现在多了一层约束：**差分测试把它写死成了基准，所以它不能再改**
 * （改它就等于同时改了「被测对象」和「量尺」）。T6 因此把生产实现
 * `lifeStep` 写成另一份独立代码，而不是让 lifeStep 直接等于它 ——
 * 详见 lifeStep 的注释。
 *
 * 规则（B3/S23）：
 *   死细胞周围恰好 3 个活细胞 → 诞生
 *   活细胞周围 2 或 3 个活细胞 → 存活
 *   其余 → 死亡
 */
export function referenceStep(b: Board, topo: Topology): Board {
  const { cols, rows, cells } = b;
  const next = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          let rr = r + dr;
          let cc = c + dc;
          if (topo === "torus") {
            rr = (rr + rows) % rows;
            cc = (cc + cols) % cols;
          } else if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) {
            continue; // bounded：界外视为死
          }
          n += cells[rr * cols + cc];
        }
      }
      const alive = cells[r * cols + c];
      next[r * cols + c] = alive ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
    }
  }
  return { cols, rows, cells: next };
}

/**
 * 位并行的 B3/S23（每格占 4 bit，整行打包进一个 BigInt）。
 *
 * 每格 4 bit 的理由：一个格子最多有 8 个活邻居，8 = 0b1000 需要 4 位才放得下，
 * 这样 8 个邻居直接**相加**就不会进位串到隔壁格子 —— 位平面因此能一次算完整行。
 *
 * ═══ 它现在不对外使用，是被实测淘汰下来的 ═══
 *
 * 设计计划初稿认定「lifeStep 用位并行」，理由是 torus 的水平环绕在位上
 * 就是一次循环移位、拓扑更清晰。但**那是一条可读性论据，不是性能论据** ——
 * 实测（tools/bench-step.ts，2026-09-21）显示它在全部三档预设尺寸上都更慢：
 * 相对 referenceStep，4×4 慢 4.6–5.0×、8×8 慢 2.2–2.8×、16×16 慢 1.3–2.4×，
 * 而且放大到 128×128 也没有反超的迹象。原因见那个文件的表：每步约 750 次
 * BigInt 运算，对小整数运算慢一到两个数量级。
 *
 * **保留而不删**的理由有两条，都与性能无关：
 *   1. torus 的水平环绕在这里确实是一次循环移位 —— 相同拓扑下两份实现
 *      互相比对，能抓出「环绕方向写反」这类错（差分测试的另一条腿）
 *   2. 将来若真把棋盘放大到几百格，反超点在哪目前**没有实测依据**，
 *      留着一份可以随时拿 tools/bench-step.ts --sizes= 复测
 */
export function bitwiseStep(b: Board, topo: Topology): Board {
  const { cols, rows, cells } = b;
  const width = BigInt(4 * cols);
  const FRAME = (1n << width) - 1n;

  // 每个 nibble 的四个位平面掩码
  let m0 = 0n;
  let m1 = 0n;
  let m2 = 0n;
  let m3 = 0n;
  for (let c = 0; c < cols; c++) {
    const s = BigInt(4 * c);
    m0 |= 1n << s;
    m1 |= 1n << (s + 1n);
    m2 |= 1n << (s + 2n);
    m3 |= 1n << (s + 3n);
  }

  const packed: bigint[] = [];
  for (let r = 0; r < rows; r++) {
    let x = 0n;
    const base = r * cols;
    for (let c = 0; c < cols; c++) if (cells[base + c]) x |= 1n << BigInt(4 * c);
    packed.push(x);
  }

  const wrap = BigInt(4 * (cols - 1));
  const rollL = (x: bigint): bigint => {
    const top = (x >> wrap) & 0xfn;
    return ((x << 4n) | top) & FRAME;
  };
  const rollR = (x: bigint): bigint => {
    const bot = x & 0xfn;
    return (x >> 4n) | (bot << wrap);
  };
  const shlL = (x: bigint): bigint => (topo === "torus" ? rollL(x) : (x << 4n) & FRAME);
  const shlR = (x: bigint): bigint => (topo === "torus" ? rollR(x) : x >> 4n);

  const rowAt = (r: number): bigint => {
    if (r < 0 || r >= rows) return topo === "torus" ? packed[(r + rows) % rows] : 0n;
    return packed[r];
  };

  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const mid = packed[r];
    const up = rowAt(r - 1);
    const dn = rowAt(r + 1);

    // 8 个邻居相加。每个 nibble 的值落在 0..8，不会进位到相邻 nibble。
    const sum = shlL(up) + up + shlR(up) + shlL(mid) + shlR(mid) + shlL(dn) + dn + shlR(dn);

    // 把四个位平面全部对齐到 nibble 的最低位（4c），才能逐格做条件判断
    const b0 = sum & m0;
    const b1 = (sum & m1) >> 1n;
    const b2 = (sum & m2) >> 2n;
    const b3 = (sum & m3) >> 3n;

    const alive = mid & m0;
    // BigInt 的 ~ 是无限位的，直接用会跑到 frame 之外；取反一律在 m0 掩码内做
    const zero = (x: bigint): bigint => m0 ^ x;

    // 恰好 3 个邻居：0011
    const n3 = b0 & b1 & zero(b2) & zero(b3);
    // 恰好 2 个邻居：0010
    const n2 = b1 & zero(b0) & zero(b2) & zero(b3);

    // 活细胞存活（2 或 3），死细胞诞生（恰好 3）
    const next = (alive & (n2 | n3)) | (zero(alive) & n3);

    const base = r * cols;
    for (let c = 0; c < cols; c++) {
      if ((next >> BigInt(4 * c)) & 1n) out[base + c] = 1;
    }
  }

  return { cols, rows, cells: out };
}

/**
 * 生产实现：B3/S23 的朴素算法。
 *
 * ═══ 为什么是朴素而不是位并行 ═══
 *
 * 实测说了算（tools/bench-step.ts，2026-09-21）：位并行在三档预设尺寸上
 * 全部更慢，相对 referenceStep，8×8 慢 2.2–2.8×、16×16 慢 1.3–2.4×。
 * 完整表格与「什么条件下该重新审视」见 DESIGN.md。**这是一条被数据推翻的
 * 直觉** —— 计划初稿认定位并行更快，理由是它拓扑更清晰；事实证明清晰是真的、
 * 快是假的。
 *
 * ═══ 为什么它和 referenceStep 写得不一样 ═══
 *
 * `referenceStep` 是差分测试的基准，**测试文件不允许改**（T6 的约束），
 * 所以它必须保持原样。于是这里不能直接 `export const lifeStep = referenceStep`
 * —— 那样差分测试就变成了「拿一个函数和它自己比」，永远不可能失败，
 * 一条不可能失败的测试等于没有测试。
 *
 * 所以这里是同一算法的**另一份独立写法**，刻意与 referenceStep 走不同的路：
 *   - 邻居数按「行 × 三个来源行」累加到 counts，最后统一套规则；
 *     referenceStep 是逐格扫 3×3 邻域
 *   - 取模只在每行的三个来源行上做一次，内层循环里没有任何取模；
 *     referenceStep 对**每个邻居**都取模
 *   - 水平环绕用两个显式分支（c-1 < 0 / c+1 >= cols）处理
 *
 * 两者思路不同，才不会共享同一个思维错误。jev-2048 的差分测试用的就是
 * 这个手法（engine.test.ts 的 reference()）。
 *
 * 规则（B3/S23）：
 *   死细胞周围恰好 3 个活细胞 → 诞生
 *   活细胞周围 2 或 3 个活细胞 → 存活
 *   其余 → 死亡
 */
export function lifeStep(b: Board, topo: Topology): Board {
  const { cols, rows, cells } = b;

  /* 第一步：把每格的活邻居数累加到 counts。
     注意行数下限是 MIN_SIZE = 4 —— torus 下 rows < 3 时「上一行」与
     「下一行」会折回同一行，同一批细胞被重复计数。这正是 types.ts 里
     MIN_SIZE 取 4 而不是 1 的原因。 */
  const counts = new Uint8Array(cols * rows);

  for (let r = 0; r < rows; r++) {
    const base = r * cols;

    // 邻居来自上、中、下三行。bounded 下界外的整行直接跳过
    for (let dr = -1; dr <= 1; dr++) {
      const raw = r + dr;
      let sr: number;
      if (topo === "torus") {
        sr = (raw + rows) % rows;
      } else if (raw < 0 || raw >= rows) {
        continue; // bounded：界外那整行视为死，一个邻居都不贡献
      } else {
        sr = raw;
      }
      const sBase = sr * cols;

      for (let c = 0; c < cols; c++) {
        if (cells[sBase + c] === 0) continue;

        // 正上 / 正下。同一行（dr=0）时不能自计，否则每格给自己 +1
        if (dr !== 0) counts[base + c]++;

        // 左邻右舍：越界时 bounded 不算、torus 折回另一端
        if (c > 0) counts[base + c - 1]++;
        else if (topo === "torus") counts[base + cols - 1]++;

        if (c < cols - 1) counts[base + c + 1]++;
        else if (topo === "torus") counts[base]++;
      }
    }
  }

  /* 第二步：统一套规则。拆成两步而不是边算边判，是因为规则只依赖
     「邻居总数」这一个量，而 counts 的累加与规则完全无关 —— 分开写，
     规则那一行读起来就是 B3/S23 的定义本身。 */
  const next = new Uint8Array(cols * rows);
  for (let i = 0; i < cells.length; i++) {
    const n = counts[i];
    next[i] = cells[i] ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
  }
  return { cols, rows, cells: next };
}

/* ═══════════════════════════════════════════════════════════════
   T7 · 状态哈希与终局判定
   ═══════════════════════════════════════════════════════════════ */

/**
 * 棋盘的状态哈希，用于 repeatBlocked 检测的 `seen` 集合。
 *
 * **必须带上尺寸**：不带的话 4×4 全死与 5×5 全死都是「一长串 0」，
 * 而它们是不同的局面（合法落点、后继、占比全都不同）。尺寸前缀一并解决
 * 了「cells 长度不是 4 的倍数时末位补 0」带来的跨尺寸歧义。
 *
 * 每 4 格打包成一个 hex 数字：格子只有 0/1 两个值，nibble 里剩下的位恒为 0，
 * 所以同尺寸下这个编码是单射 —— 不会有两个不同棋盘撞同一个 key。
 */
export function boardKey(b: Board): string {
  let out = `${b.cols}x${b.rows}:`;
  for (let i = 0; i < b.cells.length; i += 4) {
    let nib = 0;
    for (let k = 0; k < 4 && i + k < b.cells.length; k++) nib |= b.cells[i + k] << k;
    out += nib.toString(16);
  }
  return out;
}

/** 从序列末尾往前数，连续满足 pred 的个数。防抖计数用它 —— 一旦断了就归零重数 */
function trailingRun(xs: readonly number[], pred: (x: number) => boolean): number {
  let n = 0;
  for (let i = xs.length - 1; i >= 0; i--) {
    if (!pred(xs[i])) break;
    n++;
  }
  return n;
}

/** 走投无路时按当前占比定胜负：越界判该方胜，夹在中间判和局 */
function ratioWinner(ratio: number, rules: GameRules): Role | null {
  if (ratio >= rules.lifeWinRatio) return "life";
  if (ratio <= rules.deathWinRatio) return "death";
  return null;
}

/**
 * 终局判定。返回 null 表示对局继续。
 *
 * ═══ 判定顺序是有讲究的，不能重排 ═══
 *
 *   1. 连续越界 ≥ 该侧 streak → 判该方胜
 *   2. 当前行动方无合法动作（noLegalCell / repeatBlocked）→ 按当前占比定胜负
 *   3. 回合上限 → 和局
 *
 * 第 1 条排最前，因为那是玩家主动争取的目标 —— 已经赢到手的东西不该被
 * 「正好这回合也没棋可走」改写成一个不同的原因（更不该变成和局）。
 *
 * 第 2 条排在第 3 条之前：无棋可走与回合上限同时成立时，「走投无路」是更具体的
 * 那个原因，回合上限只是兜底。两者都判和局的话，报哪个原因会影响 UI 上的复盘文案。
 *
 * 第 2 条那半句「按占比定胜负」是刻意加的：防抖的作用是**挡住一代走运就赢**，
 * 而游戏既然已经因为别的原因要结束了，再卡防抖就会出现「棋盘全活、生之执却
 * 因为只持续了一代而判和局」这种说不通的结果。
 *
 * 两侧胜负线不会同时触发 —— 两条线判的都是**末尾**的连续序列，
 * 而同一个占比不可能既 ≥ lifeWinRatio 又 ≤ deathWinRatio（0.6 > 0.05）。
 *
 * ═══ 调用方的契约 ═══
 *
 * `seen` 必须由调用方构造并**包含当前局面**（当前局面当然是「见过的」），
 * 之后每走一回合把新局面的 key 加进去。函数只读它，不改它。
 *
 * 注意 `seen` 是**按角色**使用的：生执与死执的合法集互斥，后继自然也不同，
 * 所以一方走投无路不代表另一方也是。这正是 `role` 参数不可省的原因。
 *
 * 本函数不改动任何入参（引擎纯度的硬约束，见文件头）。
 */
export function classifyTermination(
  snap: GameSnapshot,
  role: Role,
  rules: GameRules,
  seen: ReadonlySet<string>,
): Termination | null {
  const { board, topology } = snap;

  // 当前占比现算，不存两份真相。历史 + 当前拼成一条序列再数末尾连续段：
  // 当前这一代是刚演化完的，必须参与计数。
  const ratio = aliveCount(board) / (board.cols * board.rows);
  const series = [...snap.ratioHistory, ratio];

  // 1. 胜负线
  if (trailingRun(series, (v) => v >= rules.lifeWinRatio) >= rules.lifeStreak) {
    return { reason: "lifeWinRatio", winner: "life" };
  }
  if (trailingRun(series, (v) => v <= rules.deathWinRatio) >= rules.deathStreak) {
    return { reason: "deathWinRatio", winner: "death" };
  }

  // 2. 无棋可走。先判空集再判重复 —— 两者是不同情况，不能合并。
  //    空集若不先判，下面的 every 会对空数组返回 true，把 noLegalCell 误报成 repeatBlocked。
  const options = legalCells(board, role);
  if (options.length === 0) {
    return { reason: "noLegalCell", winner: ratioWinner(ratio, rules) };
  }
  const everyOptionRepeats = options.every((cell) =>
    seen.has(boardKey(lifeStep(flip(board, cell), topology))),
  );
  if (everyOptionRepeats) {
    return { reason: "repeatBlocked", winner: ratioWinner(ratio, rules) };
  }

  // 3. 回合上限
  if (snap.turn >= rules.turnLimit) return { reason: "turnLimit", winner: null };

  return null;
}
