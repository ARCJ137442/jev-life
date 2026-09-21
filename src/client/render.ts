/**
 * 棋盘渲染与三种动画。
 *
 * ═══ 为什么是 canvas ═══
 *
 * 与 2048 同源的理由：DOM 绝对定位依赖 `clientWidth` 的测量时机，字体加载、
 * 滚动条出现都会让缓存值失真，结果是最右一列越界、或者字号算成 0 而整盘消失。
 * canvas 里每个像素都由自己算，这类问题从根上不存在。
 *
 * ═══ 复用了 2048 渲染器的哪部分 ═══
 *
 * 骨架是照搬的，因为那部分与「2048」无关、只与「用 canvas 画一块格阵」有关：
 *
 *   - `Map<Cell, Visual>` 目标值模型 —— 视觉层自带 `scale/alpha` 与**目标值**，
 *     与逻辑状态解耦。逻辑侧只管说「这一格现在是活的」，补间归渲染
 *   - 指数逼近补间，**按实际帧间隔归一化**（`easeK(dt)`）。这是唯一正确的写法：
 *     写死「每帧乘 0.28」的话，120Hz 屏上动画快一倍、掉帧时慢一半
 *   - 懒启动的 rAF：没有东西在动时把 `raf` 置 0，循环整个停掉
 *   - DPR 夹到 2.5（常量从 `chart.ts` 取，两处必须是同一个值）
 *   - `GUTTER_K` 几何：pad 与 gap 取**同一个常数**，格阵的节奏才与四周留白一致
 *   - 粒子积分的透明度 / 缩放曲线
 *
 * **不复用**：`SCALE` 橙色阶（生命棋只有「活/死」两态，没有 2 的幂要分档）、
 * `GLYPH` 方向箭头（生命棋的落子没有方向）、按位数分档的字号（格子里没有数字）。
 *
 * ═══ 与 2048 的三处结构性差异 ═══
 *
 * 1. **视觉单元是「格子」而不是「方块」**。2048 的 tile 会移动，所以视觉对象要
 *    跟着 tile 的 id 走；生命棋的格子不动，动的是它的生死 —— 所以 `visuals`
 *    按**格号**索引，不存在「从 A 格移到 B 格」这回事。
 * 2. **一回合有两段动画，且必须错开**：先「落子」（带发光选框），再「演化」
 *    （不带）。挤在同一帧里的话，被演化立刻改写的那些格子会把落子的动画吃掉，
 *    两种动画就只剩一种可见了。
 * 3. **构造函数不抛异常**。2048 在 `getContext` 失败时抛 —— 那是对的写法，
 *    但在这个项目里，模块求值阶段抛出的异常会**静默中断整个启动流程**，
 *    表现为「棋盘空白」（见 CLAUDE.md 红线 2）。拿不到上下文时降级成不画，
 *    比整页死掉好。
 *
 * ═══ 节奏是一个参数（`flipMs`）═══
 *
 * 落子相多久、选框留多久、粒子飘多久，**全部由 `flipMs` 一个数缩放**
 * （`scaleRate`）。它们各用各的常量的话，把落子相调长会得到「格子早就不动了、
 * 选框和粒子还在飘」—— 那不是看得更清楚，是三个不同步的动画叠在一起。
 */
import type { Board, Cell, Role } from "../core/types.js";
import { MAX_DPR } from "./chart.js";

/* ═══════════ 补间 ═══════════ */

/** 每帧的指数逼近比例。tick 内用 `easeK(dt)` 按实际帧间隔归一化 */
export const EASE = 0.28;
/**
 * 落子的缩放比常规补间**慢一点**。
 *
 * 它读的是「谁刚刚在这里落了一子」，而落子只发生在一格上 —— 用常规速率
 * 的话，等眼睛从棋盘别处移过去时它已经长完了，等于没看见。
 */
export const EASE_FLIP = 0.18;
/**
 * 发光选框的淡出速率 —— 比缩放更慢。
 *
 * 选框要回答「这是**谁**落的子」（绿=生之执、红=死之执），而颜色是需要在
 * 两个动画之间被读出来的信息：缩放在落子相结束时已经到位，选框再留一会儿，
 * 演化开始时才还能看出上一手是谁下的。
 */
export const EASE_GLOW = 0.085;

/**
 * 落子相的时长**基准**（ms）。其余速率常数（`EASE` / `EASE_GLOW` /
 * `PARTICLE_TTL`）都是照着这个时长调的，所以它是「1 倍速」的定义。
 *
 * 演化相在这一相结束之后才开始（见文件头第 2 条）。
 */
export const FLIP_MS_BASE = 420;

/**
 * 落子相时长的出厂值。**全部动画时长都由它缩放**，见 `scaleRate`。
 *
 * 这一相要让人看清「谁在哪儿落了一子，然后棋盘怎么变」——看不清就等于没做。
 *
 * ⚠ **曾经的 1680 是一次误读。** 实现这一版的 agent 在注释里写「用户看了两轮
 * 实物，两次都说『还不够慢』」，据此把基准 420 一路乘到 4 倍。但用户从未提过
 * 那两次要求，看到实物后的原话是：*「那个动画的默认值是自己重复要求给误解了，
 * 大概动画在 1000ms 差不多」*。
 *
 * 教训不在数字，在**归因**：一句「用户要求」写进注释之后，后面的人（包括
 * 复核者）会把它当成已授权的决定放过去。**要求必须有出处**，而没有出处时
 * 应当写「这是实现者的判断」，而不是替用户签名。
 */
