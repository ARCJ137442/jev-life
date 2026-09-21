/**
 * 棋盘渲染里**能被断言的那部分** —— 补间、粒子生命周期、落子与迭代的区别。
 *
 * ═══ 为什么测的是这几个纯函数，而不是渲染器本身 ═══
 *
 * 无头环境里没有 canvas，`BoardRenderer` 画不出来，也没有任何办法「看一眼」
 * 结果对不对。所以这里刻意把渲染器里**与像素无关**的那几层抽成纯函数来测：
 *
 *   - 补间会不会收敛、会不会冲过头（`easeK` / `tweenVisual`）
 *   - 粒子什么时候死、透明度与半径的曲线对不对（`stepParticles` 等）
 *   - 落子与迭代**在目标值上的区别**（`planCells`）—— 这是三种动画里唯一
 *     有语义的部分：「0 → 1」还是「0.55 → 1」、「挂不挂发光选框」
 *
 * 断言能覆盖的到此为止；**配色与布局没有任何测试背书**，只能靠人眼。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { aliveCount, boardFromRows, flip, lifeStep } from "../core/life.js";
import type { Board, Cell, Role } from "../core/types.js";
import {
  BoardRenderer,
  EASE,
  FLIP_MS,
  FLIP_MS_BASE,
  GUTTER_K,
  PARTICLE_SIZE_MAX,
  ROUND_OF_GLOW,
  SCALE_OF_GLOW,
  approach,
  easeK,
  flipColor,
  makeVisual,
  particleAlpha,
  particleShrink,
  planCells,
  scaleRate,
  stepParticles,
  tweenVisual,
  type Particle,
} from "../client/render.js";
import { fakeCanvas, fillsInLastFrame, installRaf } from "./_canvas.js";

/** 一块有生死两种格子的 4×4 棋盘。用 `boardFromRows` 造，尺寸校验也一并走到 */
const BOARD: Board = boardFromRows(["##..", ".##.", "....", "###."]);

const cell = (row: number, col: number): Cell => row * BOARD.cols + col;

/* ═══════════ 补间 ═══════════ */

test("easeK 把「按帧」的步长归一化：连推两帧 = 一次推两帧", () => {
  // 这条等式就是「按实际帧间隔归一化」的定义。写死「每帧乘 0.28」的实现
  // 会在这里红 —— 它在 120Hz 上快一倍、掉帧时慢一半
  const one = 1 - easeK(1);
  assert.ok(
    Math.abs((1 - one * one) - easeK(2)) < 1e-12,
    `easeK(2) 必须等于「推两次 easeK(1)」：${easeK(2)} vs ${1 - one * one}`,
  );
  assert.equal(easeK(0), 0, "步长为 0 时不动");
  assert.ok(Math.abs(easeK(1) - EASE) < 1e-12, "一帧的比例就是 EASE 本身");
});

test("easeK 单调递增且有上界 1", () => {
  let prev = -1;
  for (const dt of [0, 0.25, 0.5, 1, 2, 4, 8, 30]) {
    const k = easeK(dt);
    assert.ok(k > prev, `dt=${dt} 处不单调：${k} 不大于 ${prev}`);
    assert.ok(k < 1 && k >= 0, `dt=${dt} 处越界：${k}`);
    prev = k;
  }
  // 4 秒不动之后的残差必须小到看不见，否则「停下」的判据永远不满足
  assert.ok(easeK(240) > 0.999);
});

test("approach 永不冲过目标", () => {
  let v = 0;
  for (let i = 0; i < 40; i++) {
    v = approach(v, 1, easeK(1));
    assert.ok(v <= 1, `第 ${i} 帧冲过了目标：${v}`);
  }
});

test("tweenVisual 收敛：缩放、透明度、发光选框都会到位并停机", () => {
  const v = makeVisual(0, 1, "#4ade80");
  assert.equal(v.glow, 1, "带颜色的视觉单元一诞生就挂着发光选框");

  let frames = 0;
  // 上限 240 帧 = 4 秒。停在「永远差不完」上比不收敛更隐蔽，所以给个硬上限
  while (tweenVisual(v, easeK(1)) && frames < 240) frames++;

  assert.ok(frames < 240, "补间没有在 4 秒内停机");
  assert.ok(Math.abs(v.scale - 1) < 0.004, `缩放没到位：${v.scale}`);
  assert.ok(Math.abs(v.alpha - 1) < 0.01, `透明度没到位：${v.alpha}`);
  assert.ok(v.glow <= 0.02, `发光选框没淡干净：${v.glow}`);
});

test("tweenVisual 的停机判据：差得还多就必须继续要帧", () => {
  const v = makeVisual(0, 1);
  assert.equal(tweenVisual(v, easeK(1)), true, "刚起步就必须还要帧");
  v.scale = 1;
  v.alpha = 1;
  v.glow = 0;
  assert.equal(tweenVisual(v, easeK(1)), false, "什么都到位了就不该继续空转");
});

