# CLI version strategy — implementation checklist

Tracks the four-axis rollout from `plan.md`. Order follows the plan's
"Recommended rollout order".

## Axis 2 — Supply-chain hardening (do first) — DONE

- [x] Create a dedicated manifest for the global CLI installs
      (`docker/agent-cli/package.json`) pinning `@anthropic-ai/claude-code`
      (2.1.140), `@openai/codex` (0.130.0), `@playwright/mcp` (0.0.75) to
      known-good versions that clear the 7-day cooldown (cutoff 2026-05-13).
- [x] Generate the committed `docker/agent-cli/package-lock.json` (integrity
      hashes for every platform binary → bytes verified, not just version
      strings).
- [x] Install via `npm ci --ignore-scripts` into `/opt/agent-cli` whose
      `node_modules/.bin` is added to `PATH` (keeps bare-name `claude` /
      `codex` / `playwright-mcp` resolution working — no spawn-site changes).
- [x] Update all six Dockerfiles to use the lockfile-based install:
  - [x] `docker/Dockerfile.session-worker.prod`
  - [x] `docker/Dockerfile.session-worker.dev`
  - [x] `docker/Dockerfile.session-worker.dogfood`
  - [x] `docker/Dockerfile.prod` (orchestrator; now includes `@playwright/mcp`)
  - [x] `docker/Dockerfile.dev` (orchestrator; now includes `@playwright/mcp`)
  - [x] `docker/Dockerfile.dogfood` (orchestrator)
- [x] Drop `NPM_GLOBALS_REBUILD=$(date +%s)` from `deployment/vps/deploy.sh`
      and update the explanatory comment block. Also updated the stale
      references in `deployment/vps/restart.sh` and `CLAUDE.md`.
- [x] Drop the `NPM_GLOBALS_REBUILD` ARG + cache-bust comment from
      `Dockerfile.session-worker.prod` and `Dockerfile.prod`.
- [x] Verify the CLIs run under `--ignore-scripts`. Finding: `claude-code` 2.x
      *requires* its postinstall (`install.cjs`) to link its native binary, so
      a blanket `--ignore-scripts` breaks it. Solution: `npm ci --ignore-scripts`
      blocks the whole tree, then `npm rebuild @anthropic-ai/claude-code` runs
      the install script for *only* that one trusted package. codex and
      `@playwright/mcp` need no scripts. Browsers are still fetched explicitly
      via `playwright install-deps` / `playwright-mcp install-browser` (worker
      images only). Verified end-to-end on x86_64.
- [ ] (Higher effort, optional) provenance / SBOM verification + image scan.

> Note: with `npm ci` driving freshness deterministically, the per-package
> "install nothing younger than 7 days" cooldown is enforced at *bump time* by
> Renovate's `minimumReleaseAge` (Axis 1/C), not at build time. The initial pin
> above was hand-selected to already clear the cooldown.

## Axis 3 — Integration safety net (CLI contract test)

- [ ] CI job that installs the candidate version and exercises real binaries:
  - [ ] Spawn `claude` with `stream-json`; assert NDJSON event shapes
        (assistant text, `tool_use`, `tool_result`, `result`).
  - [ ] Spawn `codex app-server`; complete JSON-RPC handshake; assert protocol
        version + round-trip.
  - [ ] Assert every flag we pass is still accepted (`--resume`,
        `--mcp-config`, `--model`, `--settings`).
  - [ ] Run `tool-map` normalization against observed tool names.
- [ ] Wire as the required merge gate on bump PRs.
- [ ] (Optional) worker startup self-check that logs/flags version mismatch or
      failed handshake; feed `agent-registry` health reporting.
- [ ] Decide whether the startup self-check blocks a session or merely warns
      (open question).

## Axis 1 / Option C — tested pin + auto-bump (Renovate)

- [ ] Install the Mend-hosted Renovate GitHub App (out-of-band admin action).
- [x] Commit `renovate.json` targeting `docker/agent-cli/package.json` as a
      dependency target. Scoped with `includePaths: ["docker/agent-cli/**"]` so
      Renovate ignores the root repo deps and only bumps the three agent CLIs;
      `rangeStrategy: "pin"` keeps the exact pins so the lockfile (and its
      integrity hashes) is regenerated on every bump.
- [x] Set `minimumReleaseAge` (`"7 days"`) to enforce the cooldown.
- [ ] Enable auto-merge on green. **Deliberately left `automerge: false`** until
      the Axis-3 CLI contract test exists and is wired as a required status
      check — auto-merging CLI bumps on only lint/build/unit-test green would
      ship the exact integration breakage Axis 3 is meant to catch (the plan's
      top concern). Flip to `true` in the package rule once Axis 3 lands. Until
      then a human reviews + merges the grouped bump PR.

## Axis 1 / Option D — stable + latest channels

- [ ] Bake two install trees into the image under versioned prefixes
      (`/opt/agents/stable`, `/opt/agents/latest`).
- [ ] Decide whether `@playwright/mcp` is channel-scoped or a single global
      install (open question).
- [ ] Channel-aware spawn in `src/server/session/claude.ts`
      (absolute path / PATH-scoped `spawnEnv`).
- [ ] Channel-aware `which` + `spawn` in
      `src/server/session/agents/codex-adapter.ts`.
- [ ] Per-channel `installed`/health probe in
      `src/server/shared/agent-registry.ts`.
- [ ] Thread `channel` through the agent factory
      (`app-di.ts` `agentFactory`, `session-runner.ts` call sites,
      `buildLocalAgentFactory` for local mode).
- [ ] Add `agent.channel` to `src/server/shared/shipit-config.ts`
      (`AGENT_DEFAULTS`, `KNOWN_AGENT_KEYS`) + session/repo setting.
- [ ] Document `agent.channel` in `src/server/shipit-docs/`.
- [ ] Replicate the two-prefix install in the orchestrator images for
      local/dogfood mode.

## Open questions (track, resolve before the relevant axis)

- [ ] Per-package cooldown overrides? (Axis 2)
- [ ] Canonical home for the channel setting + precedence (Axis 1/D).
- [ ] Does `@playwright/mcp` follow the pin/channel discipline? (currently
      pinned in Axis 2 alongside the others).
- [ ] Startup self-check: block vs. warn (Axis 3).
- [ ] Shared credential store across channels — per-channel credential paths or
      pinned auth schema (Axis 1/D).