export const FLIP_MS = 1000;

/**
 * 缩放与粒子占**选框**时长的比例。
 *
 * 用户定的比例是
 *
 *     缩放 : 粒子 : 选框 : 落子→演化的间隔 = 1 : 1 : 2 : 2
 *
 * 而 `flipMs` 是其中**选框**那一段（它同时也是落子到演化的间隔）——
 * 所以缩放与粒子只占它的一半。早先的实现让三者都跟着 `flipMs` 走，
 * 那是错的：选框要回答「这是**谁**落的子」，而缩放只是「这里刚变过」的反馈，
 * 两者同长就分不出主次。
 */
export const SCALE_OF_GLOW = 0.5;

/**
 * 一轮动画的总时长 = 选框时长的几倍。
 *
 * 展开是：落子相 1 段（选框铺满）→ 演化相 1 段（缩放 + 粒子，无选框）
 * → 空余 1 段。后两段合起来是「落子到演化」的间隔那么长，所以一轮 = 2 倍。
 *
 * **空余是刻意的**：演化演完立刻接下一回合的话，眼睛来不及把
 * 「刚才发生了什么」看完 —— 而这一局的信息量本来就比 2048 大得多。
 */
export const ROUND_OF_GLOW = 2;

/**
 * 把「每帧逼近比例」按倍数换算成另一条时间线。
 *
 * 指数补间没有「时长」这个参数，它的时长体现在**多久走到停机判据**上：
 * 走 n 帧后的残差是 `(1−k)ⁿ`。要让同样的残差在 `f` 倍的帧数之后才出现，
 * 解 `(1−k')^f = 1−k` 即得 `k' = 1 − (1−k)^(1/f)`。
 *
 * 这是「把动画整体拉长 f 倍」被精确实现的方式 —— 不是拿 `k/f` 近似
 * （那在 f=2 时会把 0.28 变成 0.14，实际时长只拉长了约 1.9 倍）。
 */
export function scaleRate(k: number, factor: number): number {
  if (!(factor > 0) || factor === 1) return k;
  return 1 - Math.pow(1 - k, 1 / factor);
}

/**
 * 外边距与内间距相对**格子边长**的比例。
 *
 * 两者刻意取同一个值 —— 这样格子之间的节奏与四周留白一致，整个棋盘读起来
 * 是一个规整的格阵，而不是「被一圈宽边包住的方阵」。这个常数是从 2048 那份
 * 反推来的，别凭感觉改（那边的注释记着一次真实的踩坑）。
 */
export const GUTTER_K = 0.0905;

/**
 * 按「帧」为单位的步长求本帧的逼近比例。
 *
 * 指数逼近的性质：连续逼近两帧（各 `dt`）与一次性逼近 `2·dt` 等价 ——
 * `easeK(dt)²` 复合出的正是 `easeK(2·dt)`。这条等式就是「按实际帧间隔归一化」
 * 的定义，测试直接钉它。形状上它是 **ease-out**（快起慢收）：头几帧走完大半，
 * 尾巴拖得很长，正好是规格要求的落子手感。
 */
export function easeK(dt: number, ease: number = EASE): number {
  return 1 - Math.pow(1 - ease, dt);
}

/** 指数逼近一步。抽出来是为了让「补间会收敛」这件事可以被单元测试直接钉住 */
export function approach(cur: number, target: number, k: number): number {
  return cur + (target - cur) * k;
}

/* ═══════════ 粒子的曲线 ═══════════ */

/** 单颗粒子的存活时长（秒） */
export const PARTICLE_TTL = 0.62;
/** 每个落子格撒出的粒子数区间（含两端） */
export const PARTICLE_PER_CELL_MIN = 2;
export const PARTICLE_PER_CELL_MAX = 4;
/** 粒子初始半径相对**格子边长**的比例区间。相对格子而非棋盘，换尺寸时比例恒定 */
export const PARTICLE_SIZE_MIN = 0.32;
export const PARTICLE_SIZE_MAX = 0.56;
/** 粒子的初速（格/秒）。方向随机 —— 落子没有方向可言（见文件头「不复用 GLYPH」） */
export const PARTICLE_SPEED = 1.1;

/** 一颗粒子。位置与速度都以**格**为单位，与像素尺寸解耦 */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 初始半径占格子边长的比例 */
  size: number;
  age: number;
  ttl: number;
  color: string;
}

/** 存活进度 t（0→1）处的透明度。指数 > 1 使收尾更快，读起来像「熄灭」而不是「淡出」 */
export function particleAlpha(t: number): number {
  return Math.pow(1 - t, 1.6);
}

/** 存活进度 t 处的半径收缩比例。指数 < 1，所以收缩比熄灭**慢**，粒子是变小而不是消失 */
export function particleShrink(t: number): number {
  return Math.pow(1 - t, 0.75);
}

/**
 * 推进所有粒子一帧，返回还活着的那些。
 *
 * 位置用**秒**推进而补间用**帧**推进，不是笔误：补间关心的是「还要几帧到位」，
 * 而粒子的轨迹是物理量，掉帧时它该走得更远而不是走得更慢。
 */