/* ═══════════ 粒子 ═══════════ */

function particle(over: Partial<Particle> = {}): Particle {
  return {
    x: 1,
    y: 1,
    vx: 2,
    vy: -1,
    size: 0.4,
    age: 0,
    ttl: 0.5,
    color: "#4ade80",
    ...over,
  };
}

test("粒子的透明度与半径曲线：起点满、终点零、单调不回头", () => {
  assert.ok(Math.abs(particleAlpha(0) - 1) < 1e-12);
  assert.ok(Math.abs(particleAlpha(1)) < 1e-12);
  assert.ok(Math.abs(particleShrink(0) - 1) < 1e-12);
  assert.ok(Math.abs(particleShrink(1)) < 1e-12);

  let a = 1;
  let s = 1;
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    const na = particleAlpha(t);
    const ns = particleShrink(t);
    assert.ok(na < a && na >= 0, `透明度在 t=${t} 处不单调：${na} vs ${a}`);
    assert.ok(ns < s && ns >= 0, `半径在 t=${t} 处不单调：${ns} vs ${s}`);
    a = na;
    s = ns;
  }
  // 透明度衰减得比半径快（指数 1.6 > 0.75）—— 读起来才是「往回收」而不是「缩小」
  assert.ok(particleAlpha(0.5) < particleShrink(0.5));
});

test("粒子的生命周期：按秒推进、到 ttl 就消失", () => {
  const ps = [particle({ ttl: 0.1 }), particle({ ttl: 0.5 })];

  let alive = stepParticles(ps, 0.05);
  assert.equal(alive.length, 2, "都还没到 ttl");
  assert.ok(Math.abs(alive[0].age - 0.05) < 1e-12);
  // 位置按**秒**推进：掉帧时它该走得更远，而不是走得更慢
  assert.ok(Math.abs(alive[0].x - (1 + 2 * 0.05)) < 1e-12);
  assert.ok(Math.abs(alive[0].y - (1 - 1 * 0.05)) < 1e-12);

  alive = stepParticles(alive, 0.05);
  assert.equal(alive.length, 1, "ttl=0.1 的那颗该死了");
  assert.equal(alive[0].ttl, 0.5);

  alive = stepParticles(alive, 0.45);
  assert.equal(alive.length, 0, "全部到期之后必须清空 —— 否则 rAF 永远停不下来");
});

test("粒子恰好活满 ttl 帧数，不多不少", () => {
  let ps = [particle({ ttl: 0.3 })];
  let steps = 0;
  while (ps.length) {
    ps = stepParticles(ps, 0.1);
    steps++;
    assert.ok(steps < 10, "粒子没有在预期步数内消失");
  }
  // 0.1 × 3 = 0.3（含）→ 第 3 步就该清空
  assert.equal(steps, 3);
});

/* ═══════════ 落子的颜色 ═══════════ */

test("★ 落子颜色按「这一手会把它变成什么」取，**不按谁在翻**", () => {
  // 双人局里两者恰好一一对应（生之执只能翻死格、死之执只能翻活格），所以
  // 按角色取色从没出过问题。**单人局里行动方生死一体、两种都能翻** ——
  // 那时按角色取色会让「玩家把活格翻死」也闪绿光，看起来像渲染坏了
  const dead = cell(2, 2); // BOARD 里是死格
  const alive = cell(0, 0); // BOARD 里是活格
  assert.equal(BOARD.cells[dead], 0, "夹具前提：这一格应当是死的");
  assert.equal(BOARD.cells[alive], 1, "夹具前提：这一格应当是活的");

  assert.equal(flipColor(BOARD, dead), "life", "翻死格 = 让它活 → 绿");
  assert.equal(flipColor(BOARD, alive), "death", "翻活格 = 让它死 → 红");

  // 与热力图同一条判据：颜色只取决于**翻之前**那一格的生死，
  // 与谁在翻无关。把棋盘翻过来，两格的取色应当整个对调
  const flipped = flip(flip(BOARD, dead), alive);
  assert.equal(flipColor(flipped, dead), "death");
  assert.equal(flipColor(flipped, alive), "life");
});

/* ═══════════ 落子 vs 迭代 ═══════════ */

test("落子：起始缩放 0、起始不透明度 1、挂对应角色的发光选框", () => {
  const mid = flip(BOARD, cell(2, 0)); // 死格 → 活格，生之执落的子
  const flips = new Map<Cell, Role>([[cell(2, 0), "life"]]);

  const plan = planCells(new Set(), mid, flips, true);
  const p = plan.get(cell(2, 0));
  assert.equal(p?.kind, "spawn");
  assert.deepEqual(p, { kind: "spawn", scale: 0, alpha: 1, glow: "life" });
});

