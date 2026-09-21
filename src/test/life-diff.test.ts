import { test } from "node:test";
import assert from "node:assert/strict";

import { bitwiseStep, lifeStep, referenceStep, toRows } from "../core/life.js";
import type { Board, Topology } from "../core/types.js";

/**
 * 差分测试：每个演化实现都必须与 referenceStep 逐格一致。
 *
 * ═══ 为什么是「参数化到实现」，而不是只比 lifeStep ═══
 *
 * T6 按实测把生产实现换成了朴素算法，于是 `lifeStep` 与 `referenceStep`
 * **都是朴素邻居计数、共享同一套概念模型**。真出现概念性错误（比如两者
 * 对 torus 环绕的理解一起错），这两条腿会一起瘸。
 * `bitwiseStep` 是唯一一条**建模方式完全不同**的腿（位平面 BigInt），
 * 它能抓住的正是前两条一起错的那种错。
 *
 * 这个参数化不是预防性设计，是对一次实测事故的修补：T6 之后只比 lifeStep 时，
 * 把 `bitwiseStep` 的 n2 判据改坏（`const n2 = b1;`），
 * **31 个测试全绿，一条都没拦住** —— 一条没人比对的实现等于没有实现。
 *
 * 失败消息里必须带实现名，否则失败了分不清是哪条腿断的。
 */
const IMPLS = [
  { name: "lifeStep", fn: lifeStep },
  { name: "bitwiseStep", fn: bitwiseStep },
] as const;

/** mulberry32 —— 小而确定的 PRNG。失败时能凭 seed 复现出同一副棋盘 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBoard(cols: number, rows: number, p: number, rand: () => number): Board {
  const cells = new Uint8Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = rand() < p ? 1 : 0;
  return { cols, rows, cells };
}

/** 尺寸覆盖方形与非方形 —— 非方形是位并行最容易写错的地方（行宽与总长不等） */
const SIZES = [
  [4, 4],
  [5, 7],
  [6, 6],
  [8, 8],
  [8, 12],
  [13, 5],
  [16, 16],
] as const;

/** 稀疏与稠密会走到不同的分支：极稀疏时 sum 恒为 0，稠密时每 nibble 逼近 8 */
const DENSITIES = [0.05, 0.2, 0.35, 0.5, 0.8] as const;

const TOPOLOGIES: readonly Topology[] = ["bounded", "torus"];

/** 断言的失败消息要能直接粘回测试文件当回归用例，所以带上完整输入与两份输出 */
function explain(
  impl: string,
  cols: number,
  rows: number,
  topo: Topology,
  p: number,
  seed: number,
  b: Board,
  got: string[],
  want: string[],
): string {
  return (
    `不一致：impl=${impl} ${cols}×${rows} topo=${topo} p=${p} seed=${seed}\n` +
    `输入：\n${toRows(b).join("\n")}\n` +
    `${impl}：\n${got.join("\n")}\n` +
    `referenceStep：\n${want.join("\n")}\n`
  );
}

test("每个实现都与 referenceStep 在所有尺寸 × 两种拓扑 × 多种密度下一致", () => {
  for (const impl of IMPLS) {
    // 下限断言**逐实现**成立：总数达标可能是被另一条腿撑起来的，
    // 那样其中一条悄悄退化成空转也看不出来。
    let checked = 0;

    for (const [cols, rows] of SIZES) {
      for (const topo of TOPOLOGIES) {
        for (const p of DENSITIES) {
          const seed = cols * 1000 + rows * 10 + Math.round(p * 100);
          const rand = rng(seed);
          for (let trial = 0; trial < 30; trial++) {
            const b = randomBoard(cols, rows, p, rand);
            const got = toRows(impl.fn(b, topo));
            const want = toRows(referenceStep(b, topo));
            checked++;
            assert.deepEqual(
              got,
              want,
              explain(impl.name, cols, rows, topo, p, seed, b, got, want),
            );
          }
        }
      }
    }

    // 防止用例被悄悄改空 —— 源仓库的差分测试也做了同样的下限断言。
    // 一条从不失败的测试等于没有测试，而下限断言是「它还在真的比对」的机器保证。
    assert.ok(checked >= 2000, `${impl.name}：比对次数过少：${checked}`);
  }
});

test("每个实现连续多代演化后仍与 referenceStep 逐格一致", () => {
  // 单代比对覆盖的是「随便撒的棋盘」；这里覆盖的是**演化可达**的局面 ——
  // 它们会迅速变得比随机棋盘稀疏得多，走到单代比对碰不到的分支上。
  for (const impl of IMPLS) {
    let checked = 0;

    for (const [cols, rows] of SIZES) {
      for (const topo of TOPOLOGIES) {
        const rand = rng(cols * 7919 + rows * 104729);
        const b = randomBoard(cols, rows, 0.35, rand);
        let a = b;
        let c = b;
        for (let gen = 1; gen <= 6; gen++) {
          a = impl.fn(a, topo);
          c = referenceStep(c, topo);
          checked++;
          assert.deepEqual(
            toRows(a),
            toRows(c),
            `第 ${gen} 代起分岔：impl=${impl.name} ${cols}×${rows} topo=${topo}\n` +
              `起点：\n${toRows(b).join("\n")}\n` +
              `${impl.name}：\n${toRows(a).join("\n")}\n` +
              `referenceStep：\n${toRows(c).join("\n")}\n`,
          );
        }
      }
    }

    assert.ok(checked >= 84, `${impl.name}：比对次数过少：${checked}`);
  }
});

test("每个实现都是纯函数，不改动入参", () => {
  for (const impl of IMPLS) {
    const b = randomBoard(8, 8, 0.3, rng(1));
    const before = Array.from(b.cells);
    impl.fn(b, "bounded");
    impl.fn(b, "torus");
    assert.deepEqual(Array.from(b.cells), before, `${impl.name} 修改了入参`);
  }
});

test("每个实现连续 5 次结果稳定（无隐藏状态）", () => {
  for (const impl of IMPLS) {
    const b = randomBoard(6, 6, 0.3, rng(7));
    const first = toRows(impl.fn(b, "torus"));
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(toRows(impl.fn(b, "torus")), first, `${impl.name} 连续调用结果不稳定`);
    }
  }
});