export function stepParticles(ps: Particle[], dtSec: number): Particle[] {
  const out: Particle[] = [];
  for (const p of ps) {
    p.age += dtSec;
    if (p.age >= p.ttl) continue;
    p.x += p.vx * dtSec;
    p.y += p.vy * dtSec;
    out.push(p);
  }
  return out;
}

/* ═══════════ 视觉单元 ═══════════ */

export interface CellVisual {
  scale: number;
  alpha: number;
  tScale: number;
  tAlpha: number;
  /** 发光选框的当前 / 目标不透明度。只在落子时被点亮，然后单调淡到 0 */
  glow: number;
  tGlow: number;
  /** 选框颜色 = 落子方的角色色。空串表示这一格没有选框 */
  glowColor: string;
}

/** 新建一个视觉单元。落子与演化的**初始状态不同**，所以两者分开给参数 */
export function makeVisual(scale: number, alpha: number, glowColor = ""): CellVisual {
  return {
    scale,
    alpha,
    tScale: 1,
    tAlpha: 1,
    glow: glowColor ? 1 : 0,
    tGlow: 0,
    glowColor,
  };
}

/**
 * 把一个视觉单元朝目标推进一帧。
 *
 * @returns 是否还需要下一帧。返回 false 是**停机信号** —— rAF 靠它决定
 *          什么时候把循环停掉，判据写松了会空转、写紧了会「差一点没走完就卡住」
 */
export function tweenVisual(v: CellVisual, k: number, kGlow: number = k): boolean {
  v.scale = approach(v.scale, v.tScale, k);
  v.alpha = approach(v.alpha, v.tAlpha, k);
  if (v.glow > 0) v.glow = approach(v.glow, v.tGlow, kGlow);
  return (
    Math.abs(v.tScale - v.scale) > 0.004 ||
    Math.abs(v.tAlpha - v.alpha) > 0.01 ||
    v.glow > 0.02
  );
}

/* ═══════════ 目标值的规划 ═══════════ */

/**
 * 一次落子：哪一格，以及**用哪个颜色演它**。
 *
 * ⚠ `color` **不是「谁翻的」**，而是「这一手会把它变成什么」：
 * 翻死格 → 绿（让它活），翻活格 → 红（让它死）。它只用于取色
 * （`palette[color]`），与任何角色语义无关。
 *
 * 双人局里这两种说法**恰好一致**（生之执只能翻死格、死之执只能翻活格），
 * 所以这个字段从前叫 `role` 也从没出过问题。**单人局里行动方生死一体、
 * 两种都能翻**，两者就此分家 —— 症状是「玩家翻活格时选框与粒子还是绿的」，
 * 看起来像渲染坏了，根因是把「谁」当成了「做什么」。
 *
 * 与 `chart.ts` 的 `buildHeat` 是同一条判据：那张图也按格子当前生死取色，
 * 于是热力图的红绿与棋盘动画的红绿说的是同一件事。
 */
export interface FlipAnim {
  readonly cell: Cell;
  readonly color: Role;
}

/**
 * 这一手会把它变成什么 → **用哪个颜色演它**。
 *
 * 翻死格 = 让它活 → `"life"`（绿）；翻活格 = 让它死 → `"death"`（红）。
 * 传的是**翻转之前**那一副棋盘。
 *
 * ⚠ 双人局里「谁在翻」与「把它变成什么」**恰好一一对应**，所以按角色取色
 * 从没出过问题；单人局里行动方生死一体、两种都能翻，两者才分家。单独抽成
 * 一个函数是为了它能被无头断言 —— 这一行取错没有任何测试背书，而症状
 * （玩家把活格翻死却闪绿光）看起来像渲染坏了，不像取色错了。
 *
 * 与 `chart.ts` 的 `buildHeat` 是同一条判据：那张图也按格子当前生死取色。
 */
export function flipColor(before: Board, cell: Cell): Role {
  return before.cells[cell] ? "death" : "life";
}

/** 一格在本次同步里要做的事。三种对应三种动画，见 `planCells` */
export type CellPlan =
  | {
      readonly kind: "spawn";
      /** 起始缩放。落子是 0，演化新生是 0.55 —— 前者要「蹦出来」，后者只要「长出来」 */
      readonly scale: number;
      readonly alpha: number;
      /**
       * 落子方（要挂发光选框）。null = 不挂。
       *
       * 两种情况都落到 null：**演化**没有行动方，**开局前的手绘**也没有。
       * 它们共同点正是「这一格的变化不是某个角色的一手棋」。
       */
      readonly glow: Role | null;
    }
  | {
      readonly kind: "update";
      /** 这一格刚被谁翻过。null = 没翻，只是继续活着 */
      readonly glow: Role | null;
    }
  | {
      readonly kind: "fade";
      /** 淡出时的收缩目标。落子翻死是 0（与 0→1 对称），演化死亡是 0.86 */
      readonly toScale: number;
      /**
       * 落子方（要挂发光选框）。null = 不挂。
       *
       * ★ **翻死的那一手同样要挂框。** 规格（`docs/ui-spec.md`：落子一节）
       * 写的是「**任一行动方**翻转一格 ⟹ 外加发光选框淡出 —— 生之执绿、
       * 死之执**红**」。而这一支从前整个不发选框（只有 `spawn` / `update`
       * 会发），于是死之执的落子在双人局里从来没有红框 ——
       * **单人局里更是只剩绿框**（行动方生死一体、两种都能翻，而只有
       * 「翻活」那一半会亮），看起来正像渲染坏了。
       *
       * 演化杀死格子时是 null（那一格不在 `flips` 里，本来就没有行动方）——
       * 规格：「迭代 …… 不带发光选框」
       */
      readonly glow: Role | null;
    };

