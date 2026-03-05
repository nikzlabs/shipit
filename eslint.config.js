import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
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
      // ── TypeScript strict rules ──────────────────────────────────────────
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Allow void expressions in arrow shorthand (common fire-and-forget pattern)
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      // Allow numbers and booleans in template literals
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      // Allow non-null assertions — the codebase uses them intentionally
      "@typescript-eslint/no-non-null-assertion": "off",
      // Async functions without await are common for interface conformance
      "@typescript-eslint/require-await": "off",
      // Promise executor returns are common in this codebase (resolve in callbacks)
      "no-promise-executor-return": "off",
      // Allow empty functions (common for no-op callbacks and mocking)
      "@typescript-eslint/no-empty-function": "off",
      // Allow || for string/number defaults (nullish coalescing is safer but || is fine for these)
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true, number: true, boolean: true } },
      ],
      // Unnecessary conditions: too noisy with defensive checks
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Promise-in-void-return: too noisy with event handlers and callbacks
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      // Prevent `any` contamination — all previously-warned cases are now fixed
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      // Catch variables must be typed as unknown
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",

      // ── Built-in ESLint rules ────────────────────────────────────────────
      // Error prevention
      "no-constant-binary-expression": "error",
      "no-constructor-return": "error",
      // no-duplicate-imports is off — it conflicts with separate `import type` statements
      "no-new-native-nonconstructor": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "no-unused-private-class-members": "error",
      // Best practices
      "curly": ["error", "multi-line"],
      "default-case-last": "error",
      "eqeqeq": ["error", "always"],
      "grouped-accessor-pairs": ["error", "getBeforeSet"],
      "no-alert": "error",
      "no-caller": "error",
      "no-eval": "error",
      "no-extend-native": "error",
      "no-extra-bind": "error",
      "no-implicit-coercion": ["error", { boolean: false }],
      "no-implied-eval": "error",
      "no-iterator": "error",
      "no-labels": "error",
      "no-lone-blocks": "error",
      "no-multi-str": "error",
      "no-new-wrappers": "error",
      "no-object-constructor": "error",
      "no-octal-escape": "error",
      "no-proto": "error",
      "no-return-assign": ["error", "except-parens"],
      "no-sequences": "error",
      "no-throw-literal": "error",
      "no-unneeded-ternary": "error",
      "no-useless-call": "error",
      "no-useless-computed-key": "error",
      "no-useless-concat": "error",
      "no-useless-rename": "error",
      "no-useless-return": "error",
      "no-var": "error",
      "object-shorthand": "error",
      "prefer-arrow-callback": "error",
      "prefer-const": "error",
      "prefer-numeric-literals": "error",
      "prefer-object-spread": "error",
      "prefer-rest-params": "error",
      "prefer-spread": "error",
      "prefer-template": "error",
      "symbol-description": "error",
      "yoda": "error",

      // ── Custom restrictions ──────────────────────────────────────────────
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression > MemberExpression[property.name='then']",
          message: "Prefer async/await over .then(). Use store methods or async helpers. Add eslint-disable if .then() is intentional (fire-and-forget in sync context, lazy(), Promise two-arg form).",
        },
        {
          selector: "TSImportType",
          message: "Avoid inline import() types. Use a top-level `import type { X } from '...'` instead. Add eslint-disable if dynamic import() is intentional (lazy(), conditional loading).",
        },
      ],
    },
  },
  // ── useEffect restriction (client code) ────────────────────────────────
  // useEffect is a synchronization tool for external systems. Most state
  // derivation, event handling, and prop-change reactions should use
  // inline computation, event handlers, useMemo, or key props instead.
  // Add an eslint-disable-next-line with a justification for each valid usage.
  {
    files: ["src/client/**/*.ts", "src/client/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{
            name: "react",
            importNames: ["useEffect"],
            message: "useEffect is restricted. Prefer event handlers, derived state, useMemo, or key props. If useEffect is genuinely needed (external system sync, browser API subscription, cleanup), add eslint-disable-next-line with a justification.",
          }],
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
      // Tests use unsafe operations extensively for mocking
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // Tests may have unbound methods for mocking
      "@typescript-eslint/unbound-method": "off",
      // Test assertions on possibly-undefined are fine
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
