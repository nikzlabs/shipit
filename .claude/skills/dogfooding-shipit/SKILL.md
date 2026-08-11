---
name: dogfooding-shipit
description: "Running ShipIt inside ShipIt: the manual `dev` Compose preview, the inner orchestrator's RUNTIME_MODE=local limitations, which credentials to set (and which to leave unset), repo seeding, and driving the inner instance over its HTTP API. Load when working on the dogfood loop, debugging the inner ShipIt UI, or touching local-mode behavior."
user-invocable: true
---

# Dogfooding ShipIt in ShipIt

Opening the ShipIt repo in production ShipIt surfaces the `dev` Compose service as a **manual** preview — heavy enough (a whole second orchestrator, plus a `Dockerfile.dogfood` build) that it starts on demand rather than every boot. It shares the agent container's `/workspace/node_modules` (populated by `agent.install` at session boot) and runs Vite's **dev server** on the exposed port 3000, proxying `/api`, `/ws`, and `/preview` to the inner orchestrator on internal port 4000. It does **not** run its own `npm install` or a production `vite build` — the Compose file explains why that would be redundant and unsafe.

Start it with `shipit service start dev`. A first start may take minutes; a `start` that times out is still running — re-check with `shipit service list`.

## Local mode is a real exception to "ShipIt always runs in Docker"

The inner orchestrator runs with `RUNTIME_MODE=local`, which **skips Docker entirely**: no inner containers, no inner Compose, and inner agents spawn in-process via `claude-adapter` / `codex-adapter` rather than in a session worker container.

That makes several things degrade, by design — do not treat them as bugs:

- No inner terminal
- No inner file watcher
- No inner preview

Full design: `docs/118-shipit-ui-local`.

## Credentials — set them once, outside

The `dev` service's credentials are **user-supplied secrets**, set once in the outer **Settings → Secrets** (`docs/184-remove-platform-secret-forwarding`). Platform secret forwarding was deliberately removed, so nothing is inherited.

`GITHUB_TOKEN` plus **any service credential you want to exercise** is the set. The `x-shipit-secrets` block in `docker-compose.yml` declares every `storageEnv` name the model catalogue knows — `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_CODING_PLAN_KEY`, `ZAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY` — so a key set once out there appears in every dogfood session without a visit to inner Settings (docs/131 req 11).

**Declaring a name costs nothing; supplying a value is the opt-in.** An unset secret resolves to nothing and seeds nothing. That per-name choice is the only granularity there is — there is no second switch.

### A supplied key becomes a credential ROUTE, not just a variable

This matters and is not what the environment alone gives you. A bare variable is read by `listConfiguredCredentials` (`service-routing.ts`), so its models are already *eligible* — but it has no row, so inner Settings → Services shows nothing, it can be neither benched nor ordered nor failed over to, and the quota system has nothing to attach a reader to. `scripts/seed-inner-credentials.ts` closes that: at boot it POSTs each supplied variable to `/api/credential-routes`, so the inner instance holds a real credential.

### ⚠ Three names bypass a connected subscription

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `OPENAI_API_KEY` are read by the vendor CLIs **directly**, so their mere presence in the inner orchestrator's environment can decide a spawn.

A *turn* is safe: it spawns with `HOME` at the routed account's root (`local-agent-home.ts`) and `scrubEnvAuthForScopedHome` drops them. **Non-turn work is not** — session naming and PR descriptions go through `spawnSubAgent`, which in local mode calls the agent factory with no `resolveHome` (`session-runner.ts`), so the scrub is a no-op and Codex's `hasFileAuth` check misses the account root too. Consequence:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are **metered**, so background work quietly bills per token while every real turn runs on the subscription. Set them only when you are deliberately testing metered billing.
- `ANTHROPIC_AUTH_TOKEN` is a subscription token, not metered — but it still takes precedence over a connected account, so attribution points at the wrong credential.

The other five names are ShipIt's own; no CLI reads them, so they are inert until the router selects their service. The seed logs a `⚠` line naming whichever of the three it finds.

`local-agent-credentials.ts` maintains the unscoped fallback home (planning#284) and is not on the per-turn path.

## Seeding

At `dev`-service boot, two background steps run in order, both prefixed `[seed]` in the service logs (`docs/131-dogfood-seed-sessions`):

1. **Credentials** (`scripts/seed-inner-credentials.ts`) — every supplied service key becomes a credential route, labelled `… (dogfood secret)` in inner Settings → Services.
2. **Repos** (`scripts/seed-inner-sessions.js`) — adds and trusts the repos in `scripts/dogfood-seed.json`, so the inner UI comes up with a repo ready to work in instead of an empty slate.

Behavior for both: skips what is already present, exits 0 on any failure (never blocks boot), honors `DOGFOOD_SEED=0`. `DOGFOOD_SEED_CREDENTIALS=0` disables the credential half alone.

Already-present means *left completely alone*: a credential you edited in the inner UI survives a restart, and rotating the outer secret does **not** propagate — delete the inner credential to re-seed it.

## Driving the inner instance over HTTP

You do not have to click through the inner UI. The `dev` service publishes 3000 and Vite proxies `/api` to the inner orchestrator.

First resolve the host, against the **outer** orchestrator:

```bash
curl -s http://${SHIPIT_HOST}:${SHIPIT_PORT}/api/sessions/${SHIPIT_SESSION_ID}/services
```

Then these calls cover the whole loop:

| Call | Purpose |
|---|---|
| `GET /api/sessions/all` | What sessions exist |
| `POST /api/sessions/headless` `{repoUrl, initialPrompt}` | Start a new session |
| `POST /api/sessions/:id/agent/dispatch` `{text}` | Send a turn — wakes a session nobody has open |
| `GET /api/sessions/:id/status` | Is it still running? |
| `GET /api/sessions/:id/history` | Read the conversation back |

## Key references

- `docs/118-shipit-ui-local` — local-mode design and degraded behaviors
- `docs/131-dogfood-seed-sessions` — seeding
- `docs/184-remove-platform-secret-forwarding` — why credentials are user-supplied
- `src/server/shipit-docs/preview.md` (shipped to containers as `/shipit-docs/preview.md`) — resolving service hosts from inside a container
