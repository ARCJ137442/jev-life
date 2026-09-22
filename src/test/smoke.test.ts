/**
 * 工具链冒烟测试。
 *
 * 为什么需要它：start.sh 里有 `node --test dist-test/test/*.test.js`。
 * 在 T3 之前 dist-test/test/ 是空的，bash 会把没有匹配的 glob 原样传给
 * node，node 把那个字面量当文件名，报错退出 —— 管道在「运行单元测试」
 * 这一步就红。与其给 start.sh 加一条特例，不如放一个真断言工具链的用例：
 * 它让管道从 T2 起就是绿的，而且它检查的东西本来就是整个项目的前提。
 *
 * T3 加入真正的 core/ 测试后这个文件可以留着 —— 工具链坏掉时的报错
 * 会出现在最前面，比「所有 core 测试一起失败」好定位得多。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 编译产物在 dist-test/test/，往上两级才是仓库根
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Termux 下 tsc 的 shebang 不可用，一律用 node 执行它的 JS 入口（见 CLAUDE.md）
const TSC = "node_modules/typescript/bin/tsc";

test("Node 版本 ≥ 22 —— tools/*.ts 靠 type-stripping 直接跑", () => {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 22, `需要 Node ≥ 22，当前 ${process.versions.node}`);
});

test("六份 tsconfig 都在，且 **tsc 读得动**（用真正的消费者校验，不是 JSON.parse）", () => {
  // 每份配置对应编译管道的一段，缺任何一份 start.sh 都会中途断。
  // 在这里先失败一次，报错信息比 tsc 的 "Cannot read file" 直接得多。
  //
  // ⚠ 判据是 `tsc --showConfig` 而不是 `JSON.parse`：**tsconfig 是 JSONC** ——
  //    合法的配置文件里允许写注释，而 `JSON.parse` 不认。
  //
  //    这条曾经两处都错：用 `JSON.parse` 判、且名单里**少了 `tsconfig.tools.json`**
  //    —— 于是那份确实带着注释的配置**从没被查过**，规则空转了不知多久；
  //    而给 `tsconfig.api.json` 加上注释（解释 Vercel 那次 500 的教训）时，
  //    它当场红了。换成用真正的消费者来判，两个问题一起消失。
  const names = [
    "tsconfig.base.json",
    "tsconfig.client.json",
    "tsconfig.server.json",
    "tsconfig.api.json",
    "tsconfig.test.json",
    "tsconfig.tools.json",
  ];
  for (const name of names) {
    assert.doesNotThrow(
      () =>
        execFileSync(process.execPath, [TSC, "--showConfig", "-p", name], {
          cwd: ROOT,
          stdio: "pipe",
        }),
      `${name} 读不动（tsc --showConfig 失败）`,
    );
  }
});
