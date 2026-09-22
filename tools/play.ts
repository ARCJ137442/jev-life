/**
 * 无头跑完一整局生命棋。
 *
 * ═══ 它是什么 ═══
 *
 * 关卡一的验收物，同时是将来 `tools/bench-step.ts` 的雏形。两者共用同一条管线：
 * 「组题 → 发一次请求 → 解析 → 决策 → 落子 → 演化 → 判终局」。
 * 差别只在 bench 会把它跑几百遍、并把每一局的结果写进 CSV。
 *
 * ═══ 三条必须守住的规矩 ═══
 *
 * 1. **每回合双方并发发两个请求**（`Promise.all`），都基于**演化前**的棋盘。
 *    顺序 await 的结果一模一样（两边本来就不知道对方走了哪），但代码结构会
 *    误导人以为死之执能看到生之执的落子 —— 而这个项目的全部意义就是别搞错
 *    这种因果关系。两边各发一个请求也**不需要任何冲突消解**：合法集天然互斥。
 *
 * 2. **一条通道 = 一个请求**。绝不为省事把题拆成几批循环发。
 *
 * 3. **失败就是失败**。上游报错、回包对不上题面，一律当场停下、退出码 1 ——
 *    把一次失败的调用当成「模型答不出来」正是本项目踩过的坑
 *    （免费额度 429 被探针统计成了模型不行）。
 *
 * ═══ 用法 ═══
 *
 *   # 不花额度：固定 seed 的假概率，跑完整条管线
 *   node tools/play.ts --dry-run --size 8x8 --turns 20
 *
 *   # 真额度：先起本机服务器（./start.sh），它会注入密钥
 *   node tools/play.ts --size 8x8 --turns 4
 *
 *   # 直连网关（自己带密钥）
 *   node tools/play.ts --base https://ai-gateway.vercel.sh/v1/evaluate \
 *        --backend vercel --key "$KEY" --model typesafe-ai/jev
 *
 * 运行前必须先把 core 编译出来（`loadCore()` 会检查产物是否比源码旧）：
 *   node node_modules/typescript/bin/tsc -p tsconfig.test.json
 *
 * ═══ 与计划的一处偏离 ═══
 *
 * 计划里写的是 `--size 6x6`。**6×6 不是预设尺寸** —— `presets.ts` 只有
 * 4 / 8 / 16 三档正方形，每档的规则与开局库都是单独标定的（固定格数的开局
 * 换个尺寸就从「离死之执很远」变成「贴着线」）。所以这里只接受预设里有的尺寸，
 * 短局用 `--turns` 压回合数而不是换一个没标定过的棋盘。
 */
import { loadCore } from "./_load.ts";
import type { DecisionBackend, DecisionResult } from "../src/shared/backend.js";
import type { Answer, TurnRecord } from "../src/shared/types.js";
import type { CellProbabilities, Strategy } from "../src/core/decide.js";
import type { Channel } from "../src/core/channels.js";
import type { StateInput } from "../src/core/context.js";
import type { Board, Cell, GameRules, Role, Termination, Topology } from "../src/core/types.js";

/* ══════════════════════════════════════════════════════════════════
   参数
   ══════════════════════════════════════════════════════════════════ */

interface Args {
  dryRun: boolean;
  size: string;
  turns: number | null;
  opening: string | null;
  topology: Topology | null;
  strategy: Strategy;
  threshold: number;
  seed: number;
  backend: string;
  base: string;
  model: string;
  key: string;
}

const HELP = `
  用法： node tools/play.ts [选项]

  --dry-run           假概率跑完整局，**不调用上游、不花额度**
  --size  8x8         棋盘尺寸。只接受预设里有的档：4x4 / 8x8 / 16x16
  --turns N           覆盖回合上限（短局用它压开销）
  --opening ID        开局 id，默认取该尺寸的第一个
  --topology T        bounded（默认）| torus
  --strategy S        greedy（默认）| sample | threshold
  --threshold X       置信度门槛，0 = 不启用（默认 0）
  --seed N            dry-run 的随机种子（默认 20260921）
  --base URL          上游地址。默认 http://127.0.0.1:8787/api/evaluate
  --backend ID        判别值来源：vercel 会给布尔类型发 boolean，其余发 noul
  --model ID          模型 ID，默认 typesafe-ai/jev
  --key K             密钥。走本机代理时不用填（密钥在服务端）
  --help              这份说明
`;

