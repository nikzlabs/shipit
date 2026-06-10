---
issue: https://linear.app/shipit-ai/issue/SHI-88
description: Readiness assessment and migration plan for npm v12's install hardening (lifecycle-script allowlist, --allow-git, --allow-remote) across ShipIt's npm invocation points.
---

# npm v12 readiness

npm v12 (estimated July 2026, per the [GitHub changelog](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/))
ships three install-hardening defaults that flip from permissive to deny. This
doc records how each lands on ShipIt's npm invocation points, what is already
compatible, and what we change (and when). It is **reference / readiness** — no
install command changes ship with this doc. The work is deliberately deferred
until npm v12 is released and its `approve-scripts` allowlist API is final;
see the migration plan and `checklist.md`.

## The three breaking changes

1. **Lifecycle scripts off by default.** `npm install` no longer runs
   `preinstall` / `install` / `postinstall` from dependencies (nor `prepare`
   from git/file/link deps, nor implicit `node-gyp` rebuilds) unless the package
   is explicitly allowlisted. The migration path npm provides is
   `npm approve-scripts --allow-scripts-pending` to enumerate the scripts a tree
   wants to run, then committing an allowlist into `package.json`.
2. **Git dependencies off by default.** `npm install` no longer resolves git
   dependencies (direct or transitive) without `--allow-git`. This closes a hole
   where a git dep's `.npmrc` could override the git executable even under
   `--ignore-scripts`.
3. **Remote-URL dependencies off by default.** `npm install` no longer resolves
   https-tarball dependencies (direct or transitive) without `--allow-remote`.
   `--allow-file` and `--allow-directory` keep their current defaults.

The throughline is supply-chain hardening — the same posture ShipIt already
encodes in its [dependency policy](../../CLAUDE.md) (exact pins, 7-day minimum
age) and in the agent-CLI install (`docs/141`). npm v12 is the ecosystem
catching up to where ShipIt already lives, so most of the surface is already
compatible.

## Impact by invocation point

ShipIt installs npm packages in three distinct contexts. Status against each
npm v12 change:

### A. Agent CLI install — already compatible ✅

All Dockerfiles install the agent CLIs from the committed, integrity-pinned
`docker/agent-cli/` lockfile via:

```dockerfile
(cd /opt/agent-cli && npm ci --ignore-scripts && npm rebuild @anthropic-ai/claude-code)
```

`--ignore-scripts` already denies the whole tree; the single trusted native
postinstall (`@anthropic-ai/claude-code`) is run explicitly via `npm rebuild`.
This is exactly the npm v12 posture, reached early (see `docs/141`, Axis 2).
**No change required** for change #1. There are no git/remote deps in
`docker/agent-cli/package.json`, so #2/#3 don't apply.

- `docker/Dockerfile.prod:40`
- `docker/Dockerfile.dev:19`
- `docker/Dockerfile.dogfood:44`
- `docker/Dockerfile.session-worker.dev:30`
- `docker/Dockerfile.session-worker.prod:67`

### B. Main app build — needs attention ⚠️ (change #1 only)

The orchestrator/client build installs the root `package.json` **without**
`--ignore-scripts`:

```dockerfile
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline   # Dockerfile.prod:11, .session-worker.prod:9
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --loglevel=verbose  # .dev:29, .session-worker.dev:48
```

GitHub Actions does the same: `.github/workflows/ci.yml` (`npm ci`) and
`.github/workflows/release.yml` (`npm ci`).

Under npm v12 defaults, the lifecycle scripts these rely on stop running. The
root tree's known script-running dependencies are the two native modules:

- **`better-sqlite3`** — `node-gyp` build (deliberate; see `docs/071`).
- **`node-pty`** — native PTY binding `node-gyp` build.

plus any transitive packages with install scripts (e.g. build-tooling natives
pulled by vite/esbuild). When npm v12 ships, this is the surface that needs
either an `approve-scripts` allowlist committed to `package.json`, **or** the
agent-CLI pattern (`npm ci --ignore-scripts && npm rebuild better-sqlite3
node-pty`, after enumerating the full set of script-needing packages with
`npm approve-scripts --allow-scripts-pending`).

No git/remote deps in the root tree, so #2/#3 don't apply. The
`check-dependency-age.ts` exact-pin rule structurally forbids git/tarball
specifiers, so #2/#3 stay pre-satisfied as long as that check runs in CI.

### C. Session installs — needs attention ⚠️ (change #1 only)

User session installs run a bare command, and session MCP packages install
globally:

- `shipit.yaml:14` — `install: npm install`
- session-worker global MCP installs — `npm install -g <pkg>`

These are user-project installs (whatever the user's repo declares) plus a small
fixed set of MCP packages. Under npm v12 they would skip lifecycle scripts by
default. This is the widest blast radius (every session), so any change here is
treated separately and is **out of scope for the readiness doc** — it touches
user-facing install behavior and wants its own design pass.

## What ships now

Nothing in the install path — just this doc and its tracker issue (SHI-88). The
actual command changes are gated on npm v12's release because:

- The `approve-scripts` allowlist field does not exist in the npm version we
  currently ship, so we cannot author or test it today.
- Pre-emptively switching the main build to `--ignore-scripts` + explicit
  `npm rebuild` is a real hardening win but risks breaking the build if a
  transitive script-needing package is missed — it should be done against a real
  npm v12 (or a faithful enumeration via `approve-scripts`) and verified, not
  guessed.

## Migration plan (when npm v12 is released)

1. Run `npm approve-scripts --allow-scripts-pending` against the **root** tree to
   enumerate every package that wants a lifecycle script. Confirm the set is the
   expected natives (`better-sqlite3`, `node-pty`, build-tooling transitives).
2. Commit the resulting allowlist to root `package.json` (preferred — declarative
   and reviewable) **or** convert the main-app installs to
   `npm ci --ignore-scripts && npm rebuild <enumerated packages>` to mirror the
   agent-CLI pattern. Pick one consistently.
3. Verify `npm run build`, `npm test`, and a container build all pass with the
   v12 defaults.
4. Decide separately on session installs (context C) — likely surface a clear
   error/guidance when a user project needs scripts, rather than silently
   allowing them.
5. Keep `npm run check-deps` in CI so git/tarball specifiers stay impossible,
   keeping #2/#3 pre-satisfied without `--allow-git` / `--allow-remote`.

## Key files

- `docker/Dockerfile.prod`, `docker/Dockerfile.dev`, `docker/Dockerfile.dogfood`,
  `docker/Dockerfile.session-worker.prod`, `docker/Dockerfile.session-worker.dev`
  — the npm install invocations (agent CLI + main app).
- `docker/agent-cli/package.json`, `docker/agent-cli/package-lock.json` — already
  installed with `--ignore-scripts` (`docs/141`).
- `scripts/check-dependency-age.ts` — exact-pin + 7-day-age enforcement; the
  exact-pin rule is what keeps git/remote specifiers out (changes #2/#3).
- `shipit.yaml`, session-worker global MCP installs — session-context installs
  (context C).
- `.github/workflows/ci.yml`, `.github/workflows/release.yml` — CI installs.

## Related docs

- `docs/141-cli-version-strategy/plan.md` — agent-CLI install hardening
  (`--ignore-scripts` + selective rebuild), the pattern the main app would adopt.
- `docs/071-sqlite-investigation/` — why `better-sqlite3` (a native, script-using
  dependency) is in the tree.
