# 部署指南

面向不熟悉 Vercel / GitHub Pages 控制台的人。按顺序做即可，全程只需要在浏览器里点。

**两种部署形态可以只做一种**，也可以都做：

| 形态 | 能得到什么 | 密钥放在哪 |
|---|---|---|
| **Vercel** | 完整功能，三条「免费试用」后端都能用 | Vercel 项目的**环境变量** |
| **GitHub Pages** | 纯静态页面，后端**跨域调用 Vercel 那份** | **不持有** —— 静态页面拿不到任何凭据 |

---

## 为什么密钥必须放在服务端

浏览器不带任何凭据请求 `/api/evaluate`、`/api/evaluate2`、`/api/evaluate3`，
由 **Vercel 上的 Serverless Function** 补上密钥再转发出去。

密钥只在函数进程内被读取，**从不进入响应体或客户端代码**。

> **密钥不要放进 GitHub Secrets。** 那会多一个泄漏面而没有任何好处 ——
> 它不是给 GitHub Actions 用的，是给 Vercel 运行时用的。

---

## 准备工作：先拿到密钥

按你打算启用的后端准备，**只配一部分也能跑**，没配的会自动显示为不可用。

| 后端 | 环境变量 | 密钥从哪拿 |
|---|---|---|
| Jev 免费试用 1（`/api/evaluate`） | `VERCEL_AI_GATEWAY_KEY`，形如 `vck_...` | <https://vercel.com/dashboard> → 顶部 **AI** → **AI Gateway** → **API Keys** → Create |
| Jev 免费试用 2（`/api/evaluate2`） | `OPENROUTER_API_KEY`，形如 `sk-or-v1-...` | <https://openrouter.ai/settings/keys> → **Create Key** |
| **LLM 免费试用 1**（`/api/evaluate3`） | `AGNES_API_KEY` | 由该提供商的个人后台签发 |

**给这几把钥匙都设消费上限。** 公开端点没有鉴权（见文末「担心被刷」），
**账单上的限制比代码里的限制可靠得多**。

---

## 一、部署到 Vercel

### 1. 导入仓库

1. 打开 <https://vercel.com/new>
2. **Import Git Repository** → 第一次用要先 **Add GitHub Account** 授权
   （只授权这一个仓库即可）
3. 选中你的仓库 → **Import**
4. 如果展开了 **Configure Project**：**Framework Preset 保持默认的 `Other`**
   （自动识别成 `Other` 就对了，别去挑 `Next.js` / `Vite` / `Create React App` 之类）

Vercel 会自己读仓库里的 `vercel.json`，构建配置不用手填。

> ⚠ **为什么框架预设要留 `Other`**：`vercel.json` 里写的是 `"framework": null`
> 加**显式的** `buildCommand` 与 `outputDirectory`。选任何具体框架预设，都会套上
> 那个框架自己的默认输出目录与构建命令，与仓库里的声明**冲突** ——
> 而冲突的结果**不是报错**，是构建出一个空站点或者一个错目录的站点，
> 界面能打开、资源全 404。本项目的构建产物在 `public/`（由 `tsconfig.client.json`
> 编译出来），不是任何框架的默认目录。

### 2. 配置环境变量

**在点 Deploy 之前**，展开 **Environment Variables**，按上表逐条添加。
每条要设两栏：

| 这一栏 | 选什么 |
|---|---|
| **Type（类型）** | **Secret** |
| **Environments（环境）** | **Production + Preview**（**不要**勾 Development） |

**类型选 Secret 的理由**：Secret 保存后**只写不可读** —— 谁也读不回来，只有构建与
函数运行时能用它。三把钥匙都是 API key / token，正属于这一类。

**环境只勾 Production + Preview 的理由**：

- 本项目的**本地开发根本不读 Vercel 环境变量**。本地服务器（`./start.sh` 启动的那个）
  是从**仓库外**的 `../local/` 目录读密钥文件，三档优先级：
  环境变量 > `*.sealed` > 明文（见 `src/server/server.ts` 的 `loadKey`）。
  所以勾 Development **不会**让本地多出任何东西。
