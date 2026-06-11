---
issue: https://linear.app/shipit-ai/issue/SHI-110
description: Evaluate and (optionally) migrate ShipIt's root toolchain from npm to pnpm — reframed once npm v11.10 shipped its own install-age gate, making the migration an efficiency/strictness upgrade rather than a security necessity.
---

# 193 — pnpm migration

## Summary

Migrate **ShipIt's own application toolchain** (the orchestrator + client build) from
npm to pnpm. The trigger was the dependency-age question (`scripts/check-dependency-age.ts`):
pnpm's `minimumReleaseAge` enforces the 7-day age policy **at install time across the
entire dependency tree**, where the current script only inspects the direct deps listed
in `package.json`. As a bonus, pnpm 10 blocks dependency build scripts by default —
the most common supply-chain code-exec vector.

This is a toolchain migration, not a config flip. It touches CI, both production
Dockerfiles, the deploy build, Dependabot, and the dogfood/dev paths. The work is
mechanical but spread across infra, so it's planned in phases with a clean rollback.

## 2026 reality check — npm closed the gap (read before committing to this)

Research (June 2026) materially weakens this migration's headline rationale. The
release-age gate now exists in **all three** major package managers:

| Tool | Config key | Default |
|---|---|---|
| **npm ≥ 11.10** | `min-release-age` (days) in `.npmrc` — requires Node 24 LTS, which ShipIt already runs | OFF (opt-in) |
| **pnpm ≥ 11** | `minimumReleaseAge` (minutes) | **ON, 1 day** by default |
| **Yarn ≥ 4.10** | `npmMinimalAgeGate` | ON, 3 days |

So the strongest concrete reason to migrate — "only pnpm enforces install-age" — is no
longer true. ShipIt can get the supply-chain age gate **today, on npm**, by setting
`min-release-age=7` in `.npmrc` (plus a scoped `ignore-scripts` allow-list for
`better-sqlite3` / `node-pty` / `esbuild`). The gate governs version *resolution* at
install time, which is already broader than `check-dependency-age.ts`'s direct-deps-only
check — so the security goal does **not** require leaving npm.

**Revised recommendation:** the cheap, high-ROI move is to enable npm's `min-release-age`
now and treat this pnpm migration as an **optional efficiency/strictness upgrade**, not a
security necessity. pnpm's durable edges over a configured npm are: secure-*by-default*
(no need to remember to configure), content-addressable store (~70% less disk, faster
installs), best-in-class monorepo support, and strict no-phantom-deps `node_modules`. Of
these, **the monorepo advantage does not apply** (ShipIt is a single package), and the
disk/speed win is real-but-modest across the CI + Docker fleet. Worth doing if/when (a) the
repo splits into a monorepo, (b) CI/Docker install time becomes real pain, or (c) we want
secure-by-default without relying on opt-in config. Until one of those bites, the migration
is defensible but not a priority.

