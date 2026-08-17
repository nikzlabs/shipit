/**
 * Server test setup — runs in every server-test worker before the test modules
 * load (registered in `vitest.config.ts` under the `server` project).
 */

import { beforeEach } from "vitest";
import { credentialStorageEnvNames } from "./src/server/shared/catalogue/index.js";
import { CREDENTIAL_ROUTE_ENV_PREFIX } from "./src/server/shared/types/domain-types/credential-route.js";

/**
 * Neutralize host-injected command-line-level git config. Some dev sandboxes
 * export `safe.bareRepository=explicit` (and similar) via git's
 * GIT_CONFIG_COUNT / GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n> env protocol —
 * the highest-precedence config layer, above even GIT_CONFIG_GLOBAL. With
 * `safe.bareRepository=explicit`, git refuses to auto-discover a bare repo from
 * its working directory ("fatal: not in a git directory"), which breaks every
 * test that operates on a bare cache (repo-git, git-utils, git-worktree,
 * repo-prefetch, warm-pool, template repo creation, …). CI and production
 * session containers never set this, so the failures are purely a local-env
 * artifact. Stripping the injection makes the suite run git in the same
 * pristine config as CI and prod. Tests that need specific git config still set
 * it explicitly via `initGlobalGitConfig` / GIT_CONFIG_GLOBAL.
 */
const count = Number.parseInt(process.env.GIT_CONFIG_COUNT ?? "", 10);
const keysToClear = ["GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"];
if (Number.isInteger(count)) {
  for (let i = 0; i < count; i += 1) {
    keysToClear.push(`GIT_CONFIG_KEY_${i}`, `GIT_CONFIG_VALUE_${i}`);
  }
}
for (const key of keysToClear) {
  Reflect.deleteProperty(process.env, key);
}

/**
 * docs/172 (planning#92) — agent egress containment is now ON by default
 * (`egressEnforceEnabled()` returns true unless `SESSION_EGRESS_ENFORCE=0`).
 * In production that's correct; in the server test suite it's an artifact: the
 * container-lifecycle / standby / warm-pool integration tests create sessions
 * against a *fake* Docker with no `SESSION_EGRESS_SIDECAR_IMAGE`, so a contained
 * session would (correctly) fail closed and abort `createContainer`. Default the
 * opt-out here so those tests exercise container lifecycle without a real
 * NET_ADMIN sidecar. The egress-specific unit tests don't rely on this — they
 * pass explicit env objects to `egressEnforceEnabled(...)` / `egressEnforcementActive(...)`
 * — and any test that wants enforcement on can still set the var locally.
 */
if (process.env.SESSION_EGRESS_ENFORCE === undefined) {
  process.env.SESSION_EGRESS_ENFORCE = "0";
}

/**
 * planning#313 — `SHIPIT_WORKER_TOKEN` is injected into EVERY session container
 * unconditionally (`container-lifecycle.ts:createContainer`, no sandbox/ops
 * branch) and is set on nothing else: CI runners and developer boxes never have
 * it. So inside a dogfood session container it is ambient, and any test code
 * that reads it from `process.env` behaves differently there than in CI — the
 * CI-INVISIBLE failure class this file exists to kill (same shape as the
 * git-config injection above).
 *
 * planning#421 narrowed how far that can reach: `registerWorkerAuthGuard` no longer
 * falls back to the environment at all, so a `SessionWorker` built without a
 * `workerToken` is tokenless everywhere, and the ~ten integration fixtures that
 * drive `/agent/start` over loopback no longer depend on this line. The single
 * remaining reader is `requireWorkerToken`, called by the container entry point
 * (never by a test) and given its env explicitly in its own tests. The strip
 * stays as the cheap guarantee that a future `requireWorkerToken(process.env)`
 * in a test cannot pass in a container and fail in CI. The literal is spelled
 * out — this file imports only side-effect-free catalogue data (see the
 * credential strip below) — and is pinned to `WORKER_TOKEN_ENV` by an assertion
 * in `shared/worker-auth.test.ts`.
 */
Reflect.deleteProperty(process.env, "SHIPIT_WORKER_TOKEN");