- 勾了也拿不到值：Secret 是只写的，`vercel env pull` 拉下来的只是**占位符**，
  不是真值 —— 本地要能跑，密钥得自己放到 `../local/`。
- **Preview 要勾**：每次预览部署是**独立域名**，不勾的话预览版一律回 503。
  上线前拿预览域名验一遍（见下一节的三条 URL）是最省事的做法。

⚠️ **变量名必须一模一样**，大小写敏感。

> Secret 的值**填进去就再也读不出来了**（连你自己在控制台里也看不到）。
> 先把原始密钥存到别处再填。要换值就编辑这一条重填一遍；
> **改 key 名只能删了重建**（Secret 不允许原地改 key）。

写错时函数返回 503，但**错误信息不会告诉你缺哪个变量** —— 这是刻意的：
响应体里出现 `AGNES_API_KEY` 这样的变量名，等于把「免费试用背后是哪家」直接告诉访客。
**缺哪个变量只写在 Vercel 的 Function 日志里**：项目 → **Logs** → 找那条 503。

### 3. 部署与验证

点 **Deploy**。完成后在地址栏直接访问：

```
https://你的域名/api/evaluate          →  {"ok":true,"backend":"free-trial",...}
https://你的域名/api/evaluate2         →  {"ok":true,"backend":"free-trial-2",...}
https://你的域名/api/evaluate3         →  {"ok":true,"backend":"llm-free-trial",...}
```

- `"ok":true` → 成功
- `"ok":false` → 环境变量没配上，回第二步检查变量名
- `key` 是**脱敏**的（一串 `*` 加**末 4 位**）→ 正常，它本来就不该回显完整密钥

  > ⚠️ **刻意不留前几位。** 早先的形态是「前 7 位 + `*` + 后 4 位」，而各家的密钥
  > 前缀本身就是**公开的厂商标识格式** —— 等于把这份响应体刻意隐藏的
  > 「免费试用背后是哪一家」又说了一遍。留后 4 位够操作者认出自己配的是哪把钥匙。

### 4. 绑定好记的域名（可选）

项目 → **Settings** → **Domains** → 输入想要的子域名 → **Add**。

> 换域名之后，**如果还要部署 GitHub Pages，必须同步改那一边的
> `JEV_LIFE_REMOTE_BASE`** —— 否则静态版跨域调不通，而失败的样子是「请求超时」，
> 看不出跟域名有关。

---

## 二、部署到 GitHub Pages

Pages 上只有静态文件，**没有 Serverless Function**。所以：

- 那三条「免费试用」后端会**跨域调用 Vercel 上那份部署**
- 密钥仍在 Vercel 的函数进程里，静态页面拿不到任何凭据

### 1. 打开 Pages

仓库 → **Settings** → **Pages** → **Source** 选 **GitHub Actions**。

### 2. 配一个仓库变量（**必须**）

仓库 → **Settings** → **Secrets and variables** → **Actions** → **Variables** →
新建：

| Name | Value |
|---|---|
| `JEV_LIFE_REMOTE_BASE` | 你的 Vercel 域名，如 `https://your-app.vercel.app` |

**为什么必须有它**：仓库里的 `src/client/deploy.ts` 的 `REMOTE_PROXY_BASE`
**默认是空字符串，刻意不给默认值**。写死一个默认域名，等于让别人的 fork
静默消耗原作者的免费额度，而他这边界面一切正常。

工作流会在编译前把上面这个变量的值注入进去。**没配它也不会报错** ——
静态版就是「没有远端后端可用」，那几条会在界面上隐藏，
而不是发一堆注定 404 的请求。

### 3. 推送

推到 `main` 就会自动构建发布，网址形如 `https://<用户名>.github.io/<仓库名>/`。

---

## 三、如果你是 fork 了这个仓库

**先做这一件事**：把你自己的 Vercel 域名填进 `JEV_LIFE_REMOTE_BASE`（Pages 用），
或者直接改 `src/client/deploy.ts`（其他静态托管用）。