One risk this research raised, specific to the Phase-3 Docker plan below: `node-linker=hoisted`
has open bugs where `pnpm deploy` yields an empty `node_modules`
(pnpm/pnpm#6682) — the exact prod-image path this plan depends on. Validate it on a real
image build before trusting it.

### Alternative considered: stay on npm + `min-release-age` — **IMPLEMENTED**
Lowest-cost option, captures the motivating security benefit, zero migration risk. The
trade-off vs pnpm is opt-in-vs-default safety and the disk/speed/strictness wins — none of
which are urgent for a working single-package repo. This is the recommended near-term path;
the full migration below remains the documented option for when the durable advantages
start to matter.

**Shipped in this PR:** `.npmrc` now sets `min-release-age=7` (alongside the existing
`save-exact=true`). npm implements this by computing a `before` cutoff of *now − 7 days* at
each invocation — verifiable via `npm config ls`, which shows the derived
`before = <date>` in the project config (note: `npm config get min-release-age` returns
`null` because npm exposes only the computed `before`, not the source key). `npm ci`
installs the lockfile verbatim and is unaffected; the gate only bites when *resolving* new
versions (`npm install <pkg>`, `npm update`, lockfile regen). Requires npm ≥ 11.10 on
Node 24 — already the repo's baseline. The full pnpm migration below is now explicitly the
*deferred* option.

## Scope — read this first

The repo has **three independent npm surfaces**. Only the first is in scope.

| Surface | What it is | In scope? |
|---|---|---|
| **Root manifest** (`/package.json`, `/package-lock.json`) | ShipIt's own orchestrator + React client | ✅ **Yes — this migration** |
| **Agent-CLI manifest** (`docker/agent-cli/`) | Pinned install of Claude/Codex/Playwright-MCP CLIs baked into images, Renovate-managed | ⚠️ Optional, deferred (see below) |
| **User-project installs** (inside session containers, `/workspace`) | Whatever package manager the *user's* repo uses | 🚫 **Never** — must stay neutral |

### User projects stay package-manager-neutral (hard constraint)

ShipIt deliberately never picks a package manager for user repos — `corepack enable`
in `Dockerfile.session-worker.prod` already resolves `pnpm`/`yarn` from each repo's
`packageManager` field, and `tuneNpmInstall()` (`src/server/session/install-runtime.ts`)
only tunes a *bare* `npm install`. **None of that changes.** A user on npm keeps getting
npm. This migration is strictly about how ShipIt builds *itself*.

### Agent-CLI manifest stays on npm (for now)

`docker/agent-cli/package.json` is a tiny, isolated, lockfile-pinned manifest installed
with `npm ci --ignore-scripts && npm rebuild @anthropic-ai/claude-code`. It's already
hardened (scripts blocked except one trusted rebuild) and Renovate already applies a
`minimumReleaseAge` cooldown to it. Migrating it buys almost nothing and widens the blast
radius, so it stays on npm. Revisit only if we want a single package manager repo-wide.

## What pnpm buys us (and what it doesn't)

**Wins:**
- **Full-tree install-age enforcement** via `minimumReleaseAge` — covers transitive deps,
  which `check-dependency-age.ts` does not. This is the original motivation.
- **Build scripts blocked by default** (`onlyBuiltDependencies` allow-list) — npm runs
  every dependency's `postinstall` freely; pnpm 10 refuses unless explicitly approved.
- Content-addressable store → faster, smaller installs across the dev/CI/Docker fleet.
- Strict `node_modules` (no phantom dependencies) — *if* we keep the isolated linker.

**Non-wins — do not expect these for free:**
- **Exact-version pinning is NOT enforced by pnpm.** `pnpm add` honours `save-exact`, but a
  hand-edited `"^19.2.4"` is still accepted at install. The pinning half of
  `check-dependency-age.ts` must survive (see "check-deps decision").
- The "deliberate bump" policy (CLAUDE.md dependency policy) is a *stance*, not a tooling
  artifact — pnpm's deterministic lockfile is no more deterministic than
  `package-lock.json` already is.

## Touchpoint inventory (grounded in the current tree)

| File | Current | After |
|---|---|---|
| `package.json` | `overrides`, devDep `tsx` | add `packageManager`, `pnpm.overrides`, `pnpm.onlyBuiltDependencies`, `pnpm.minimumReleaseAge`; move `tsx` → `dependencies` |
| `package-lock.json` | npm lockfile | delete; add `pnpm-lock.yaml` |
| `.github/workflows/ci.yml` | `setup-node cache: npm` + `npm ci` ×2 | `pnpm/action-setup` + `cache: pnpm` + `pnpm install --frozen-lockfile`; swap `npm run …` → `pnpm …` |
| `.github/workflows/release.yml` | `npm` invocations | audit + swap |
| `docker/Dockerfile.prod` | `npm ci --prefer-offline`, `npm prune --omit=dev && npm install tsx`, `/root/.npm` cache mount | `pnpm fetch`/`pnpm install --frozen-lockfile`, `pnpm prune --prod`, pnpm store cache mount |
| `docker/Dockerfile.session-worker.prod` | same npm build-stage pattern (agent-CLI `npm ci` block stays) | same swap as prod; **leave the `/opt/agent-cli` npm block untouched** |
| `docker/Dockerfile.dev`, `Dockerfile.dogfood`, `docker-entrypoint.dev.sh` | `npm install` / `vite build` | pnpm equivalents |
| `deployment/vps/deploy.sh` | builds via Docker (no direct npm) | no change beyond what the Dockerfiles pull in |
| `.github/dependabot.yml` | `package-ecosystem: npm`, cooldown 7d | unchanged — Dependabot's `npm` ecosystem reads `pnpm-lock.yaml`; keep cooldown + `versioning-strategy: increase` |
| `shipit.yaml` | `install: npm install` (dogfood) | `install: pnpm install` |
| `scripts/check-dependency-age.ts` | reads direct deps from `package.json` | keep (pinning), optionally trim the age half — see below |
| `CLAUDE.md`, `CONTRIBUTING.md`, `RELEASING.md`, `README.md`, skills | npm commands in docs | update commands |

## Key decisions

### 1. node-linker: `hoisted` first, tighten later
pnpm's default **isolated** linker (symlinked `node_modules`) is its strictest mode but is
also where native modules (`better-sqlite3`, `node-pty`) and phantom-dependency assumptions
across ~697 TS files are most likely to break. **Start with `node-linker=hoisted`** (a
flat, npm-like layout) to get a low-risk parity migration, confirm the full suite +
native addons + Docker build are green, then optionally switch to the isolated linker as a
follow-up PR to gain strictness. Trading strictness for a safe landing is the right order.

### 2. `onlyBuiltDependencies` allow-list
pnpm 10 blocks postinstall scripts. The packages here that genuinely need them:
`better-sqlite3`, `node-pty`, `esbuild` (and possibly a Tailwind v4 oxide native dep).
Determine the exact set from the first `pnpm install` output (`pnpm approve-builds`), then
pin it explicitly in `package.json` so CI/Docker installs are non-interactive. This
allow-list is itself a supply-chain win — it's the documented set of code-exec deps.

### 3. `overrides` → `pnpm.overrides`
Translate the existing npm `overrides` block. The nested entry changes syntax:
`"@fastify/static": { "brace-expansion": "5.0.6" }` → `"@fastify/static>brace-expansion": "5.0.6"`.
Flat entries (`ws`, `postcss`, `uuid`, …) carry over unchanged.

### 4. `tsx` moves to `dependencies`
Both prod Dockerfiles do `npm prune --omit=dev && npm install tsx` because the runtime
entrypoint is `node --import tsx`. Under pnpm, the clean equivalent is to declare `tsx`
in `dependencies` and run `pnpm prune --prod` (or `pnpm deploy`), instead of re-installing
it post-prune.

### 5. Docker layer caching: `pnpm fetch`
Replace `--mount=type=cache,target=/root/.npm` + `npm ci` with the canonical pnpm Docker
pattern: `COPY pnpm-lock.yaml` → `pnpm fetch` (store cache mount) → `COPY . .` →
`pnpm install --frozen-lockfile --offline`. This caches the store keyed only on the
lockfile, so source edits don't re-download.

### 6. `packageManager` pin
Add `"packageManager": "pnpm@<x.y.z>"` so corepack/CI use one pinned pnpm version. Pick a
version ≥ the one that ships `minimumReleaseAge` (pnpm 10.16+).

### check-deps decision
`scripts/check-dependency-age.ts` does two things; pnpm only subsumes one:
- **Age** → now enforced by `pnpm.minimumReleaseAge` across the *whole* tree at install
  time. The script's age check becomes redundant for direct deps and weaker than pnpm's.
- **Pinning** → still only enforced by the script's regex (pnpm won't reject hand-edited
  ranges).

