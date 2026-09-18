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
  target accepts `openai-responses`, and the harness style list now leads with
  it. `resolveStyle` takes the first match, so leading with Responses is what
  implements req 8; models offering only one shape are unaffected.
- `src/server/shared/catalogue/services.ts` — the OpenAI subscription rows drop
  `harnesses: ["codex"]`, except `gpt-5.3-codex` and `gpt-5.2`, which
  OpenCode's filter refuses by id (req 7).

## Which subscription models OpenCode accepts

Transcribed from the pinned binary and checked against it:

```
allow  = {"gpt-5.5","gpt-5.3-codex-spark","gpt-5.4","gpt-5.4-mini"}
deny   = {"gpt-5.5-pro"}, and the exact id "gpt-5.6"
else   = /^gpt-(\d+)(?:\.(\d+))?/ with major > 5, or major 5 and minor > 4
```

Eight of the ten rows pass, including Astra; `gpt-5.3-codex` and `gpt-5.2` do
not. Per req 4 the eight are all offered, though only Astra is verified live —
breadth here is deliberate and is not evidence that each was checked.

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
