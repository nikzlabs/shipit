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

export default defineConfig({
  plugins: [react()],
  test: {
    reporters: ["./vitest-llm-reporter.ts"],
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
