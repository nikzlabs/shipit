---
issue: planning#321
title: Custom models — live pair verification sweep
description: A live turn per viable (harness, service, billing mode, model) pair, run 2026-08-15 against the dogfood inner instance — what the catalogue got right, and the three defects the sweep exposed.
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

## Coverage this sweep does not have

Stated plainly so nobody reads the matrix as broader than it is:

- **`anthropic:key` and every OpenAI row** (`sub` and `key`, 8 models each) are untested — no
  credential was present. Nothing here says whether they work.
- **No Codex row has been exercised *through ShipIt*** anywhere in this instance. The Codex
  cells above verify the catalogue's endpoints, styles and model ids at the CLI; they do not
  verify ShipIt's local-mode spawn path, which is broken (planning#390). Once that lands,
  those four pairs are worth re-running through the product — the fix is what converts them
  from CLI-verified to end-to-end verified.
- The sweep ran **serially by design** — local mode applies `SHIPIT_CREDENTIAL_*` to
  `process.env` around each spawn, so concurrent turns would race on process-global state and
  produce results that mean nothing.