const DEFAULT_BASE = "http://127.0.0.1:8787/api/evaluate";

/** 逐项解析 `--key value` 与布尔开关。不认识的参数**当场报错**，不静默忽略 */
function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    dryRun: false,
    size: "8x8",
    turns: null,
    opening: null,
    topology: null,
    strategy: "greedy",
    threshold: 0,
    seed: 20260921,
    backend: "",
    base: DEFAULT_BASE,
    model: "typesafe-ai/jev",
    key: "",
  };

  const value = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} 后面缺一个值`);
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--dry-run": args.dryRun = true; break;
      case "--size": args.size = value(i, a); i++; break;
      case "--turns": args.turns = Number(value(i, a)); i++; break;
      case "--opening": args.opening = value(i, a); i++; break;
      case "--topology": {
        const v = value(i, a);
        if (v !== "bounded" && v !== "torus") throw new Error(`--topology 只能是 bounded 或 torus，收到 ${v}`);
        args.topology = v;
        i++;
        break;
      }
      case "--strategy": {
        const v = value(i, a);
        if (v !== "greedy" && v !== "sample" && v !== "threshold") {
          throw new Error(`--strategy 只能是 greedy / sample / threshold，收到 ${v}`);
        }
        args.strategy = v;
        i++;
        break;
      }
      case "--threshold": args.threshold = Number(value(i, a)); i++; break;
      case "--seed": args.seed = Number(value(i, a)); i++; break;
      case "--base": args.base = value(i, a); i++; break;
      case "--backend": args.backend = value(i, a); i++; break;
      case "--model": args.model = value(i, a); i++; break;
      case "--key": args.key = value(i, a); i++; break;
      case "--help": case "-h": console.log(HELP); process.exit(0); break;
      default: throw new Error(`不认识的参数：${a}（--help 看用法）`);
    }
  }

  if (args.turns !== null && (!Number.isInteger(args.turns) || args.turns <= 0)) {
    throw new Error(`--turns 必须是正整数，收到 ${String(args.turns)}`);
  }
  return args;
}

/* ══════════════════════════════════════════════════════════════════
   小工具
   ══════════════════════════════════════════════════════════════════ */

/** mulberry32 —— 与 presets.ts / life-diff.test.ts 用的是同一个 PRNG */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把 (seed, 角色, 回合) 混成一个整数种子 —— dry-run 的结果与调用顺序无关 */
function mix(seed: number, role: Role, turn: number): number {
  let h = seed >>> 0;
  for (const ch of `${role}:${turn}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  return h;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const money = (usd: number | null): string => (usd === null ? "—（无法计价）" : `$${usd.toFixed(6)}`);

function rc(board: Board, cell: Cell): [number, number] {
  return [Math.floor(cell / board.cols), cell % board.cols];
}

const at = (board: Board, cell: Cell): string => `(${rc(board, cell).join(",")})`;

/* ══════════════════════════════════════════════════════════════════
   假后端：--dry-run
   ══════════════════════════════════════════════════════════════════ */

/**
 * 固定 seed 的假概率。
 *
 * 它存在的意义不是「假装能跑」，而是**把管线本身与上游解耦**：题面组装、
 * 键名解析、决策、演化、终局判定这五步都能在没有额度、没有网络的情况下
 * 被跑通与调试。真跑时换掉的就只有这一个对象。
 *
 * 每个 (角色, 回合) 有**自己的** PRNG：两边并发发请求，共用一个序列会让
 * 结果依赖调用的先后顺序 —— 而「结果依赖顺序」正是这个项目最该避免的东西。
 */
