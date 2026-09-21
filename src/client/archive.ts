/**
 * 存档导入导出。
 *
 * 四类内容各自独立成档：
 *   game      对局 + 对局级设置 + 双方玩家级设置
 *   strategy  双方玩家级设置里的「上下文 + 规则」那部分
 *   api       重试参数。**密钥从不参与** —— 它连内存以外的地方都不去
 *   log       调用日志，只导出不导入
 *
 * 每份档案都带 `app`（`"jev-life"`）、`v`（schema 版本）与 `kind`。**导入时
 * 先验 `app`**：2048 的存档结构与生命棋完全不同，而两者的导出文件名与
 * 内部字段名都长得很像 —— 不验归属的话，一次误选文件会把一份 2048 的棋盘
 * 当成生命棋的棋盘读进来，报出来的错还离真正的原因很远。
 *
 * ═══ 密钥为什么连「导出」都没有 ═══
 *
 * 密钥只在浏览器内存里（代理模式下更是连浏览器都拿不到）。存档要落盘，
 * 落盘就可能被同步、被分享、被贴进 issue。所以这里不是「导出时过滤掉密钥」，
 * 而是**这一层根本拿不到密钥** —— 它只接受 `RoleSettings`，而那个类型里
 * 没有密钥字段。类型上够不着的字段，不会因为某次重构被顺手加回来。
 */
import type { Role } from "../core/types.js";
import type { TurnLog } from "./session.js";
import type { SessionInput } from "./session.js";
import {
  DEFAULT_API,
  DEFAULT_DUEL,
  defaultRole,
  type ApiSettings,
  type ArchiveSettings,
  type DuelSettings,
  type RoleSettings,
} from "./config.js";
import { t } from "./i18n.js";

/** 档案格式版本。字段结构变更时递增，用于识别不兼容的旧档 */
export const ARCHIVE_VERSION = 1;

/** 档案归属标识。导入时逐字比对 */
export const ARCHIVE_APP = "jev-life";

export type ArchiveKind = "game" | "strategy" | "api" | "log" | "all";

export interface Archive {
  app: string;
  v: number;
  kind: ArchiveKind;
  exportedAt: string;
  /** 导出时的应用信息，便于人工辨认 */
  meta?: { cols?: number; rows?: number; turn?: number; openingId?: string };
  payload: unknown;
}

/* ══════════════ 导出 ══════════════ */

export interface GamePayload {
  duel: DuelSettings;
  roles: Record<Role, RoleSettings>;
  session: SessionInput | null;
}

export interface StrategyPayload {
  roles: Record<Role, RoleSettings>;
}

export interface ApiPayload {
  api: ApiSettings;
}

export interface LogPayload {
  logs: TurnLog[];
}

export function buildArchive(
  kind: ArchiveKind,
  store: ArchiveSettings,
  session: SessionInput | null,
  logs: TurnLog[],
): Archive {
  const base = {
    app: ARCHIVE_APP,
    v: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
  };
  const meta = {
    cols: store.duel.cols,
    rows: store.duel.rows,
    turn: session?.turn ?? 0,
    openingId: store.duel.openingId,
  };

  switch (kind) {
    case "game":
      return { ...base, kind, meta, payload: { duel: store.duel, roles: store.roles, session } satisfies GamePayload };

    case "strategy":
      return { ...base, kind, payload: { roles: store.roles } satisfies StrategyPayload };

    case "api":
      // 只有重试参数。密钥从来不在 store 里
      return { ...base, kind, payload: { api: store.api } satisfies ApiPayload };

    case "log":
      return { ...base, kind, payload: { logs } satisfies LogPayload };

    case "all":
      return {
        ...base,
        kind,
        meta,
        payload: {
          duel: store.duel,
          roles: store.roles,
          api: store.api,
          session,
          logs,
        },
      };
  }
}

