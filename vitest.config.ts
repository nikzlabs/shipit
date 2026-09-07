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
 * The timeout is a wall-clock deadline, but the work it bounds here is CPU
 * bound with no intentional waiting, so what it actually measures is how
 * loaded the host is. The dominant case, measured at load average 65 on 16
 * cores: a file that does `vi.resetModules()` + `await import(...)` inside the
 * test body pays the cold transform + execution of the whole transitive module
 * graph in its FIRST test — 15.6s, against 0.06-0.85s for every later test in
 * the same file, which hits the warm transform cache. Client render tests that
 * drive `waitFor`/`userEvent` are the same class more cheaply (~2s at load 94).
 *
 * Global rather than per-file because the class has no grep-able boundary — it
 * spans dynamic-import server tests and jsdom render tests — and a per-file
 * override only covers the files that have already flaked. 30s is ~2x the
 * worst measured cold import: the deadline exists to turn a deadlock into a
 * failure, not to enforce a performance budget, and no unit test here is
 * legitimately near it. A file needing more still sets its own
 * (`turn-self-wake-commit.test.ts` uses `vi.setConfig`).
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