**不做会怎样**：你的静态版会把每一个决策请求发到**原作者的部署**上，
消耗**原作者**的额度 —— 而你这边界面一切正常，看不到任何异常。

**本仓库不附带任何密钥。** 未配密钥的上游一律回 503，不静默降级、
不回落到任何内置凭据。所以你 fork 之后本来就得自备（见上面「准备工作」）。

---

## 四、推送即自动部署

Vercel 与 GitHub Pages 都连了仓库之后，往 `main` 推代码就会自动重新部署，
不需要再做任何事。状态分别在 Vercel 的 **Deployments** 与 GitHub 的 **Actions** 页看。

---

## 常见问题

**部署失败，日志里说找不到 `public/js/client/main.js`**

客户端没编译出来。检查 `vercel.json` 的 `buildCommand`：

```json
"buildCommand": "node node_modules/typescript/bin/tsc -p tsconfig.client.json"
```

**页面能打开，但一开始对局就提示后端不可用**

先访问 `/api/evaluate` 看 `"ok"` 字段。`"ok":false` 就是密钥没配上。

**构建日志里的 `memory` / Node 版本 warning**

两条都**不用管**，本仓库已经处理过：

| warning | 现状 |
|---|---|
| ``Provided `memory` setting in `vercel.json` is ignored on Active CPU billing`` | 内存现在只能在控制台配（项目 → **Settings → Functions**），写在 `vercel.json` 里**一律被忽略** —— 所以本仓库**不写它**。写了不但不生效，还会让读配置的人**误以为函数跑在 256 MB**。Hobby 套餐下内存不可配，按平台默认跑 |
| `Detected "engines": { "node": ">=22" } … will automatically upgrade` | **你不会再看到这一条** —— `package.json` 现在钉的是 `"22.x"`。松散范围（`>=22`）的后果是：**将来 Node 23/24 发布时 Vercel 会自己升上去**，而运行时的变化可能悄悄发生（本仓库栽过一次「本地 Node 能跑、Vercel 加载不了」，见 `api/_upstream.ts` 顶部） |

> `"22.x"` 钉的是 **Vercel 用的运行时**（CI 跑的也是 22）。
> **本地开发仍然 ≥ 22 都能跑**，`npm ci` 时若本地 Node 不是 22.x，
> 会打一条 `EBADENGINE` 警告 —— 那只是 npm 在报告 `engines` 不符，不影响本地开发。

**LLM 免费试用 1 报「上游没有给出可用的答案」**

那是 broker 层给出的诊断，最常见的原因是**推理吃光了输出预算**
（表现是上游返回 200、但 `finish_reason: "length"` 且 `content` 为空）。
本项目默认关思维链就是为了避开它；若你在后端配置里改过这一项，改回来试试。
详见 `docs/llm-backends.md`。

**想在局域网/本地也能用**

跑 `./start.sh` 即可。它启动的本地服务器会从**仓库外**的 `../local/` 目录读密钥文件
（优先级：环境变量 > `*.sealed` > 明文）。
本地与线上用的是**同一组端点路径**，所以前端代码完全一样。

**担心密钥被刷**

- **在两个提供商后台都设置消费上限**（这是最有效的一道）
- 公开仓库不含任何密钥，密钥只在 Vercel 环境变量里
- 端点是公开且无鉴权的，任何人都能调 —— 代码里的限制总会被绕过，
  账单上的限制不会
- 确实被刷了：去提供商后台 revoke 旧 key，在 Vercel 里换新的，重新部署

---

## 附：另一条部署路径（GitHub Actions）

仓库里还有 `.github/workflows/deploy.yml`，可以在 GitHub 侧触发 Vercel 部署。
它需要三个仓库 Secrets：`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。

**用控制台连通之后就不需要它了。** 它在缺少 `VERCEL_TOKEN` 时自动跳过、不让 CI 变红。
留着是为了将来需要「部署记录与代码变更放在一起」时可用。

> ⚠ 无论走哪条路径，**上游密钥都只配在 Vercel 项目环境变量里**，
> 不要放进 GitHub Secrets —— 那只会多一个泄漏面。