function stamp(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}` +
    `-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`
  );
}

function saveBlob(text: string, filename: string): void {
  const blob = new Blob([text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 交给浏览器读完再回收，立即 revoke 在部分浏览器上会截断下载
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 触发浏览器下载。文件名带时间戳，便于多次导出后区分 */
export function download(archive: Archive, label: string): void {
  saveBlob(JSON.stringify(archive, null, 2), `jev-life-${label}-${stamp()}.json`);
}

/** 把任意 JSON 文本下载下来（用于「导出旧的不兼容数据」） */
export function downloadRaw(text: string, label: string): void {
  saveBlob(text, `jev-life-${label}-raw.json`);
}

/* ══════════════ 导入 ══════════════ */

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * 解析并校验一份档案。
 *
 * 校验刻意做得严格：宁可明确报错让用户重新导出，也不要把结构不对的数据
 * 悄悄写进状态 —— 那会产出更难排查的问题。
 */
export function parseArchive(text: string): Archive {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new ArchiveError(t("arcerr.badJson"));
  }
  if (!isObj(o)) throw new ArchiveError(t("arcerr.notObject"));
  if (o.app !== ARCHIVE_APP) throw new ArchiveError(t("arcerr.notOurs"));

  const v = Number(o.v);
  if (!Number.isFinite(v)) throw new ArchiveError(t("arcerr.noVersion"));
  if (v > ARCHIVE_VERSION) {
    throw new ArchiveError(t("arcerr.versionHigh", { v, cur: ARCHIVE_VERSION }));
  }

  const kinds: ArchiveKind[] = ["game", "strategy", "api", "log", "all"];
  if (!kinds.includes(o.kind as ArchiveKind)) {
    throw new ArchiveError(t("arcerr.unknownKind", { kind: String(o.kind) }));
  }
  if (!("payload" in o) || !isObj(o.payload)) {
    throw new ArchiveError(t("arcerr.noPayload"));
  }

  return o as unknown as Archive;
}

export interface ImportResult {
  duel?: DuelSettings;
  roles?: Record<Role, RoleSettings>;
  api?: ApiSettings;
  session?: SessionInput | null;
  logs?: TurnLog[];
  /** 该档案属于哪一类 */
  kind: ArchiveKind;
}

/**
 * 把档案里的字段取出来并做类型兜底，交给调用方决定如何应用。
 *
 * 这里只做**形状**兜底（缺字段补默认值），不做取值校验 —— 后者归 `config.ts`
 * 的 `clamp*` 系列。一份被手改过的存档因此走的是与「本地已有配置」完全相同的
 * 那条规范化路径，不会出现「导入的路径更宽松」这种只有一条入口才有的漏洞。
 */
export function extract(archive: Archive): ImportResult {
  const p = archive.payload as Record<string, unknown>;
  const out: ImportResult = { kind: archive.kind };

  const asRole = (v: unknown): RoleSettings | undefined =>
    isObj(v) ? { ...defaultRole(), ...(v as Partial<RoleSettings>) } : undefined;

  const asRoles = (v: unknown): Record<Role, RoleSettings> | undefined => {
    if (!isObj(v)) return undefined;
    const life = asRole(v.life);
    const death = asRole(v.death);
    return life && death ? { life, death } : undefined;
  };

  const asDuel = (v: unknown): DuelSettings | undefined =>
    isObj(v) ? { ...DEFAULT_DUEL, ...(v as Partial<DuelSettings>) } : undefined;

  const asApi = (v: unknown): ApiSettings | undefined =>
    isObj(v) ? { ...DEFAULT_API, ...(v as Partial<ApiSettings>) } : undefined;

  if (archive.kind === "all" || archive.kind === "game") {
    out.duel = asDuel(p.duel);
    out.roles = asRoles(p.roles);
    out.session = (p.session as SessionInput | null) ?? null;
    if (archive.kind === "all") {
      out.api = asApi(p.api);
      out.logs = Array.isArray(p.logs) ? (p.logs as TurnLog[]) : undefined;
    }
    return out;
  }

  if (archive.kind === "strategy") {
    out.roles = asRoles(p.roles);
    return out;
  }

  if (archive.kind === "api") {
    out.api = asApi(p.api);
    return out;
  }

  // log：只导出，导入时明确拒绝
  throw new ArchiveError(t("arcerr.logNoImport"));
}

/** 读取用户选中的文件 */
export function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result ?? ""));
    fr.onerror = () => reject(new ArchiveError(t("arcerr.readFail")));
    fr.readAsText(file);
  });
}