function dryBackend(seed: number, role: Role, turn: number): DecisionBackend {
  const rand = rng(mix(seed, role, turn));
  return {
    id: `dry-run/${role}`,
    kind: "systemone",
    evaluate: async (req): Promise<DecisionResult> => {
      const answers: Record<string, Answer> = {};
      // 逐题给一个 0~1 的假概率。**只覆盖题面里的键** —— 多一个少一个都会被
      // parseAnswers 抓住，那正好也是这条管线该被验证的地方
      for (const key of Object.keys(req.questions)) {
        answers[key] = { type: "noul", noul: rand() };
      }
      return {
        answers,
        latencyMs: 0,
        // 一次上游请求都没发出去。「发了 1 次」是假话
        upstreamCalls: 0,
        usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
        // 干跑确实不花钱，而这里的 0 是「确实没花」；真要报「不知道」用 null
        costUsd: 0,
        raw: null,
      };
    },
  };
}

/* ══════════════════════════════════════════════════════════════════
   主流程
   ══════════════════════════════════════════════════════════════════ */

type LifeModule = typeof import("../src/core/life.js");
type ContextModule = typeof import("../src/core/context.js");
type ChannelsModule = typeof import("../src/core/channels.js");
type DecideModule = typeof import("../src/core/decide.js");
type PresetsModule = typeof import("../src/core/presets.js");
type BackendModule = typeof import("../src/shared/backend.js");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  try {
    await play(args);
  } catch (e) {
    fail(e, args);
  }
}

