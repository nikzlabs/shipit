/**
 * Server test setup — runs in every server-test worker before the test modules
 * load (registered in `vitest.config.ts` under the `server` project).
 *
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
 * docs/172 (SHI-90) — agent egress containment is now ON by default
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
