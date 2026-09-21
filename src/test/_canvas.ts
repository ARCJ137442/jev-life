/**
 * 测试用的假画布。**不是测试文件**（`node --test` 只跑 `*.test.js`）。
 *
 * 无头环境里没有 canvas，所以「画像素」这件事没法验证 —— 但**画得出异常**。
 * 一个只记录调用的假上下文能抓住的，正是这一层最要命的错误：拼错的字段、
 * 越界的坐标、漏掉的判空、空数据没提前返回。它们在浏览器里的症状是
 * 「棋盘空白」，而那与真正的原因毫无关联（CLAUDE.md 红线 2 记着这个坑）。
 *
 * 它验证不了配色与布局 —— 那两项只能靠人眼，报告里要如实说。
 */

export interface FakeCtx {
  /** 一帧的序号，`clearRect` 时加一 —— 用它只看「最后一帧」画了什么 */
  frame: number;
  /** 圆点（粒子、线头）。`color` 是调用时的 fillStyle */
  arcCalls: Array<{ x: number; y: number; r: number; color: string; frame: number }>;
  /** 每次 stroke() 时的 strokeStyle。**空格井也会描边**，所以按颜色判而不是数次数 */
  strokes: string[];
  /** 每次 fill() 时的填充色与不透明度 */
  fills: Array<{ color: string; alpha: number; frame: number }>;
  /** 每次 fillText() 写下的文本（「等待对局数据」、越界轮数、阈值标签…） */
  texts: string[];
  [k: string]: unknown;
}

export function fakeCanvas(): { canvas: HTMLCanvasElement; ctx: FakeCtx } {
  const ctx: FakeCtx = {
    frame: 0,
    arcCalls: [],
    strokes: [],
    fills: [],
    texts: [],
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    shadowColor: "",
    shadowBlur: 0,
    lineWidth: 1,
    lineJoin: "miter",
    font: "",
    textAlign: "left",
    textBaseline: "top",
    clearRect: () => {
      ctx.frame++;
    },
    fillRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arcTo: () => {},
    arc: (x: number, y: number, r: number) => {
      ctx.arcCalls.push({ x, y, r, color: String(ctx.fillStyle), frame: ctx.frame });
    },
    fill: () => {
      ctx.fills.push({
        color: String(ctx.fillStyle),
        alpha: Number(ctx.globalAlpha),
        frame: ctx.frame,
      });
    },
    stroke: () => {
      ctx.strokes.push(String(ctx.strokeStyle));
    },
    save: () => {},
    restore: () => {},
    setLineDash: () => {},
    setTransform: () => {},
    fillText: (s: string) => {
      ctx.texts.push(String(s));
    },
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  const el = { width: 0, height: 0, style: {}, getContext: () => ctx };
  return { canvas: el as unknown as HTMLCanvasElement, ctx };
}

/** 最后一帧里，某个填充色 + 不透明度下限的填充次数 */
export function fillsInLastFrame(ctx: FakeCtx, color: string, minAlpha = 0.98): number {
  return ctx.fills.filter((f) => f.frame === ctx.frame && f.color === color && f.alpha > minAlpha)
    .length;
}

/**
 * 把 rAF 换成手动驱动的一帧一帧。
 *
 * 这样「空闲时把循环停掉」这件事才可以被断言 —— 它是渲染器最容易被写坏的
 * 一处（漏掉就是每帧空转重画），而它在浏览器里只表现为风扇转得快一点。
 */
export function installRaf(): { frame: (ts: number) => boolean } {
  let pending: ((ts: number) => void) | null = null;
  let id = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = (cb: (ts: number) => void): number => {
    pending = cb;
    return ++id;
  };
  g.cancelAnimationFrame = (): void => {
    pending = null;
  };
  // `fitCanvas` / `resize` 都要读它
  g.window = { devicePixelRatio: 1 };
  return {
    frame: (ts: number): boolean => {
      const cb = pending;
      if (!cb) return false;
      pending = null;
      cb(ts);
      return true;
    },
  };
}
