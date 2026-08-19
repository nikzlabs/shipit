/**
 * The pin for `server-test-setup.ts`'s credential strip.
 *
 * A ShipIt session container materializes the user's real credentials into the
 * agent's `process.env` — a catalogue `storageEnv` per credential group, plus a
 * `SHIPIT_CREDENTIAL_*` per stored route (docs/252 phase 5). CI runners and
 * developer boxes have none, so any test asking "what can this install run"
 * answered differently in the two places: `reviewer-settings-api`,
 * `agent-spawn-route` (twice) and `ask-user-question` all passed in CI while
 * failing inside a container, and none of them names a credential anywhere.
 *
 * The strip alone cannot be tested where there is nothing to strip, which is
 * exactly CI. So the `server` project injects a sentinel of each shape
 * (`vitest.config.ts` → `env`) and this file asserts both halves:
 *
 *   - the sentinels are GONE, so the strip still runs;
 *   - the marker is PRESENT, so the injection still happens.
 *
 * Without the second assertion, deleting the injection would leave this file
 * passing and the strip unverified again — the same shape as the bug.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { credentialStorageEnvNames } from "./catalogue/index.js";
import { CREDENTIAL_ROUTE_ENV_PREFIX } from "./types/domain-types/credential-route.js";

describe("server test environment is hermetic", () => {
  it("still injects the ambient-credential sentinels", () => {
    expect(
      process.env.SHIPIT_TEST_AMBIENT_ENV_MARKER,
      "the `server` project's `env` block in vitest.config.ts no longer injects the sentinel "
        + "credentials, so nothing here proves server-test-setup.ts strips them",
    ).toBe("1");
  });

  it("strips every catalogue credential variable", () => {
    for (const name of credentialStorageEnvNames()) {
      expect(process.env[name], `${name} leaked into a server test`).toBeUndefined();
    }
  });

  it("strips every per-route credential variable", () => {
    const leaked = Object.keys(process.env).filter((n) =>
      n.startsWith(CREDENTIAL_ROUTE_ENV_PREFIX),
    );
    expect(leaked, `${CREDENTIAL_ROUTE_ENV_PREFIX}* leaked into a server test`).toEqual([]);
  });

  /**
   * The strip runs before EVERY test, not only once per file: a credential
   * written through the API assigns its mode's variable in this process
   * (`setApiKey`, `credential-routes`), so a test that stores one would
   * otherwise hand the next test in its file an install that is already
   * configured.
   */
  it("re-strips between tests in the same file", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-written-by-a-test";
  });

  it("sees no credential from the preceding test", () => {
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  /**
   * The pin for the throwaway `GIT_CONFIG_GLOBAL` (#2432).
   *
   * A session container points that variable at `/credentials/.gitconfig`, the
   * live brokered config; the suite's git writes went straight into it, swapped
   * the `shipit-git-credential` helper for a `cat` of a fixture token and left
   * the session unable to push for the rest of its life. Both halves are
   * asserted because the failure modes are opposite: pointing it somewhere real
   * breaks the session, and unsetting it sends
   * `git-config.ts`'s `globalCredentialFilePath()` to its hardcoded
   * `/credentials` fallback — the same directory, by a different route.
   */
  it("gives the suite its own throwaway global git config", () => {
    const configPath = process.env.GIT_CONFIG_GLOBAL;
    expect(
      configPath,
      "GIT_CONFIG_GLOBAL is unset, so `globalCredentialFilePath()` falls back to /credentials — "
        + "the session's own credential directory",
    ).toBeDefined();
    // Compared through realpath: macOS resolves os.tmpdir() to /private/var/…,
    // so a raw prefix check would fail there for a path that IS in the temp dir.
    const realTmp = fs.realpathSync(os.tmpdir());
    const realConfigDir = fs.realpathSync(path.dirname(configPath!));
    expect(
      realConfigDir.startsWith(realTmp + path.sep) || realConfigDir === realTmp,
      `GIT_CONFIG_GLOBAL points at ${configPath} — outside the temp dir, so a test's `
        + "`git config --global` write lands on a real config (in a session container, the "
        + "brokered /credentials/.gitconfig)",
    ).toBe(true);
  });

  /**
   * The other half of #2432's family, and the reason it is a static scan rather
   * than an assertion about this process: the write happens in whichever worker
   * runs the offending file, so no single test can observe it.
   *
   * `credentialsDir` is a HOST path. Passed as the literal, `createContainer` →
   * `ensureSessionCredentialsScaffold` creates real fixture subtrees under it,
   * and inside a session container that is the running agent's own credentials
   * directory. `resolveCredentialsDir` (`app-di.ts`) already refuses the live
   * volume for anything built through `buildApp()`; this covers the tests that
   * build a config directly and never reach it. The container-side mount
   * TARGET is legitimately the literal, so the scan matches the assignment
   * only.
   *
   * **Scanned per SETUP FILE, not per directory.** The hazard is exactly "a
   * test file that runs with `server-test-setup.ts` loaded", and
   * `vitest.config.ts` loads it for TWO projects: `server` (`src/server/**`)
   * and `tooling` (`scripts/**`). Walking only `src/server` — as this did when
   * it was written beside the `server` project's other pins — left the second
   * one unscanned, so a `scripts/**.test.ts` could reintroduce #2432's litter
   * half with the guard green. There is no offender there today; the point is
   * that the scan's reach should be decided by which files can do the damage,
   * not by which directory the guard happens to live in.
   */
  it("no test passes the live credentials volume as a host path", () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    // Listed rather than walked from the repo root: `docs/`, `.git/` and the
    // Gradle trees hold no test Vitest runs, and walking them costs more than
    // it can ever catch.
    // Exactly the two roots, and no more: `src/client` runs under its own
    // `test-setup.ts` and never loads `server-test-setup.ts`, so a file there
    // cannot trip this guard and scanning it would only blur what the scan
    // claims to cover.
    const setupFileRoots = ["src/server", "scripts"];
    const roots = setupFileRoots.map((rel) => path.join(repoRoot, rel));
    const offenders: string[] = [];
    const scanned: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (entry.name.endsWith(".test.ts")) {
          const rel = path.relative(repoRoot, full);
          scanned.push(rel);
          const text = fs.readFileSync(full, "utf-8");
          text.split("\n").forEach((line, i) => {
            if (/credentialsDir:\s*"\/credentials"/.test(line)) {
              offenders.push(`${rel}:${i + 1}`);
            }
          });
        }
      }
    };
    for (const root of roots) walk(root);

    // Both roots must actually have been reached. With no offender anywhere,
    // the assertion below passes whether the scan covers one root or both —
    // the same CI-invisibility that let #2432 exist, one level up. So the
    // reach is asserted directly rather than inferred from a green scan.
    for (const rel of setupFileRoots) {
      expect(
        scanned.some((f) => f.startsWith(`${rel}${path.sep}`)),
        `the scan reached no *.test.ts under ${rel}/ — it covers a project whose tests load `
          + "server-test-setup.ts, so a live-credentials write there would go uncaught",
      ).toBe(true);
    }

    expect(
      offenders,
      "these tests would write fixture credential subtrees into the live /credentials volume — "
        + "import TEST_CREDENTIALS_DIR from orchestrator/credentials-test-helpers.js instead",
    ).toEqual([]);
  });
});