/**
 * 算出一格在新局面下该变成什么样。**纯函数，不碰 DOM、不碰 canvas。**
 *
 * 抽出来是因为三种动画的**全部区别**都在这几步判断里，而它们恰好在渲染器上是
 * 私有方法、没有 canvas 就测不了。动画的语义能被断言的部分必须能脱离浏览器跑：
 *
 *   - **落子**：起始缩放 0、起始透明度 1（尺寸为 0 时本来就看不见，不必再淡入）、
 *     有角色时**挂发光选框**
 *   - **演化**：新生从 0.55 长起并淡入、死亡缩到 0.86 后淡出，**一律不挂选框** ——
 *     选框是「谁落的子」，而演化没有行动方
 *   - **手绘**（`flips` 里有这一格、但值是 null）：按落子的形状缩放，**不挂选框**。
 *     「被翻动了」与「被某个角色翻动了」是两件事，这也是这里必须把
 *     `flips.has(i)` 与 `role` 分开判的原因 —— 合成一个判断的话，手绘就会
 *     退化成演化新生（从 0.55 长起），玩家的点击反馈会变得含糊
 *
 * @param present 视觉层当前存在的格子（已经不是逻辑状态，但决定了「新生」与
 *                「已有的继续活着」这两种情况的区别）
 * @param flips   本次被翻动的格子 → 落子方（null = 没有角色）
 * @param animate false 时一律直接到位（关掉动效开关的路径）
 */
export function planCells(
  present: ReadonlySet<Cell>,
  board: Board,
  flips: ReadonlyMap<Cell, Role | null> | null,
  animate: boolean,
): Map<Cell, CellPlan> {
  const plan = new Map<Cell, CellPlan>();

  for (let i = 0; i < board.cells.length; i++) {
    // 「被翻动了」与「被某个角色翻动了」是两件事：前者决定缩放的形状，
    // 后者决定有没有发光选框。手绘只有前者
    const flipped = flips !== null && flips.has(i);
    const role = flips?.get(i) ?? null;

    if (board.cells[i]) {
      if (!present.has(i)) {
        plan.set(i, {
          kind: "spawn",
          scale: !animate ? 1 : flipped ? 0 : 0.55,
          alpha: !animate ? 1 : flipped ? 1 : 0,
          glow: animate ? role : null,
        });
      } else {
        plan.set(i, { kind: "update", glow: animate ? role : null });
      }
    } else if (present.has(i)) {
      // 被落子翻死：缩到没有（与 0 → 1 对称）；被演化杀死：2048 那套 0.86
      // 选框按「有没有行动方」给，与 `spawn` / `update` 同一判据 ——
      // 演化杀死时 `role` 必然是 null（那一格不在 `flips` 里）
      plan.set(i, { kind: "fade", toScale: flipped ? 0 : 0.86, glow: animate ? role : null });
    }
  }

  return plan;
}

/* ═══════════ 渲染器 ═══════════ */

/** 一个回合的两段动画。`mid` = 双方落完子、还没演化 */
export interface TurnAnim {
  readonly mid: Board;
  readonly after: Board;
  readonly flips: readonly FlipAnim[];
}

/**
 * 一回合的两段动画**各自落地**的那一刻。
 *
 * `flip` = 落子已生效（棋盘是 `TurnAnim.mid`），`evolve` = 演化已生效
 * （棋盘是 `TurnAnim.after`）。名字说的是「哪一段演完了」，不是「谁在动」——
 * 记分板之类的读数按它决定「该报哪一副棋盘的数」。
 */
export type TurnPhase = "flip" | "evolve";

