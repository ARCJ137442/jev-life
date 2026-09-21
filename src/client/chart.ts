/**
 * 置信度追踪图（侧栏三张图里的 ①）。
 *
 * 每个回合记录该回合概率分布的三个统计量：
 *   上界 = 最高概率   下界 = 最低概率   中线 = 中位概率
 * 用上下界之间的带状面积表达「这一手有多分散」，中线带点标出中位走势。
 * 带状越窄 → Jev 越笃定。**它是一条时间序列**：横轴是回合。
 *
 * ═══ T14 只搬机制，图上还差两件事（归 T15）═══
 *
 * 1. **双人对弈要两组合并进同一张图**：生之执的面积绿、死之执的红，
 *    两块面积的**交集渲染成黄色**，中值折线各跟随各自的颜色。
 *    这里已经按「多条序列」建模（`setData` 收一个数组），所以 T15 要补的是
 *    交集那层混合，而不是重画这张图。
 * 2. 侧栏另外两张图（② 生死态势、③ 决策热力图）也归 T15。本文件只提供
 *    画布尺寸管理（`fitCanvas`），让它们在 T14 就有正确的 DPR 与像素尺寸 ——
 *    否则 T15 接上去的第一件事会是「图糊了」，而那是尺寸问题不是绘图问题。
 *
 * ═══ 一个刻意保留的细节 ═══
 *
 * DPR 夹到 2.5 且**按实际像素尺寸写入 canvas.width/height**，而不是把 CSS 尺寸
 * 直接当像素尺寸用。这是源仓库踩出来的：不夹 DPR 时 4K 屏上一次 resize 会
 * 分配 8000×8000 的位图，滚动肉眼可见地卡。
 */
import { t } from "./i18n.js";

const PAD_L = 4;
const PAD_R = 4;
const PAD_T = 10;
const PAD_B = 12;

/** DPR 上限 —— 见文件头 */
export const MAX_DPR = 2.5;

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
 * 抽出来是给 T15 的两张图用的：它们现在只是占位，但**尺寸必须是最终尺寸** ——
 * 一块 0×0 或没设 DPR 的画布，接上绘图代码之后看到的第一眼永远是「糊的」，
 * 而那时人会去怀疑绘图代码。
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
    ctx.fillText("1.0", PAD_L + 1, PAD_T + 0.5);
    ctx.textBaseline = "bottom";
    ctx.fillText("0.0", PAD_L + 1, h - PAD_B - 0.5);

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

    for (const s of visible) this.drawSeries(ctx, s, plotW, plotH, yOf);
  }

  private drawSeries(
    ctx: CanvasRenderingContext2D,
    s: ChartSeries,
    plotW: number,
    plotH: number,
    yOf: (v: number) => number,
  ): void {
    const d = s.points;
    const n = d.length;
    const xOf = (i: number): number =>
      n === 1 ? PAD_L + plotW / 2 : PAD_L + (i / (n - 1)) * plotW;

    // 带状：上界 → 下界闭合
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i);
      const y = yOf(d[i].top);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(xOf(i), yOf(d[i].bottom));
    ctx.closePath();

    const band = ctx.createLinearGradient(0, PAD_T, 0, PAD_T + plotH);
    band.addColorStop(0, s.fillFrom);
    band.addColorStop(1, s.fillTo);
    ctx.fillStyle = band;
    ctx.fill();

    // 中位线
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = xOf(i);
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
      ctx.arc(xOf(i), yOf(d[i].median), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    // 末点强调
    const lx = xOf(n - 1);
    const ly = yOf(d[n - 1].median);
    ctx.beginPath();
    ctx.arc(lx, ly, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = "#e8fbff";
    ctx.fill();
  }
}
