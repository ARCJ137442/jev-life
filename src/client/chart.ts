/**
 * 侧栏三张图。它们的分工**不是**「三张图」，而是两个视角：
 *
 *   ① 置信度面积图（`ConfidenceChart`）—— **模型**的时间序列
 *   ③ 决策热力图（`HeatChart`）        —— **模型**的当回合空间分布
 *   ② 生死态势图（`MomentumChart`）    —— **游戏**的时间序列
 *
 * ① 与 ③ 都在说模型，区别只在时间维度（「历来」与「此刻」）；② 说的是游戏本身，
 * 与模型无关。把 ①③ 当成同类、② 当成另一类，是读这三张图的前提。
 *
 * ═══ ① 置信度：每个回合三个标量 ═══
 *
 *   上界 = 最高概率   下界 = 最低概率   中线 = 中位概率
 * 上下界之间的带状面积表达「这一手有多分散」，中线标出中位走势。带状越窄 →
 * Jev 越笃定。双人对弈时两组画进同一张图：生之执绿、死之执红，
 * **两块面积的交集渲染成黄色**（两个模型都很笃定的地方）。
 *
 * ═══ 一个刻意保留的细节 ═══
 *
 * DPR 夹到 2.5 且**按实际像素尺寸写入 canvas.width/height**，而不是把 CSS 尺寸
 * 直接当像素尺寸用。这是源仓库踩出来的：不夹 DPR 时 4K 屏上一次 resize 会
 * 分配 8000×8000 的位图，滚动肉眼可见地卡。
 */
import type { Board, Cell, Role } from "../core/types.js";
import { t } from "./i18n.js";

/**
 * 角色的主题色。**高饱和** —— 它们要在一张近黑的棋盘上「亮」起来。
 *
 * 住在这里而不是装配层：它有**三个**消费者（记分板与日志的元数据、棋盘渲染器
 * 的落子选框与粒子、侧栏两张图的界限与底色），而这三处都要 import 本模块 ——
 * 放这里谁也不用反向依赖谁。更实际的一层理由：`ratioColor` 的两端就是这两个色，
 * 放在同一个模块里，那条「折线顶端必须与它旁边的界限线同色」的约束才**测得出来**
 * （见 `charts.test.ts`），而不是只在注释里写着。
 *
 * 饱和度是用户看着实物调过一轮的：早先是 #4ade80 / #f87171（偏粉彩），
 * 在深色棋盘上那圈发光选框不够「跳」，而它还要靠颜色去区分是谁落的子。
 * 与 index.html 的 `--green` / `--red` 必须一致 —— 那里画的是图例圆点，
 * 与画布上的曲线挨在一起，差一点都看得出来。
 */
export const ROLE_COLOR: Record<Role, string> = { life: "#22ff88", death: "#ff4d4d" };

const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 10;
const PAD_B = 12;

/** DPR 上限 —— 见文件头 */
export const MAX_DPR = 2.5;

/**
 * 交集区的填色（规格里的「黄」）。
 *
 * 它是**图表语义**而不是角色色，所以不跟着 `ROLE_META` 走 —— 绿/红是「谁」，
 * 黄是「两个人都在这里」，它与 CSS 的 `--yellow` 是同一个色。
 */
const OVERLAP_FILL = "rgba(251,191,36,.42)";

/** 把 `#rrggbb` 变成等价的 `rgba()`。热力图靠它把「概率」压进不透明度 */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex; // 认不出来就原样用 —— 总比画不出来强
  const n = parseInt(m[1], 16);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface ChartPoint {
  /** 最高概率 */
  readonly top: number;
  /** 最低概率 */
  readonly bottom: number;
  /** 中位概率 */
  readonly median: number;
}

export interface ChartSeries {
  /** 中位线与末点的颜色 */
  readonly stroke: string;
  /** 带状面积渐变的上下两端（rgba 字符串） */
  readonly fillFrom: string;
  readonly fillTo: string;
  readonly points: readonly ChartPoint[];
}

/**
 * 按 CSS 尺寸 + 当前 DPR 调整一块画布，返回已经 setTransform 好的 2D 上下文。
 *
 * 三张图共用：一块 0×0 或没设 DPR 的画布，接上绘图代码之后看到的第一眼
 * 永远是「糊的」，而那时人会去怀疑绘图代码。
 */