const BASE = "#0b0f14";
const WELL = "#080b10";
const LIVE = "#ffffff";
/** 活细胞的冷光。主题色是青，让白块在冷底上「亮」起来而不是一块死白 */
const LIVE_GLOW = "rgba(34,211,238,.55)";

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class BoardRenderer {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly visuals = new Map<Cell, CellVisual>();
  private particles: Particle[] = [];
  private cols = 0;
  private rows = 0;
  private cssW = 0;
  private cssH = 0;
  private cellPx = 0;
  private dpr = 1;
  private raf = 0;
  private lastTs = 0;
  /** 演化相：到点之前先画落子相 */
  private pending: { board: Board; at: number; onEvolve?: () => void } | null = null;
  /**
   * 本轮动画的终点（rAF 时间戳）。0 = 当前没有在跑的轮次。
   *
   * 用它而不是「等补间自己停」：指数补间是渐近的，停机判据受帧率与阈值影响，
   * 拿它当节拍器会得到抖动的轮长（有时 1.8s 有时 2.3s），而空余那一段
   * 恰恰是「让人看完刚才发生了什么」—— 抖动就等于有时够看、有时不够。
   */
  private roundEndsAt = 0;
  /** 补间开关。关掉后所有过渡瞬时完成 */
  animations = true;
  /** 落子粒子 */
  particlesEnabled = true;
  /**
   * **选框**的时长（ms）—— 整套动画的基准，不是「落子相总长」。
   *
   * 用户定的比例是 `缩放 : 粒子 : 选框 : 落子→演化的间隔 = 1 : 1 : 2 : 2`。
   * 这个数对应其中**选框**那一段（它同时也是落子到演化的间隔），
   * 缩放与粒子按 `SCALE_OF_GLOW` 取它的一半，一轮总计 `ROUND_OF_GLOW` 倍。
   *
   * 改它就等于整体变速：`scaleRate` 会把各条速率精确换算过去，
   * 所以不会出现「格子早就不动了、选框还在飘」那种三拍子不同步。
   */
  flipMs = FLIP_MS;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** 角色色由装配层给（`main.ts` 的 ROLE_META）—— 颜色是数据的一部分，不在这里另立一份 */
    private readonly palette: Record<Role, string>,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: true });
  }

  /* ---------- 几何 ---------- */

  /**
   * 按可用空间算出棋盘该多大。
   *
   * 几何全部以**格子边长 c** 为基准：`pad = gap = GUTTER_K · c`，
   * 宽 = c·(cols + (cols+1)·GUTTER_K)，高同理。c 由宽高两个约束**共同**决定，
   * 取较小者 —— 否则极端的宽高比会横向溢出（生命棋的棋盘是正方形，
   * 但 Board 本身带 cols/rows，没有理由在这里假设它们相等）。
   *
   * @returns 是否发生了实际变化
   */
  resize(availW: number, availH: number, cols: number, rows: number): boolean {
    if (availW <= 0 || availH <= 0 || cols <= 0 || rows <= 0) return false;

    const wUnits = cols + (cols + 1) * GUTTER_K;
    const hUnits = rows + (rows + 1) * GUTTER_K;
    const cell = Math.floor(Math.min(availW / wUnits, availH / hUnits));
    if (cell < 4) return false; // 太小，放弃本次

    const cssW = Math.round(cell * wUnits);
    const cssH = Math.round(cell * hUnits);
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    if (cssW === this.cssW && cssH === this.cssH && dpr === this.dpr && cols === this.cols && rows === this.rows) {
      return false;
    }

    this.cssW = cssW;
    this.cssH = cssH;
    this.cellPx = cell;
    this.dpr = dpr;
    this.cols = cols;
    this.rows = rows;

    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
    return true;
  }

  private get pad(): number {
    return this.cellPx * GUTTER_K;
  }

  private get gap(): number {
    return this.cellPx * GUTTER_K;
  }

  /** 格号 → 该格左上角的像素坐标 */
  private px(cell: Cell): { x: number; y: number } {
    const step = this.cellPx + this.gap;
    return { x: this.pad + (cell % this.cols) * step, y: this.pad + Math.floor(cell / this.cols) * step };
  }

  /**
   * 视口坐标 → 格号。落在格子外（含四周留白与格子之间的缝）时返回 null。
   *
   * 给「开始对弈之前手绘开局」用。**几何只在这里算一次** —— 把 pad / gap /
   * cellPx 抄到调用方去，改一次 GUTTER_K 就会得到「点得中但画不到」这种
   * 只在特定尺寸下出现的错位，而它看起来像点击没生效。
   *
   * 用的是 `getBoundingClientRect()` 而不是 `offsetX/offsetY`：canvas 的 CSS
   * 尺寸与它的位图尺寸（DPR 缩放后）不是一回事，offsetX 在部分浏览器上给的
   * 是位图坐标，于是高 DPR 屏上点哪儿都偏。
   */
  cellAtPoint(clientX: number, clientY: number): Cell | null {
    if (this.cellPx <= 0 || this.cols <= 0 || this.rows <= 0) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    // CSS 像素 → 内部几何单位（resize 时算的是 CSS 像素，两者同尺度；
    // 这一层换算只是为了防止 canvas 被外层 CSS 拉伸过）
    const x = ((clientX - rect.left) / rect.width) * this.cssW;
    const y = ((clientY - rect.top) / rect.height) * this.cssH;

    const step = this.cellPx + this.gap;
    const col = Math.floor((x - this.pad) / step);
    const row = Math.floor((y - this.pad) / step);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return null;

    // 缝里（格子的右/下留白）不算命中 —— 否则相邻两格会争同一条边界，
    // 而谁赢取决于浮点误差
    const inX = x - this.pad - col * step;
    const inY = y - this.pad - row * step;
    if (inX > this.cellPx || inY > this.cellPx) return null;

    return row * this.cols + col;
  }

  /** 连续格坐标 → 像素坐标（粒子用）。整数部分是格索引，小数部分是格内偏移 */
  private pxFrac(gx: number, gy: number): { x: number; y: number } {
    const step = this.cellPx + this.gap;
    const fx = Math.floor(gx);
    const fy = Math.floor(gy);
    return {
      x: this.pad + fx * step + (gx - fx) * this.cellPx,
      y: this.pad + fy * step + (gy - fy) * this.cellPx,
    };
  }

  /* ---------- 状态同步 ---------- */

  /** 整套动画的节奏倍数。1 = 出厂节奏，2 = 时长全部翻倍 */
  private get tempo(): number {
    return this.flipMs / FLIP_MS_BASE;
  }

  /**
   * 把还没落地的演化相通知补出去，然后清掉它。
   *
   * ═══ 为什么需要它 ═══
   *
   * `pending` 是**单个槽位** —— 新的一轮 `playTurn` 会把它整个替换掉，而
   * `evolve` 相的通知就挂在这个槽位上。于是「决策回得比动画快」时（下一回合
   * 在演化落地之前就开始），那一次 `evolve` 就此消失，**调用方无从知道少了
   * 一次通知**。记分板与态势图都挂在它上面，症状是态势图**一个点都不再更新**
   * ——每回合都丢一次，而画面本身一切正常，看起来像「图卡住了」。
   *
   * 补报是安全的，因为 `playTurn` 的约定已经要求过：回调必须**幂等、且能从
   * 当前状态重算**（`refreshMomentumChart` 读的是当前 state，`renderScore`
   * 读的是它闭包里捕获的那一副读数）。这正是那条约定存在的意义。
   *
   * ⚠ **只补通知，不补棋盘。** 棋盘在调用方那一侧早已提交进 `state.board`
   * （逻辑先走、动画后演），这里再去 apply 一副旧的，反而会画出一个从来没
   * 发生过的中间态；紧接着的 `applyBoard(anim.mid, …)` 才是该显示的那一副。
   *
   * ⚠ 只在 `playTurn` 开头调，**不放进 `setBoard` / `toggle` / `clear`**：
   * 那三条是「这一局翻篇了」，补报上一回合的读数没有意义。判据详见 `playTurn`
   * 的文档——「被下一回合顶掉」与「被打断」看着像，差的正是这一条。
   */
  private flushPendingEvolve(): void {
    const p = this.pending;
    this.pending = null;
    p?.onEvolve?.();
  }

  /**
   * 把一个回合的两段动画排进时间线。
   *
   * 落子相立刻开始（它带发光选框），演化相排在 `flipMs` 之后 —— 两段挤在
   * 同一帧里的话，被演化改写的格子会当场把落子的动画顶掉，而落子的选框
   * 是**唯一**能看出「上一手是谁下的」的地方。
   *
   * ★ **`onPhase` 是给记分板这类读数用的**：它在两段**各自落地的那一刻**被调，
   * 而不是在调用方发请求的那一刻。没有它的话，调用方只能在自己那一侧立刻刷新
   * 读数 —— 于是画面还在落子相，数字已经把演化后的结局报出来了（详见
   * `score.ts` 的注释：那是**时机**错，不是算术错，看起来像算错）。
   *
   * 时序由渲染器自己持有（`flipMs` 是它的参数、`animations` 关掉时两相会
   * 合并到同一帧），所以这个通知必须从**这里**发 —— 调用方另起一个
   * `setTimeout(flipMs)` 就是第二份时间线，两份迟早对不上。
   *
   * ⚠ 动画被 `setBoard` / `toggle` / `clear` 打断时，`evolve` **不会**被调
   * （那一帧的棋盘从来没出现在屏幕上）。所以回调里做的事必须是**幂等且可从
   * 当前状态重算**的 —— 这条约束正是下面那个补报能成立的前提。
   *
   * ★ 但**被下一次 `playTurn` 顶掉**是另一回事：那一次 `evolve` 必须补报，
   * 见 `flushPendingEvolve`。两者看着像，差在「这一回合还算不算数」——
   * `setBoard` / `clear` 是「这一局翻篇了」，而连续的 `playTurn` 是同一局里的
   * 下一回合，上一回合的读数本来就该落地。
   */
  playTurn(anim: TurnAnim, onPhase?: (phase: TurnPhase) => void): void {
    // 上一回合若还没演化完就被这一回合接上，先把它的通知补出去 —— 见
    // `flushPendingEvolve`。必须在本函数改动任何渲染状态**之前**调
    this.flushPendingEvolve();

    const flips = new Map<Cell, Role | null>();
    for (const f of anim.flips) flips.set(f.cell, f.color);
    this.applyBoard(anim.mid, flips);
    onPhase?.("flip");

    if (this.animations && this.particlesEnabled) {
      for (const f of anim.flips) this.burst(f.cell, this.palette[f.color]);
    }

    if (!this.animations) {
      // 动效关掉 = 两相在同一帧里落地，那就按同一帧报
      this.applyBoard(anim.after, null);
      onPhase?.("evolve");
      return;
    }
    // rAF 的时间戳与 performance.now() 同源，可以直接比
    const now = performance.now();
    this.pending = {
      board: anim.after,
      at: now + this.flipMs,
      ...(onPhase ? { onEvolve: () => onPhase("evolve") } : {}),
    };
    // 一轮的终点定死在时间线上，而不是「等到补间自己停」——
    // 指数补间是渐近的，它的停机判据受帧率与判据阈值影响，
    // 拿它当节拍器会得到「有时 1.8s 有时 2.3s」的抖动
    this.roundEndsAt = now + this.flipMs * ROUND_OF_GLOW;
    this.start();
  }

  /**
   * 翻转一格 —— **不带任何角色语义**的那一种。
   *
   * 给「开始对弈之前玩家手绘开局」用：这时还没有行动方，所以**只有缩放**，
   * 既不撒粒子也不出发光选框。粒子和选框在规格里是「某个角色落子」的标记，
   * 借给手绘用会让人以为那是某一方下的子。
   *
   * 与 `playTurn` 分开是刻意的：一个 `if (role === null)` 塞在落子路径里，
   * 会让「这格是谁下的」这个唯一重要的信息变成一个可空字段 —— 那正是将来
   * 最容易传错的地方。两条语义各有一个入口，调用方就没法含糊。
   *
   * @param board 翻转**之后**的棋盘。渲染器不持有逻辑状态，所以由调用方给
   */
  toggle(board: Board, cell: Cell): void {
    this.pending = null;
    this.roundEndsAt = 0;
    const flips = new Map<Cell, Role | null>([[cell, null]]);
    this.applyBoard(board, flips);
    this.draw();
  }

  /** 直接落到一副棋盘上（开新局、恢复存档、改尺寸）。不走动画 */
  setBoard(board: Board): void {
    this.pending = null;
    this.roundEndsAt = 0;   // 直接落盘 = 不在任何一轮动画里
    this.applyBoard(board, null, true);
    this.particles = [];
    this.draw();
  }

  clear(): void {
    this.cancel();
    this.pending = null;
    this.roundEndsAt = 0;
    this.visuals.clear();
    this.particles = [];
    this.draw();
  }

  redraw(): void {
    this.draw();
  }

  /**
   * 把视觉层对齐到一副棋盘。
   *
   * @param flips   这一手被翻动的格子 → 落子方。**值为 null 表示「没有角色」**
   *                （开局前的手绘），此时只有缩放，不出选框
   * @param instant 直接到位，不做补间
   *
   * 目标值的给法对应规格里的三种动画：
   *   - **落子**：0 → 1 缩放（ease-out）+ 发光选框淡出。翻死的格子对称地缩到 0
   *   - **演化**：新生格 0.55 + 淡入，死亡格缩到 0.86 + 淡出 —— 都**不带**选框
   *   - **粒子**：另起炉灶，见 `burst()`
   */
  private applyBoard(
    board: Board,
    flips: ReadonlyMap<Cell, Role | null> | null,
    instant = false,
  ): void {
    const animate = this.animations && !instant;
    const plan = planCells(new Set(this.visuals.keys()), board, flips, animate);

    for (const [cell, p] of plan) {
      if (p.kind === "spawn") {
        this.visuals.set(cell, makeVisual(p.scale, p.alpha, p.glow ? this.palette[p.glow] : ""));
        continue;
      }
      const v = this.visuals.get(cell);
      if (!v) continue;
      // ★ 选框对 `update` 与 `fade` **一视同仁**：它回答的是「这一手是谁下的」，
      // 而「把活格翻死」同样是一手。从前它只挂在 `update` 上，于是死之执
      // 的落子从来没有红框（见 `CellPlan` 的 fade 那条注释）
      if (p.glow) {
        v.glow = 1;
        v.tGlow = 0;
        v.glowColor = this.palette[p.glow];
      }
      if (p.kind === "update") {
        v.tScale = 1;
        v.tAlpha = 1;
      } else {
        v.tAlpha = 0;
        v.tScale = p.toScale;
      }
    }

    if (!animate) {
      for (const [cell, v] of this.visuals) {
        if (v.tAlpha === 0) {
          this.visuals.delete(cell);
          continue;
        }
        v.scale = 1;
        v.alpha = 1;
        v.glow = 0;
      }
      this.cancel();
      this.draw();
      return;
    }

    this.start();
  }

  /* ---------- 粒子 ---------- */

  /**
   * 在落子格附近撒一把粒子。
   *
   * 骨架与 2048 的 `burst` 同源（位置/速度以格为单位、年龄与 ttl、透明度与
   * 缩放的幂曲线、字号锚定格子边长），只有两处不同：
   *   - 方向随机而不是沿某个方向 —— 生命棋的落子没有方向
   *   - 画的是圆点而不是箭头字符（规格明确说不复用 `GLYPH`）
   */
  burst(cell: Cell, color: string): void {
    if (!this.animations || !this.particlesEnabled || this.cssW <= 0) return;
    if (cell < 0 || cell >= this.cols * this.rows) return;

    const cx = (cell % this.cols) + 0.5;
    const cy = Math.floor(cell / this.cols) + 0.5;
    const count =
      PARTICLE_PER_CELL_MIN +
      Math.floor(Math.random() * (PARTICLE_PER_CELL_MAX - PARTICLE_PER_CELL_MIN + 1));

    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      const sp = PARTICLE_SPEED * (0.7 + Math.random() * 0.6);
      this.particles.push({
        x: cx + (Math.random() - 0.5) * 0.6,
        y: cy + (Math.random() - 0.5) * 0.6,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        size: PARTICLE_SIZE_MIN + Math.random() * (PARTICLE_SIZE_MAX - PARTICLE_SIZE_MIN),
        age: 0,
        // 粒子的存续时间跟着**缩放**那条时间线走（不是选框那条）——
        // 比例表里粒子与缩放同为 1 份，而选框是 2 份
        ttl: PARTICLE_TTL * this.tempo * SCALE_OF_GLOW * (0.7 + Math.random() * 0.65),
        color,
      });
    }
    this.start();
  }

  /* ---------- 动画循环 ---------- */

  private cancel(): void {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.lastTs = 0;
  }

  private start(): void {
    if (this.raf) return;
    this.lastTs = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (ts: number): void => {
    const rawDt = this.lastTs ? Math.min(ts - this.lastTs, 60) : 16.667;
    const dt = rawDt / 16.667; // 以「帧」为单位的归一化步长
    const dtSec = rawDt / 1000;
    this.lastTs = ts;
    // ⚠ 缩放与选框**不是**同一个节奏倍数（见 SCALE_OF_GLOW）：
    //    选框铺满整个落子相，缩放与粒子只占它的一半
    const tempo = this.tempo;
    const k = easeK(dt, scaleRate(EASE, tempo * SCALE_OF_GLOW));
    const kGlow = easeK(dt, scaleRate(EASE_GLOW, tempo));

    // 落子相演完 → 接上演化相
    if (this.pending && ts >= this.pending.at) {
      const { board, onEvolve } = this.pending;
      this.pending = null;
      this.applyBoard(board, null);
      // 先让棋盘落地再通知：回调此刻若问「渲染器现在摆的是哪一副」，
      // 拿到的必须是演化后那一副（`pending` 已清、目标值已换）。
      // 它**看不到**这一帧画完的画 —— 绘制在本轮 tick 的末尾 ——
      // 所以回调只该写读数，不该去画布上取像素
      onEvolve?.();
    }

    // 演化相 + 空余：到 roundEndsAt 之前都算「还在演」
    if (this.roundEndsAt !== 0 && ts >= this.roundEndsAt) this.roundEndsAt = 0;
    let busy = this.pending !== null || this.roundEndsAt !== 0;

    for (const [cell, v] of this.visuals) {
      if (tweenVisual(v, k, kGlow)) busy = true;
      // 已经淡干净、也没有选框要收尾的格子直接摘掉，别让它永远挂在表里
      if (v.alpha < 0.02 && v.tAlpha === 0 && v.glow < 0.02) this.visuals.delete(cell);
    }

    if (this.particles.length) {
      busy = true;
      this.particles = stepParticles(this.particles, dtSec);
    }

    this.draw();

    if (busy) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.raf = 0;
      this.lastTs = 0;
      this.draw();
    }
  };

  /* ---------- 绘制 ---------- */

  private draw(): void {
    const ctx = this.ctx;
    const W = this.cssW;
    const H = this.cssH;
    if (!ctx || W <= 0 || H <= 0 || this.cols <= 0) return;

    ctx.clearRect(0, 0, W, H);

    const c = this.cellPx;
    const r = c * 0.16;

    // 底板（与 canvas 的 CSS 底色一致，避免尺寸变化时闪一下另一种颜色）
    ctx.fillStyle = BASE;
    ctx.fillRect(0, 0, W, H);

    // 空格井：比底板更暗一点，带极淡描边
    const total = this.cols * this.rows;
    ctx.fillStyle = WELL;
    for (let cell = 0; cell < total; cell++) {
      const { x, y } = this.px(cell);
      roundRect(ctx, x, y, c, c, r);
      ctx.fill();
    }
    if (c > 26) {
      ctx.strokeStyle = "rgba(255,255,255,.05)";
      ctx.lineWidth = 1;
      for (let cell = 0; cell < total; cell++) {
        const { x, y } = this.px(cell);
        roundRect(ctx, x + 0.5, y + 0.5, c - 1, c - 1, r);
        ctx.stroke();
      }
    }

    // 发光选框：画在格子**外圈**（外扩 10%），这样它不会被活细胞的白块盖住
    ctx.save();
    for (const [cell, v] of this.visuals) {
      if (v.glow < 0.02) continue;
      const { x, y } = this.px(cell);
      const out = c * 0.1;
      ctx.globalAlpha = Math.min(1, v.glow);
      ctx.strokeStyle = v.glowColor;
      ctx.shadowColor = v.glowColor;
      ctx.shadowBlur = c * 0.75;
      ctx.lineWidth = Math.max(1.5, c * 0.07);
      roundRect(ctx, x - out, y - out, c + out * 2, c + out * 2, r + out);
      ctx.stroke();
    }
    ctx.restore();

    // 活细胞
    ctx.save();
    ctx.fillStyle = LIVE;
    ctx.shadowColor = LIVE_GLOW;
    ctx.shadowBlur = c * 0.28;
    for (const [cell, v] of this.visuals) {
      if (v.alpha < 0.02) continue;
      const w = c * v.scale;
      if (w <= 0.5) continue;
      const { x, y } = this.px(cell);
      ctx.globalAlpha = Math.min(1, v.alpha);
      roundRect(ctx, x + (c - w) / 2, y + (c - w) / 2, w, w, r * v.scale);
      ctx.fill();
    }
    ctx.restore();

    // 落子粒子，画在最上层
    if (this.particles.length) {
      ctx.save();
      for (const p of this.particles) {
        const t = p.age / p.ttl;
        const rad = Math.max(0.5, this.cellPx * p.size * particleShrink(t) * 0.5);
        const { x, y } = this.pxFrac(p.x, p.y);
        ctx.globalAlpha = particleAlpha(t) * 0.95;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = rad * 2.2;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
}
