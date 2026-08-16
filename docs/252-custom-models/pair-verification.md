---
issue: planning#321
title: Custom models — live pair verification sweep
description: A live turn per viable (harness, service, billing mode, model) pair against the dogfood inner instance — what the catalogue got right, the three defects the sweep exposed, and the post-fix re-verification.
---

# 252 — Live pair verification sweep

What happens when every viable `(harness, service, billingMode, model)` combination the
catalogue declares is actually *run*, rather than reasoned about. Companion to
[`catalogue.md`](./catalogue.md), which declares the rows, and [`plan.md`](./plan.md).

Run **2026-08-15** against the dogfood inner instance (`dev` service, `RUNTIME_MODE=local`),
one fresh session per pair, each turn a single trivial prompt asking for a fixed token back.

This is a **measurement record**, not a design. It exists because the catalogue's rows carry
claims — which endpoint, which API style, which credential — that only a real turn can
falsify, and because CLAUDE.md's rule applies to the catalogue as much as to anything else:
a doc describing a guarantee is a claim, not a contract.

## How the pair set was derived

A pair is viable when the harness's `styles` intersect the model's — `resolveStyle` in
`catalogue/index.ts`, which returns `undefined` for "this harness cannot run this model".
Both shipped harnesses declare exactly one style, so the join is narrow:

| Harness | Style | Reaches |
|---|---|---|
| Claude Code | `anthropic-messages` | every service declaring `A_MSG` |
| Codex | `openai-responses` | only services declaring `O_RESP` |

Credentials present in the instance (all six adopted and `ready`): `anthropic:sub`,
`deepseek:key`, `zai:sub`, `zai:key`, `openrouter:key`, `vercel:key`. No `anthropic:key`
and no OpenAI credential, so those rows are **untested** rather than passing or failing.

That yields **16 viable pairs** — 12 on Claude, 4 on Codex.

## Status: all three defects fixed and re-verified

