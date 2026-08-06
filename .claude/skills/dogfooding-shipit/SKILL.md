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

## Credentials — set almost nothing

The `dev` service's credentials are **user-supplied secrets**, set once in the outer **Settings → Secrets** (`docs/184-remove-platform-secret-forwarding`). Platform secret forwarding was deliberately removed, so nothing is inherited.

**Only `GITHUB_TOKEN` should normally be set.** Sign the inner ShipIt in to a Claude or Codex account instead of supplying keys.

**Leave `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` unset.** They are not broken — a local turn spawns its CLI with `HOME` at the routed account's root (`local-agent-home.ts`), and `scrubEnvAuthForScopedHome` drops them from that spawn's env so the account's own login is what the CLI sees. The reason to leave them unset is billing, not breakage:

- They rank as a **metered fallback below** connected subscription accounts.
- A spawn with **no session route** — `generateText`, used for PR descriptions — is **not** scrubbed. So a key set "just in case" would silently bill for those calls while every real turn ran on the subscription.

`local-agent-credentials.ts` maintains that unscoped fallback home (SHI-282) and is not on the per-turn path.

## Seeding

At `dev`-service boot, a background step adds and trusts the repos listed in `scripts/dogfood-seed.json`, so the inner UI comes up with a repo ready to work in instead of an empty slate (`docs/131-dogfood-seed-sessions`).

Behavior: skips repos already present, exits 0 on any failure (never blocks boot), honors `DOGFOOD_SEED=0`, and prefixes its output with `[seed]` in the service logs.

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
