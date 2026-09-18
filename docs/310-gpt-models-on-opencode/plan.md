---
issue: planning#600
title: GPT models on the OpenCode harness
description: Teach ShipIt's OpenCode spawn to speak Responses, and stop pinning the ChatGPT GPT rows to Codex.
---

# GPT models on the OpenCode harness

Acceptance conditions are in [requirements.md](./requirements.md); remaining
work is in [checklist.md](./checklist.md).

## Why no GPT model could use OpenCode

Two independent gates, one behind the other. Lifting the first alone is what
made the second visible, which is why this looked unfixed after PR #2824.

**Gate 1 — OpenCode's own model filter.** Until 1.18.29, OpenCode's
ChatGPT-subscription route matched model ids against `/^gpt-(\d+\.\d+)/`, so
`gpt-6-astra` matched nothing and was refused. 1.18.29 widened it to
`/^gpt-(\d+)(?:\.(\d+))?/` with a major-version comparison, and added the
registry row. PR #2824 moved the pin to 1.18.30 and cleared this gate.

**Gate 2 — ShipIt's own spawn shaper.** `opencodeProviderConfig`
(`src/server/shared/opencode-spawn-shaping.ts`) mapped a request style to the
npm provider package OpenCode should load, and had entries only for
`openai-chat-completions` and `anthropic-messages`. `openai-responses`
returned `undefined`, meaning "refuse to spawn". Matching that,
`harnesses.ts` allowed OpenCode's string credential target only those two
styles. Every GPT row in the catalogue is `openai-responses`, so:

| Route | Credential | What blocked it |
|---|---|---|
| OpenCode Zen | string | Responses not allowed on the string target |
| OpenCode Go (sub) | string | same |
| OpenAI API key | string | same for Responses-only rows such as Astra |
| OpenAI subscription | account | per-model `harnesses: ["codex"]` pin |

`docs/272-opencode-inference` states the premise plainly — "`openai-responses`
is Codex's style alone" — and `docs/295-opencode-chatgpt` deferred it: keep
Responses unavailable "until the existing string shaper supports and verifies
them". This is that work.

## Measured, not assumed

`@ai-sdk/openai-compatible` posts to `<base>/chat/completions` and will never
post to `/responses`, so the style needed a different provider package. On
2026-09-18 a local recorder was put on `127.0.0.1:8899` and OpenCode 1.18.30
was run against a `shipit` provider block using `npm: "@ai-sdk/openai"`, a
custom `baseURL` and an `{env:…}` apiKey. Recorded:

```
POST /v1/responses
user-agent: opencode/1.18.30 ai-sdk/provider-utils/4.0.40 runtime/bun/1.3.14
authorization: present
body: {"model":"gpt-5.6-luna","input":[{"role":"developer",…
```

So OpenCode drives Responses through ShipIt's custom-provider shape, against an
arbitrary base URL, with the key delivered the way ShipIt already delivers it.
Nothing about the CLI needed to change.

## What changed

- `src/server/shared/opencode-spawn-shaping.ts` — `npmPackageForStyle` maps
  `openai-responses` to `@ai-sdk/openai`. The existing refusal on a non-`env`
  credential target is untouched, so an unshapeable route still refuses.
- `src/server/shared/catalogue/harnesses.ts` — OpenCode's string credential
  target accepts `openai-responses`. The harness style list is **unchanged**;
  see below.
- `src/server/shared/catalogue/services.ts` — the OpenAI subscription rows drop
  `harnesses: ["codex"]`, except `gpt-5.3-codex` and `gpt-5.2`, which
  OpenCode's registry filter refuses by id (req 7).

Every resulting change is **additive**: a combination that resolved to nothing
now resolves to `openai-responses`. No combination that already worked changes
shape. That was verified by dumping `resolveStyle` and `retirementSuccessor`
for every harness × service × model on `main` and on this branch and diffing.

## Req 8 was dropped, and why

Preferring Responses for GPT models has no lever that hits only GPT models.
Both global orderings were built and measured, and both were reverted:

| Lever | Collateral measured |
|---|---|
| Lead OpenCode's harness style list with Responses | 12 non-GPT gateway combinations (Grok, DeepSeek, Kimi, GLM, Gemini, Qwen) switched to Responses, and `retirementSuccessor` re-pointed Vercel's retired DeepSeek V4 Pro from `deepseek-v4-flash` to `zai/glm-5.2` — a different vendor, price and behavior |
| Prefer each model row's own declared style order | 22 gateway rows moved onto Anthropic Messages, because those rows lead with `anthropic-messages` for Claude Code's benefit |

The harness list is global per harness and the row order is written for a
different harness, so neither encodes "this model, on this harness, prefers
this shape". A per-row preference is the mechanism that would.

It was not built, and on 2026-09-18 the user dropped the requirement. The
deciding fact is that req 8 never covered the route it was asked about. The
OpenAI **subscription** path does not use ShipIt's synthetic provider at all —
`adapter.ts` branches on `isOpenCodeAccountRouting` and writes
`enabled_providers: ["openai"]`, so OpenCode's native provider handles it and
it was already on Responses. Req 8 therefore governed only the API-key and
gateway routes, where GPT models keep Chat Completions. `resolveStyle` keeps
harness-order preference.

## A pre-existing inconsistency this surfaced

`catalogueEntriesForHarness` does not consult a mode's credential `carriers`,
while `eligibleEntriesForHarness` does. Unpinning the subscription rows made
that visible: the raw helper now reports 8 ChatGPT-subscription models for the
**grok** harness, which cannot carry that credential. The picker is unaffected
because it goes through the eligibility path. `retirementSuccessor` uses the
raw path, so it too will name a successor for a harness that cannot reach it.
Not introduced here and not fixed here.

## Which subscription models OpenCode accepts

Transcribed from the pinned binary and checked against it:

```
allow  = {"gpt-5.5","gpt-5.3-codex-spark","gpt-5.4","gpt-5.4-mini"}
deny   = {"gpt-5.5-pro"}, and the exact id "gpt-5.6"
else   = /^gpt-(\d+)(?:\.(\d+))?/ with major > 5, or major 5 and minor > 4
```

Eight of the ten rows pass, including Astra; `gpt-5.3-codex` and `gpt-5.2` do
not. Per req 4 all eight are offered. **None of them is yet verified by a live
authenticated turn**, Astra included — req 5 is still open in
[checklist.md](./checklist.md). The recorder measurement above proves the
request shape reaches `/responses`; it is not a completed subscription turn,
and the subscription path uses `opencodeAccountConfig` rather than the string
shaper it exercised.

Req 7's exclusion also rests on the registry filter alone. OpenCode applies
that filter before merging explicit provider models, and ShipIt supplies an
explicit model row, so "cannot start a turn" is the expected behavior rather
than an established one. The two rows stay pinned pending a check either way.

`opencode-subscription-models.test.ts` re-derives this per row rather than
listing ids, so a new catalogue row is classified automatically and a drifted
pin fails the build. **Re-extract the filter on every OpenCode bump** — it has
changed twice already:

```
strings -n 8 <binary> | grep -oE '\.has\(K\.api\.id\).{0,200}'
```

## Key files

- `src/server/shared/opencode-spawn-shaping.ts` — style to provider package.
- `src/server/shared/catalogue/harnesses.ts` — style preference, credential
  target allowlists.
- `src/server/shared/catalogue/services.ts` — per-model harness pins.
- `src/server/shared/catalogue/opencode-subscription-models.test.ts` — the
  drift guard against OpenCode's filter.