async function play(args: Args): Promise<void> {
  const life = await loadCore<LifeModule>("core/life.js");
  const context = await loadCore<ContextModule>("core/context.js");
  const channels = await loadCore<ChannelsModule>("core/channels.js");
  const decide = await loadCore<DecideModule>("core/decide.js");
  const presets = await loadCore<PresetsModule>("core/presets.js");
  const backendMod = await loadCore<BackendModule>("shared/backend.js");

  /* ── 对局级配置：它们定义的是「这是哪一局棋」 ── */

  const m = /^(\d+)x(\d+)$/.exec(args.size);
  if (!m) throw new Error(`--size 的格式应当是 8x8，收到 ${args.size}`);
  const cols = Number(m[1]);
  const rows = Number(m[2]);

  const preset = presets.PRESETS.find((p) => p.cols === cols && p.rows === rows);
  if (!preset) {
    const available = presets.PRESETS.map((p) => `${p.cols}x${p.rows}`).join(" / ");
    throw new Error(
      `没有 ${args.size} 这一档预设（只有 ${available}）。` +
        "每一档的规则与开局库都是单独标定的，固定格数的开局换个尺寸就从「离死之执很远」变成「贴着线」——" +
        "所以短局请用 --turns 压回合数，而不是换一个没标定过的棋盘",
    );
  }

  const opening =
    preset.openings.find((o) => o.id === args.opening) ?? preset.openings[0];
  if (args.opening !== null && opening.id !== args.opening) {
    const ids = preset.openings.map((o) => o.id).join(" / ");
    throw new Error(`尺寸 ${args.size} 下没有开局「${args.opening}」（可选：${ids}）`);
  }

  const topology: Topology = args.topology ?? preset.defaultTopology;
  const rules: GameRules =
    args.turns === null ? preset.rules : { ...preset.rules, turnLimit: args.turns };

  let board: Board = life.boardFromRows(opening.build(cols, rows));

  /* ── 通道：一条通道 = 一个请求 ── */

  const channel: Channel = { kind: "noul-all", ...(args.backend === "" ? {} : { backend: args.backend }) };
  const discriminator = args.backend === "vercel" ? "boolean" : "noul";

  /* ── 真后端（dry-run 时不用） ── */

  const realBackend: DecisionBackend | null = args.dryRun
    ? null
    : backendMod.createSystemoneBackend(
        { base: args.base, model: args.model, apiKey: args.key },
        { id: "cli" },
      );

  const roleContext = context.DEFAULT_ROLE_CONTEXT;

  /* ── 开场 ── */

  console.log("");
  console.log("═".repeat(70));
  console.log(
    `  生命棋无头对局   ${cols}×${rows}  ${topology}  开局 ${opening.id}（${opening.nameZh}）`,
  );
  console.log(
    `  通道 ${channel.kind}  判别值 ${discriminator}  策略 ${args.strategy}` +
      (args.strategy === "threshold" ? ` 门槛 ${args.threshold}` : ""),
  );
  console.log(
    args.dryRun
      ? "  ★ DRY RUN —— 假概率，未调用上游，不花额度"
      : `  后端 ${args.base}  模型 ${args.model}`,
  );
  console.log("═".repeat(70));

  const seen = new Set<string>([life.boardKey(board)]);
  /** 此前各回合的占比，**不含当前局面** —— 当前占比由 classifyTermination 现算 */
  const ratioHistory: number[] = [];
  const history: TurnRecord[] = [];
  let scores = { life: 0, death: 0 };

  const totals = { calls: 0, input: 0, output: 0, reasoning: 0, latencyMs: 0, cost: 0, costUnknown: false };

  let turn = 0;
  let termination: Termination | null = null;

  for (;;) {
    // 无头 CLI 只跑双人对弈（单人模式还没有 CLI 入口）
    const snap = { board, mode: "duel" as const, topology, turn, ratioHistory: [...ratioHistory] };
    const verdict = life.classifyTermination(snap, rules, seen);
    if (verdict) {
      termination = verdict;
      break;
    }

    /* ── 双方**同时**决策，都基于演化前的棋盘 ── */

    const roles: readonly Role[] = ["life", "death"];
    const inputs = roles.map((role) => {
      const input: StateInput = {
        board,
        role,
        mode: "duel",
        topology,
        rules,
        turn,
        scores,
        history,
        context: roleContext,
      };
      return { role, input, state: context.buildState(input), questions: context.buildQuestions(channel, input) };
    });

    const results = await Promise.all(
      inputs.map((req) =>
        (args.dryRun ? dryBackend(args.seed, req.role, turn) : (realBackend as DecisionBackend)).evaluate({
          model: args.model,
          state: req.state,
          questions: req.questions,
        }),
      ),
    );

    /* ── 解析 → 决策 ── */

    const decisions = inputs.map((req, i) => {
      const res = results[i];
      totals.calls += res.upstreamCalls;
      totals.latencyMs += res.latencyMs;
      if (res.usage) {
        totals.input += res.usage.inputTokens;
        totals.output += res.usage.outputTokens;
        totals.reasoning += res.usage.reasoningTokens;
      }
      if (res.costUsd === null) totals.costUnknown = true;
      else totals.cost += res.costUsd;

      // 这个工具**只跑双人局**（`mode: "duel"` 在两处写死，见文件头）——
      // 单人局的题面与合法集不同，真要跑得先把它做成一个参数
      const probs: CellProbabilities = channels.parseAnswers(
        channel,
        res.answers,
        board,
        req.role,
        "duel",
      );
      const resolution = decide.resolveDecision(
        probs,
        board,
        req.role,
        "duel",
        args.strategy,
        args.threshold,
        rng(mix(args.seed, req.role, turn + 1)),
      );
      return { role: req.role, res, probs, resolution };
    });

    const flipOf = (role: Role): Cell => {
      const d = decisions.find((x) => x.role === role);
      if (!d) throw new Error(`内部错误：没有 ${role} 的决策`);
      return d.resolution.cell;
    };
    const lifeFlip = flipOf("life");
    const deathFlip = flipOf("death");

    /* ── 打印这一回合：**决策所依据的那副**棋盘 ──
       顺序不是排版问题。决策里的 (行, 列) 是对着演化前的棋盘算的；把它们印在
       演化**后**的棋盘旁边，读的人会拿新棋盘去找那个坐标 —— 而那里是另一格。 */

    const decisionBoard = board;
    const before = life.aliveCount(decisionBoard);
    console.log("");
    console.log(`第 ${turn + 1} 回合  boardKey=${life.boardKey(decisionBoard)}`);
    for (const row of life.toRows(decisionBoard)) console.log(`  ${row}`);
    console.log(`  活 ${before}（${pct(before / (cols * rows))}）  拓扑 ${topology}`);

    for (const d of decisions) {
      const label = d.role === "life" ? "Life " : "Death";
      const flags = [d.resolution.coerced ? "coerced" : "", d.resolution.belowThreshold ? "belowThreshold" : ""]
        .filter((s) => s !== "")
        .join(" ");
      console.log(
        `  ${label} 选 ${at(decisionBoard, d.resolution.cell)}  ` +
          `p=${(d.probs.get(d.resolution.cell) ?? 0).toFixed(2)}  ${flags}`.trimEnd(),
      );
      console.log(`        前 5：${topFive(decisionBoard, d.probs)}`);
      console.log(
        `        usage in=${d.res.usage?.inputTokens ?? 0} out=${d.res.usage?.outputTokens ?? 0} ` +
          `reason=${d.res.usage?.reasoningTokens ?? 0}  calls=${d.res.upstreamCalls}  ` +
          `${d.res.latencyMs}ms  ${money(d.res.costUsd)}`,
      );
    }

    /* ── 落子 + 演化一代 ── */

    // 先把**本回合开始时**的占比记进历史：classifyTermination 的 series 是
    // [...ratioHistory, 当前占比]，把当前局面也塞进历史会让同一代被数两次
    ratioHistory.push(before / (cols * rows));

    const next = life.lifeStep(life.flip(life.flip(board, lifeFlip), deathFlip), topology);
    const after = life.aliveCount(next);
    const netGrowth = after - before;
    scores = { life: scores.life + netGrowth, death: scores.death + netGrowth };

    history.push({
      turn,
      board: next,
      lifeFlip,
      deathFlip,
      aliveCount: after,
      netGrowth,
    });

    board = next;
    turn++;
    seen.add(life.boardKey(board));

    /* ── 打印结果 ── */

    console.log(`  ── 双方各翻一格（${at(decisionBoard, lifeFlip)} / ${at(decisionBoard, deathFlip)}）后演化一代 ──`);
    for (const row of life.toRows(board)) console.log(`  ${row}`);
    console.log(
      `  活 ${after}（${pct(after / (cols * rows))}）  ` +
        `本回合净增长 ${netGrowth >= 0 ? "+" : ""}${netGrowth}  ` +
        `累计 ${scores.life >= 0 ? "+" : ""}${scores.life}  boardKey=${life.boardKey(board)}`,
    );
  }

  /* ── 终局 ── */

  console.log("");
  console.log("═".repeat(70));
  console.log("  终局");
  console.log("═".repeat(70));
  console.log(`  原因 ${termination?.reason ?? "（未知）"}`);
  console.log(`  胜方 ${termination?.winner ?? "和局"}`);
  console.log(`  回合 ${turn} / ${rules.turnLimit}`);
  console.log(
    `  累计净增长 ${scores.life >= 0 ? "+" : ""}${scores.life}  ` +
      `（生之执越大越好、死之执越小越好，所以两边看的是同一个数）`,
  );
  const finalRatio = life.aliveCount(board) / (board.cols * board.rows);
  console.log(
    `  最终占比 ${pct(finalRatio)}（生之执线 ${pct(rules.lifeWinRatio)} / 死之执线 ${pct(
      rules.deathWinRatio,
    )}）`,
  );
  console.log(`  boardKey=${life.boardKey(board)}`);
  for (const row of life.toRows(board)) console.log(`  ${row}`);

  console.log("");
  console.log("─".repeat(70));
  console.log(`  上游请求 ${totals.calls} 次`);
  console.log(
    `  token：输入 ${totals.input}  输出 ${totals.output}（其中推理 ${totals.reasoning}）`,
  );
  console.log(
    `  延迟：累计 ${(totals.latencyMs / 1000).toFixed(1)}s` +
      (totals.calls > 0 ? `，平均 ${Math.round(totals.latencyMs / totals.calls)}ms/次` : ""),
  );
  console.log(
    `  成本：${totals.costUnknown ? "至少 " : ""}${money(totals.cost)}` +
      (totals.costUnknown ? "（有调用无法计价，这一栏是下界而不是总额）" : ""),
  );
  if (args.dryRun) console.log("  ★ DRY RUN —— 以上数字来自假概率，不是模型的输出，也不是真实计费");
  console.log("─".repeat(70));
  console.log("");
}