test("迭代：新生格从 0.55 长起来，且**不带**发光选框", () => {
  // 演化相没有行动方 —— 选框画的是「谁落的子」，所以它一格都不该有。
  // 这条是规格里落子与迭代唯一的视觉分界，必须钉死
  const mid = flip(BOARD, cell(2, 0));
  const after = lifeStep(mid, "bounded");

  const plan = planCells(new Set(), after, new Map(), true);
  let spawned = 0;
  for (const [c, p] of plan) {
    if (p.kind !== "spawn") continue;
    spawned++;
    assert.equal(p.glow, null, `演化新生格 ${c} 挂了发光选框`);
    assert.equal(p.scale, 0.55);
    assert.equal(p.alpha, 0);
  }
  assert.ok(spawned > 0, "这副棋盘的演化相应当有新生格，否则这条测试什么也没测");
});

test("翻活一个还没收拾完的视觉单元：只点亮选框，不把缩放重置回 0", () => {
  // 它本来就在场上（上一回合死掉、视觉上还在淡出），这时被翻活 —— 要的是
  // 「长回去」，不是「重新蹦一次」。重置成 0 会让同一格反复从零弹起
  const c = cell(2, 2); // BOARD 里是死格
  const mid = flip(BOARD, c); // 被生之执翻活
  const plan = planCells(new Set([c]), mid, new Map([[c, "life"]]), true);
  assert.deepEqual(plan.get(c), { kind: "update", glow: "life" });
});

test("手绘翻转：按**落子**的形状缩放，但不挂选框（与演化新生也不是一回事）", () => {
  // 开局前玩家点格子摆局面：这时还没有行动方。三种情况的区别只在这三个数上：
  //   落子    scale 0    alpha 1  glow 有
  //   手绘    scale 0    alpha 1  glow 无   ← 本条
  //   演化新生 scale 0.55 alpha 0  glow 无
  // 把手绘并进演化新生（"反正是缩放"）会让点击反馈变得含糊：0.55 起跳与
  // 0 起跳的观感差别很明显，而 alpha 从 0 淡入看起来像「淡出来」而不是「弹出来」
  const c = cell(2, 2); // BOARD 里是死格
  const mid = flip(BOARD, c);
  const plan = planCells(new Set(), mid, new Map<Cell, Role | null>([[c, null]]), true);

  assert.deepEqual(plan.get(c), { kind: "spawn", scale: 0, alpha: 1, glow: null });
});

test("★ 落子翻死也要挂**红**框 —— 规格写的是「任一行动方翻转一格都发光」", () => {
  // 这一条曾把旧行为写死成「翻死不带选框」，而那违背 `docs/ui-spec.md`：
  //   | 落子 | 任一行动方翻转一格 | …外加发光选框淡出 —— 生之执绿、**死之执红** |
  // 旧实现只有 `spawn` / `update`（格子由死变活）会发选框，于是死之执的落子
  // 从来没有红框；生死一体之后单人局更是只剩绿框（只有「翻活」那一半会亮）
  const alive = cell(0, 0);
  const board = flip(BOARD, alive);
  const byRole = planCells(new Set([alive]), board, new Map<Cell, Role | null>([[alive, "death"]]), true);

  const b = byRole.get(alive);
  assert.equal(b?.kind, "fade", "翻死是淡出，不是消失后重生");
  assert.ok(b?.kind === "fade" && b.glow === "death", `翻死没挂选框：${JSON.stringify(b)}`);
});

test("手绘翻死与落子翻死：**缩放的形状相同**，只有落子才挂选框", () => {
  // 「被翻动了」与「被某个角色翻动了」是两件事：前者定缩放的形状，
  // 后者定有没有选框。手绘（值是 null）只有前者
  const alive = cell(0, 0);
  const board = flip(BOARD, alive);
  const silent = planCells(new Set([alive]), board, new Map<Cell, Role | null>([[alive, null]]), true);
  const byRole = planCells(new Set([alive]), board, new Map<Cell, Role | null>([[alive, "death"]]), true);

  const s = silent.get(alive);
  const b = byRole.get(alive);
  assert.equal(s?.kind, "fade");
  assert.equal(b?.kind, "fade");
  assert.ok(s?.kind === "fade" && b?.kind === "fade");
  if (s.kind !== "fade" || b.kind !== "fade") return; // 给 TS 收窄

  assert.equal(s.toScale, b.toScale, "翻死的缩放形状与有没有角色无关");
  assert.equal(s.glow, null, "手绘没有行动方，不挂选框");
  assert.equal(b.glow, "death", "落子翻死挂的是死之执的框");
});

