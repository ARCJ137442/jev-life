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
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 编译产物在 dist-test/test/，往上两级才是仓库根
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("Node 版本 ≥ 22 —— tools/*.ts 靠 type-stripping 直接跑", () => {
  const major = Number(process.versions.node.split(".")[0]);
  assert.ok(major >= 22, `需要 Node ≥ 22，当前 ${process.versions.node}`);
});

test("tsconfig 五份配置都在，且都是合法 JSON", () => {
  // 每份配置对应编译管道的一段，缺任何一份 start.sh 都会中途断。
  // 在这里先失败一次，报错信息比 tsc 的 "Cannot read file" 直接得多。
  const names = [
    "tsconfig.base.json",
    "tsconfig.client.json",
    "tsconfig.server.json",
    "tsconfig.api.json",
    "tsconfig.test.json",
  ];
  for (const name of names) {
    const raw = readFileSync(join(ROOT, name), "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), `${name} 不是合法 JSON`);
  }
});