/** 分布的前 5 名，标出被选中的那一格 */
function topFive(board: Board, probs: CellProbabilities): string {
  const ranked = [...probs.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 5);
  return ranked.map(([cell, p]) => `${at(board, cell)} ${p.toFixed(2)}`).join("  ");
}

/**
 * 失败报告。
 *
 * ★ 这里有一件事必须做对：**报协议错误时要能直接指出是哪个后端、期望什么判别值。**
 *
 * 这一条是计划点名要求的，而它来自一个真实的坑：布尔类型的判别值四个网关不一致
 * （Vercel 用 `boolean`，官方 / OpenRouter / AI-ML-API 用 `noul`），传错的样子就是
 * 一个 400。而本机代理**刻意不透传上游原文**（那会把上游选型泄露给浏览器），
 * 于是 CLI 拿到手只剩一句「该免费后端暂时不可用」—— 有信息量的是零。
 * 第一次真跑就撞上了这个，所以这段提示是实测逼出来的，不是想象出来的。
 */
/**
 * 从 `--base` 猜它背后是哪个网关。**猜不到就返回 null**，不硬编一个答案。
 *
 * 后两条规则认的是本机代理的路由名（`/api/evaluate` → Vercel，`evaluate2` →
 * OpenRouter）。这是 `src/server/server.ts` 的上游表在这里的第二份副本 ——
 * 它只用来**提示**，不参与任何判定，所以走样了顶多是一句提示不准，
 * 不会让一局棋跑错。真要加第三个代理时记得同步。
 */
