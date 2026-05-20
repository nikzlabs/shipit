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

Today the CLIs are installed **unpinned, at image build time**. Only the
production worker image refreshes them, by busting a Docker cache layer on every
deploy:

```dockerfile
# docker/Dockerfile.session-worker.prod (lines 31-34) — the ONLY image with the cache-bust
ARG NPM_GLOBALS_REBUILD=0
RUN --mount=type=cache,target=/root/.npm \
    echo "rebuild=${NPM_GLOBALS_REBUILD}" \
 && npm install -g @anthropic-ai/claude-code @openai/codex @playwright/mcp
```

```bash
# deployment/vps/deploy.sh (line 25)
BUILD_ARGS=("--pull" "--build-arg" "NPM_GLOBALS_REBUILD=$(date +%s)")
```

The effective policy on `.prod` is *"whatever `@latest` resolved to at the
instant of the deploy, frozen until the next deploy."* The other images are
**worse**: `Dockerfile.session-worker.dev:7` and `.dogfood:77` run a plain
`npm install -g …` with **no** `NPM_GLOBALS_REBUILD` ARG, so they install
whatever `@latest` resolved to *at first build* and then never refresh (pure
layer cache) until something else invalidates the layer. The orchestrator images
(`Dockerfile.prod:33`, `Dockerfile.dev:10`, `Dockerfile.dogfood:34`) install the
CLIs too — relevant for local/dogfood mode (see below) — and prod/dev install
only `claude-code` + `codex`, **not** `@playwright/mcp`. Consequences:

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

No code anywhere inspects the CLI version. `codex-adapter.ts` and
`agent-registry.ts` `which` the binary to confirm it exists; `claude.ts` doesn't
even do that — it just `pty.spawn("claude", …)` and relies on the spawn failing
if the binary is absent. None of the three look at a version. The
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

- **Freshness SLA: within a few days.** A **7-day** tested cooldown is the chosen
  setting; safety is weighted over same-hour currency.
- **Two channels: yes.** Power users opt into bleeding-edge per session; the
  default stays on the tested pin.
- **Top concern: integrations breaking.** Axis 3 (adapter contract tests) is the
  centerpiece and the gate everything else hangs off of. Supply-chain hardening
  (Axis 2) is still done, but the contract test is the priority.
- **Bump tooling: the Renovate GitHub App.** Install the Mend-hosted Renovate
  app (free for public and private repos) and drive it with a committed
  `renovate.json`. It opens the version-bump PRs and enforces the cooldown via
  `minimumReleaseAge`; our CI contract test is the required gate. We are *not*
  self-hosting Renovate or hand-rolling a bump Action — the hosted app is the
  least-maintenance option that still gives us the cooldown primitive.

## Axis 1 — Version selection: tested pin + auto-bump, plus a latest channel

Options considered:

- **A — Status quo (`@latest` at deploy).** Zero maintenance, but
  non-deterministic, no rollback, no canary, both risks live. Rejected as the
  default; survives only as the `latest` channel (below).
- **B — Hard pin, manual bumps.** Deterministic and auditable, but we become the
  bottleneck on users getting new models — contradicts the "stay current" goal
  and the few-days SLA.
- **C — Pinned floor, auto-promoted ceiling (chosen).** A pinned known-good
  version lives in a single manifest. The Renovate GitHub App opens a bump PR
  when a new CLI ships (held back until the version clears the cooldown via
  `minimumReleaseAge`); the PR is gated on the Axis-3 contract tests. Green →
  auto-merge; red → it parks and warns us *before* shipping. Deterministic,
  auditable, git-revertable rollback, and stays current automatically within the
  few-days SLA.
- **D — Two channels (chosen, on top of C).** Default sessions run the
  pinned/tested version (`stable`); opt-in `latest` per session. Resolves the
  core tension: cautious by default, bleeding-edge on request.

**Channel mechanism (concrete — this is the load-bearing part).** Versions are
baked into the image, so per-session selection must avoid a per-session npm fetch
(slow cold start + reintroduces per-session supply-chain exposure). The naive
reading — "two global installs, pick one at spawn" — does **not** work as-is:

- `npm install -g` writes one `bin` symlink per package into a single global
  prefix (`/usr/local/bin/claude`); a second install **overwrites** the first.
  You cannot have a `stable` and a `latest` `claude` from one global prefix.
- All three spawn/probe sites resolve the CLI **by bare name** via `$PATH`:
  `claude.ts` → `pty.spawn("claude", …)`; `codex-adapter.ts` → `which codex`
  then `spawn("codex", …)`; `agent-registry.ts` → `which <binary>`. Bare-name
  resolution can only ever find one version.

So the concrete design is:

1. **Two install trees, not two global installs.** Install each channel into its
   own prefix at build time, e.g.
   `npm ci --prefix /opt/agents/stable …` and `npm ci --prefix /opt/agents/latest …`,
   yielding `/opt/agents/<channel>/bin/{claude,codex}`. The bump pipeline pins
   `stable`; `latest` resolves to the newest cooled-down version at build time.
   `@playwright/mcp` is consumed via `npx @playwright/mcp` (an MCP server, not a
   spawned agent) — decide whether it is channel-scoped or stays a single global
   install (see Open Questions).
2. **Channel-aware spawn in three files.** `claude.ts` must spawn an absolute
   path (`/opt/agents/${channel}/bin/claude`) or prepend the channel's bin dir to
   `PATH` in the existing `spawnEnv`; `codex-adapter.ts`'s `which` check and bare
   `spawn("codex")` must both become channel-aware; `agent-registry.ts`'s
   `which`-based `installed` probe must report per channel.
3. **Channel must thread through the agent factory.** `agentFactory` is currently
   `(agentId: AgentId) => AgentProcess` (`app-di.ts:85`) — no channel parameter.
   Threading channel through means extending the factory signature / agent run
   params and the call sites in `session-runner.ts`.

This is feasible but it is **not** a one-line env-var read; it touches
`claude.ts`, `codex-adapter.ts`, `agent-registry.ts`, the agent factory, and the
Dockerfiles. The doc calls this out so the work isn't undersold.

