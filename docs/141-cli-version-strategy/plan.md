---
status: planned
priority: medium
description: Strategy for keeping the Claude/Codex CLIs current without letting unpinned auto-latest break integrations or open supply-chain risk — tested pin + auto-bump, install hardening, and an opt-in latest channel.
---

# Agent CLI version strategy

How ShipIt should choose, install, and surface the versions of the agent CLIs
(`@anthropic-ai/claude-code`, `@openai/codex`, and `@playwright/mcp`) it bakes
into session-worker images. The CLIs move very fast — users want the newest
models and features — but every new version is also a chance for a malicious
npm publish to land in our image and for an output/protocol change to break our
adapters. This doc separates those concerns and lays out the chosen approach.

## Problem

Today the CLIs are installed **unpinned, at image build time**, and refreshed by
busting a Docker cache layer on every deploy:

```dockerfile
# docker/Dockerfile.session-worker.prod (also .prod / .dev / .dogfood variants)
ARG NPM_GLOBALS_REBUILD=0
RUN --mount=type=cache,target=/root/.npm \
    echo "rebuild=${NPM_GLOBALS_REBUILD}" \
 && npm install -g @anthropic-ai/claude-code @openai/codex @playwright/mcp
```

```bash
# deployment/vps/deploy.sh
BUILD_ARGS=("--pull" "--build-arg" "NPM_GLOBALS_REBUILD=$(date +%s)")
```

The effective policy is *"whatever `@latest` resolved to at the instant of the
deploy, frozen until the next deploy."* Consequences:

- **Non-deterministic & unaudited.** The shipped version is a side effect of
  *when* we deployed. Two deploys an hour apart can ship different agent
  versions with no record of what changed.
- **No rollback.** If a new CLI breaks NDJSON parsing or the `codex app-server`
  handshake, the only recourse is redeploy-and-hope npm still serves the old
  version (it may be unpublished/deprecated).
- **All-or-nothing blast radius.** Every session on the box runs the same
  baked-in version. No canary, no per-user choice.
- **Maximal supply-chain exposure.** Pulling `@latest` at deploy time means a
  freshly published malicious version can land in our image within minutes of
  publication — before the ecosystem has flagged and unpublished it.

