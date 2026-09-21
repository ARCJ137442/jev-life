/**
 * 对局持久化。
 *
 * 刷新页面不该丢掉正在跑的一局 —— 尤其本项目的定位是「测量 Jev」，跑一局
 * 几十回合、每次请求都在花钱，刷新即清零等于白跑。
 *
 * 写入是**防抖**的：每回合都存一次全量 JSON 会拖慢决策循环，而 300ms 的延迟
 * 对人来说无感，对浏览器足够友好。
 *
 * 与 `config.ts` 的分工：
 *   config  → 长期设置（对局级 + 双方玩家级 + 重试）
 *   session → 当前这一局（棋盘、回合、历史、比分、调用日志）
 *
 * ═══ 两处与 2048 不同的地方，都是生命棋逼出来的 ═══
 *
 * 1. **棋盘存成行文本**（`"##...#"`）而不是一维数组。生命棋的棋盘是
 *    `Uint8Array`，直接 `JSON.stringify` 会变成 `{"0":0,"1":1,...}` 这种
 *    几十倍膨胀的形状；行文本既紧凑、又能被人直接读出来，出问题时肉眼可查。
 *
 * 2. **`seen` 必须一起存**。终局判定里的 `repeatBlocked` 靠的是「这盘推不推得动」，
 *    而它要问的是「后继局面是不是**见过的**」。只恢复棋盘而丢掉 `seen`，
 *    恢复出来的那一局与原来那一局就**不是同一局**：一个能判 repeatBlocked 的局面
 *    会继续往下走。这是那种「不报错、只是结论不同」的错，最该防。
 */
import { boardFromRows, toRows } from "../core/life.js";
import type { GameRules, Mode, Topology } from "../core/types.js";
import type { TurnRecord } from "../shared/types.js";
import type { Role } from "../core/types.js";
import { t } from "./i18n.js";

const KEY = "jevlife.session.v1";
const SAVE_DEBOUNCE_MS = 300;

/**
 * 随存档一起写盘的日志条数。
 *
 * 每条日志含**完整的请求体与回包**，而 16×16 的一次请求就有 256 道题
 * （题面 + criteria 各自带一段中文），单条 JSON 几十 KB。全存会直接撞爆
 * localStorage 的配额（5MB 量级），而配额爆掉的表现是「存档整个没了」。
 * 所以只保留最近几条；更早的仍在内存里，可用日志抽屉的「复制全部」导出。
 */
export const MAX_PERSISTED_LOGS = 6;

/** schema 版本。字段结构变更时递增 —— 旧档据此判定为不兼容 */
export const SESSION_VERSION = 1;

/** 存档归属标识。与 2048 的 `jev2048.session.v1` 分属不同键，且自带 app 标记 */
export const SESSION_APP = "jev-life";

/* ══════════════ 日志行 ══════════════ */

/**
 * 一个玩家在一个回合里的完整往返记录。
 *
 * `request` / `response` 原样留着 —— 关卡二的验收标准里有一条是「看完整
 * request/response」，而这是**唯一**能看到「当时到底问了什么」的地方。
 */
export interface RoleLog {
  readonly role: Role;
  /** 落点（一维格号）。失败时为 null */
  readonly cell: number | null;
  readonly row: number;
  readonly col: number;
  readonly reasonKey: string;
  readonly reasonParams?: Record<string, string | number>;
  readonly coerced: boolean;
  readonly belowThreshold: boolean;
  /** 被选中那一格的概率。失败时为 0 */
  readonly prob: number;
  /** 该手概率分布的三个统计量：最高 / 最低 / 中位。失败时全为 0 */
  readonly top: number;
  readonly bottom: number;
  readonly median: number;
  readonly latencyMs: number;
  readonly upstreamCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly costUsd: number | null;
  readonly request: unknown;
  readonly response: unknown;
  /** 非空表示这一次调用失败了；此时 cell 为 null */
  readonly error?: string;
}

export interface TurnLog {
  readonly turn: number;
  readonly at: string;
  readonly life: RoleLog | null;
  readonly death: RoleLog | null;
  readonly aliveBefore: number;
  readonly aliveAfter: number;
  readonly netGrowth: number;
  /** 这一回合是否失败。失败的回合不计入比分与历史 */
  readonly failed: boolean;
}

