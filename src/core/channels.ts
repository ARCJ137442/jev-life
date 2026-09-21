/**
 * 评估通道 —— 一次请求问什么、回包怎么读。
 *
 * ═══ 一条通道 = 一个请求 ═══
 *
 * `buildQuestions`（`context.ts`）返回**完整的** `Questions` record，调用方把它
 * **一次性**发出去，**绝不循环**。理由不只是省往返 —— 实测是「上下文越短越可靠」：
 * 每多一次调用就多一次静默失败的机会（思维链吃光 max_tokens → content 为空 →
 * 一个答案都没有）。
 *
 * 这条约束的代价是**回包必须整批正确**：一条坏参数就能毁掉整批。所以下面的
 * 解析一律**失败即抛**，不猜、不补、不跳过。
 *
 * ═══ M1 只实现 noul-all ═══
 *
 * `choice-all` 与 `choice-filtered` 的类型先定下来（免得以后回头改签名），
 * 实现抛「未实现」。这样「三条通道」在类型层面是齐的，而调用方不会在
 * 运行时拿到一个空分布冒充结果。
 *
 * ═══ 为什么解析失败必须炸 ═══
 *
 * `noulProbability()` 在两家键名都缺时**返回 0**。于是一个「模型没答这一题」的
 * 回包会变成「模型认为这一格很不利」—— 一份完全合法、完全可用的概率分布，
 * 会一路走到决策层被当成真数据用。整局实验的结论就此被污染，而画面上
 * 看不出任何异常。**这正是本项目最该防的那种错：症状与原因无关。**
 *
 * 所以这里宁可炸。缺键、多键、没有概率字段、概率越界、格子对该角色非法 ——
 * 全部当场抛错，并且**点名是哪一题、为什么**。
 */
import { legalCells } from "./life.js";
import type { CellProbabilities } from "./decide.js";
import type { Board, Cell, Role } from "./types.js";
import type { Answer, BooleanAnswer } from "../shared/types.js";

/* ══════════════════════════════════════════════════════════════════
   通道
   ══════════════════════════════════════════════════════════════════ */

export type FilterId = string;

/**
 * 三条评估通道。
 *
 * `backend` 放在通道上而不在 `StateInput` 里：判别值（`noul` / `boolean`）是
 * **怎么跟上游说话**的细节，而 state 是**博弈本身**的快照 —— 把传输层的东西
 * 塞进 state，会让「同一局棋换个后端」变成两个不同的 state。
 *
 * ⚠ 只有 `noul-all` 带 `backend`：`choice` 与 `score` 的判别值四家一致，
 * 只有布尔类型在 Vercel 上被改名成了 `boolean`。
 */
export type Channel =
  | { kind: "noul-all"; backend?: string }
  | { kind: "choice-all" }
  | { kind: "choice-filtered"; filter: FilterId };

/** M1 只实现了这一条 */
const IMPLEMENTED = "noul-all";

/* ══════════════════════════════════════════════════════════════════
   键名
   ══════════════════════════════════════════════════════════════════ */

/**
 * `noul-all` 的键名形状：`flip_行_列`。
 *
 * 行与列而不是一维格号：题面里给模型看的就是 `(行, 列)` 坐标（见 `context.ts`
 * 的 `board_legend`），回包用同一套坐标才不用让模型自己做一次换算 ——
 * 而那一次换算是它最容易算错的地方。
 */
const NOUL_KEY = /^flip_(\d+)_(\d+)$/;

function noulKey(board: Board, cell: Cell): string {
  return `flip_${Math.floor(cell / board.cols)}_${cell % board.cols}`;
}

/** 一个不在题面上的键，**为什么**不在 —— 错误信息要能直接指出原因 */
function explainUnexpected(board: Board, role: Role, key: string): string {
  const m = NOUL_KEY.exec(key);
  if (!m) return "不是 flip_行_列 的形状";
  const r = Number(m[1]);
  const c = Number(m[2]);
  if (r >= board.rows || c >= board.cols) {
    return `行列越界（棋盘是 ${board.rows} 行 × ${board.cols} 列）`;
  }
  const want = role === "life" ? "死格" : "活格";
  return `该角色翻不了这一格（${
    role === "life" ? "生之执" : "死之执"
  }只能翻${want}），或者棋盘与回包不是同一副`;
}

