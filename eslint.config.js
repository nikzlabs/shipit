import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression > MemberExpression[property.name='then']",
          message: "Prefer async/await over .then(). Use store methods or async helpers. Add eslint-disable if .then() is intentional (fire-and-forget in sync context, lazy(), Promise two-arg form).",
        },
      ],
    },
  },
  // ── Layer boundary enforcement ──────────────────────────────────────────
  // orchestrator/ and session/ must not import from each other (even type
  // imports). Shared types belong in shared/types/. Integration tests are
  // excluded because they deliberately cross the boundary to test the
  // session-worker IPC layer.
  {
    files: ["src/server/orchestrator/**/*.ts"],
    ignores: ["src/server/orchestrator/integration_tests/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{
            group: ["**/session/**"],
            message: "Orchestrator must not import from session/. Move shared types to shared/types/.",
          }],
        },
      ],
    },
  },
  {
    files: ["src/server/session/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{
            group: ["**/orchestrator/**"],
            message: "Session must not import from orchestrator/. Move shared types to shared/types/.",
          }],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      // Tests often use any for mocking
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