/* ══════════════ 会话 ══════════════ */

/** 回合记录的落盘形态：棋盘变行文本，翻转格仍是格号 */
export interface StoredTurn {
  readonly turn: number;
  readonly board: string[];
  readonly lifeFlip: number;
  /**
   * 死之执那一手。**可选** —— 单人模式没有它（见 `shared/types.ts` 的
   * `TurnRecord.deathFlip`）。
   *
   * ⚠ 读的时候必须用 `undefined` 判，**不能**用 `Number(x) || 0`：
   * 后者会把「没有这一手」与「落在第 0 格」变成同一个值，而第 0 格是一个
   * 完全合法的落点 —— 于是恢复出来的单人局会凭空多出一手死之执的棋。
   */
  readonly deathFlip?: number;
  readonly aliveCount: number;
  readonly netGrowth: number;
}

export interface Session {
  v: number;
  app: string;
  cols: number;
  rows: number;
  /**
   * 对局模式。**旧存档没有这一栏，按 `duel` 读** —— 在 `mode` 存在之前
   * 只可能有双人对弈，把它当单人会让一份双人存档在恢复后少掉一半的行动。
   */
  mode: Mode;
  topology: Topology;
  rules: GameRules;
  openingId: string;
  board: string[];
  turn: number;
  /** 此前各回合的活细胞占比（不含当前局面）—— 防抖判定要用 */
  ratioHistory: number[];
  /** 出现过的局面键 —— repeatBlocked 判定要用（见文件头第 2 条） */
  seen: string[];
  history: StoredTurn[];
  scores: { life: number; death: number };
  aliveMax: number;
  aliveMin: number;
  logs: TurnLog[];
  /** 该局是否已结束（结束后刷新不该「续玩」） */
  finished: boolean;
  savedAt: string;
}

export type SessionInput = Omit<Session, "savedAt" | "v" | "app">;

export type LoadResult =
  | { status: "none" }
  | { status: "ok"; session: Session }
  | { status: "incompatible"; raw: string; reason: string };

let timer = 0;

function canUseStorage(): boolean {
  try {
    return typeof localStorage !== "undefined";
  } catch {
    return false; // 某些隐私模式下访问就会抛
  }
}

/* ══════════════ 序列化 ══════════════ */

export function serializeTurn(rec: TurnRecord): StoredTurn {
  return {
    turn: rec.turn,
    board: toRows(rec.board),
    lifeFlip: rec.lifeFlip,
    // 单人模式下**整个字段不落盘**，不是落一个 0（理由见 StoredTurn 的注释）
    ...(rec.deathFlip === undefined ? {} : { deathFlip: rec.deathFlip }),
    aliveCount: rec.aliveCount,
    netGrowth: rec.netGrowth,
  };
}

/**
 * 反过来。行数与列数由 `cols` 决定（`boardFromRows` 从行文本推宽高），
 * 行数对不上时返回 null —— 让调用方整局作废，而不是造一副尺寸对不上的棋盘。
 */
export function deserializeTurn(s: StoredTurn, cols: number): TurnRecord | null {
  if (!Array.isArray(s.board) || s.board.length === 0) return null;
  if (s.board.some((row) => typeof row !== "string" || row.length !== cols)) return null;
  return {
    turn: Number(s.turn) || 0,
    board: boardFromRows(s.board),
    lifeFlip: Number(s.lifeFlip) || 0,
    // 缺了就是缺了 —— 不补 0。补出来的 0 是一个真实的格号，会让恢复出来的
    // 单人局看起来像「死之执在 (0,0) 落了一子」
    ...(typeof s.deathFlip === "number" && Number.isFinite(s.deathFlip)
      ? { deathFlip: s.deathFlip }
      : {}),
    aliveCount: Number(s.aliveCount) || 0,
    netGrowth: Number(s.netGrowth) || 0,
  };
}

/* ══════════════ 读 ══════════════ */