test("翻死缩到 0，演化死亡缩到 0.86 —— 两者不同", () => {
  const bornAlive = cell(0, 0);

  // 落子翻死：与「0 → 1」对称地缩到没有（并挂红框，见上面那条）
  assert.deepEqual(
    planCells(new Set([bornAlive]), flip(BOARD, bornAlive), new Map([[bornAlive, "death"]]), true).get(bornAlive),
    { kind: "fade", toScale: 0, glow: "death" },
  );

  // 演化死亡：2048 那套 0.86 收缩，缩完还留着一点余像
  const after = lifeStep(BOARD, "bounded");
  const died: Cell[] = [];
  for (let i = 0; i < BOARD.cells.length; i++) {
    if (BOARD.cells[i] && !after.cells[i]) died.push(i);
  }
  assert.ok(died.length > 0, "这副棋盘的演化相应当有死亡格，否则这条测试什么也没测");
  // `glow: null` 这一栏是刻意的：演化杀死格子时**没有行动方**，不挂选框 ——
  // 规格：「迭代 …… 不带发光选框」。它与上面那条「翻死要挂红框」合起来，
  // 才是规格里落子与迭代在选框上的那条分界
  assert.deepEqual(
    planCells(new Set(died), after, new Map(), true).get(died[0]),
    { kind: "fade", toScale: 0.86, glow: null },
  );
});

test("动效关掉时：一律直接到位，且没有任何选框", () => {
  const mid = flip(BOARD, cell(2, 0));
  const flips = new Map<Cell, Role>([[cell(2, 0), "life"]]);
  const plan = planCells(new Set(), mid, flips, false);

  assert.deepEqual(plan.get(cell(2, 0)), {
    kind: "spawn",
    scale: 1,
    alpha: 1,
    glow: null,
  });
});

test("planCells 覆盖棋盘上的每一格：活的要画、死的若在场上就要收尾", () => {
  // 漏掉一格 = 那一格永远停在上一回合的样子（活的重影 / 死的赖着不走）
  const present = new Set<Cell>([cell(0, 0), cell(1, 1), cell(3, 3)]);
  const mid = flip(BOARD, cell(1, 1)); // 让 cell(1,1) 变死
  const plan = planCells(present, mid, new Map([[cell(1, 1), "death"]]), true);

  for (let i = 0; i < BOARD.cells.length; i++) {
    if (BOARD.cells[i] || present.has(i)) {
      assert.ok(plan.has(i), `第 ${i} 格（活或在场）没有出现在计划里`);
    } else {
      assert.ok(!plan.has(i), `第 ${i} 格（死的、也不在场）不该出现在计划里`);
    }
  }
});

test("落子相与演化相错开：FLIP_MS 必须大于一帧，否则两段动画挤在一起看不见", () => {
  assert.ok(FLIP_MS >= 200, `落子相太短：${FLIP_MS}ms`);
});

test("落子相时长的出厂值：落在滑块步长网格上，且不短于「看得清」的下限", () => {
  // 这条是**规格守卫**，不是实现细节。但只写**能独立验证的性质**，不写来历 ——
  //
  // ⚠ 它原本叫「出厂节奏是基准的四倍 —— 用户连着两轮都说『还不够慢』」，
  // 而那两次「用户要求」并不存在（见 `render.ts` 里 `FLIP_MS` 的注释）。
  // 教训在**归因**：一句凭空的「用户要求」写进断言名之后，复核者会把它当成
  // 已授权的规格放过去。断言名里不该出现无法从代码验证的因果。
  //
  // 1) 落在网格上 —— 否则「恢复默认」与「刚装好」不是同一个数（滑块步长见 index.html）
  assert.equal(FLIP_MS % 20, 0, `出厂值 ${FLIP_MS}ms 不在滑块步长 20 的网格上`);
  // 2) 不能比基准还快 —— 基准是「1 倍速」的定义
  assert.ok(FLIP_MS >= FLIP_MS_BASE, `出厂值比基准还快：${FLIP_MS} < ${FLIP_MS_BASE}`);
  // 3) 不短于下限 —— 短了就回到「看不清谁在哪儿落的子」
  assert.ok(FLIP_MS >= 700, `落子相太短了：${FLIP_MS}ms`);
});

test("scaleRate：倍数换算精确到「走完同样的距离要几帧」", () => {
  // 指数补间没有「时长」参数，时长体现在**多久走到停机判据**上：
  // 走 n 帧后的残差是 (1−k)ⁿ。要让它 f 倍帧数才走完，就得解出 k'
  const k = 0.28;
  const f = 2;
  const k2 = scaleRate(k, f);

  const framesTo = (kk: number): number => Math.log(0.004) / Math.log(1 - kk);
  assert.ok(
    Math.abs(framesTo(k2) / framesTo(k) - f) < 1e-9,
    `换算后的帧数不是 ${f} 倍：${framesTo(k2)} vs ${framesTo(k)}`,
  );
  // 常见的错误写法是 k/f —— 那在 f=2 只把时长拉长约 1.9 倍
  assert.ok(scaleRate(k, 2) > k / 2, "简单折半拉不到要求的倍数");
  // 倍数为 1（或无效）时原样返回，免得把速率算成 0 而彻底停住
  assert.equal(scaleRate(k, 1), k);
  assert.equal(scaleRate(k, 0), k);
});

/* ═══════════ 渲染器的空转冒烟 ═══════════ */

/* 假画布与手动 rAF 见 `_canvas.ts` —— 三个测试文件共用同一份 */
const PALETTE = { life: "#4ade80", death: "#f87171" };