The adapters only check that the binary exists (`which`), never its version
(`claude-adapter.ts`, `codex-adapter.ts`, `shared/agent-registry.ts`). The
multi-agent design doc (`docs/034-multi-agent-cli/plan.md`, "Pin supported CLI
versions; adapter includes version detection and warns on unknown versions")
flagged this as a risk mitigation that was never implemented.

## The key framing: three separable axes

"Latest vs. safe" feels like one impossible tradeoff but is actually three
independent decisions. Conflating them is what makes it hard.

| Axis | Risk it addresses | Question |
|------|-------------------|----------|
| **1. Version selection** | Integration breakage | What version do we *choose* to run? |
| **2. Supply-chain hardening** | Malicious package | How do we install it *safely*, whatever version? |
| **3. Integration safety net** | Breakage detection | How do we *know* a version broke us before users do? |

Our coupling surface to the CLIs — what actually breaks on a bad version — is
narrow and known, which makes Axis 3 cheap and high-leverage:

- `claude-adapter.ts` / `session/claude.ts`: parses the `stream-json` NDJSON
  output (assistant text, `tool_use`, `tool_result`, `result` events).
- `codex-adapter.ts`: JSON-RPC 2.0 over the `codex app-server` protocol, plus
  the handshake / protocol-version negotiation.
- `agents/tool-map.ts`: tool-name normalization across backends.
- CLI flags we pass: `--resume`, `--mcp-config`, `--model`, `--settings`, etc.

## Decisions

Driven by product input:

- **Freshness SLA: within a few days.** A tested cooldown (3–7 days) is
  acceptable; safety is weighted over same-hour currency.
- **Two channels: yes.** Power users opt into bleeding-edge per session; the
  default stays on the tested pin.
- **Top concern: integrations breaking.** Axis 3 (adapter contract tests) is the
  centerpiece and the gate everything else hangs off of. Supply-chain hardening
  (Axis 2) is still done, but the contract test is the priority.

## Axis 1 — Version selection: tested pin + auto-bump, plus a latest channel

Options considered:

- **A — Status quo (`@latest` at deploy).** Zero maintenance, but
  non-deterministic, no rollback, no canary, both risks live. Rejected as the
  default; survives only as the `latest` channel (below).
- **B — Hard pin, manual bumps.** Deterministic and auditable, but we become the
  bottleneck on users getting new models — contradicts the "stay current" goal
  and the few-days SLA.
- **C — Pinned floor, auto-promoted ceiling (chosen).** A pinned known-good
  version lives in a single manifest. An automated job opens a bump PR when a
  new CLI ships; the PR is gated on the Axis-3 contract tests + the cooldown.
  Green → merge; red → it parks and warns us *before* shipping. Deterministic,
  auditable, git-revertable rollback, and stays current automatically within the
  few-days SLA.
- **D — Two channels (chosen, on top of C).** Default sessions run the
  pinned/tested version (`stable`); opt-in `latest` per session. Resolves the
  core tension: cautious by default, bleeding-edge on request.

**Channel mechanism.** Versions are baked into the worker image, so per-session
selection must avoid a per-session npm fetch (slow cold start + reintroduces
per-session supply-chain exposure). Bake **both** `stable` and `latest` into the
image under versioned/prefixed install paths and select via env var or PATH at
spawn time in the adapters. The bump pipeline pins `stable`; `latest` resolves
to the newest cooled-down version at build time.

**Surfacing the choice.** Channel selection is *configuration*, not a
shell-shaped affordance, so it fits the product principles (CLAUDE.md §5). Expose
it as a session/repo setting and/or a `shipit.yaml` field, e.g.:

```yaml
agent:
  channel: stable   # stable | latest
```

This threads through to the adapter spawn (env var picking the binary path).

## Axis 2 — Supply-chain hardening (do regardless of Axis 1)

Cheapest → highest effort; items 1–4 are a few hours and kill most realistic
risk:

1. **Install cooldown.** Never install a version younger than N days (3–7).
   Most npm supply-chain attacks are caught and unpublished within
   hours-to-days; a cooldown sidesteps the window. (Renovate exposes
   `minimumReleaseAge`; for the raw Dockerfile path the bump job resolves
   "newest version older than N days".)
2. **`--ignore-scripts` on the global install.** Postinstall scripts are the
   usual code-exec vector. Verify the CLIs don't *require* a postinstall (most
   don't) and add the flag.
3. **Pin by integrity hash.** Record `--integrity sha512-…` (or `npm ci` against
   a lockfile) so the bytes are verified, not just the version string — defeats
   post-publish tampering.
4. **Lockfile for the global installs.** Move the global CLI installs into a
   dedicated `package.json` + committed `package-lock.json`, install with
   `npm ci`. Reproducible, integrity-checked, and the natural surface for the
   auto-bump tool. Lets us **drop the `NPM_GLOBALS_REBUILD=$(date +%s)`
   cache-buster** — the lockfile now controls freshness deterministically.
5. **Provenance / SBOM (higher effort, diminishing returns).** Verify npm
   provenance attestations where available; scan the resulting image.

## Axis 3 — Integration safety net (the high-leverage piece)

The reason new versions are scary is that we have **no automated signal** that a
version broke the adapters. Build a **CLI contract test**: a CI job that installs
the candidate version and exercises the real coupling points against the actual
binaries:

- Spawn `claude` with `stream-json`, run a trivial prompt, assert the NDJSON
  parser produces the expected event shapes (assistant text, `tool_use`,
  `tool_result`, `result`).
- Spawn `codex app-server`, complete the JSON-RPC handshake, assert protocol
  version + a round-trip.
- Assert every flag we pass (`--resume`, `--mcp-config`, `--model`,
  `--settings`) is still accepted.
- Run `tool-map` normalization against the observed tool names.

This is the gate that makes the Option-C auto-bump *safe* — it turns "new
version dropped" from roulette into a green check. Run it in two modes:

- **Merge gate** on bump PRs (catch before deploy).
- **Optional worker startup self-check** that logs/flags a version mismatch or
  failed handshake (cheap defense in depth; surfaces a degraded backend before
  the user hits it). Could feed `agent-registry`'s installed/health reporting.

## Recommended rollout order

1. **Axis 2 (independent, do first):** dedicated `package.json` +
   `package-lock.json` for the global CLIs, `npm ci --ignore-scripts`, 3–7 day
   cooldown; drop the `date +%s` cache-buster. Biggest risk reduction per hour.
2. **Axis 3:** the adapter contract test against real CLIs.
3. **Axis 1 = Option C:** Renovate (or a scheduled GH Action) opens bump PRs,
   gated on the contract test + cooldown; green auto-merges, red parks and pings.
4. **Axis 1 = Option D:** bake `stable` + `latest` into the image under
   versioned paths; add `agent.channel` (session setting + `shipit.yaml`); thread
   selection through the adapter spawn. Default stays on the tested pin.

Net: deterministic and auditable, git-revertable rollback, supply-chain risk
slashed by cooldown + integrity + `--ignore-scripts`, breakage caught in CI
before users see it, and power users get the bleeding edge on demand.

## Key files (to touch when implementing)

- `docker/Dockerfile.session-worker.prod` / `.dev` / `.dogfood`,
  `docker/Dockerfile.prod`, `docker/Dockerfile.dogfood` — global CLI install
  layer; replace ad-hoc `npm install -g … @latest` with lockfile-based install
  of both channels.
- `deployment/vps/deploy.sh` — drop `NPM_GLOBALS_REBUILD=$(date +%s)`.
- `src/server/session/agents/claude-adapter.ts`,
  `src/server/session/agents/codex-adapter.ts` — channel-aware binary selection;
  optional startup version self-check.
- `src/server/session/claude.ts`, `src/server/session/agents/tool-map.ts` —
  surfaces exercised by the contract test.
- `src/server/shared/agent-registry.ts` — version/health reporting.
- `src/server/shared/shipit-config.ts` — `AgentConfig` gains `channel`.
- `src/server/shipit-docs/` — document `agent.channel` for the in-container
  agent (agent-facing platform behavior).
- New: CLI global-install `package.json` + `package-lock.json`; CLI contract
  test; Renovate config or scheduled bump Action.

## Open questions

- Exact cooldown length (3 vs. 7 days) and whether it differs per package.
- Where the channel setting lives canonically (session setting vs. `shipit.yaml`
  vs. both) and precedence between them.
- Whether `@playwright/mcp` follows the same pin/channel discipline or stays
  best-effort latest (it's less tightly coupled than the agent CLIs).
- Whether the startup self-check should *block* a session on a failed handshake
  or merely warn.