/** 列表太长时截断 —— 错误信息是给人读的，不是把 256 个键全倒出来 */
function brief(keys: readonly string[], limit = 8): string {
  const head = keys.slice(0, limit).join("、");
  return keys.length > limit ? `${head} 等 ${keys.length} 个` : head;
}

/* ══════════════════════════════════════════════════════════════════
   解析
   ══════════════════════════════════════════════════════════════════ */

/**
 * 一个答案里的概率。
 *
 * ★ **两个键名都没有时抛错，绝不当成 0。**
 * `noulProbability()` 的设计是「抹平两家键名差异」，它的 `?? 0` 是为了让
 * 「读到一半的合法回包」也能用。但在这里，「没有概率字段」只可能是回包坏了 ——
 * 把它读成 0 等于替模型说了一句它没说过的话。
 */
function probabilityOf(key: string, a: Answer): number {
  const raw = (a as BooleanAnswer).noul ?? (a as BooleanAnswer).probability;
  if (typeof raw !== "number") {
    throw new Error(
      `答案「${key}」里没有概率字段（type=${String((a as { type?: unknown }).type)}）。` +
        `布尔答案的概率要么在 noul 里（官方 / OpenRouter），要么在 probability 里（Vercel）——` +
        `两个都没有，说明回包不符合预期；**不能当成 0**，那等于替模型说了一句它没说过的话`,
    );
  }
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new Error(`答案「${key}」的概率是 ${String(raw)}，不是 [0,1] 区间内的有限数`);
  }
  return raw;
}

/**
 * 把一条通道的回包统一解析成「每格一个概率」。
 *
 * `board` 与 `role` 必须与**组题时用的是同一副**：合法集决定题面，题面决定
 * 回包里该有哪些键。对不上就抛错（「多出来的键」和「缺了的键」都会被抓到），
 * 而不是让一份错位的分布悄悄流进决策层。
 *
 * 返回的 Map 按**格号升序**，与回包里键的书写顺序无关 ——
 * 测量要求「同一个分布 ⟹ 同一个落子」，而落子顺序会影响同概率时的取舍。
 */
export function parseAnswers(
  channel: Channel,
  answers: Record<string, Answer>,
  board: Board,
  role: Role,
): CellProbabilities {
  if (channel.kind !== IMPLEMENTED) {
    throw new Error(
      `通道「${channel.kind}」尚未实现：M1 只实现 ${IMPLEMENTED}，` +
        `choice-all 与 choice-filtered 由后续任务补`,
    );
  }

  const legal = legalCells(board, role);
  if (legal.length === 0) {
    throw new Error(
      `${
        role === "life" ? "生之执" : "死之执"
      }没有可翻的格子（棋盘 ${board.cols}×${board.rows}）—— ` +
        "这种情况应当由终局判定先结束对局，而不是去解析一份没有题目的回包",
    );
  }

  const keys = Object.keys(answers);
  if (keys.length === 0) {
    throw new Error("回包里的 answers 是空的 —— 没有任何答案就没有分布");
  }

  const expected = new Set(legal.map((cell) => noulKey(board, cell)));

  // 先按合法集（升序）取，顺序才是确定的
  const out = new Map<Cell, number>();
  const missing: string[] = [];
  for (const cell of legal) {
    const key = noulKey(board, cell);
    if (!Object.hasOwn(answers, key)) {
      missing.push(key);
      continue;
    }
    out.set(cell, probabilityOf(key, answers[key]));
  }

  const unexpected = keys.filter((k) => !expected.has(k));

  if (missing.length > 0 || unexpected.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `缺了 ${missing.length} 题：${brief(missing)}。` +
          "一条通道 = 一个请求，题面问了几格就该回几格 —— " +
          "少几格会让剩余的概率被轮盘赌放大，等于悄悄改了模型的话",
      );
    }
    if (unexpected.length > 0) {
      const detail = unexpected
        .slice(0, 4)
        .map((k) => `${k}（${explainUnexpected(board, role, k)}）`)
        .join("；");
      parts.push(
        `多出 ${unexpected.length} 个不在题面上的键：${brief(unexpected)}。` +
          `判断依据：${detail}` +
          (unexpected.length > 4 ? " …" : ""),
      );
    }
    throw new Error(`回包与题面对不上：${parts.join(" ")}`);
  }

  return out;
}
