# The Chess of Life × Jev

|[简体中文](README.md) | **English**|
|:-:|:-:|

<!-- 📝Badge layout reference: https://daily.dev/blog/readme-badges-github-best-practices#organizing-badges-in-your-readme -->

![License](https://img.shields.io/badge/license-MIT-78dce8?style=for-the-badge)
![Code Size](https://img.shields.io/github/languages/code-size/ARCJ137442/jev-life?style=for-the-badge&color=78dce8)
![Language](https://img.shields.io/badge/language-TypeScript-78dce8?style=for-the-badge)
![Node](https://img.shields.io/badge/node-%E2%89%A522-78dce8?style=for-the-badge)

<!-- For users -->

Try it:

[![Online Demo](https://img.shields.io/badge/Online%20Demo-Vercel-78dce8?style=for-the-badge)](https://jev-life.vercel.app)

<!-- For developers -->

Development status:

[![CI](https://img.shields.io/github/actions/workflow/status/ARCJ137442/jev-life/ci.yml?style=for-the-badge&label=CI)](https://github.com/ARCJ137442/jev-life/actions)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-78dce8?style=for-the-badge)](https://conventionalcommits.org)
![Last Commit](https://img.shields.io/github/last-commit/ARCJ137442/jev-life?style=for-the-badge&color=78dce8)

---

## Introduction

An **experimental game**: a browser-based lab bench for "**write a new ruleset, then immediately watch it be played**", written entirely in [TypeScript](https://www.typescriptlang.org/).

"The Chess of Life" is its first ruleset. It **starts with one player**: flip one cell before each evolution to steer Conway's Game of Life towards **more life** — the evolution itself is out of your hands.

It **can grow into a two-player game**, and a deliberately **asymmetric** one: **Life** flips dead cells alive, **Death** flips live cells dead. Both names use 执 — "to hold", as in *holding a stone* in Go. The asymmetry is not just flavour: the two sides' legal sets are **mutually exclusive** (Life may only flip dead cells, Death only live ones), so simultaneous moves **cannot collide** and no conflict-resolution rule is needed.

The rules themselves, the win lines and the opening library are all defined in this repository — and **how the rules are worded, where the win lines sit, and what the opening looks like are all yours to change**.

[TypeSafe AI's "Jev"](https://www.typesafe.ai/) wears two hats here: the **tool for exploring the rules**, and the **first player** of every new ruleset.
It does not generate text. It takes a piece of **state** plus a set of **typed questions**, and returns **structured decisions with calibrated probabilities**.
This project hands every flip to it, and lays its probability distribution, confidence, latency and token cost out on screen.

> ★ **Why a "first player" is needed here**
>
> Before any original game is understood, **there is no human precedent** — no opening theory, no guides, no strong play to imitate.
> What a freshly written ruleset lacks most is exactly "someone who actually walks it once".
> Jev starts from **the rules themselves**, and how those rules are told to it is editable too — so **whether a new ruleset is playable, and whether it was explained clearly**, shows up within a single game.

Making "how a decision model adapts to entirely new rules" **visible, tunable, and measurable** is what that amounts to in this repository.

It is the **sister project of [`jev-2048`](https://github.com/ARCJ137442/jev-2048), not a fork of it** — same skeleton, completely different game and measurements.
Compared to that one, it carries **two increments you can lift out on their own**:

- 📌 **A measurement of what Jev's parallel decisions are actually worth** — an 8×8 board has 64 cells and **every legal cell is one boolean question**; all of them go out in **a single request**, against the number of round trips an LLM needs behind the broker. Latency, upstream call count and cost are first-class outputs, not statistics bolted on afterwards.
- 📌 **A "LLM → Jev" broker** — a Jev-compatible API layer that can wrap any OpenAI- or Anthropic-compatible LLM into a Jev backend. The decision and evaluation code above it does not change by a single line, and **cannot tell** whether it is talking to Jev or to a wrapped LLM.

---

## Online Demo

| Deployment | Address | Notes |
|---|---|---|
| Vercel | <https://jev-life.vercel.app> | Ships serverless functions; the three "Free Trial" backends work same-origin |
| GitHub Pages | <https://arcj137442.github.io/jev-life/> | Static only; calls the free-trial endpoints on the deployment above cross-origin |

> ✅ **Both are deployed and live** (released `1.0.0` on `2026-09-21`). The addresses above are real — click through and play, no API key needed. You can also deploy your own; steps are in [`DEPLOY.md`](DEPLOY.md), and **forks must set `JEV_LIFE_REMOTE_BASE`** (section 3 of that document explains what happens if you don't).

Both forms can reach the built-in "Free Trial" backends with no API key required
(the Pages build points at the Vercel one through the `JEV_LIFE_REMOTE_BASE` repository variable — see [`DEPLOY.md`](DEPLOY.md)).
Quota is limited; when it runs out the app prompts you to switch to your own key. See "Getting Started" below to run it locally instead.

> ⚠️ **The "Free Trial" quota comes out of the original author's own pocket — please don't abuse it.**
> Those endpoints are **public and unauthenticated** (deliberately — they are for trying the game out, not for batch runs).
> The quota is metered in tokens and stops when it is gone; **for sustained or batch use, switch to the bring-your-own-key backends** — the whole point of this project is that any LLM can be plugged into it, and your own key comes with no quota anxiety.

> 📝 **How does static hosting handle keys?** A static site has no serverless functions, so it **holds no key** — it calls the Vercel deployment above cross-origin, and the key stays inside that function process. The remote address comes from `REMOTE_PROXY_BASE` in `src/client/deploy.ts`, which is **an empty string by default, deliberately given no default value**: hard-coding a domain means other people's forks would silently burn the original author's quota. When it is empty, a static build simply hides those backends instead of firing off a batch of requests that are certain to 404.

---

## Getting Started

### Prerequisites

1. Install [**Node.js**](https://nodejs.org/) (≥ 22)
2. An API key (optional — only needed for bring-your-own-key backends, or to run the "Free Trial" proxies locally)

### Quick run

```bash
git clone https://github.com/ARCJ137442/jev-life.git
cd jev-life
npm install
./start.sh
```

`start.sh` runs seven steps and aborts on the first failure:

```plaintext
▸ Scan for secrets…                        tools/scan-secrets.ts
▸ Check layering (core/ must not import client/)…  tools/scan.ts
▸ Check DOM id consistency…                tools/check-dom.ts
▸ Run unit tests…
▸ Compile client (src/client → public/js)…
▸ Compile server (src/server → dist)…
▸ Start server…                            8787
```

Once started, the terminal prints the addresses:

```plaintext
Local      http://localhost:8787/
LAN        http://<your-LAN-IP>:8787/
```

### Providing a key

Keys are read in this order (any one is enough):

1. Environment variable
2. `../local/<name>.sealed` (sealed ciphertext)
3. `../local/<name>` (plaintext, legacy)

| Backend | Environment variable | Local key file (in `../local/`) |
|---|---|---|
| "Free Trial 1" `/api/evaluate` | `VERCEL_AI_GATEWAY_KEY` | `vercel-secret-api-key` |
| "Free Trial 2" `/api/evaluate2` | `OPENROUTER_API_KEY` | `openrouter-secret-api-key` |
| "LLM Free Trial 1" `/api/evaluate3` | `AGNES_API_KEY` | `agens-flash-secret-api-key` |

To seal a plaintext key:

```bash
node tools/seal-key.ts ../local/vercel-secret-api-key
# → produces ../local/vercel-secret-api-key.sealed, which the server prefers automatically
# once verified, remove the plaintext:
rm ../local/vercel-secret-api-key
```

> ⚠️ **This is not cryptographic protection.** The default passphrase lives in `src/server/seal.ts`; anyone with the repository can decrypt it. It guards against *accidental* exposure — a key showing up in `cat` output, a screenshot, a stray commit — not targeted attacks. Real key protection comes from "never sending it to the client" and "server-side environment variables". For a stricter setup, set `JEV_SEAL_PASSPHRASE` so the source only contains a useless default.

> ⚠️ **Key files live in `../local/`, i.e. outside the repository.** `.gitignore` cannot escape the repository root, so those two `../local/` rules are effectively inert — the real protection is that the file is *physically* outside the repo. The repository ships no keys; an upstream with no key configured returns **503**, with no silent downgrade and no fallback to any built-in credential.

### Manual build

```bash
# Type check (five tsconfigs)
node node_modules/typescript/bin/tsc -p tsconfig.client.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.api.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
node node_modules/typescript/bin/tsc -p tsconfig.tools.json --noEmit

# Unit tests (461)
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test dist-test/test/*.test.js

# Build
node node_modules/typescript/bin/tsc -p tsconfig.client.json   # → public/js/
node node_modules/typescript/bin/tsc -p tsconfig.server.json   # → dist/
```

Shorthands: `npm test`, `npm run typecheck`.

> 📝 **No bundler.** The client uses native browser ES Modules; tsc emits import paths with explicit `.js` extensions, which browsers load directly. On Termux, `npm`/`npx` have a shebang pointing at a nonexistent `/usr/bin/env`, so `start.sh` invokes tsc's JS entry point through `node` instead.

### Running a game headless

No browser required:

```bash
# Costs nothing: fake probabilities from a fixed seed, whole pipeline exercised
node tools/play.ts --dry-run --size 8x8 --turns 20

# Through the local server (run ./start.sh first), which injects the key
node tools/play.ts --size 8x8 --turns 4
```

`tools/play.ts` runs the **same** pipeline as the UI: build questions → one request → parse → decide → flip → evolve → classify termination.

---

## Project Overview

### Disclaimer

This is a **third-party lab bench** for Jev. It is not affiliated with TypeSafe AI.
The rules of Conway's Game of Life are in the public domain; this project merely borrows them as a decision scenario with a well-defined objective. **The Chess of Life** — the variant layered on top of them, named after Conway's *The Game of Life* — belongs to this repository.

### Module architecture

```plaintext
jev-life
├── src
│   ├── core                        ★ Pure functions, no DOM, no network — runs in plain Node
│   │   ├── types.ts:       Board / Role / Topology / GameRules / GameSnapshot / Termination
│   │   ├── life.ts:        Evolution / flip / legal cells / state hash / termination
│   │   ├── patterns.ts:    Pattern library (still lifes / oscillators / spaceships / guns / eaters)
│   │   ├── presets.ts:     Size presets (4 / 8 / 16) + a per-size opening library
│   │   ├── context.ts:     buildState / buildQuestions — board → Jev's state
│   │   ├── template.ts:    "Template + placeholder autofill" for the rule book
│   │   ├── channels.ts:    Evaluation channels — what one request asks, how the reply is read ★
│   │   └── decide.ts:      Decision strategy — probabilities into the one cell to flip ★
│   ├── shared
│   │   ├── types.ts:       Jev protocol types (SystemOne) + discriminator normalisation
│   │   ├── backend.ts:     Decision backend adapter layer (one contract + its implementations)
│   │   └── llm-broker.ts:  Jev–LLM broker ★ pure, runs in both the browser and Node
│   ├── client
│   │   ├── api.ts:         The BACKENDS catalogue + address resolution
│   │   ├── deploy.ts:      Remote proxy address (empty by default, deliberately)
│   │   ├── main.ts:        Wiring layer: core → DOM
│   │   ├── render.ts:      Canvas board rendering + three animations (place / iterate / particles)
│   │   ├── chart.ts:       The sidebar's three charts (confidence / momentum / decision heat)
│   │   ├── score.ts:       Scoreboard values — the two moments of one turn
│   │   ├── mode.ts:        The **UI-side** effects of switching mode (which panels are dead in solo)
│   │   ├── config.ts:      Long-term settings persistence (no keys)
│   │   ├── session.ts:     Game session persistence (resume after refresh)
│   │   ├── archive.ts:     Save import / export (validated by app / v / kind)
│   │   └── i18n.ts:        UI internationalisation (deliberately does **not** translate what Jev is fed)
│   ├── server
│   │   ├── server.ts:      Local server + key proxy for three upstreams
│   │   └── seal.ts:        Key sealing (AES-256-GCM)
│   └── test:               23 test files, 461 cases
├── api:                    Vercel Serverless Functions (three free-trial backends)
├── tools
│   ├── _load.ts:           The single entry point for tools to reach core (checks staleness)
│   ├── check-dom.ts:       Build-time DOM id consistency check
│   ├── scan.ts:            Layering check: core/'s transitive closure must not touch client/
│   ├── scan-secrets.ts:    Secret scan (byte-wise + zlib-inflate rescan + git history)
│   ├── bench-step.ts:      Benchmark of the two evolution implementations (diagnostic; always exits 0)
│   ├── play.ts:            Play a whole game headless (--dry-run costs nothing)
│   └── seal-key.ts:        Plaintext key → ciphertext
├── public:                 Single-page UI + build output
├── docs
│   ├── ui-spec.md:         UI specification
│   └── llm-backends.md:    LLM backend spec and cross-provider measurements
├── DESIGN.md:              Design decision record (handoff; the "why")
└── ...
```

### Technical highlights

- 📌 **Pure TypeScript, unified front and back**, no bundler
- 📌 **A DOM-free, network-free core**: if the **transitive closure** of `src/core/` reaches `src/client/`, the build fails (`tools/scan.ts`, run by both `./start.sh` and CI). Every benchmarking tool depends on this to run in plain Node
- 📌 **A pure engine**: `lifeStep` / `flip` / `legalCells` / `classifyTermination` never mutate their input. `flip` returns a new `Board`, and a `Uint8Array` must be copied — returning the input's backing array would pass every "unchanged before and after the call" assertion, yet let a caller mutate the input by writing to the return value
- 📌 **Two independent differential baselines**: the production `lifeStep` and the baseline `referenceStep` are two independent writings of the same algorithm, plus a bit-parallel `bitwiseStep` built on an entirely different model. All three are reconciled against each other — two legs sharing one conceptual model go lame *together*; only the third catches a conceptual error
- 📌 **Canvas-rendered board**: geometry is constructive — `2·pad + n·cell + (n-1)·gap` always equals the edge length, so margins stay exactly equal at any board size, no tuning required
- 📌 **No heuristics anywhere**: when the model is unsure we do not silently swap in an algorithm; we surface the uncertainty to the user
- 📌 **Zero credential exposure**: a proxied API key only ever lives in the server process; a bring-your-own-key LLM backend does not touch the server at all — the key stays in your browser's memory, never written to disk, never exported with an archive

### Configurable parameters

The UI has five drawers, ordered as a user journey:
**Game → Strategy → API → Log → Archive**.

Settings come in **two tiers**, split by **who the setting belongs to**:

| Tier | Items | Criterion |
|---|---|---|
| **Game-level** | Board size / topology / mode / end rules / opening | They are **the definition of the game**; if the two sides disagree, it is not the same game |
| **Player-level** | Backend / model / key / call policy / evaluation channel / memory depth / outcome prediction / automatic pattern detection / rule-book templates / strategy hint / strategy / confidence threshold | They describe **how this player thinks** |

"Sync both sides" is therefore not a property of a section but an **action**: copy one side's player-level settings wholesale onto the other.

> ⚠️ **2048's partitioning criterion breaks down here.**
> That one split by "whose input does this affect", concluding that "Game" and "API" items affect neither. Here **both break**: the rules of the Chess of Life are **not self-evident**, so every rule has to go into the `state` sent to Jev; and swapping a backend swaps the whole way the prompt is constructed, which also affects the model's input.
>
> The new criterion's second half is "**change it, and what should you look at**":

| Section | What to watch after changing it |
|---|---|
| Game | The probability distribution **should** move (the reverse of 2048) |
| Strategy › Context | The probability distribution |
| Strategy › Rules | Which move was actually played |
| **API** | **Latency, upstream call count, cost** — the only section that produces these three |

> 📝 2048's criterion came with a very handy by-product: "change a Game setting; if the distribution moves, something is wrong" doubles as a regression test. The new criterion offers no assertion that clean — only the "what to watch" table above.

The context knobs are the heart of the bench:

| Parameter | Injected into | What to watch |
|---|---|---|
| **Rule book (six templates)** | `state.rules` | You own the wording; the numbers are **filled in automatically** from your settings (placeholders like `{{lifeWinRatio}}`). ⚠️ Delete a placeholder and the model no longer knows the win condition — the UI warns, but does not block you |
| "Rule description (supplement)" | `rules.rule_note` | The body is rendered from the templates, so this is for supplements only; leave it empty and the field disappears entirely |
| "Strategy hint" | `aids.strategy_hint` | Knowledge of Life (which shapes are still lifes, that gliders travel) is exactly what this experiment measures, so it is **empty by default** |
| "Outcome prediction" | Question text | When on, the live-cell change of "this flip plus one evolution" goes into the question text. **Background only** — the question always asks about long-term value, or the answer would be printed on the question |
| "Memory turns" | `aids.recent_history` | Sends the last n turns (board, both flips, net growth) along with the request. 0 = leave it out |
| "Automatic pattern detection" | `aids.detected_patterns` | **On by default.** Turning it off is "tear out the scaffolding and see how much is the model's own" |

### On "no heuristics"

If the model's uncertainty were silently handed to a rule-based algorithm, the measurement would be contaminated — you could no longer tell whether a flip came from Jev or from the rules.

So this project **flags** uncertainty instead and leaves the judgement to you. The confidence threshold defaults to **0**, i.e. every move uses the model's output.

### Gateway naming differences ⚠️

Same Jev, same "SystemOne" protocol — each gateway made **different naming choices**:

| | TypeSafe Official | OpenRouter | AI/ML API | Vercel Gateway |
|---|---|---|---|---|
| Endpoint | `/v1/systemone` | `/api/v1/systemone` | `/v1/decisions` | `/v1/evaluate` |
| Model ID | `jev-latest` | `typesafe/jev-1.13` | `typesafe/jev` | `typesafe-ai/jev` |
| **Boolean discriminator** | `noul` | `noul` | `noul` | **`boolean`** |

**Vercel is the sole outlier** — its wrapper renamed `noul` to `boolean`. This was once inverted in our docs: "the docs say noul, the API actually wants boolean" holds *only* for Vercel.

`choice` and `score` are identical across all four, so the main path here is unaffected.
But the Chess of Life's **main path is exactly the boolean question** (one `noul` question per legal cell), and a wrong discriminator is rejected with a 400 straight away — so normalisation happens **server-side**: the client sends only the *semantics* ("this is a boolean question"), and the proxy — which knows who it is talking to — does the translation.

> ⚠️ Here is a **trap we actually fell into**: a proxied backend's UI id and its real upstream are not the same thing — "Free Trial 1"'s id is `localproxy`, but the upstream behind it is Vercel. Deriving the discriminator from the UI id is guaranteed to be wrong, and the symptom is that **the default backend 400s on the very first request**.

### Running a local model?

**Two different senses of "local" — keep them apart.**

**① Using Jev itself: a plain OpenAI-compatible endpoint cannot reach it.**

Jev is a decision model: it takes `state` + `questions` and returns structured answers with probabilities. It has **no `/v1/chat/completions`**. The OpenAI-compatible layers of LM Studio / vLLM / Ollama are text completion — a different job, and forcing them together does not work.

The right approach is to **implement the SystemOne protocol on the local side**, leaving OpenAI compatibility where it belongs: with text models.
Fully offline Jev is not possible — the official weights are not open.

**② Using a local LLM to impersonate Jev: that is exactly what this project's broker does.**

The translation between "LLM-compatible" and "Jev-compatible" is [`src/shared/llm-broker.ts`](src/shared/llm-broker.ts) — it turns a Jev-shaped request into an LLM call and the reply back into Jev's shape, with **the layer above unchanged and unable to tell the difference**. It is deliberately a **pure function**: no DOM, no network, so the same code runs in the browser (the two bring-your-own-key backends) and in Node (the headless CLI).

To attach a self-hosted endpoint, pick "Self-hosted / local compatible endpoint" in the API drawer and fill in the address.

### Offline alternative: Laya

[Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0) is an **open-source alternative** to Jev —
also a non-autoregressive decision model that answers every question in a single forward pass and
generates no text. It ships as a Python package with no HTTP server, so you need a thin sidecar
that implements SystemOne.

```plaintext
POST /v1/systemone   request  { state, model, questions }
                     response { model, answers, usage, routing }
GET  /v1/models      checkpoints this server can route to
GET  /healthz        health check
```

#### Differences from Jev ⚠️

| | |
|---|---|
| **Much smaller context** | Overflow is truncated from the tail |
| **Choice options share a budget** | Too many options are rejected by the upstream outright |
| **Confidence is on a different scale** | Thresholds calibrated for Jev **do not transfer**; recalibrate |
| **Type discriminator is `noul`** | Not Vercel's `boolean` |
| **Zero cost** | No key, no per-token billing, no network |

> 📌 The "Local Laya server" backend in this project is reserved for it (default `127.0.0.1:8137`), and is marked **untested** in the UI: the adapter is not open-sourced with this repository, so you need to write that sidecar yourself. The protocol shape above is quoted from the sister project [`jev-2048`](https://github.com/ARCJ137442/jev-2048); **it has not been re-verified here**.

### Potential applications

The value here is not "a model plays a board game" but a **reproducible context bench**:

- Studying how prompts and context shape a classifier's decision quality — especially where **the rules are not self-evident**
- Measuring **the payoff of parallel decisions**: the same batch of questions sent once versus N round trips — how many seconds, how much money, how much success rate
- **Putting Jev and any LLM on the same board**: the broker makes both sides look identical, so a cross-model comparison needs no second codebase
- A reference implementation of how to integrate a structured decision model (full SystemOne call wrapper)

---

## Contributing

### Branches

- `main`: currently the only branch, long-term support (ℹ️ **PRs go straight to `main`**)
- CI runs on pushes to **every** branch (`branches: ["**"]` in `.github/workflows/ci.yml`)

### How to contribute

- [GitHub Issues](https://github.com/ARCJ137442/jev-life/issues): report problems, suggestions, bugs
- [GitHub Pull Request](https://github.com/ARCJ137442/jev-life/pulls): contribute code directly

### Before submitting

```bash
node tools/check-dom.ts && node tools/scan.ts && npm test
```

`./start.sh` and CI run the same set of checks — if it passes locally, it passes in CI, and vice versa.

---

<!-- 📝Full rationale for every design decision lives in DESIGN.md — the "why", not the "what" -->
