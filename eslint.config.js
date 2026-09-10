import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

// Later flat-config blocks replace rule arrays; spread these to retain them.
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

const RESTRICTED_AGENT_ID_LEAK = [
  {
    selector: "BinaryExpression[operator=/^[!=]==$/][left.type='Identifier'][left.name=/[Aa]gentId$/][right.type='Literal'][right.value=/^(claude|codex|opencode|grok)$/]",
    message: "Avoid `agentId === \"claude\" | \"codex\"` comparisons outside `agents/<id>/` folders — they break the agent abstraction (docs/155). Use a capability flag (`AgentCapabilities`), an `AgentRegistry` method, or a `Map<AgentId, …>` runtime table instead. If the branch is a genuine per-CLI-shape exception (marketplace v1 gate, Claude-only `--resume` recovery, runtime input validation), add `eslint-disable-next-line no-restricted-syntax` with a one-line rationale.",
  },
  {
    selector: "BinaryExpression[operator=/^[!=]==$/][left.type='MemberExpression'][left.property.type='Identifier'][left.property.name=/[Aa]gentId$/][right.type='Literal'][right.value=/^(claude|codex|opencode|grok)$/]",
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
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "no-promise-executor-return": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        { ignorePrimitives: { string: true, number: true, boolean: true } },
      ],
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",

      "no-constant-binary-expression": "error",
      "no-constructor-return": "error",
      "no-new-native-nonconstructor": "error",
      "no-self-compare": "error",
      "no-template-curly-in-string": "error",
      "no-unmodified-loop-condition": "error",
      "no-unreachable-loop": "error",
      "no-unused-private-class-members": "error",
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

      "no-restricted-syntax": [
        "error",
        ...RESTRICTED_SYNTAX_BASE,
        ...RESTRICTED_AGENT_ID_LEAK,
      ],
    },
  },
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
          }, {
            name: "highlight.js",
            message: "Import { highlightCode, languageFromPath } from src/client/syntax-highlight.ts instead. The root highlight.js entry bundles all 192 language grammars.",
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
  // Avoid the recommended preset: it also enforces React Compiler rules.
  {
    files: ["src/client/**/*.ts", "src/client/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
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
    files: [
      "src/server/session/agents/claude/**",
      "src/server/session/agents/codex/**",
      "src/server/session/agents/opencode/**",
      "src/server/session/agents/grok/**",
      "src/server/orchestrator/agents/claude/**",
      "src/server/orchestrator/agents/codex/**",
      "src/server/orchestrator/agents/opencode/**",
      "src/server/orchestrator/agents/grok/**",
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
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "no-restricted-syntax": [
        "error",
        ...RESTRICTED_SYNTAX_BASE,
        RESTRICTED_USEEFFECT,
      ],
    },
  },
  // Separate blocks keep hook-guard exemptions from disabling layer boundaries.
  {
    files: ["src/server/orchestrator/**/*.ts"],
    ignores: ["src/server/orchestrator/integration_tests/**", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [{
            group: ["**/session/**"],
            message: "Orchestrator must not import from session/. Move shared types to shared/types/.",
          }],
          paths: [{
            name: "simple-git",
            importNames: ["default"],
            message: "Use `safeSimpleGit` from shared/git-hooks-guard.js — bare `simpleGit` runs repository-controlled git hooks as root in the orchestrator (planning#384). Type-only imports (`import { type SimpleGit }`) are fine.",
          }],
        },
      ],
    },
  },
  {
    files: ["src/server/shared/**/*.ts"],
    ignores: ["src/server/shared/git-hooks-guard.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{
            name: "simple-git",
            importNames: ["default"],
            message: "Use `safeSimpleGit` from ./git-hooks-guard.js — bare `simpleGit` runs repository-controlled git hooks as root in the orchestrator (planning#384). Type-only imports (`import { type SimpleGit }`) are fine.",
          }],
        },
      ],
    },
  },
  {
    ignores: [
      "dist/",
      "node_modules/",
      "src/client/public/",
    ],
  },
);