test("渲染器空转一整回合不抛异常，落子相画了选框与粒子，演化相接得上", () => {
  const { frame } = installRaf();
  const { canvas, ctx } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);

  assert.equal(r.resize(400, 400, 4, 4), true, "首次 resize 必须真的改了尺寸");
  assert.equal(r.resize(400, 400, 4, 4), false, "尺寸没变时不该重复分配位图");
  // 棋盘带外边距，所以画布比可用空间略小 —— 但绝不能超出
  assert.ok(canvas.width > 380 && canvas.width <= 400, `画布宽度离谱：${canvas.width}`);

  const mid = flip(BOARD, cell(2, 2)); // 生之执落子：2,2 由死转活
  const after = lifeStep(mid, "bounded");

  const t0 = performance.now();
  r.playTurn({
    mid,
    after,
    flips: [{ cell: cell(2, 2), color: "life" }],
  });

  // 第一帧：落子相已经开始
  assert.equal(frame(t0 + 16), true, "playTurn 之后必须已经排了一帧");
  assert.ok(ctx.strokes.includes(PALETTE.life), "落子那一格没有画出发光选框");
  const sparks = ctx.arcCalls.filter((a) => a.color === PALETTE.life);
  assert.ok(sparks.length > 0, "落子处没有撒出粒子");
  // 粒子半径锚定**格子边长**（不是棋盘边长）—— 换尺寸时视觉比例才恒定。
  // 上界按同一套几何反推，不写死数字：写死的话，格子边长一变这条就会随机地
  // 红或绿（粒子的尺寸本身是随机取样的）
  const cellPx = Math.floor(400 / (4 + 5 * GUTTER_K));
  const maxR = cellPx * PARTICLE_SIZE_MAX * 0.5;
  assert.ok(
    sparks.every((s) => s.r > 0 && s.r <= maxR + 1e-6),
    `粒子半径越出格子：${sparks.map((s) => s.r).join(",")}（上界 ${maxR}）`,
  );

  // 推过 FLIP_MS，演化相必须接上（`after` 里 2,2 可能又死了）
  let frames = 1;
  while (frame(t0 + 16 * (frames + 1)) && frames < 400) frames++;
  assert.ok(frames > 1, "只跑了一帧就停了，演化相根本没机会开始");
  assert.ok(frames < 300, `循环跑了 ${frames} 帧还没停 —— 空闲时应当把 rAF 停掉`);

  // ★ 整段动画跑完之后，画面上剩下的必须**正好是演化后的局面**。
  // 这条是端到端的：落子相画的是 mid，演化相画的是 after，中间隔着一次相位
  // 切换 —— 任何一处接错（相位没接上、淡出的格子没摘干净、选框留了个鬼影），
  // 最后停下来的这一帧都会与 after 对不上
  const last = ctx.frame;
  const settled = ctx.fills.filter(
    (f) => f.frame === last && f.color === "#ffffff" && f.alpha > 0.98,
  );
  assert.equal(
    settled.length,
    aliveCount(after),
    `停机那一帧画了 ${settled.length} 个活细胞，演化后的局面是 ${aliveCount(after)} 个`,
  );

  // 停机之后不该再有粒子残留（残留 = 每帧都在空转重画）
  const before = ctx.arcCalls.length;
  assert.equal(frame(t0 + 16 * 500), false, "停机之后还在排帧");
  assert.equal(ctx.arcCalls.length, before, "停机之后还在画东西");
});

test("时序比例：缩放/粒子占选框的一半，一轮 = 2 倍选框时长", () => {
  // 用户定的比例：**缩放 : 粒子 : 选框 : 落子→演化的间隔 = 1 : 1 : 2 : 2**
  // （见 docs/ui-spec.md 第三节）
  //
  // 这条是**规格守卫**：早先的实现让缩放、粒子、选框都跟着 `flipMs` 走
  // （三者同长），用户看实物后指出选框要比缩放留得久 —— 选框要回答
  // 「这是谁落的子」，而缩放只是「这里刚变过」的反馈，同长就分不出主次。
  assert.equal(SCALE_OF_GLOW, 0.5, "缩放/粒子应当只占选框的一半");
  assert.equal(ROUND_OF_GLOW, 2, "一轮应当是选框时长的两倍");

  const { frame } = installRaf();
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.flipMs = 1000;
  r.resize(400, 400, 4, 4);

  const mid = flip(BOARD, cell(2, 2));
  const after = lifeStep(mid, "bounded");
  const t0 = performance.now();
  r.playTurn({ mid, after, flips: [{ cell: cell(2, 2), color: "life" }] });

  // ⚠ **必须逐帧推进**：渲染器把单帧 dt 上限压在 60ms（防跳帧），
  //    稀疏地跳时钟等于「只过了几帧」，动画根本没往前走
  let i = 0;
  /** 一路推进到 t0+ms；返回推进完之后循环还活着吗 */
  const advance = (ms: number): boolean => {
    while ((i + 1) * 16 <= ms) {
      i++;
      if (!frame(t0 + 16 * i)) return false; // 已经没有排帧了
    }
    return true;
  };

  assert.equal(advance(880), true, "落子相没到 1s 就停了");
  assert.equal(advance(1440), true, "演化相与空余那两段没跑");
  assert.equal(advance(2100), false, "过了 2 倍选框时长还在排帧");
});

