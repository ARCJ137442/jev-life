/**
 * 「LLM 免费试用 1」后端 —— 转发到一个 **OpenAI 兼容**的 LLM 上游。
 *
 * ⚠ 与 evaluate.ts / evaluate2.ts **不是同一套协议的实例**。
 * 那两条说的是 Jev 协议（SystemOne，`{state, questions} → {answers}`），
 * 原样转发即可；这条说的是 OpenAI 兼容的 `chat/completions`，
 * **形状完全不同**，进出一趟都要经 `../src/shared/llm-broker.js` 翻译。
 *
 * 翻译放在服务端，收益有两条：
 *   1. **密钥不落地浏览器**（与其余几条上游同一条纪律）
 *   2. **客户端一行不用改** —— 对客户端而言这条后端与其余几条完全一样，
 *      它照常发 Jev 形状，也看不出对面是一个被包起来的 LLM。
 *      这就是 `DESIGN.md` 第七节那条「中间那层必须真的兼容」
 *
 * 需要配置的环境变量：AGNES_API_KEY
 *
 * 实测结论（详见 `docs/llm-backends.md`）：
 *   - 默认关思维链：两个后端实测 0–63% → 100%
 *   - 该上游的 `reasoning_effort` 只接受 `none|low|medium|high|max`，**没有 xhigh**
 *   - 它**不报** `completion_tokens_details`，所以推理 token 那一栏恒为 0
 */
import { makeHandler } from "./_upstream.js";

export default makeHandler({
  label: "llm-free-trial",
  url: "https://apihub.agnes-ai.com/v1/chat/completions",
  envKey: "AGNES_API_KEY",
  model: "agnes-2.5-flash",
  upstream: "agnes",
  // ★ 这一栏决定「原样转发」还是「经 broker 翻译」
  kind: "llm",
});
