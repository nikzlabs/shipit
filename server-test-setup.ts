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
