import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Some ShipIt session images run with NODE_ENV=production. React's production
// bundle does not export `act`, which breaks React Testing Library even though
// the same tests pass in CI with NODE_ENV=test.
if (process.env.NODE_ENV === "production") {
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