**Warm pool / pre-baked images.** Both channels are baked into a **single**
image, so warm-pooled containers (already booted before the user picks a channel)
need no rebuild — channel is purely a spawn-time bin-dir choice made when the
agent process is created, not an image property. A warm container can therefore
serve either channel. (This is the payoff of "bake both" over "install on
demand.")

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

1. **Install cooldown.** Never install a version younger than **7 days**.
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
   `package-lock.json` for the global CLIs, `npm ci --ignore-scripts`, 7-day
   cooldown; drop the `date +%s` cache-buster. Biggest risk reduction per hour.
2. **Axis 3:** the adapter contract test against real CLIs.
3. **Axis 1 = Option C:** install the Renovate GitHub App + commit `renovate.json`;
   it opens bump PRs (cooldown via `minimumReleaseAge`) gated on the contract
   test; green auto-merges, red parks and pings.
4. **Axis 1 = Option D:** bake `stable` + `latest` into the image under
   versioned paths; add `agent.channel` (session setting + `shipit.yaml`); thread
   selection through the adapter spawn. Default stays on the tested pin.

Net: deterministic and auditable, git-revertable rollback, supply-chain risk
slashed by cooldown + integrity + `--ignore-scripts`, breakage caught in CI
before users see it, and power users get the bleeding edge on demand.

## Local / dogfood mode (RUNTIME_MODE=local)

In `local` mode there are no session-worker containers: `buildLocalAgentFactory`
(`app-di.ts`) spawns `ClaudeAdapter`/`CodexAdapter` **in-process inside the
orchestrator container**, which gets its CLIs from `Dockerfile.prod` /
`Dockerfile.dev` / `Dockerfile.dogfood` — *not* the worker image. So:

- The two-prefix install + channel-aware spawn must be replicated in the
  orchestrator images, or `agent.channel` silently no-ops in local/dogfood mode.
- Axis-2 hardening and the Axis-3 contract test must cover the orchestrator-image
  install path too, not only the worker image.
- The orchestrator prod/dev images currently omit `@playwright/mcp`; the channel
  layout there differs from the worker image and should be reconciled.

This is a first-class supported runtime (CLAUDE.md "Dogfooding ShipIt in
ShipIt"), so it's part of scope, not an afterthought.

## Key files (to touch when implementing)

CLI install layer — **six** Dockerfiles install the CLIs, not a subset:
- Worker images: `docker/Dockerfile.session-worker.prod` (has cache-bust),
  `.dev` (no refresh), `.dogfood` (no refresh).
- Orchestrator images (local/dogfood mode): `docker/Dockerfile.prod`,
  `docker/Dockerfile.dev`, `docker/Dockerfile.dogfood` — prod/dev omit
  `@playwright/mcp` today.
- Replace ad-hoc `npm install -g … @latest` with lockfile-based per-prefix
  installs of both channels in all six.
- `docker/Dockerfile.session-worker.docker` exists but does **not** install the
  CLIs — no change needed.

Other touchpoints:
- `deployment/vps/deploy.sh` — drop `NPM_GLOBALS_REBUILD=$(date +%s)` (line 25)
  and update the explanatory comment block (lines 22-24); likewise the comments
  in `Dockerfile.session-worker.prod:28-30`.
- `src/server/session/claude.ts` — bare `pty.spawn("claude")` → channel-aware
  absolute path / PATH-scoped spawn.
- `src/server/session/agents/codex-adapter.ts` — channel-aware `which` check and
  `spawn("codex")`; optional startup version self-check.
- `src/server/session/agents/tool-map.ts` — surface exercised by the contract
  test (no change, but covered).
- `src/server/shared/agent-registry.ts` — per-channel `installed`/health probe;
  version reporting.
- `src/server/orchestrator/app-di.ts` / `session-runner.ts` — extend the
  `agentFactory` signature (currently `(agentId) => AgentProcess`) and call sites
  to carry the channel; covers `buildLocalAgentFactory` for local mode.
- `src/server/shared/shipit-config.ts` — `AgentConfig` gains `channel`; add it to
  `AGENT_DEFAULTS` (line 68) and `KNOWN_AGENT_KEYS` (line 80).
- `src/server/shipit-docs/` — document `agent.channel` for the in-container
  agent (agent-facing platform behavior).
- New: per-channel CLI install `package.json` + `package-lock.json`; CLI contract
  test; `renovate.json` for the Renovate GitHub App (config the manifest as a
  dependency target, set `minimumReleaseAge: "7 days"` for the cooldown, enable
  auto-merge on green).

## Bump tooling — decision

Use the **Mend-hosted Renovate GitHub App** (free for public and private repos).
Rationale:

- The cooldown primitive (`minimumReleaseAge`) is built in — the one thing we
  specifically need and the reason we don't roll our own.
- Hosted app = no infra to run (vs. self-hosting Renovate as an Action/cron).
- Auto-merge-on-green is native, so the happy path needs no human babysitting.

Alternatives considered and rejected for now: **Dependabot** (built into GitHub,
free, but weaker/newer cooldown support); **self-hosted Renovate** (more control,
unnecessary infra); a **hand-rolled scheduled Action** (~30 lines: `npm view`,
age check, bump, open PR — full control but more code to maintain). Mend's paid
SCA/security platform is *not* required for this use case.

## Open questions

- Cooldown length is fixed at **7 days**; open only whether any package warrants
  a different value (default: same 7 days for all).
- Where the channel setting lives canonically (session setting vs. `shipit.yaml`
  vs. both) and precedence between them.
- Whether `@playwright/mcp` follows the same pin/channel discipline or stays a
  single best-effort-latest global install (it's an MCP server invoked via `npx`,
  not a spawned agent, so less tightly coupled — but it's absent from the
  prod/dev orchestrator images, so its layout already differs).
- Whether the startup self-check should *block* a session on a failed handshake
  or merely warn.
- **Shared credential store across channels.** Both channels share a single
  credentials volume (`/root/.claude`, `/root/.codex`, `~/.claude.json`). A
  `latest` CLI that migrates or rewrites the on-disk auth format (e.g. Codex
  `auth.json`, the `codex login --device-auth` flow) could break the `stable`
  channel that shares the same file. The Axis-3 contract test checks *protocol*,
  not credential-store migration, so this needs separate consideration — possibly
  per-channel credential paths, or pinning the auth schema across channels.
