import os from "node:os";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Vitest preserves inherited NODE_ENV values; normalize session containers to match CI.
if (process.env.NODE_ENV !== "test") {
  process.env.NODE_ENV = "test";
}

// Let jsdom supply storage instead of Node 25's globals.
const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
const clientExecArgv = nodeMajor >= 25 ? ["--no-webstorage"] : [];

// Allow cold imports under host contention. Vitest 4 requires this per project.
const TEST_TIMEOUT_MS = 30_000;

// An uncapped pool sizes itself from the container's visible cores, so concurrent full runs
// across sessions oversubscribe the shared host and starve the orchestrator's main thread.
// Vitest uses a numeric maxWorkers verbatim with no clamp, and its own default differs by mode
// (run: cpus - 1, watch: cpus / 2) — so leave it unset below the ceiling rather than computing
// a replacement, which would otherwise *raise* the pool on a smaller machine.
const WORKER_CEILING = 8;
const cpus = os.availableParallelism?.() ?? os.cpus().length;
const MAX_WORKERS = cpus > WORKER_CEILING ? WORKER_CEILING : undefined;

export default defineConfig({
  plugins: [react()],
  test: {
    reporters: ["./vitest-llm-reporter.ts"],
    // Projects inherit this from the root config and share groupOrder 0, so it caps the run.
    maxWorkers: MAX_WORKERS,
    projects: [
      {
        test: {
          name: "server",
          include: ["src/server/**/*.test.ts"],
          environment: "node",
          testTimeout: TEST_TIMEOUT_MS,
          setupFiles: ["./server-test-setup.ts", "./server-debug-setup.ts"],
          // Sentinels verify that test setup strips ambient credentials and agent depth.
          env: {
            DEEPSEEK_API_KEY: "sk-sentinel-ambient-credential",
            SHIPIT_CREDENTIAL_CRED_SENTINEL: "sk-sentinel-ambient-credential",
            SHIPIT_AGENT_DEPTH: "7",
            SHIPIT_TEST_AMBIENT_ENV_MARKER: "1",
          },
        },
      },
      {
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