export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssW: number,
  cssH: number,
): CanvasRenderingContext2D | null {
  if (cssW <= 0 || cssH <= 0) return null;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/* ══════════════════════════════════════════════════════════════
   ① 置信度面积图
   ══════════════════════════════════════════════════════════════ */

/** 两条带状面积的交集在横轴上的连续区间（**按下标对齐**，闭区间） */
export interface BandOverlap {
  readonly from: number;
  readonly to: number;
}

/**
 * 求两条带的交集区间。
 *
 * 带在横轴下标 i 处的宽度是 `[bottom, top]`；两条带的交集是
 * `[max(bottomA,bottomB), min(topA,topB)]`，它非空的下标连成的每一段就是一个
 * 区间。「两块面积的交集渲染成黄色」靠的就是它。
 *
 * 两条序列**按下标对齐**：它们来自同一批回合，第 i 个点说的是同一手。
 * 长度不一致时只比到较短的那条 —— 宁可少画一段，也不要错位。
 */
export function bandOverlap(
  a: readonly ChartPoint[],
  b: readonly ChartPoint[],
): BandOverlap[] {
  const n = Math.min(a.length, b.length);
  const out: BandOverlap[] = [];
  let from = -1;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(a[i].bottom, b[i].bottom);
    const hi = Math.min(a[i].top, b[i].top);
    if (hi > lo) {
      if (from < 0) from = i;
    } else if (from >= 0) {
      out.push({ from, to: i - 1 });
      from = -1;
    }
  }
  if (from >= 0) out.push({ from, to: n - 1 });
  return out;
}

export class ConfidenceChart {
  private w = 0;
  private h = 0;
  private dpr = 1;
  private series: ChartSeries[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.draw();
  }

  setData(series: ChartSeries[]): void {
    this.series = series;
    this.draw();
  }

  clear(): void {
    this.series = [];
    this.draw();
  }

  /**
   * 只重绘，不动数据。
   *
   * 画布上的文案（如「等待对局数据」）是绘制那一刻写死的，切换界面语言后
   * 不重绘就会一直停在旧语言。`clear()` 不能用 —— 它会把曲线一起清掉。
   */
  redraw(): void {
    this.draw();
  }

  private draw(): void {
    const ctx = fitCanvas(this.canvas, this.w, this.h);
    if (!ctx) return;

    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);

    const plotW = w - PAD_L - PAD_R;
    const plotH = h - PAD_T - PAD_B;
    if (plotW <= 4 || plotH <= 4) return;

    const yOf = (v: number): number => PAD_T + (1 - Math.max(0, Math.min(1, v))) * plotH;

