import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    reporters: ["vitest-llm-reporter"],
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
        },
      },
    ],
  },
});
