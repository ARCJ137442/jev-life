/**
 * `tools/` 怎么拿到 `core/` —— **全仓唯一的规矩就写在这一个文件里**。
 *
 * ═══ 规矩（三条，其余写法一律不要用）═══
 *
 * 1. **`tools/` 内部互相 import 用 `.ts` 后缀**（`import { loadCore } from "./_load.ts"`）。
 *    `src/` 用 `.js` 是另一回事 —— 那边是先编译再运行，`.js` 是编译产物的真实后缀。
 *    而 `tools/*.ts` 由 Node 的 type-stripping **直接运行**，Node 不做
 *    `.js` → `.ts` 的重写，写 `.js` 会当场 ERR_MODULE_NOT_FOUND。
 *    这条差异是实测出来的，不是约定俗成。
 *
 * 2. **要「类型」就直接 `import type ... from "../src/..."`，带 `.js` 后缀。**
 *    类型在运行前被整个擦掉，不涉及模块解析，所以它没有上面那个问题。
 *
 * 3. **要「运行时能力」一律走本模块的 `loadCore()`**，绝不自己 import `dist-test`
 *    —— 那样每个工具都会各写一遍存在性检查，而漏掉的那一个就会拿过期产物
 *    跑出一张看起来完全正常的错表。**这个坑真实发生过一次**（T6 的基准测试，
 *    详见 DESIGN.md）。
 *
 * ═══ 为什么是「加载编译产物」而不是别的办法 ═══
 *
 * 三个候选，各自为什么不选：
 *   - 直接 import `../src/core/life.js`：Node 不重写后缀，跑不起来（实测）。
 *   - 用 `.ts` 后缀 import 源码：`life.ts` 自己的 `./types.js` 同样解析不了，
 *     要能跑就得把整个 `src/` 的相对 import 全改成 `.ts` —— 那会破坏
 *     `src/` 的编译产物契约，代价远大于收益。
 *   - 走 CLI 子命令（`node dist-test/cli.js <子命令>`）：跨进程边界后，
 *     像基准测试这种要在 core 上跑几万次的场景没法用 —— 要么把整个
 *     基准测试搬进 `src/`，要么每次调用背一次进程启动开销。
 *
 * 代价（必须明说）：**用之前必须先编译**。所以本模块把「产物不存在」
 * 和「产物比源码旧」都当成**硬错误**处理，退出码 1。
 *
 * 这一条是刻意的：**「没测」和「测了没问题」必须长得不一样。**
 * 退出码 0 意味着「跑完了、结果如上」，而脚本一旦退出 0，任何 shell
 * 管道都会把「根本没跑」当成「跑过了」。同一个教训在 `tools/scan.ts`
 * 的文件头有完整复盘（判据依赖目标的呈现形式 → 工具报的是「干净」
 * 而不是「没查」）。诊断工具只在「跑完了但结果不好看」时才该退出 0。
 */
import { readdirSync, statSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const DIST = new URL("dist-test/", ROOT);

/**
 * 与 tools 有关的源码子树。
 *
 * 只盯这两个而不是整个 `src/`：改 `src/client/` 的渲染逻辑不该让一个
 * 核心引擎的基准测试拒绝运行 —— 那种误报会很快把人训练成「看到提示就绕过」，
 * 而一个会被绕过的检查等于没有检查。
 */
const WATCHED = ["src/core/", "src/shared/"] as const;

function exists(url: URL): boolean {
  try {
    statSync(url);
    return true;
  } catch {
    return false;
  }
}

/** 递归取目录下所有 .ts 里最新的 mtime；目录不存在则返回 0 */
function newestSourceMtime(dir: URL): { time: number; file: string } {
  let newestTime = 0;
  let newestFile = "";
  const stack: URL[] = [dir];

  while (stack.length > 0) {
    const cur = stack.pop() as URL;
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // 目录不存在 —— 交给调用方按「没有可对照的源码」处理
    }
    for (const entry of entries) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), cur);
      if (entry.isDirectory()) {
        stack.push(child);
      } else if (entry.name.endsWith(".ts")) {
        const t = statSync(child).mtimeMs;
        if (t > newestTime) {
          newestTime = t;
          newestFile = entry.name;
        }
      }
    }
  }
  return { time: newestTime, file: newestFile };
}

function bail(lines: string[]): never {
  console.log("✗ 拿不到 core，本次**没有运行**：");
  for (const l of lines) console.log(`    ${l}`);
  console.log("  ↑ 这句不是「跑过了没问题」。");
  process.exit(1);
}

/**
 * 加载 `dist-test/<relPath>`（如 `"core/life.js"`），并保证它不比源码旧。
 *
 * 类型由调用方给出，因为它来自源码：
 * ```ts
 * type LifeModule = typeof import("../src/core/life.js");
 * const life = await loadCore<LifeModule>("core/life.js");
 * ```
 */
export async function loadCore<T>(relPath: string): Promise<T> {
  const artifact = new URL(relPath, DIST);

  if (!exists(artifact)) {
    bail([
      `找不到编译产物 ${artifact.pathname}`,
      "先编译：",
      "  node node_modules/typescript/bin/tsc -p tsconfig.test.json",
    ]);
  }

  const artifactTime = statSync(artifact).mtimeMs;
  let newestTime = 0;
  let newestFile = "";
  for (const dir of WATCHED) {
    const got = newestSourceMtime(new URL(dir, ROOT));
    if (got.time > newestTime) {
      newestTime = got.time;
      newestFile = got.file;
    }
  }

  if (newestTime > artifactTime) {
    bail([
      `编译产物比源码旧（源码 ${newestFile} 更新），跑下去测的是**过期代码**`,
      "先重新编译：",
      "  node node_modules/typescript/bin/tsc -p tsconfig.test.json",
    ]);
  }

  return (await import(artifact.href)) as T;
}