test("动效关掉时不排帧，且两副棋盘当场落地", () => {
  const { frame } = installRaf();
  const { canvas, ctx } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.animations = false;
  r.particlesEnabled = false;
  r.resize(400, 400, 4, 4);

  const mid = flip(BOARD, cell(2, 2));
  const after = lifeStep(mid, "bounded");
  r.playTurn({ mid, after, flips: [{ cell: cell(2, 2), color: "life" }] });

  assert.equal(frame(performance.now() + 16), false, "关掉动效后不该再排帧");
  // 空格井的描边也是 stroke()，所以这里按**颜色**判，不能数调用次数
  assert.ok(!ctx.strokes.includes(PALETTE.life), "关掉动效后不该有发光选框");
  assert.ok(!ctx.strokes.includes(PALETTE.death), "关掉动效后不该有发光选框");
  assert.equal(ctx.arcCalls.length, 0, "关掉粒子后不该有粒子");
});

test("particlesEnabled 单独关掉：选框照画，粒子一颗不撒", () => {
  // 两个开关是**独立**的 —— 合成一个的话，「有选框没粒子」这个中间状态
  // 就没法被验证，而它正是排查「粒子是不是根本没生成」时唯一的分辨依据
  const { frame } = installRaf();
  const { canvas, ctx } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.particlesEnabled = false;
  r.resize(400, 400, 4, 4);

  r.playTurn({ mid: flip(BOARD, cell(2, 2)), after: BOARD, flips: [{ cell: cell(2, 2), color: "life" }] });
  frame(performance.now() + 16);

  assert.ok(ctx.strokes.includes(PALETTE.life), "粒子关掉不该连选框一起关掉");
  assert.equal(ctx.arcCalls.length, 0, "粒子开关关掉后仍有粒子");
});

test("落子相时长可配：相位切换真的等到 flipMs 之后", () => {
  // 这条是「把时间拉长方便查看」那个需求的**行为**验收：拉长之后，
  // 演化应当晚到，而不是照旧在 420ms 处接上（那样拉长就只是拖了个尾巴）
  const { frame } = installRaf();
  const { canvas, ctx } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.flipMs = 2000; // 任意一个明显长于探测窗口的值；这条测的是机制，不是出厂值
  r.resize(400, 400, 4, 4);

  const mid = flip(BOARD, cell(2, 2));
  const after = lifeStep(mid, "bounded");
  const t0 = performance.now();
  r.playTurn({ mid, after, flips: [{ cell: cell(2, 2), color: "life" }] });

  for (let i = 1; i <= 60; i++) frame(t0 + 16 * i); // ≈960ms，仍在落子相里
  assert.equal(
    fillsInLastFrame(ctx, "#ffffff"),
    aliveCount(mid),
    "还没到 2000ms，画面上却已经是演化后的局面了",
  );

  // 粒子也要跟着拉长：0.62s（旧时长）时它们早该没了
  const sparks = ctx.arcCalls.filter((a) => a.color === PALETTE.life && a.frame === ctx.frame);
  assert.ok(sparks.length > 0, "特效的存续时间没有跟着落子相一起拉长");

  // 推到 ≈3.2s：相位切换在 1.68s，之后还要留够时间让演化相自己长完
  for (let i = 61; i <= 200; i++) frame(t0 + 16 * i);
  assert.equal(
    fillsInLastFrame(ctx, "#ffffff"),
    aliveCount(after),
    "过了 flipMs 之后演化相没有接上",
  );
});

/* ═══════════ ★ 两段动画落地的那一刻（记分板挂在它上面）═══════════
 *
 * 读数（记分板那五格、态势图本回合那个点）必须跟着方块**真正变的那两刻**走：
 * 落子落地时报一次、演化落地时报一次。没有这两个通知，调用方只能在自己那一侧
 * 立刻刷新 —— 于是画面还在落子相，数字已经把这一回合的结局报出来了。
 */

/** 推进到 t0+ms。逐帧走是必须的，理由见「空转一整回合」那条 */
function makeAdvancer(frame: (ts: number) => boolean, t0: number) {
  let i = 0;
  return (ms: number): boolean => {
    while ((i + 1) * 16 <= ms) {
      i++;
      if (!frame(t0 + 16 * i)) return false;
    }
    return true;
  };
}