/**
 * No server test may touch the network through git.
 *
 * Several integration tests drive paths that clone or fetch from a *fake*
 * GitHub URL and assert the resulting failure — `claim-session`'s slow path
 * self-heals a missing bare cache with `ensureBareCache(url)`, and
 * `fetchAndResolveDefaultBranch` fetches the workspace's origin directly. Those
 * URLs don't exist, but git still performs a real DNS + TLS + HTTP round-trip
 * to github.com before finding that out. On a developer box that costs ~230ms
 * and looks harmless; on a CI runner sharing a NAT with hundreds of parallel
 * jobs it is unbounded, and it timed out two different 5s tests on consecutive
 * runs (`repos.test.ts` claim-session, `http-phase3.test.ts` repo creation)
 * with no code change to explain either.
 *
 * `GIT_ALLOW_PROTOCOL` is git's own transport allowlist. Restricting it to
 * `file` turns every https/ssh operation into an immediate
 * `fatal: transport 'https' not allowed` (~5ms, no packets), while local-path
 * and `file://` remotes — which is what every legitimate git test uses for its
 * bare remotes — keep working unchanged. The tests that assert a failure still
 * assert a failure; they just stop paying for a round-trip to learn it.
 *
 * `GIT_TERMINAL_PROMPT=0` is belt-and-braces for any transport that slips
 * through: git must fail rather than block on a credential prompt. Individual
 * tests already set this; defaulting it here means a new test can't forget.
 */
if (process.env.GIT_ALLOW_PROTOCOL === undefined) {
  process.env.GIT_ALLOW_PROTOCOL = "file";
}
if (process.env.GIT_TERMINAL_PROMPT === undefined) {
  process.env.GIT_TERMINAL_PROMPT = "0";
}

/**
 * **A server test starts with NO credential configured**, whatever the machine
 * running it holds.
 *
 * Same class as the `SHIPIT_WORKER_TOKEN` strip above, and the same
 * CI-invisible shape: a ShipIt session container materializes the user's real
 * credentials into the agent's `process.env` — a catalogue `storageEnv`
 * (`DEEPSEEK_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, …) per credential group, plus a
 * `SHIPIT_CREDENTIAL_*` per stored route (docs/252 phase 5) — and the test
 * process inherits every one of them. CI runners and developer boxes have none,
 * so service and credential discovery answers a *different question* in the two
 * places and tests that assert on what an install can run diverge silently.
 * Four tests across three files did, and none of them names a credential
 * anywhere:
 *
 *   - `reviewer-settings-api` — the second reviewer slot is derived from the
 *     families the install holds, so an ambient `DEEPSEEK_API_KEY` seeded the
 *     very service the test then adds to prove re-derivation happens.
 *   - `agent-spawn-route` — "no reviewer is available" and "Codex is not signed
 *     in" are both statements about an install with nothing configured; an
 *     ambient key makes a reviewer resolvable (the spawn then really runs, and
 *     the test times out) and turns the sign-in refusal into a per-model one.
 *   - `ask-user-question` — the quota-failover ledger walks every candidate
 *     credential, so an ambient key adds an attempt the test never feeds.
 *
 * Stripped here rather than per test file: "inherits the host's credentials" is
 * a property of the whole suite, and a per-file save/restore has to be
 * remembered by every future test that asks what an install can run.
 *
 * **Twice, and both are load-bearing.** Eagerly, before the test modules are
 * imported, because a test file can read the variable at module scope (several
 * capture `process.env.OPENAI_API_KEY` into a `const` to restore later). And
 * again before every test, because the ambient environment is not the only
 * source: a credential written through the API materializes its mode's variable
 * into THIS process — `setApiKey` and `credential-routes` both assign
 * `process.env`, deliberately, since `AgentRegistry` and `reservedRouteFor`
 * probe it — so a test that stores a credential leaves one set for the next
 * test in its file. `http-mutations.test.ts` does exactly that with
 * `POST /api/auth/api-key` and restores only `OPENAI_API_KEY`.
 *
 * Tests that *exercise* env-delivered credentials are unaffected: they set the
 * variable themselves, in a `beforeEach` or in the test body, which runs after
 * this hook and wins. (No test sets one in `beforeAll`, which this WOULD clear
 * — set it per test, or stub it with `vi.stubEnv`.)
 *
 * The name list is DERIVED from the catalogue, so a new service needs no edit
 * here — the same rule `ALLOWED_ENV_KEYS` follows, and the reason this file
 * imports at all. Both imports are side-effect-free data.
 *
 * Pinned by `shared/test-env-hermeticity.test.ts` against a sentinel credential
 * the `server` project injects, so CI — which has no real credentials and would
 * otherwise pass whether or not any of this runs — fails if it regresses.
 */
function stripCredentialEnv(): void {
  for (const name of credentialStorageEnvNames()) {
    Reflect.deleteProperty(process.env, name);
  }
  for (const name of Object.keys(process.env)) {
    if (name.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX)) Reflect.deleteProperty(process.env, name);
  }
}

stripCredentialEnv();
beforeEach(stripCredentialEnv);
