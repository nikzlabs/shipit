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
          setupFiles: ["./server-test-setup.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "client",
          include: ["src/client/**/*.test.ts", "src/client/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["src/client/test-setup.ts"],
          execArgv: clientExecArgv,
        },
      },
    ],
  },
});
