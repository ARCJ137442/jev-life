import type {
  Board,
  Cell,
  GameRules,
  GameSnapshot,
  Mode,
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
 * 这一回合推不动吗 —— repeatBlocked 的判定核心。
 *
 * ═══ 为什么是「一对落点」而不是「一个角色的落点」 ═══
 *
 * 回合的结构是**双方同时各走一步，然后演化一代**：
 *
 *     ① 生之执翻转一个死格  ② 死之执翻转一个活格  ③ lifeStep 演化一代
 *
 * 所以「局面还能不能动」是对**回合**问的，不是对角色问的：只要存在任意一对
 * (生之执落点, 死之执落点) 能演化出 `seen` 之外的局面，这一回合就推得动。
 *
 * 只查「该角色单独走一步 + 演化」是错的 —— 它忽略了同回合另一方的落子。
 * 实测反例（16×16 方块阵、方块间隔 2 格、36 格）：死之执的 36 个落点全部惰性
 * （方块是静物，敲掉任一角下一代都长回原样），而同一批回合里生之执有 220 个
 * 落点、其中 156 个能改变局面。旧实现按角色判，第 1 代就报 repeatBlocked 终局，
 * 而它明明推得动。
 *
 * ═══ 早退出不是可选项 ═══
 *
 * 健康局面上通常前几对就命中新局面，扫全一整轮是纯浪费；只有真卡死时才需要
 * 扫完 |生执落点| × |死执落点| 个组合（那时本来就该结束了）。所以这里一找到
 * 新局面就立刻返回 false。
 *
 * ═══ 空集合的情形 ═══
 *
 * 任意一方的合法集为空时，一对组合都不存在 —— 「没有组合能产生新局面」按字面
 * 成立，于是返回 true。这是对的：回合根本成立不了，游戏就该结束。
 *
 * 注意 classifyTermination 里这条路径**走不到**：它先判 noLegalCell，而空集
 * 正是 noLegalCell 的触发条件，所以空集总是先被报成那个更具体的原因。这里的
 * 返回值是给「本函数单独被调用」时兜底的，语义上仍然正确 —— 只是不该指望
 * classifyTermination 会把空集报成 repeatBlocked。
 */
function roundIsBlocked(
  board: Board,
  topology: Topology,
  seen: ReadonlySet<string>,
  mode: Mode,
): boolean {
  const born = legalCells(board, "life");

  // ★ 单人模式：一回合只有**一格**落子，所以「推得动」只问生之执的那些落点。
  // 仍然按一侧判是**对的**（不是简化）—— 死之执根本不落子，把它的落点也算进
  // 「这一回合能不能改变局面」是在给一个不存在的行动方投票。
  // 与双人那条「按角色判是错的」并不矛盾：那里错的原因是**忽略了同回合
  // 另一方的落子**，而单人模式下另一方本来就没有落子。
  if (mode === "solo") {
    for (const life of born) {
      if (!seen.has(boardKey(lifeStep(flip(board, life), topology)))) return false;
    }
    return true;
  }

  const killed = legalCells(board, "death");
  for (const life of born) {
    // 生之执先落子。翻一次得到一个中间局面，再让死之执在它上面落子 ——
    // 两边都基于**演化前**的棋盘决策，所以两者落点必然不同格（见 legalCells）。
    const afterLife = flip(board, life);
    for (const death of killed) {
      if (!seen.has(boardKey(lifeStep(flip(afterLife, death), topology)))) return false;
    }
  }
  return true;
}

/**
 * 终局判定。返回 null 表示对局继续。
 *
 * ═══ 判定单位是对局，不是任何一方 ═══
 *
 * 这个函数曾经有一个 `role` 参数 —— 「该回合里被问的那一方」。
 * **它已经被去掉了，而且不应该被加回来。** 四条终局条件全是对局级的：
 *
 *   - 胜负线判的是**当前局面**的占比，和谁在问没有关系
 *   - `repeatBlocked` 判的是**回合**（理由见 roundIsBlocked）：一对落点都推不动
 *   - `noLegalCell` 判的是**棋盘本身**：全死则死之执无处可翻，全活则生之执
 *     无处可翻。这是棋盘的性质，不是「轮到谁」的性质
 *
 * 去掉 `role` 是下面那处修复的**结论**，不是顺手做的清理：旧的 `noLegalCell`
 * 只查被问的那一方，于是同一个全死棋盘上「问死之执」得到 `noLegalCell`、
 * 「问生之执」得到 `repeatBlocked` —— 结论碰巧一样（占比 0 也算出死之执胜），
 * 但**原因是错的**。一条对局级的判定只因提问的角色不同就报出不同的原因，
 * 就说明那个参数本来就不该存在。
 *
 * ═══ noLegalCell：把棋盘清空 / 占满的一方获胜 ═══
 *
 * 原因名是 `noLegalCell`（那一方一格都落不下去），但它真正的含义要具体得多，
 * 而且要具体地读 —— 它判的从来不是「谁没棋走」，而是**谁已经把棋盘做成了
 * 自己要的样子**：
 *
 *   - 死之执无处可翻 ⟺ 棋盘**全死** ⟺ 死之执把全部活细胞**清空**了
 *   - 生之执无处可翻 ⟺ 棋盘**全活** ⟺ 生之执把整个棋盘**占满**了
 *
 * 清空与占满正是双方各自的目的被推到极限的形态 —— 一方的目的彻底达成，
 * 对方自然一格都翻不动。所以判它胜。「无棋可走」只是这件事在棋盘上的症状，
 * 不是判胜的理由；照字面去读，很容易反过来以为是在惩罚走不动的那一方。
 *
 * 旧写法是 `winner: ratioWinner(ratio, rules)`，也就是错的，两条理由：
 *
 *   1. 它**依赖阈值**。棋盘清空时占比恰为 0 或 1，在默认阈值下碰巧算出同一个
 *      胜方；阈值一被推到极端就改判 —— 例如 `lifeWinRatio = 0` 时，
 *      ratioWinner 里生之执那条判在前（`0 >= 0` 先命中），全死棋盘会被判给
 *      生之执。「把棋盘清空」这种终极胜利不该取决于一条可以随便调的线。
 *   2. 它只在**被问的那一方**为空时才检查（见上）。
 *
 * 两侧的检查不会同时命中：死之执无落点 ⟺ 一格活细胞都没有，生之执无落点
 * ⟺ 一格死细胞都没有；两者同时成立要求棋盘一个格子都不剩，而 MIN_SIZE = 4。
 * 顺序因此无关紧要，这里按「死 → 生」写，与 types.ts 里 TerminationReason
 * 的列举顺序一致。
 *
 * ═══ repeatBlocked 的胜方仍然来自 ratioWinner ═══
 *
 * 这一条**没有**跟着 noLegalCell 一起变成「无棋可走者胜」，是刻意的：
 * 整盘推不动意味着**占比也冻住了** —— 没有新局面，就不会有新的占比值。
 * 若此刻占比已在某条线之外，那一方实际上会把这个占比无限保持下去，
 * 「连续 N 代」的防抖当然满足（欠的只是回合数）。所以判它胜。
 * 只有占比夹在两条线之间时才是和局。
 *
 * 这也是「防抖不在这里再卡一道」的理由：防抖的作用是**挡住一代走运就赢**，
 * 而游戏既然已经因为别的原因要结束了，再卡防抖就会出现「棋盘全活、生之执却
 * 因为只持续了一代而判和局」这种说不通的结果。
 *
 * ═══ 判定顺序是有讲究的，不能重排 ═══
 *
 *   1. 连续越界 ≥ 该侧 streak → 判该方胜
 *   2. 走投无路：noLegalCell（清空/占满棋盘者胜）/ repeatBlocked（按占比定胜负）
 *   3. 回合上限 → 和局
 *
 * 第 1 条排最前，因为那是玩家主动争取的目标 —— 已经赢到手的东西不该被
 * 「正好这回合也没棋可走」改写成一个不同的原因（更不该变成和局）。
 *
 * 第 2 条排在第 3 条之前：无棋可走与回合上限同时成立时，「走投无路」是更具体的
 * 那个原因，回合上限只是兜底。两者都判和局的话，报哪个原因会影响 UI 上的复盘文案。
 *
 * 顺序同时也照顾了开销，从便宜到贵：胜负线是一条 O(历史长度) 的末尾连续段计数；
 * noLegalCell 是两次 O(格数) 的线性扫描；`roundIsBlocked` 最贵，最坏要扫完
 * |生执落点| × |死执落点| 个组合。而且空集若不先判，pair 扫描会对空集返回 true、
 * 把 noLegalCell 误报成 repeatBlocked。
 *
 * 两侧胜负线不会同时触发 —— 两条线判的都是**末尾**的连续序列，
 * 而同一个占比不可能既 ≥ lifeWinRatio 又 ≤ deathWinRatio（0.6 > 0.05）。
 *
 * ═══ 调用方的契约 ═══
 *
 * `seen` 必须由调用方构造并**包含当前局面**（当前局面当然是「见过的」），
 * 之后每走一回合把新局面的 key 加进去。函数只读它，不改它。
 *
 * `seen` 里装的是**回合结束时**的局面（双方都落完子、演化过一代之后的那个），
 * 不是某一方单独落子后的局面 —— 与 roundIsBlocked 的口径一致。
 *
 * 本函数不改动任何入参（引擎纯度的硬约束，见文件头）。
 */
export function classifyTermination(
  snap: GameSnapshot,
  rules: GameRules,
  seen: ReadonlySet<string>,
): Termination | null {
  const { board, topology, mode } = snap;
  const solo = mode === "solo";

  // 当前占比现算，不存两份真相。历史 + 当前拼成一条序列再数末尾连续段：
  // 当前这一代是刚演化完的，必须参与计数。
  const ratio = aliveCount(board) / (board.cols * board.rows);
  const series = [...snap.ratioHistory, ratio];

  // 1. 胜负线
  if (trailingRun(series, (v) => v >= rules.lifeWinRatio) >= rules.lifeStreak) {
    return { reason: "lifeWinRatio", winner: "life" };
  }
  if (trailingRun(series, (v) => v <= rules.deathWinRatio) >= rules.deathStreak) {
    // ⚠ 单人模式**不能报「死之执获胜」** —— 那是关于一个不在场的人的话。
    // 同一个占比在这里的含义也不同：双人时它是「对手把局面压死了」，
    // 单人时它是「局面自己死绝了」（演化会把棋盘点空，与有没有对手无关）。
    // 所以换一条 reason，胜方为 null（没有对手，也就没有胜方）。
    return solo
      ? { reason: "soloDiedOut", winner: null }
      : { reason: "deathWinRatio", winner: "death" };
  }

  // 2. 走投无路。双人模式查两边、与被问的角色无关 —— 胜方是把棋盘**清空**
  //    （死执）或**占满**（生执）的那一方，不套阈值（理由见函数头那段）。
  //
  //    ★ 单人模式**只查生之执那一侧**：死之执根本不会落子，「它无处可翻」
  //    不构成终局 —— 棋盘全死时生之执反而处处可翻（每一格都是死格）。
  //    照搬双人那条会把「棋盘被清空」当成终局判负，而单人模式下那恰恰是
  //    可以继续下的局面（死绝是另一条 reason，靠占比连续越界来判）。
  if (!solo && legalCells(board, "death").length === 0) {
    return { reason: "noLegalCell", winner: "death" };
  }
  if (legalCells(board, "life").length === 0) {
    return { reason: "noLegalCell", winner: "life" };
  }

  // 整盘推不动仍按占比定胜负 —— 占比冻住了，在界外的那一方会把它无限保持下去。
  // 单人模式下把「死之执胜」映成 null：理由同上，没有对手就没有胜方。
  if (roundIsBlocked(board, topology, seen, mode)) {
    const w = ratioWinner(ratio, rules);
    return { reason: "repeatBlocked", winner: solo && w === "death" ? null : w };
  }

  // 3. 回合上限
  if (snap.turn >= rules.turnLimit) return { reason: "turnLimit", winner: null };

  return null;
}