function upstreamOfBase(base: string): string | null {
  if (base.includes("ai-gateway.vercel.sh")) return "vercel";
  if (base.includes("openrouter.ai")) return "openrouter";
  if (base.includes("api.typesafe.ai")) return "typesafe";
  if (/\/api\/evaluate2(\/|$)/.test(base)) return "openrouter";
  if (/\/api\/evaluate(\/|$)/.test(base)) return "vercel";
  return null;
}

/** 某个网关要的布尔判别值 —— 与 `noulDiscriminator` 同一套事实 */
function noulDiscriminatorHint(upstream: string): string {
  return upstream === "vercel" ? "boolean" : "noul";
}

function fail(e: unknown, args: Args): never {
  const status = (e as { status?: number }).status;
  const message = (e as Error).message;

  // 失败就是失败：跑不成 → 退出码 1。退出码 0 会被任何 shell 管道读成「跑过了」
  console.error("");
  console.error(`✗ 这一局没跑成：${message}`);

  if (typeof status === "number" && status >= 400 && status < 500) {
    const upstream = upstreamOfBase(args.base);
    const used = args.backend === "vercel" ? "boolean" : `noul（--backend 「${args.backend}」）`;

    console.error("");
    console.error("  上游 4xx。回包里**没有**上游原文（代理刻意不透传，免得把上游选型泄给");
    console.error("  浏览器），所以下面列的是可能的原因，不是结论 —— 那行「上游原文：」在");
    console.error("  本机服务器的日志里，它才是答案。常见两种：");
    console.error("");
    if (status === 402 || status === 403 || status === 429) {
      console.error(`  · 额度 / 鉴权（HTTP ${status} 通常就是这个）：该后端已用尽、被限流，或者密钥失效。`);
    }
    console.error(`  · 判别值选错：四个网关不一致 —— Vercel 用 boolean，官方 / OpenRouter /`);
    console.error(`    AI-ML-API 用 noul。这一次发的是 ${used}。`);
    if (upstream !== null) {
      // 比的是**判别值**而不是后端 id：noul 是好几家的默认值，id 不同但值一样时
      // 提示「加 --backend xxx」会让人去改一个本来就对的参数
      const need = noulDiscriminatorHint(upstream);
      console.error(
        `    --base 看起来指向 ${upstream}，它要的是 ${need}` +
          (need === (args.backend === "vercel" ? "boolean" : "noul")
            ? "（判别值已经对了，那 4xx 不是这个原因）"
            : `（加 --backend ${upstream}）`),
      );
    } else {
      console.error("    --base 背后是哪个网关看不出来，所以要你自己核对判别值。");
    }
  }

  if (message.includes("无法连接")) {
    console.error("  （本机代理默认在 http://127.0.0.1:8787 —— 先跑 ./start.sh，或用 --base 指别处）");
  }

  console.error("");
  process.exit(1);
}

main().catch((e: unknown) => {
  console.error("");
  console.error(`✗ ${(e as Error).message}`);
  console.error("");
  process.exit(1);
});