export function loadSession(): LoadResult {
  if (!canUseStorage()) return { status: "none" };

  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return { status: "none" };
  }
  if (!raw) return { status: "none" };

  let o: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { status: "incompatible", raw, reason: t("sesserr.notObject") };
    }
    o = parsed as Record<string, unknown>;
  } catch {
    return { status: "incompatible", raw, reason: t("sesserr.badJson") };
  }

  const bad = (why: string): LoadResult => ({ status: "incompatible", raw, reason: why });

  // app 标识：把「这是别人的存档」与「这是本应用但读不懂的旧档」分开。
  // 前者只能重置，后者还能抢救 —— 两者的用户可选项不同。
  if (o.app !== SESSION_APP) return bad(t("sesserr.notChess"));

  const v = Number(o.v);
  if (Number.isFinite(v) && v > SESSION_VERSION) {
    return bad(t("sesserr.versionHigh", { v, cur: SESSION_VERSION }));
  }

  if (typeof o.cols !== "number" || typeof o.rows !== "number") return bad(t("sesserr.noSize"));
  if (typeof o.turn !== "number") return bad(t("sesserr.noTurn"));

  const cols = o.cols;
  const board = Array.isArray(o.board) ? (o.board as unknown[]) : [];
  if (board.length !== o.rows || board.some((r) => typeof r !== "string" || r.length !== cols)) {
    return bad(t("sesserr.noBoard"));
  }

  const num = (x: unknown, d: number): number => (Number.isFinite(Number(x)) ? Number(x) : d);

  // 回合记录里任何一行对不上，就整条丢掉 —— 部分恢复出来的历史会让
  // 「记忆」喂给模型一段与棋盘对不上的过去，那比没有记忆更坏
  const history: StoredTurn[] = [];
  if (Array.isArray(o.history)) {
    for (const h of o.history as StoredTurn[]) {
      if (deserializeTurn(h, cols)) history.push(h);
    }
  }

  return {
    status: "ok",
    session: {
      v: Number.isFinite(v) ? v : 0,
      app: SESSION_APP,
      cols,
      rows: o.rows,
      mode: o.mode === "solo" ? "solo" : "duel",
      topology: o.topology === "torus" ? "torus" : "bounded",
      rules: (typeof o.rules === "object" && o.rules !== null ? o.rules : {}) as GameRules,
      openingId: typeof o.openingId === "string" ? o.openingId : "",
      board: board as string[],
      turn: o.turn,
      ratioHistory: Array.isArray(o.ratioHistory) ? (o.ratioHistory as number[]).map((x) => num(x, 0)) : [],
      seen: Array.isArray(o.seen) ? (o.seen as string[]).filter((s) => typeof s === "string") : [],
      history,
      scores: {
        life: num((o.scores as Record<string, unknown> | undefined)?.life, 0),
        death: num((o.scores as Record<string, unknown> | undefined)?.death, 0),
      },
      aliveMax: num(o.aliveMax, 0),
      aliveMin: num(o.aliveMin, 0),
      logs: Array.isArray(o.logs) ? (o.logs as TurnLog[]) : [],
      finished: Boolean(o.finished),
      savedAt: typeof o.savedAt === "string" ? o.savedAt : "",
    },
  };
}

/* ══════════════ 写 ══════════════ */

/** 立即写入，不防抖。用于「重开」「终局」这类必须落盘的时点 */
export function saveSessionNow(s: SessionInput): void {
  if (!canUseStorage()) return;
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  const payload: Session = {
    ...s,
    app: SESSION_APP,
    v: SESSION_VERSION,
    logs: s.logs.slice(-MAX_PERSISTED_LOGS),
    savedAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // 配额满：把日志的**负载**丢掉再试一次。棋盘与回合数是这一局的本体，
    // 日志只是过程记录 —— 两害相权，丢日志。
    try {
      const lean = {
        ...payload,
        logs: payload.logs.map((row) => ({
          ...row,
          life: row.life ? { ...row.life, request: null, response: null } : null,
          death: row.death ? { ...row.death, request: null, response: null } : null,
        })),
      };
      localStorage.setItem(KEY, JSON.stringify(lean));
    } catch {
      /* 仍然写不下就放弃，不影响本次会话 */
    }
  }
}

/** 防抖写入。每回合结束时调用 */
export function saveSession(s: SessionInput): void {
  if (!canUseStorage()) return;
  if (timer) clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = 0;
    saveSessionNow(s);
  }, SAVE_DEBOUNCE_MS);
}

export function clearSession(): void {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  if (!canUseStorage()) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** 直接读出原始字符串，用于「导出旧的不兼容数据」 */
export function rawSession(): string | null {
  if (!canUseStorage()) return null;
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