The sweep below is the **2026-08-15 pre-fix** run — kept as the record of what was measured
and how the defects were found. All three landed and were re-verified against the merged code
on **2026-08-16**; see [after the fixes](#after-the-fixes-2026-08-16) for the post-fix matrix.

## Results

### Claude Code — 12 of 12 pass on the redirected services

| Service | Mode | Models | Result |
|---|---|---|---|
| deepseek | key | `deepseek-v4-flash`, `deepseek-v4-pro` | pass |
| zai | sub | `glm-5.2[1m]` | pass |
| zai | key | `glm-5.2` | pass |
| openrouter | key | `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `deepseek/deepseek-v4-flash`, `deepseek/deepseek-v4-pro`, `z-ai/glm-5.2` | pass (5/5) |
| vercel | key | `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`, `deepseek/deepseek-v4-flash` | pass (3/3) |
| anthropic | sub | `claude-opus-5`, `claude-sonnet-5`, `haiku`, `claude-fable-5` | **blocked** — planning#358 |

Every endpoint, style, credential-target and model id in those rows is confirmed against a
live turn. The `zai:sub` row's `[1m]` suffix and its `ANTHROPIC_AUTH_TOKEN` `targetOverride`
both work as declared.

The four `anthropic:sub` failures are the pre-existing planning#358 landmine — the route
reads `ready` and the turn dies with "This agent is not authenticated", billing nothing. The
sweep adds two facts to that issue: it affects all four models identically, and it is the
*only* failing Claude route out of five services.

### Codex — 0 of 4 through ShipIt, but all 4 rows verified at the CLI

| Service | Mode | Model | Through ShipIt | Direct `codex exec` |
|---|---|---|---|---|
| deepseek | key | `deepseek-v4-flash` | fail | **pass** |
| deepseek | key | `deepseek-v4-pro` | fail | pass (verified outside this instance) |
| vercel | key | `openai/gpt-5.6-sol` | fail | **pass** |
| vercel | key | `openai/gpt-5.6-terra` | fail | **pass** |

All four die before running, with byte-identical text regardless of service:

```
Error: The agent exited with code 1 without running. (WARNING: proceeding, even though we
could not create PATH aliases: Permission denied (os error 13) Error: error loading default
config after config error: Permission denied (os error 13))
```

**The catalogue rows are correct; ShipIt's local-mode spawn is not** — planning#390. Driving
the CLI directly in the same container, as the same user, with the same `HOME` and the same
credentials, and with the exact provider-override shape ShipIt builds, every one of those
models answers. So Vercel's `openai-responses` declaration is confirmed good, and no Codex
row is implicated.

## What the sweep exposed

Three defects, none of them in the catalogue's data.

### 1. A silent harness downgrade — planning#389

The most consequential finding, and the one the sweep found only by accident: it was looking
for a **refusal**.

Four style-incompatible requests (`agent: "codex"` for an `anthropic-messages`-only model)
were expected to be refused before spawn. They were not. The harness was silently swapped to
Claude and the turn **ran and billed**, with `sessions.agent_id` recording `claude` and
`pending_agent_notice` NULL.

`headless-sessions.ts:209-215` falls through to `agentIdForModel(opts.model)` when the
explicit harness does not list the model. The guard is real (docs/166's stale
`vibe-agent-id`), but it cannot tell a stale client key from a caller who deliberately named
a harness that cannot run the model, and resolves both the same way. The
harness-not-installed fallback ten lines below at least logs a warning; this one is silent.

The same question is answered the opposite way on the sub-agent path:
`assertHarnessCanRunSelection` refuses, and its docstring states the principle — "the call is
taken literally, so a harness pointed at another vendor's model is an error rather than
something to reroute." Two paths, opposite answers.

Worth recording how the swap was *proved* rather than assumed: `agent_id` was read from the
inner SQLite `sessions` table, and the elimination argument is independent — every genuine
Codex spawn in that instance fails to start, so a turn that succeeded cannot have been Codex.

### 2. Codex is unusable in local mode — planning#390

Not a catalogue defect and not a CLI defect. **Root cause: the spawn inherits `HOME=/root`.**

The question that cracked it was not "why does Codex fail" but "why does Codex on its own
**subscription** work in dogfood while Codex on a **custom URL** does not". The asymmetry is
`session/agents/codex/adapter.ts:254`:

```ts
const scopedHome = this.resolveHome?.();
if (scopedHome) {
  env.HOME = scopedHome;
  env.CODEX_HOME = this.codexConfigDir();
}
```

`resolveLocalAgentHome` returns a scoped home **only for an `account` route**, and
deliberately `undefined` for a reserved/string route — which is what every custom-URL service
resolves to. A subscription takes the branch that sets `HOME`; a redirected service takes the
branch that sets nothing and inherits the orchestrator's own. Read from the live inner
orchestrator process, that is:

```
AGENT_HOME=/workspace/.inner-shipit/agent-home
HOME=/root
```

`/root` is mode 700 root-owned while the process runs as uid 1000, and Codex keys its config
root off `$HOME`, not `$AGENT_HOME`. The compose `command` materializes `AGENT_HOME` but never
overrides `HOME`.

Reproduced with `HOME` as the only variable — same container, user and credential:

| `HOME` | Result |
|---|---|
| `/root` | `Error loading config.toml: Failed to read config file /root/.codex/config.toml: Permission denied (os error 13)` |
| `/workspace/.inner-shipit/agent-home` | turn completes |

This also explains why **Claude** was unaffected across five services: a redirected Claude
turn authenticates purely through environment variables and never needs a writable config
root, while Codex must read and write `config.toml`.

Two hypotheses were **refuted** along the way, recorded because both were plausible and one
was leading. The cold-root first-run race that `agents/codex/home-init.ts` exists to prevent:
after direct runs warmed the root (`state_5.sqlite`, `installation_id`, `skills/` present),
all four pairs were re-run and failed identically. And the root-owned `/opt/agent-cli` install
tree, whose non-writability produces only the *non-fatal* PATH-aliases warning — a red
herring that appears in the failing output as a side effect of `/root`, not as the cause.

### 3. OpenRouter's row understates what OpenRouter serves — planning#391

See below. The catalogue is not wrong here so much as out of date — it says the question is
open, and the question is now closed.

## The two Responses-API questions, settled

`services.ts:334` and `catalogue.md` unresolved item 5 both record that it is not established
whether OpenRouter serves the Responses API — the sole reason its rows declare no
`openai-responses` and therefore never reach Codex.

**OpenRouter serves it.** `POST https://openrouter.ai/api/v1/responses` authenticated returns
**HTTP 200** with a genuine Responses body (`"object":"response"`, `status:"completed"`, an
`output` array carrying a `reasoning` item and a `message` with `output_text`). Controls
bracket it: `/chat/completions` → 200, `/definitely-not-a-route` → 404 HTML.

Stronger than the HTTP probe, and the reason this is settled rather than merely likely: a
**real Codex turn completed over it**, with `wire_api = "responses"` against
`https://openrouter.ai/api/v1`. Adding the style to those rows is, as the comment predicted,
the whole change.

**Z.ai does not**, on its OpenAI-compatible base — the catalogue is right to omit it:

| Request | Status | Body |
|---|---|---|
| `/api/paas/v4/responses` | **404** | `{"status":404,"error":"Not Found","path":"/v4/responses"}` |
| `/api/paas/v4/chat/completions` | 429 | `{"code":"1113","message":"Insufficient balance…"}` |
| `/api/paas/v4/definitely-not-a-route` | 404 | `{"status":404,"error":"Not Found","path":"/v4/definitely-not-a-route"}` |

The earlier unauthenticated probe was inconclusive because Z.ai authenticates *before*
routing, so a bogus path and a real one both returned the same error. Authenticated, it
discriminates cleanly: `/responses` returns the bogus-route 404, while `chat/completions`
gets past routing and auth to the **billing** gate. The 429 is the more diagnostic control
here — a 200 would have proved less, because reaching billing proves the route exists.

Scope caveat, stated because it bounds the claim: this tests the documented
OpenAI-compatible base only, not some other Z.ai base path.

## Two things worth knowing before reading a future failure

- **A Z.ai `key` failure is not necessarily a catalogue defect.** That key has no balance on
  the `paas/v4` (OpenAI-protocol) surface — `chat/completions` returns 429 — yet
  `claude × zai:key × glm-5.2` passes, because it runs over the Anthropic-protocol endpoint
  (`/api/anthropic`), which bills separately. The two surfaces fail independently.
- **Codex has no metadata for gateway-namespaced ids.** `deepseek/deepseek-v4-flash` and the
  Vercel-prefixed ids produce `Model metadata for … not found. Defaulting to fallback
  metadata; this can degrade performance and cause issues.` Non-fatal — every such turn
  completed correctly — but it is a real gap in the CLI's own table, and it will show up
  again for any gateway row that reaches Codex.

## After the fixes (2026-08-16)

planning#389, planning#390 and planning#391 all merged, and the affected pairs were re-run
against the merged code in the same instance. **15 of 15 behaved as the fixes intend.**

### planning#390 — every Codex pair now runs through ShipIt

The four rows that were CLI-verified only are now end-to-end verified:

| Service | Mode | Model | Pre-fix | Post-fix |
|---|---|---|---|---|
| deepseek | key | `deepseek-v4-flash` | fail | **pass** |
| deepseek | key | `deepseek-v4-pro` | fail | **pass** |
| vercel | key | `openai/gpt-5.6-sol` | fail | **pass** |
| vercel | key | `openai/gpt-5.6-terra` | fail | **pass** |

### planning#391 — two newly viable pairs, and they work

OpenRouter's two **DeepSeek** rows now declare `openai-responses`, so the viable set grows
from 16 to 18. Both new pairs pass:

| Service | Mode | Model | Result |
|---|---|---|---|
| openrouter | key | `deepseek/deepseek-v4-flash` | **pass** |
| openrouter | key | `deepseek/deepseek-v4-pro` | **pass** |

Its Anthropic and GLM rows deliberately do **not** carry the style — one model answering does
not establish that the gateway translates for an upstream serving no Responses API of its
own. So `codex × openrouter:key × anthropic/claude-opus-5` is now correctly *refused* rather
than silently downgraded, which is the two fixes composing.

### planning#389 — refused, with a message that names the real cause

All five style-incompatible requests now return **HTTP 400** instead of running on the
substituted harness and billing:

```
Codex cannot run GLM-5.2 — they share no API style.
Choose a model Codex can run, or run GLM-5.2 on Claude Code.
```

That also settles the wording complaint this doc raised: the old text blamed the credential
("no credential this harness can use offers it") for what is an API-style incompatibility.
The new message names the actual cause and offers both remedies.

### No regression on the Claude side

Spot-checked across four services — `deepseek:key`, `openrouter:key`, `vercel:key`,
`zai:sub` — all still pass. The `HOME`/`CODEX_HOME` change is Codex-only and did not disturb
the Anthropic path, as expected: a redirected Claude turn never needed a writable config root,
which is why it was unaffected by the bug in the first place.

### Still outstanding

**planning#358 is unrelated and still open** — `anthropic:sub` remains the one failing Claude
route, and none of these three fixes touch it.

## Coverage this sweep does not have

Stated plainly so nobody reads the matrix as broader than it is:

- **`anthropic:key` and every OpenAI row** (`sub` and `key`, 8 models each) are untested — no
  credential was present. Nothing here says whether they work.
- **No Codex row was exercised *through ShipIt*** in the pre-fix run — those cells verified
  the catalogue's endpoints, styles and model ids at the CLI only. **Resolved by
  planning#390**: all six Codex pairs are now end-to-end verified, see
  [after the fixes](#after-the-fixes-2026-08-16).
- The sweep ran **serially by design** — local mode applies `SHIPIT_CREDENTIAL_*` to
  `process.env` around each spawn, so concurrent turns would race on process-global state and
  produce results that mean nothing.

## The gateway-translation sweep (2026-08-16)

A second run, same method, answering the question the first one left open (`catalogue.md`
question 7): **do the gateways translate `anthropic-messages` and `openai-responses` for an
upstream that publishes neither?** The 2026-08-16 curation pass added four models — Grok 4.6,
Gemini 3.7 Flash, Kimi K3, Qwen3.8 Max — whose vendors ShipIt holds no direct credential for
and who publish only their own APIs. Nothing but a live turn could settle it.

**40 pairs**, three harnesses × two gateways × the added models, plus four known-good
controls (`claude`/`openrouter`/Opus 5, `claude`/`vercel`/Opus 5,
`codex`/`openrouter`/V4 Flash, `codex`/`vercel`/GPT-5.6 Sol). All four controls passed, so no
verdict below is an instance-wide breakage in disguise. Every failure was re-run twice more;
the two that changed answer are called out rather than averaged away.

### Result: the two gateways translate in OPPOSITE directions

| Model | OpenRouter `A_MSG` | OpenRouter `O_RESP` | Vercel `A_MSG` | Vercel `O_RESP` | `O_CC` (both) |
|---|---|---|---|---|---|
| Grok 4.6 | pass | **fail** | pass | pass | pass |
| Gemini 3.7 Flash | pass | **fail** | **fail** | pass | pass |
| Kimi K3 | pass | pass | pass | pass | pass |
| Qwen3.8 Max | pass | **fail** | pass | pass | pass |
| Fable 5 | pass | **fail** | pass | **fail** | pass |
| GLM-5.2 | *(declared)* | — | pass | pass | pass |
| DeepSeek V4 Pro | *(declared)* | *(declared)* | pass | pass | pass |

- **OpenRouter's Anthropic skin translates for every upstream tested**, including four that
  publish no Anthropic API. **Its Responses surface carries almost nothing** — Kimi K3 alone.
- **Vercel is the mirror image**: Responses carries everything tested but Fable 5, while its
  Anthropic skin fails on exactly one model.
- So the "declare it only where the upstream publishes it" heuristic the catalogue reasoned
  from **was wrong in both directions** — it would have denied eight working pairs and
  asserted six broken ones. This is why the rule is measurement.
- Every added model reaches a default `claude,codex` install through at least one harness.
  `O_CC` passed on all 12 pairs via OpenCode and is declared everywhere.

### The one informative error

`claude` → Vercel → Gemini 3.7 Flash fails identically on all three runs:

> `API Error: 400 'system messages are only supported at the beginning of the conversation' functionality not supported.`

Claude Code's system-prompt shape is what Vercel's Anthropic translation cannot carry to
Gemini. That is a property of the pairing, not of the model — the same model passes on
Vercel's Responses surface and on OpenRouter's Anthropic skin.

### Two verdicts that flipped on re-run, and why single observations are not enough

- `claude` → Vercel → **Grok 4.6** failed its first serial run and then passed **five**
  consecutive re-runs. Recorded as a pass; the single failure was a flake.
- `codex` → Vercel → **Fable 5** went fail, pass, fail, fail, fail. Recorded as a fail on the
  majority, and the row omits `O_RESP` — but it is genuinely flaky rather than cleanly broken,
  which is worth knowing before anyone "fixes" it.

### Two methodology errors in this sweep, corrected mid-run

Recorded because both produced confident, wrong results that looked fine:

1. **The pass check could not fail.** It searched every message for the fixed token, and the
   *prompt* contains that token — so a turn that produced no assistant output at all scored a
   pass. Every Codex verdict in the first run was a false positive. Fixed to read assistant
   text only; the corrected run immediately produced a mix.
2. **The first two runs were concurrent**, against this document's own explicit warning three
   sections up. They disagree with the serial run in *both* directions — Vercel/Fable failed
   concurrently and passes serially; Vercel/Grok passed concurrently and needed five re-runs
   serially. Both runs were discarded. The warning was right and is repeated here because it
   was read, understood, and then not applied.

### Still not covered

- `openai-chat-completions` was measured **through OpenCode only** — the one harness that
  speaks it. It is not installed by default (`SHIPIT_HARNESSES=claude,codex`).
- The `:free`, `-fast`, `-pro` and dated variants both gateways list are untested; only the
  ids the catalogue declares were run.
- Each verdict is one trivial turn. It establishes that the pairing *works*, not that the
  model is good at agentic coding through that harness.

## GLM-5.3 on the Z.ai coding plan (2026-08-17)

A single-question probe, run because GLM-5.3 shipped on **2026-08-14** and the obvious
question — can ShipIt reach it? — was answerable but unanswered. Same method as the sweeps
above: live turns against the dogfood inner instance, strictly serial, assistant-role text
only, known-good control included.

**Where GLM-5.3 is.** Not on either gateway: `openrouter.ai/api/v1/models` and
`ai-gateway.vercel.sh/v1/models` were re-checked on 2026-08-17 and the newest GLM on both is
still 5.2. That follows from Z.ai holding the weights back ~2 weeks for safety hardening.
Z.ai's own docs still say *"The GLM-5.3 API is coming soon"* for general API access while
noting it is live for **GLM Coding Plan** subscribers — which is exactly what ShipIt's
`zai:sub` mode targets.

### Result: reachable today, and the id is `glm-5.3[1m]`

| Pair | Result |
|---|---|
| `claude` / `zai:sub` / `glm-5.2[1m]` — known-good control | pass |
| `claude` / `zai:sub` / **`glm-5.3[1m]`** | **pass** (twice, separate runs) |
| `claude` / `zai:sub` / `glm-9.9-nonexistent[1m]` — negative control | **fail**, as required |

No catalogue change was needed to *reach* it beyond a temporary probe row: the existing
`zai:sub` endpoint (`https://api.z.ai/api/anthropic`), its `ZAI_CODING_PLAN_KEY` credential
and the `ANTHROPIC_AUTH_TOKEN` `targetOverride` all work unchanged.

### Why the negative control was the point

A passing turn on a new model id does NOT by itself show the id was honoured — a service that
ignores an unknown model and answers with its default would look identical. So a deliberately
impossible id was run on the same route first, and it failed with a specific upstream error:

> `API Error: 400 [1214][modelCode: does not exist]`

Z.ai validates model ids and rejects unknown ones. That is what makes the GLM-5.3 pass mean
"this id exists and was served" rather than "something answered". Without this control the
probe would have been the same shape as the pass check that could not fail, three sections up.

Asked to self-identify, the 5.2 route answered `GLM-5.2 (Z.ai), context window 1M` and the 5.3
route answered `Model: glm-5.3[1m].` — recorded as an observation, not evidence. Model
self-report is unreliable, and the second answer echoes the `[1m]` suffix that Claude Code is
documented to consume and strip. The negative control, not the self-report, is what carries
the finding.

### Why no row shipped

`ModelPrice` is required and its sentinel is rejected by `catalogue.test.ts`, and **Z.ai has
published no per-token rate for GLM-5.3**. Third-party sources quoting $1.4 / $4.4 are
repeating GLM-5.2's published rate. Writing that in would assert a vendor figure that does not
exist — the same error class as the gateway pass-through pricing bug corrected on 2026-08-16,
which was wrong by up to 2.7×. The `zai:sub` block carries a comment recording this so the
question is not re-derived from scratch.

Adding the row is then a small, well-specified job: a `glm53` identity, a `glm-5.3[1m]` row
under `zai:sub` (`[A_MSG]`), a `glm-5.3` row under `zai:key` **only if** the general API is
live by then, and gateway rows if OpenRouter or Vercel have picked it up — each at that
gateway's own published rate, never the upstream's.