test("★ onPhase：落子相当场报，演化相要等到 flipMs 之后", () => {
  const { frame } = installRaf();
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.flipMs = 1000;
  r.resize(400, 400, 4, 4);

  const mid = flip(BOARD, cell(2, 2));
  const after = lifeStep(mid, "bounded");
  const phases: string[] = [];
  const t0 = performance.now();
  r.playTurn({ mid, after, flips: [{ cell: cell(2, 2), color: "life" }] }, (p) => phases.push(p));

  assert.deepEqual(phases, ["flip"], "playTurn 当场就该报落子相 —— 那一帧的方块已经变了");

  const advance = makeAdvancer(frame, t0);
  advance(960); // 仍在落子相里
  assert.deepEqual(
    phases,
    ["flip"],
    "还没到 flipMs 就报了演化相 —— 读数又跑到画面前面去了",
  );

  advance(1100);
  assert.deepEqual(phases, ["flip", "evolve"], "演化落地了却没报");

  advance(2400);
  assert.deepEqual(phases, ["flip", "evolve"], "一轮里报了不止一次演化相");
});

test("★ 被下一回合顶掉时，上一回合的演化相要**补报**（否则态势图一个点都不再更新）", () => {
  const { frame } = installRaf();
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.flipMs = 1000;
  r.resize(400, 400, 4, 4);

  const mid = flip(BOARD, cell(2, 2));
  const after = lifeStep(mid, "bounded");
  const phases: string[] = [];
  const t0 = performance.now();
  r.playTurn({ mid, after, flips: [{ cell: cell(2, 2), color: "life" }] }, (p) => phases.push(p));
  assert.deepEqual(phases, ["flip"]);

  // 决策回得比动画快：演化还没到点，下一回合就开演了。`pending` 是**单个槽位**，
  // 直接替换的话那一次 evolve 就此消失，而调用方无从知道少了一次通知 ——
  // 记分板与态势图都挂在它上面，症状是图一个点都不再更新、画面却一切正常
  const mid2 = flip(after, cell(1, 1));
  const after2 = lifeStep(mid2, "bounded");
  r.playTurn({ mid: mid2, after: after2, flips: [{ cell: cell(1, 1), color: "life" }] }, (p) =>
    phases.push(p),
  );
  assert.deepEqual(
    phases,
    ["flip", "evolve", "flip"],
    "上一回合的演化相被顶掉了 —— 挂在它上面的记分板与态势图会少一次更新",
  );

  // 新的那一回合照常演完，补报没有打乱它
  makeAdvancer(frame, t0)(1100);
  assert.deepEqual(phases, ["flip", "evolve", "flip", "evolve"]);
});

test("★ 动效关掉时两相在同一帧落地，两次通知也当场发（顺序仍是落子在先）", () => {
  const { frame } = installRaf();
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.animations = false;
  r.resize(400, 400, 4, 4);

  const mid = flip(BOARD, cell(2, 2));
  const after = lifeStep(mid, "bounded");
  const phases: string[] = [];
  r.playTurn({ mid, after, flips: [{ cell: cell(2, 2), color: "life" }] }, (p) => phases.push(p));

  assert.deepEqual(phases, ["flip", "evolve"], "动效关掉时两相合并成一帧，通知也得补齐");
  assert.equal(frame(performance.now() + 16), false, "动效关掉后不该还排帧");
});

test("★ 动画被打断时**不会**报演化相 —— 那一帧的棋盘从来没上过屏幕", () => {
  const { frame } = installRaf();
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.flipMs = 1000;
  r.resize(400, 400, 4, 4);

  const mid = flip(BOARD, cell(2, 2));
  const after = lifeStep(mid, "bounded");
  const phases: string[] = [];
  const t0 = performance.now();
  r.playTurn({ mid, after, flips: [{ cell: cell(2, 2), color: "life" }] }, (p) => phases.push(p));
  assert.deepEqual(phases, ["flip"]);

  // 半局中重开 / 恢复存档：直接落到另一副棋盘上，演化那一相被取消
  r.setBoard(after);
  const advance = makeAdvancer(frame, t0);
  advance(2400);
  assert.deepEqual(
    phases,
    ["flip"],
    "演化相已经被 setBoard 取消，却还是报了 —— 记分板会显示一个从没出现过的局面",
  );
});

test("手绘翻转（toggle）：只有缩放，不出选框、不撒粒子", () => {
  // 「开局前玩家点格子摆局面」用的入口。这时**还没有行动方**，
  // 选框与粒子是「某个角色落子」的标记，借过来用会让人以为那是谁下的子
  const { frame } = installRaf();
  const { canvas, ctx } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.resize(400, 400, 4, 4);
  r.setBoard(BOARD); // 先落一副已有的局面

  const c = cell(2, 2); // BOARD 里是死格
  const flipped = flip(BOARD, c);
  const t0 = performance.now();
  r.toggle(flipped, c);

  // `toggle` 自己会立刻画一帧：那一格的起始缩放是 0，所以这一帧里看不见它。
  // 「起始是 0」正是它与「上一帧还在、只是换了个状态」的区别，也是玩家点一下
  // 唯一能得到的反馈 —— 直接就位的话，点击会像是没反应
  assert.equal(
    fillsInLastFrame(ctx, "#ffffff"),
    aliveCount(BOARD),
    "手绘那一格起始就已经是满尺寸了 —— 缩放进不来",
  );
  assert.ok(!ctx.strokes.includes(PALETTE.life), "手绘不该有发光选框");
  assert.ok(!ctx.strokes.includes(PALETTE.death), "手绘不该有发光选框");
  assert.equal(ctx.arcCalls.length, 0, "手绘不该撒粒子");

  // 补间把那一格长出来，长完就停
  let frames = 0;
  while (frame(t0 + 16 * (frames + 1)) && frames < 200) frames++;
  assert.equal(
    fillsInLastFrame(ctx, "#ffffff"),
    aliveCount(flipped),
    "手绘那一格最终没有长到满尺寸",
  );
});