**Recommendation:** keep the script but reduce it to the pinning check (drop the `npm view`
age lookups), and let `pnpm.minimumReleaseAge` own age enforcement. Keep `npm run
check-deps` wired in CI as `pnpm check-deps`. Keep Dependabot's 7-day `cooldown` so bump
PRs aren't born red against `minimumReleaseAge`.

## Migration phases

1. **Local parity** — add `packageManager`, `pnpm.*` config, `node-linker=hoisted`; delete
   `package-lock.json`; `pnpm install` → commit `pnpm-lock.yaml`; get `pnpm lint`,
   `pnpm typecheck`, `pnpm test`, `pnpm build` green locally. Resolve `onlyBuiltDependencies`.
2. **CI** — swap `ci.yml` + `release.yml` to `pnpm/action-setup` + `cache: pnpm`. Verify the
   full suite + `check-deps` + build on a PR.
3. **Docker** — convert both prod Dockerfiles (build stage + prune), leaving the
   `/opt/agent-cli` npm block intact. Convert dev/dogfood images + `docker-entrypoint.dev.sh`
   and `shipit.yaml`'s dogfood `install:`.
4. **Supply-chain config** — set `pnpm.minimumReleaseAge` (7 days, with an exclude escape
   hatch mirroring the policy); trim `check-dependency-age.ts` to the pinning check.
5. **Docs** — update CLAUDE.md, CONTRIBUTING, RELEASING, README, and the affected skills.

## Risks & rollback

- **Native addons** (`better-sqlite3`, `node-pty`) failing to build/link under pnpm — most
  likely failure mode; mitigated by `node-linker=hoisted` + `onlyBuiltDependencies` and
  verified by booting a session container (node-pty terminal) and exercising SQLite.
- **Phantom-dependency breakage** across the codebase — minimized by the hoisted linker;
  surfaces at typecheck/lint/test.
- **Dockerfile cross-stage `COPY node_modules`** — pnpm's symlinks resolve within
  `node_modules/.pnpm`, which is copied with the directory, so this works; verify the prod
  image actually boots, don't assume.
- **Rollback** is clean: restore `package-lock.json`, revert the workflow/Dockerfile/config
  diffs. No data or schema migration is involved, so reverting the PR fully restores npm.

## Out of scope
- Migrating the agent-CLI manifest (`docker/agent-cli/`) — stays npm.
- Changing how user projects install inside session containers — stays neutral.
- Switching to the isolated linker — a possible follow-up once hoisted parity is proven.
