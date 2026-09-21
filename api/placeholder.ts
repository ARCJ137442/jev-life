/**
 * 占位文件 —— T12 会删掉它，换成真正托管在 Vercel 上的 api/evaluate.ts 等。
 *
 * 为什么需要它：`npm run typecheck` 的第三段是 `tsc -p tsconfig.api.json`，
 * 而那份配置把 api 目录下的全部 .ts 都 include 进来。目录里一个文件都没有时
 * tsc 直接报 TS18003（No inputs were found in config file）并中止 ——
 * 于是整条 typecheck 还没检查到任何一行真代码就先红了。
 * 留一个最小的合法输入把它顶住。
 *
 * 只导出一个类型而不是函数：noUnusedLocals 之下，任何真正被声明的运行时值
 * 都会因为没有调用方而报错。
 */
export type Placeholder = never;