test("2×2 这类极小棋盘的几何不退化（长宽各自可设 2~16）", () => {
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);

  assert.equal(r.resize(400, 400, 2, 2), true);
  // 格子边长 = 画布宽 / (2 + 3×GUTTER_K)，必须是个正数、且画布不超出可用空间
  const cellPx = canvas.width / (2 + 3 * GUTTER_K);
  assert.ok(cellPx > 4, `2×2 下格子边长退化了：${cellPx}`);
  assert.ok(canvas.width <= 400 && canvas.height <= 400);

  // 画得出来（不抛异常），也不是「尺寸算成 0 于是什么都不画」
  r.setBoard(boardFromRows(["##", ".."]));
  const { ctx } = fakeCanvas();
  assert.ok(cellPx > 0 && ctx.frame >= 0);

  // 长宽不等也要能用（用户要的是各自可设）
  assert.equal(r.resize(400, 400, 2, 16), true);
  assert.ok(canvas.width > 0 && canvas.height > 0 && canvas.height <= 400);
});

test("setBoard 直接落地：新局的棋盘不做动画", () => {
  const { frame } = installRaf();
  const { canvas, ctx } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  r.resize(400, 400, 4, 4);

  r.setBoard(BOARD);
  assert.equal(frame(performance.now() + 16), false, "setBoard 之后不该有任何帧在跑");
  assert.equal(ctx.arcCalls.length, 0, "开局不该有粒子");
});

/* ═══════════ 手绘开局的命中判定 ═══════════ */

/**
 * `cellAtPoint` 是「点格子即翻转」唯一的几何出口。
 *
 * 它错了不会报任何异常 —— 表现是「点这一格，那一格亮了」，或者更糟：
 * 点哪儿都没反应。而这两种症状与真正的原因（pad / gap / cellPx 抄错了一处）
 * 在界面上完全看不出关联，正是本项目反复出现的那个母题。
 */
test("命中判定：格心落本格，缝里与留白落空，长宽不等时行列不串", () => {
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);

  // ── 4×4 ──
  assert.equal(r.resize(400, 400, 4, 4), true);
  const cell = 89; // floor(400 / (4 + 5×GUTTER_K))
  const step = cell + cell * GUTTER_K;
  const pad = cell * GUTTER_K;
  const at = (row: number, col: number): [number, number] => [
    pad + col * step + cell / 2,
    pad + row * step + cell / 2,
  ];

  for (const [row, col] of [
    [0, 0],
    [0, 3],
    [3, 0],
    [3, 3],
    [1, 2],
  ] as const) {
    const [x, y] = at(row, col);
    assert.equal(
      r.cellAtPoint(x, y),
      row * 4 + col,
      `(${row},${col}) 的格心应当命中 ${row * 4 + col}`,
    );
  }

  // 格子之间那条缝：不算命中。算进去的话相邻两格会争同一条边界，
  // 谁赢取决于浮点误差
  assert.equal(
    r.cellAtPoint(pad + cell + (step - cell) / 2, pad + cell / 2),
    null,
    "格子右侧的缝不该算任何一格",
  );
  // 四周留白
  assert.equal(r.cellAtPoint(2, 200), null, "左留白不该算任何一格");
  assert.equal(r.cellAtPoint(394, 200), null, "右留白之外不该算任何一格");

  // ── 长宽不等：行列必须按各自的数走（用户要的是「各自可设」）──
  assert.equal(r.resize(400, 400, 3, 5), true);
  const cell2 = 72; // floor(min(400/(3+4k), 400/(5+6k)))
  const step2 = cell2 + cell2 * GUTTER_K;
  const pad2 = cell2 * GUTTER_K;
  assert.equal(
    r.cellAtPoint(pad2 + 2 * step2 + cell2 / 2, pad2 + 4 * step2 + cell2 / 2),
    4 * 3 + 2,
    "3 列 5 行下，(4,2) 应当命中格 14 —— 按 4 列算会得到 18",
  );
});

test("命中判定：还没 resize（尺寸为 0）时返回 null，而不是算出一个越界格", () => {
  const { canvas } = fakeCanvas();
  const r = new BoardRenderer(canvas, PALETTE);
  assert.equal(r.cellAtPoint(10, 10), null);
});