    // 网格：0 / 0.5 / 1
    ctx.strokeStyle = "rgba(255,255,255,.06)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    for (const g of [0, 0.5, 1]) {
      const y = Math.round(yOf(g)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(w - PAD_R, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(255,255,255,.28)";
    ctx.font = '9px ui-monospace, Menlo, monospace';
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    // ★ 轴标签也用**整数百分比**（用户 2026-09-21 定）：纵轴是概率 0~1，
    // 而 `1.0` / `0.0` 里的「.0」是纯冗余 —— 与态势图那两条界限线同一条口径
    ctx.fillText("100%", PAD_L + 1, PAD_T + 0.5);
    ctx.textBaseline = "bottom";
    ctx.fillText("0%", PAD_L + 1, h - PAD_B - 0.5);

    // 至少要有一条**画得出线**的序列才算有数据：一条只有 1 个点的序列
    // 画出来是一个点，而「等待对局数据」才是这一屏真正想说的话
    const visible = this.series.filter((s) => s.points.length >= 2);
    if (visible.length === 0) {
      ctx.fillStyle = "rgba(255,255,255,.22)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(t("chart.conf.waiting"), w / 2, h / 2);
      return;
    }

    // 三层，顺序不能反：先两条带 → 再交集（盖在带上）→ 最后折线与点
    for (const s of visible) this.drawBand(ctx, s, plotW, plotH, yOf);
    if (visible.length >= 2) this.drawOverlap(ctx, visible[0], visible[1], plotW, yOf);
    for (const s of visible) this.drawLine(ctx, s, plotW, yOf);
  }

  /** 序列第 i 个点的横坐标。单点序列居中（它画不出线，但位置要确定） */
  private xOf(i: number, n: number, plotW: number): number {
    return n === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW;
  }

  private drawBand(
    ctx: CanvasRenderingContext2D,
    s: ChartSeries,
    plotW: number,
    plotH: number,
    yOf: (v: number) => number,
  ): void {
    const d = s.points;
    const n = d.length;

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = this.xOf(i, n, plotW);
      const y = yOf(d[i].top);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(this.xOf(i, n, plotW), yOf(d[i].bottom));
    ctx.closePath();

    const band = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
    band.addColorStop(0, s.fillFrom);
    band.addColorStop(1, s.fillTo);
    ctx.fillStyle = band;
    ctx.fill();
  }

  /**
   * 交集区：两条带的**共同**部分，填黄。
   *
   * 每个区间的多边形 = 交集上界正向 + 交集下界反向闭合。两条带都画完再画它，
   * 否则先画的那条带会把它盖掉一半。
   */
  private drawOverlap(
    ctx: CanvasRenderingContext2D,
    a: ChartSeries,
    b: ChartSeries,
    plotW: number,
    yOf: (v: number) => number,
  ): void {
    // 点数不等 = 两边的回合对不上号，同一个下标在两条带上是**两个不同的横坐标**，
    // 那时「交集」根本没有定义（按哪条带的横轴画都是错的）。宁可不画。
    // 正常情况下两条序列来自同一批回合，长度必然相等。
    const n = a.points.length;
    if (n !== b.points.length) return;

    const runs = bandOverlap(a.points, b.points);
    if (!runs.length) return;

    ctx.fillStyle = OVERLAP_FILL;
    for (const run of runs) {
      ctx.beginPath();
      for (let i = run.from; i <= run.to; i++) {
        const y = yOf(Math.min(a.points[i].top, b.points[i].top));
        const x = this.xOf(i, n, plotW);
        i === run.from ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let i = run.to; i >= run.from; i--) {
        ctx.lineTo(this.xOf(i, n, plotW), yOf(Math.max(a.points[i].bottom, b.points[i].bottom)));
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawLine(
    ctx: CanvasRenderingContext2D,
    s: ChartSeries,
    plotW: number,
    yOf: (v: number) => number,
  ): void {
    const d = s.points;
    const n = d.length;

    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = this.xOf(i, n, plotW);
      const y = yOf(d[i].median);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = s.stroke;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    ctx.stroke();

    // 数据点（点多时抽稀，避免糊成一片）
    const step = n > 48 ? Math.ceil(n / 48) : 1;
    ctx.fillStyle = s.stroke;
    for (let i = 0; i < n; i += step) {
      ctx.beginPath();
      ctx.arc(this.xOf(i, n, plotW), yOf(d[i].median), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // 末点强调
    const lx = this.xOf(n - 1, n, plotW);
    const ly = yOf(d[n - 1].median);
    ctx.beginPath();
    ctx.arc(lx, ly, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = "#e8fbff";
    ctx.fill();
  }
}

/* ══════════════════════════════════════════════════════════════
   ② 生死态势图
   ══════════════════════════════════════════════════════════════ */

/** 与 `GameRules` 里判定胜负有关的三个数。这里只要这三个，不整份 rules */
export interface MomentumRules {
  readonly lifeWinRatio: number;
  readonly deathWinRatio: number;
}

export interface MomentumInput {
  /**
   * 活细胞占比的序列。**索引 0 = 开局**，索引 i = 第 i 回合演化之后。
   *
   * 与 `classifyTermination` 用的是同一条序列（`[...ratioHistory, 当前占比]`）——
   * 这不是巧合：图上的越界计数必须与判负用的防抖计数是同一个数，否则会出现
   * 「图上显示连续 3 轮越界、却还没判胜」这种谁也说不清的画面。
   */
  readonly ratios: readonly number[];
  readonly rules: MomentumRules;
}

export interface MomentumBounds {
  /** 末尾连续 ≥ lifeWinRatio 的轮数 */
  readonly lifeRun: number;
  /** 末尾连续 ≤ deathWinRatio 的轮数 */
  readonly deathRun: number;
  /** 当前落在了哪条线外。null = 两条线之间 */
  readonly over: Role | null;
}

/** 末尾连续满足谓词的个数。防抖判定的全部内容就是它 */
export function trailingRun(
  series: readonly number[],
  pred: (v: number) => boolean,
): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0 && pred(series[i]); i--) n++;
  return n;
}

/** 当前越界状态。与 `core/life.ts` 的防抖判定**必须同源**，见 `MomentumInput.ratios` */
export function momentumBounds(
  ratios: readonly number[],
  rules: MomentumRules,
): MomentumBounds {
  const lifeRun = trailingRun(ratios, (v) => v >= rules.lifeWinRatio);
  const deathRun = trailingRun(ratios, (v) => v <= rules.deathWinRatio);
  return { lifeRun, deathRun, over: lifeRun > 0 ? "life" : deathRun > 0 ? "death" : null };
}

/**
 * 折线在 0→1 上的配色停点。低红、中黄、高绿 —— 与规格「上生绿、下死红」同向。
 *
 * 两端的红与绿就是 `ROLE_COLOR`（写在下面而不是抄一遍色值，理由见那边的注释），
 * 黄是「中段」这个图表语义自己的颜色、不属于任何角色。
 */
const RATIO_STOPS: ReadonlyArray<{ at: number; rgb: readonly [number, number, number] }> = [
  { at: 0, rgb: hexToRgb(ROLE_COLOR.death) },
  { at: 0.5, rgb: [251, 191, 36] },
  { at: 1, rgb: hexToRgb(ROLE_COLOR.life) },
];

/** `#rrggbb` → 三元组。认不出来时给黑色 —— 宁可画错颜色，也不要让整张图消失 */
function hexToRgb(hex: string): readonly [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 占比 → 颜色。
 *
 * 折线的描边不是单色而是**随高度渐变**的：低处红、中段黄、高处绿。
 * canvas 的线性渐变在停点之间就是线性插值，所以只要停点取这里的三个端点，
 * 渐变画出来的颜色与这个函数逐点一致。
 */
export function ratioColor(v: number): string {
  const x = Math.max(0, Math.min(1, v));
  let lo = RATIO_STOPS[0];
  let hi = RATIO_STOPS[RATIO_STOPS.length - 1];
  for (let i = 1; i < RATIO_STOPS.length; i++) {
    if (x <= RATIO_STOPS[i].at) {
      lo = RATIO_STOPS[i - 1];
      hi = RATIO_STOPS[i];
      break;
    }
  }
  const span = hi.at - lo.at;
  const k = span <= 0 ? 0 : (x - lo.at) / span;
  const r = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * k);
  const g = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * k);
  const b = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * k);
  return `rgb(${r},${g},${b})`;
}

/** 一段「折线与中线之间」的面积。`pts` 的 `i` 可以是小数（穿越点） */
export interface AreaRun {
  /** true = 在中线**以上**（填绿），false = 以下（填红） */
  readonly above: boolean;
  readonly pts: ReadonlyArray<{ readonly i: number; readonly v: number }>;
}

/**
 * 把折线与中线的夹角拆成一串单侧区域。
 *
 * 折线穿过中线时必须在**交点**处断开，否则一段面积会同时跨两侧，
 * 只能整个填成一种颜色 —— 那就是「一半错」。交点用线性插值求，因此 `i` 是小数。
 */
export function splitArea(ratios: readonly number[], mid: number): AreaRun[] {
  const runs: AreaRun[] = [];
  let cur: { above: boolean; pts: Array<{ i: number; v: number }> } | null = null;

  for (let i = 0; i < ratios.length; i++) {
    const v = ratios[i];
    const above = v >= mid;
    if (!cur) {
      cur = { above, pts: [{ i, v }] };
      continue;
    }
    if (above === cur.above) {
      cur.pts.push({ i, v });
      continue;
    }
    // 与上一个点在相反的一侧 → 在区间内穿过中线
    const prev = ratios[i - 1];
    const t = prev === v ? 0 : (mid - prev) / (v - prev);
    const x = i - 1 + Math.max(0, Math.min(1, t));
    cur.pts.push({ i: x, v: mid });
    runs.push(cur);
    cur = { above, pts: [{ i: x, v: mid }, { i, v }] };
  }
  if (cur) runs.push(cur);
  return runs;
}

const MOM_THRESHOLD_DASH: number[] = [3, 3];

/**
 * 生死态势图的内边距：**上下与左右相同**（用户实测后定，见 ui-spec 第四节）。
 *
 * 单独一组常量而不是复用 `PAD_T`/`PAD_B`：那两个值（10 / 12）是给置信度
 * 面积图留「1.0 / 0.0」轴标签用的，而生死态势图不画轴标签 —— 它需要在
 * 纵向**省出空间**，而侧栏的高度正是稀缺资源。
 */
const MOM_PAD_X = 4;
const MOM_PAD_Y = 4;

/**
 * 折线以下（活细胞份额）与以上（死细胞份额）的填充色。
 *
 * ⚠ **方向容易读反，这里记一笔**：纵轴是下 0 上 1，所以「折线以上」是
 * `1 − 占比`，也就是**死细胞**的份额。用户的原话是「边界上边是绿色区域」，
 * 而图形语义要求的是「线以下填绿」—— 两者在文字上对不上，最后是
 * 做出预览图让他挑才定下来的。规格里也订正过一次。
 *
 * 定下来的口径：**占比越高、绿越大** —— 绿看着变大就是生之执在赢。
 */
const MOM_FILL_LIFE = "rgba(74,222,128,.20)";
const MOM_FILL_DEATH = "rgba(248,113,113,.20)";

export class MomentumChart {
  private w = 0;
  private h = 0;
  private dpr = 1;
  private data: MomentumInput | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** 角色色由装配层给，理由同 `BoardRenderer` */
    private readonly palette: Record<Role, string>,
  ) {}

  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.draw();
  }

  setData(data: MomentumInput): void {
    this.data = data;
    this.draw();
  }

  clear(): void {
    this.data = null;
    this.draw();
  }

  redraw(): void {
    this.draw();
  }

  private draw(): void {
    const ctx = fitCanvas(this.canvas, this.w, this.h);
    if (!ctx) return;

    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);

    const plotW = w - MOM_PAD_X * 2;
    const plotH = h - MOM_PAD_Y * 2;
    if (plotW <= 4 || plotH <= 4) return;

    // 纵轴 0 在下、1 在上
    const yOf = (v: number): number => MOM_PAD_Y + (1 - Math.max(0, Math.min(1, v))) * plotH;

    const d = this.data;
    const n = d ? d.ratios.length : 0;
    if (!d || n === 0) {
      ctx.fillStyle = "rgba(255,255,255,.22)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(t("chart.mom.waiting"), w / 2, h / 2);
      return;
    }

    const rules = d.rules;
    const xOf = (i: number): number => (n === 1 ? MOM_PAD_X : MOM_PAD_X + (i / (n - 1)) * plotW);

    /* ── ★ 折线**就是国界线** ──
       线以下填绿（活细胞份额）、线以上填红（死细胞份额），**各填到画布边缘**。

       早先填的是「折线与 0.5 中线之间」，颜色按曲线在中线的哪一侧定。那个画法
       只在曲线穿过中线时才变色，**推拉的动感全丢了**（用户实测后指出）。现在
       两个区域此消彼长：地盘大了绿区就厚、小了就薄，一眼看出谁在推谁在退。
       0.5 中线仍然画，但它降级成**背景参照**，不再决定填色。

       两段面积各自**连续**，不需要像 `splitArea` 那样在穿越点断开：折线是
       单值函数，线以上与线以下各是一块连通区域，不存在「一段同时跨两侧」。
       （`splitArea` 仍然保留 —— 它服务的是「折线与某条水平线之间的差量」这个
        另一种语义，两者不可互换。）

       ⚠ 填色方向按 `MOM_FILL_LIFE` 那段注释的口径，**别照文字方位猜**。

       画在三条水平线**之前**：线要被压在上面才看得清 —— 否则中线与两条界限
       虚线会被整片色块糊掉，而那三条线是判读「离赢多远」的全部依据。 */
    if (n >= 2) {
      const area = (toY: number, color: string): void => {
        ctx.beginPath();
        ctx.moveTo(xOf(0), yOf(d.ratios[0]));
        for (let i = 1; i < n; i++) ctx.lineTo(xOf(i), yOf(d.ratios[i]));
        ctx.lineTo(xOf(n - 1), toY);
        ctx.lineTo(xOf(0), toY);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      area(yOf(0), MOM_FILL_LIFE);  // 线下：活细胞份额（占比越高，绿越大）
      area(yOf(1), MOM_FILL_DEATH); // 线上：死细胞份额
    }

    // 三条水平元素：两条胜负界限 + 一条 0.5 中线
    this.thresholdLine(ctx, w, yOf(rules.lifeWinRatio), this.palette.life, rules.lifeWinRatio);
    this.thresholdLine(ctx, w, yOf(0.5), "rgba(255,255,255,.24)", 0.5);
    this.thresholdLine(ctx, w, yOf(rules.deathWinRatio), this.palette.death, rules.deathWinRatio);

    // 实际值折线：描边随高度渐变（低红 → 中黄 → 高绿）
    if (n >= 2) {
      const grad = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
      grad.addColorStop(0, ratioColor(1));
      grad.addColorStop(0.5, ratioColor(0.5));
      grad.addColorStop(1, ratioColor(0));
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xOf(i);
        const y = yOf(d.ratios[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    // 线头：越界时画一个带计数的圆点，没越界就画一个中性小点
    const headX = xOf(n - 1);
    const headY = yOf(d.ratios[n - 1]);
    const b = momentumBounds(d.ratios, rules);
    if (b.over) {
      const run = b.over === "life" ? b.lifeRun : b.deathRun;
      ctx.beginPath();
      ctx.arc(headX - 5.5, headY, 8.5, 0, Math.PI * 2);
      ctx.fillStyle = this.palette[b.over];
      ctx.fill();
      ctx.fillStyle = "#0a1014";
      ctx.font = "700 10px ui-monospace, Menlo, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(run), headX - 5.5, headY + 0.5);
    } else {
      ctx.beginPath();
      ctx.arc(headX, headY, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = "#e8fbff";
      ctx.fill();
    }
  }

  /** 一条水平界限线 + 左端的数值标签。bounds 是数，标签帮人把线跟具体阈值对上 */
  private thresholdLine(
    ctx: CanvasRenderingContext2D,
    w: number,
    y: number,
    color: string,
    value: number,
  ): void {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(MOM_THRESHOLD_DASH);
    ctx.beginPath();
    ctx.moveTo(MOM_PAD_X, Math.round(y) + 0.5);
    ctx.lineTo(w - MOM_PAD_X, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.75;
    ctx.font = "8px ui-monospace, Menlo, monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    // ★ **整数百分比**（用户 2026-09-21 定）：`0.60` 里的「0.」是纯冗余 ——
    // 这条线的语义本来就是「活细胞占几成」，而 `60%` 是它的直接读法。
    // 取整而不是 `toFixed(1)`：阈值本身就是拿来试的整数百分比
    // （界面上的输入框也只收整数），标出 `5.0%` 只会多一个没信息的小数位
    ctx.fillText(`${Math.round(value * 100)}%`, MOM_PAD_X + 2, y - 1);
    ctx.globalAlpha = 1;
  }
}

/* ══════════════════════════════════════════════════════════════
   ③ 决策热力图
   ══════════════════════════════════════════════════════════════ */

/** 热力图每格的归属。用数字而不是字符串：它是**逐格**的，字符串数组既费内存又费比较 */
export const HEAT_ROLE_LIFE = 0;
export const HEAT_ROLE_DEATH = 1;

/** 概率最低那一格也要看得见 —— 否则「每一格都有值」在画面上会变成一片黑 */
const HEAT_MIN_ALPHA = 0.07;

export type RoleProbs = Record<Role, ReadonlyMap<Cell, number> | null>;

export interface HeatData {
  readonly cols: number;
  readonly rows: number;
  /** 每格的概率，已按全局最大值归一化到 [0,1]。长度 cols*rows，索引 r*cols+c */
  readonly values: Float32Array;
  /** 每格的归属，取值 `HEAT_ROLE_LIFE` / `HEAT_ROLE_DEATH` */
  readonly roles: Uint8Array;
  /** 归一化前的最大概率。图上不显示，留给调用方判断「这一手是不是全都很小」 */
  readonly peak: number;
}

/**
 * 把两个角色**各自**的概率分布合成一张与棋盘同形的热力图。
 *
 * 这里有一条很干净的性质可以依赖：
 *
 * > 棋盘上每一格，**恰好属于一个角色的候选集** —— 死格是生之执的候选，
 * > 活格是死之执的候选。
 *
 * 所以两个角色把 N² 个格子完整瓜分，热力图上**每一格都有值、没有空隙、
 * 也不重叠**。函数因此不需要「这一个格子该用谁的分布」这个判断之外的任何逻辑：
 * 归属由棋盘本身决定。
 *
 * 归一化用**全局最大值**而不是固定刻度：Jev 的绝对概率常常在 0.01 量级，
 * 按绝对刻度画出来是一张全黑的图，那等于没画。
 */
export function buildHeat(board: Board, probs: RoleProbs): HeatData {
  const n = board.cells.length;
  const values = new Float32Array(n);
  const roles = new Uint8Array(n);
  let peak = 0;

  for (let i = 0; i < n; i++) {
    const role: Role = board.cells[i] ? "death" : "life";
    roles[i] = board.cells[i] ? HEAT_ROLE_DEATH : HEAT_ROLE_LIFE;
    const p = probs[role]?.get(i) ?? 0;
    values[i] = p;
    if (p > peak) peak = p;
  }

  if (peak > 0) {
    for (let i = 0; i < n; i++) values[i] /= peak;
  }
  return { cols: board.cols, rows: board.rows, values, roles, peak };
}

export class HeatChart {
  private w = 0;
  private h = 0;
  private dpr = 1;
  private data: HeatData | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly palette: Record<Role, string>,
  ) {}

  resize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.draw();
  }

  setData(data: HeatData): void {
    this.data = data;
    this.draw();
  }

  clear(): void {
    this.data = null;
    this.draw();
  }

  redraw(): void {
    this.draw();
  }

  private draw(): void {
    const ctx = fitCanvas(this.canvas, this.w, this.h);
    if (!ctx) return;

    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);

    const d = this.data;
    if (!d || d.cols <= 0 || d.values.length === 0) {
      ctx.fillStyle = "rgba(255,255,255,.22)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillText(t("chart.heat.waiting"), w / 2, h / 2);
      return;
    }

    // 格子取正方形，边长由**宽高两个约束共同**决定（长宽可以不一样 ——
    // 用户要的尺寸是各自 2~16）。整张网格在画布里居中：非方形棋盘时，
    // 贴边会让它看起来像被裁掉了一块
    const step = Math.min(w / d.cols, h / d.rows);
    if (!(step > 0)) return;
    const gap = step * 0.12;
    const r = Math.max(1, step * 0.18);
    const ox = (w - step * d.cols) / 2;
    const oy = (h - step * d.rows) / 2;

    for (let i = 0; i < d.values.length; i++) {
      const x = ox + (i % d.cols) * step + gap / 2;
      const y = oy + Math.floor(i / d.cols) * step + gap / 2;
      // 亮度/不透明度表达概率：最低也留一点底色，格子才连成一张网格而不是散点
      const a = HEAT_MIN_ALPHA + d.values[i] * (1 - HEAT_MIN_ALPHA);
      ctx.fillStyle = withAlpha(
        d.roles[i] === HEAT_ROLE_DEATH ? this.palette.death : this.palette.life,
        a,
      );
      const s = step - gap;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + s, y, x + s, y + s, r);
      ctx.arcTo(x + s, y + s, x, y + s, r);
      ctx.arcTo(x, y + s, x, y, r);
      ctx.arcTo(x, y, x + s, y, r);
      ctx.closePath();
      ctx.fill();
    }
  }
}
