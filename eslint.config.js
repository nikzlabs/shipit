import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// ── Shared `no-restricted-syntax` entries ──────────────────────────────────
// Factored out so per-file-scope blocks (client, per-agent folders, tests)
// can compose the right subset without copy-pasting selectors. ESLint flat
// config replaces the array wholesale when a later block re-declares the
// rule, so anything that wants to keep these has to spread them in.
const RESTRICTED_SYNTAX_BASE = [
  {
    selector: "CallExpression > MemberExpression[property.name='then']",
    message: "Prefer async/await over .then(). Use store methods or async helpers. Add eslint-disable if .then() is intentional (fire-and-forget in sync context, lazy(), Promise two-arg form).",
  },
  {
    selector: "TSImportType",
    message: "Avoid inline import() types. Use a top-level `import type { X } from '...'` instead. Add eslint-disable if dynamic import() is intentional (lazy(), conditional loading).",
  },
];

const RESTRICTED_USEEFFECT = {
  selector: "CallExpression[callee.name='useEffect']",
  message: "useEffect is restricted. Prefer event handlers, derived state, useMemo, or key props. If useEffect is genuinely needed (external system sync, browser API subscription, cleanup), add eslint-disable-next-line with a justification.",
};

// ── Agent abstraction leak guard (docs/155) ────────────────────────────────
// Flags inline `agentId === "claude"` / `agentId === "codex"` (and the
// MemberExpression form `something.agentId === "claude"`) outside the
// per-agent folders. The whole point of the per-agent layout is that a
// new backend is one folder to add — every leaked dispatch is a place a
// future Cursor/Gemini contributor would have to remember to update.
//
// Scoped narrowly to identifiers whose name ends in `agentId`/`AgentId`
// so it doesn't fire on unrelated literal comparisons (DB row reads
// where the field is `agent_id`, request query strings named `agent`,
// runtime input validators where the variable is `saved`/`provider`).
//
// Exemptions: per-agent folders (`agents/<id>/`) own the per-agent
// dispatch by definition; tests are allowed to assert per-agent
// behavior directly. Legitimate runtime exceptions (input validation,
// marketplace v1 gate, CLI-shape recovery paths) add an inline
// `eslint-disable-next-line` with a one-line rationale.
const RESTRICTED_AGENT_ID_LEAK = [
  {
    selector: "BinaryExpression[operator=/^[!=]==$/][left.type='Identifier'][left.name=/[Aa]gentId$/][right.type='Literal'][right.value=/^(claude|codex)$/]",
    message: "Avoid `agentId === \"claude\" | \"codex\"` comparisons outside `agents/<id>/` folders — they break the agent abstraction (docs/155). Use a capability flag (`AgentCapabilities`), an `AgentRegistry` method, or a `Map<AgentId, …>` runtime table instead. If the branch is a genuine per-CLI-shape exception (marketplace v1 gate, Claude-only `--resume` recovery, runtime input validation), add `eslint-disable-next-line no-restricted-syntax` with a one-line rationale.",
  },
  {
    selector: "BinaryExpression[operator=/^[!=]==$/][left.type='MemberExpression'][left.property.type='Identifier'][left.property.name=/[Aa]gentId$/][right.type='Literal'][right.value=/^(claude|codex)$/]",
    message: "Avoid `.agentId === \"claude\" | \"codex\"` comparisons outside `agents/<id>/` folders — they break the agent abstraction (docs/155). Use a capability flag (`AgentCapabilities`), an `AgentRegistry` method, or a `Map<AgentId, …>` runtime table instead. If the branch is a genuine per-CLI-shape exception (marketplace v1 gate, Claude-only `--resume` recovery, runtime input validation), add `eslint-disable-next-line no-restricted-syntax` with a one-line rationale.",
  },
];

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
        ...RESTRICTED_SYNTAX_BASE,
        ...RESTRICTED_AGENT_ID_LEAK,
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
      "no-restricted-syntax": [
        "error",
        ...RESTRICTED_SYNTAX_BASE,
        RESTRICTED_USEEFFECT,
        ...RESTRICTED_AGENT_ID_LEAK,
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
  // ── Per-agent folder exemption (docs/155 hair-leak guard) ───────────────
  // The whole point of `agents/<id>/` folders is that they own their per-CLI
  // dispatch — `agentId === "claude"` is exactly the kind of branch we
  // expect inside `agents/claude/`. Drop the leak guard for these paths so
  // the rule fires only when per-agent logic leaks back out into shared code.
  {
    files: [
      "src/server/session/agents/claude/**",
      "src/server/session/agents/codex/**",
      "src/server/orchestrator/agents/claude/**",
      "src/server/orchestrator/agents/codex/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...RESTRICTED_SYNTAX_BASE,
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
      // Tests assert per-agent behavior directly (parameterized fixtures,
      // SSE-event filtering by `agentId`) — that's not a leak, that's
      // intentional. Drop the docs/155 leak guard for tests but keep the
      // base restrictions (.then(), TSImportType) and useEffect for clients.
      "no-restricted-syntax": [
        "error",
        ...RESTRICTED_SYNTAX_BASE,
        RESTRICTED_USEEFFECT,
      ],
    },
  },
  {
    ignores: ["dist/", "node_modules/"],
  },
);
