/**
 * 占位模块 —— T3 会删除它。
 *
 * 为什么需要它：tsconfig.test.json 的 include 全是还没有内容的目录，
 * `tsc -p tsconfig.test.json` 会直接报 "No inputs were found in config file"
 * 而连编译都不开始。留一个最小的合法输入，让 T1 就能验证工具链本身是通的。
 *
 * 这里刻意只放一个类型导出而不是函数：noUnusedLocals 之下，任何真正被
 * 声明的运行时值都会因为没有调用方而报错。
 */
export type Placeholder = never;
