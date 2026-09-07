import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// CI runs with NODE_ENV unset, so Vitest sets it to "test". A ShipIt session
// image inherits its own value (production, development, …) and Vitest leaves
// an already-set one alone — so a local run silently diverges from CI on any
// code that branches on it. Two ways that has bitten:
//   - React's production bundle does not export `act`, breaking React Testing
//     Library while the same tests pass in CI.
//   - Test-only escape hatches keyed on `NODE_ENV === "test"` (e.g.
//     `SessionRunner.authorizeDispatch`'s, docs/243) stay disabled, so suites
//     fail locally for a reason that does not exist in CI.
// Normalize to what CI does rather than enumerating the values one at a time.
if (process.env.NODE_ENV !== "test") {
  process.env.NODE_ENV = "test";
}

// Node 25 exposes localStorage/sessionStorage on globalThis, which
// prevents Vitest from copying jsdom's implementations into scope.
// --no-webstorage disables the built-in Web Storage API so jsdom wins.
// The flag doesn't exist in earlier Node versions, so only add it for 25+.
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
const clientExecArgv = nodeMajor >= 25 ? ["--no-webstorage"] : [];

/**
 * Vitest's default is 5000ms, and on a loaded box that made a green full-suite
 * run untrustworthy: `npm test` failed 1-4 tests with "Test timed out in
 * 5000ms" and a DIFFERENT file failed each run, while every one of them passed
 * in isolation. The cost that read as a real regression was a stash-and-rerun
 * to check `main` — run under the same contention, it reproduced the flake and
 * looked like proof `main` was red.
 *
 * These tests do not wait on anything that takes seconds; the deadline is
 * wall-clock, so what it ends up measuring is how much of the host they got.
 * Three DIFFERENT mechanisms were observed producing it, which is the point:
 *
 *   - A file that does `vi.resetModules()` + `await import(...)` inside the
 *     test body pays the cold transform + execution of the whole transitive
 *     module graph in its FIRST test — measured at 15.6s at load average 65 on
 *     16 cores, against 0.06-0.85s for every later test in the same file,
 *     which hits the warm transform cache.
 *   - `block-branch-ops.test.ts` `spawnSync`s a real `node` process per test.
 *   - `RolesTab.test.tsx` accumulates several `user-event` interactions, each
 *     with its own scheduled delays and `waitFor` polls (~2s in isolation at
 *     load average 94, with the rest of the suite's workers competing in a
 *     full run).
 *
 * Global rather than per-file because of the second one: it failed a full run
 * here and contains no `resetModules`, no `doMock` and no dynamic import, so
 * scanning for the first mechanism's signature — the obvious way to enumerate
 * the affected files — does not find it. A per-file override covers the files
 * that have already flaked, and the set is not enumerable ahead of time.
 *
 * The narrower alternative for the first mechanism, considered and not taken:
 * hoist the mocks (`vi.doMock` -> `vi.mock`) so the subject can be imported
 * statically and the cold load is charged to collection instead. It works, but
 * it restructures the mocking in ~11 files, cannot apply where `resetModules`
 * exists precisely to re-run module-init-time env reads
 * (`child-sessions-quota-defaults.test.ts`), and addresses a strict SUBSET of
 * the observed failures — neither of the other two mechanisms.
 *
 * 30s is ~2x the worst measured cold import. The deadline exists to turn a
 * deadlock into a failure, not to enforce a performance budget, and no unit
 * test here is legitimately near it. A file needing more still sets its own
 * (`turn-self-wake-commit.test.ts` uses `vi.setConfig`).
 *
 * What this does NOT cover: deadlines that tests impose on themselves are
 * unaffected and remain contention-sensitive — the `waitFor(fn, label,
 * timeoutMs = 5000)` helpers in the `turn-*` files and `credential-failure-
 * retry.test.ts`, and Testing Library's own 1s per-`waitFor` default. Raising
 * this does make those diagnosable rather than silent: at the old 5000ms they
 * expired at the same instant Vitest killed the test, so the helper's label
 * never surfaced (the pathology `turn-self-wake-commit.test.ts` documents).
 *
 * MUST be set per project. Vitest 4 does not inherit the root `test` block's
 * options into `projects`, so a `testTimeout` next to `reporters` below is
 * silently ignored and every test keeps the 5000ms default.
 */
const TEST_TIMEOUT_MS = 30_000;

export default defineConfig({
  plugins: [react()],
  test: {
    reporters: ["./vitest-llm-reporter.ts"],
    // Server tests run in Node, client tests in jsdom
    projects: [
      {
        test: {
          name: "server",
          include: ["src/server/**/*.test.ts"],
          environment: "node",
          testTimeout: TEST_TIMEOUT_MS,
          setupFiles: ["./server-test-setup.ts", "./server-debug-setup.ts"],
          // Reproduce, in CI, the one thing CI does not have: a machine with
          // the user's real credentials in the environment. A ShipIt session
          // container exports them into the agent's `process.env`, so service
          // and credential discovery answered a different question there than
          // on a CI runner, and four tests passed in CI while failing in a
          // container. `server-test-setup.ts` strips them; injecting a sentinel
          // of each shape is what makes that strip OBSERVABLE here — without it
          // the suite is green whether or not the strip runs at all, which is
          // the CI-invisibility that let the divergence exist.
          //
          // Deliberately a real catalogue `storageEnv`, a real
          // `SHIPIT_CREDENTIAL_*` name, and the depth variable every sub-agent
          // inherits. The marker is not stripped: it is how the pin tells "the
          // strip worked" apart from "this block was deleted".
          env: {
            DEEPSEEK_API_KEY: "sk-sentinel-ambient-credential",
            SHIPIT_CREDENTIAL_CRED_SENTINEL: "sk-sentinel-ambient-credential",
            SHIPIT_AGENT_DEPTH: "7",
            SHIPIT_TEST_AMBIENT_ENV_MARKER: "1",
          },
        },
      },
      {
        // Dev-loop tooling (scripts/): lives outside src/, so it needs its own
        // project or `npm test` would never see its tests.
        test: {
          name: "tooling",
          include: ["scripts/**/*.test.ts"],
          environment: "node",
          testTimeout: TEST_TIMEOUT_MS,
          setupFiles: ["./server-test-setup.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "client",
          include: ["src/client/**/*.test.ts", "src/client/**/*.test.tsx"],
          environment: "jsdom",
          testTimeout: TEST_TIMEOUT_MS,
          setupFiles: ["src/client/test-setup.ts"],
          execArgv: clientExecArgv,
        },
      },
    ],
  },
});
