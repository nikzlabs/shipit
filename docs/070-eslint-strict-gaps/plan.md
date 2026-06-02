
# ESLint strict gaps

Rules from `strictTypeChecked` and `stylisticTypeChecked` that we turned off, relaxed, or downgraded to warnings — and whether fixing them is worth the effort.

## Rules turned off

### `@typescript-eslint/no-non-null-assertion` — off

**What it does:** Bans the `!` postfix operator (`foo!.bar`), which asserts a value is non-nullable without a runtime check. The risk is a runtime crash if the assertion is wrong.

**Why we disabled it:** The codebase uses `!` intentionally in places where the author knows a value is defined (e.g., after a Map `.get()` that was just `.set()`, or accessing a DOM element by known ID).

**Recommendation: Not worth fixing.** Non-null assertions are a deliberate escape hatch. Replacing every `!` with a runtime guard or refactoring to eliminate the need would add noise (redundant null checks, thrown errors for impossible states). The cases where `!` is dangerous are better caught by code review than by a blanket ban.

---

### `@typescript-eslint/require-await` — off

**What it does:** Flags `async` functions whose body contains no `await` expression. The concern is that wrapping a synchronous function in `async` adds an unnecessary microtask and obscures intent.

**Why we disabled it:** Many methods must be `async` for interface conformance — a class implementing an interface with `Promise<T>` return types will have some methods that happen to be synchronous today but must still return a promise. Marking every one with `// eslint-disable` would be worse than disabling the rule.

**Recommendation: Not worth fixing.** The false-positive rate is too high in a codebase with shared interfaces. The performance cost of a redundant `async` wrapper is negligible.

---

### `@typescript-eslint/no-empty-function` — off

**What it does:** Flags function bodies that are empty (`() => {}`). The concern is that an empty function may be an incomplete implementation.

**Why we disabled it:** No-op callbacks, default handlers, and test stubs are extremely common. Every one would need a `// noop` comment or an eslint-disable to satisfy the rule.

**Recommendation: Not worth fixing.** The signal-to-noise ratio is poor. Genuinely accidental empty functions are rare and obvious in review.

---

### `@typescript-eslint/no-unnecessary-condition` — off

**What it does:** Flags conditions that TypeScript can prove are always truthy or always falsy. For example, `if (x)` when `x: string` (never `undefined`). The intent is to catch dead code and redundant checks.

**Why we disabled it:** Defensive runtime checks are common throughout the server code — the types say a value is always present, but in practice the data comes from external sources (Docker API, file system, CLI output) where the types may be optimistic. The rule would flag hundreds of intentional guards.

**Recommendation: Low priority but potentially worth revisiting.** If the type definitions were tightened to reflect reality (e.g., `string | undefined` instead of `string` for parsed values), this rule would become useful. But that's a larger typing effort. Revisit after the `no-unsafe-*` warnings are resolved, since those share the same root cause (loose types).

---

## Rules downgraded to warn

### `@typescript-eslint/no-unsafe-assignment` — warn

**What it does:** Flags assigning a value typed as `any` to a variable with a concrete type. This is the entry point for `any` contamination — once an `any` value is assigned, the unsafety propagates silently through the code.

### `@typescript-eslint/no-unsafe-member-access` — warn

**What it does:** Flags property access on a value typed as `any` (e.g., `foo.bar` where `foo: any`). Without type information, the access could fail at runtime.

### `@typescript-eslint/no-unsafe-call` — warn

**What it does:** Flags calling a value typed as `any` as a function. There's no guarantee the value is actually callable.

### `@typescript-eslint/no-unsafe-argument` — warn

**What it does:** Flags passing an `any`-typed value as an argument to a function with typed parameters. This silently bypasses the callee's type constraints.

### `@typescript-eslint/no-unsafe-return` — warn

**What it does:** Flags returning an `any`-typed value from a function with a concrete return type. The caller believes it has a typed value but actually has unchecked `any`.

### `@typescript-eslint/use-unknown-in-catch-callback-variable` — warn

**What it does:** Flags `.catch(err => ...)` and `.then(undefined, err => ...)` where the error parameter is implicitly `any` instead of `unknown`. With `any`, the error propagates unsafely; with `unknown`, you must narrow before use.

**Why they're all warnings:** These six rules form a family — they all flag `any` propagation. The codebase has 100+ existing violations, mostly in code that parses JSON, handles CLI output, or interacts with loosely-typed third-party APIs. Fixing them requires adding type narrowing (`unknown` + guards), explicit casts, or Zod schemas at every boundary.

**Recommendation: Worth fixing incrementally.** This is the single highest-value improvement. Each fix makes the surrounding code genuinely safer. Suggested approach:
1. Pick one module at a time (start with `shared/`, then `orchestrator/services/`).
2. Add proper types or Zod schemas at the `any` entry points.
3. Promote to `error` per-directory as each directory reaches zero warnings.

---

## Rules configured more leniently

### `@typescript-eslint/no-confusing-void-expression` — `ignoreArrowShorthand: true`

**What it does (default):** Flags expressions in non-void positions that evaluate to `void` — e.g., `const x = doSomething()` where `doSomething` returns `void`. This catches accidental use of a void return value.

**What we allow:** Arrow function shorthand like `() => void doThing()` — the fire-and-forget pattern where a void call is the entire arrow body. Without `ignoreArrowShorthand`, you'd have to write `() => { void doThing(); }`.

**Recommendation: Keep as-is.** The shorthand form is idiomatic and readable. The rule still catches the dangerous cases (assigning void to a variable).

---

### `@typescript-eslint/restrict-template-expressions` — `allowNumber: true, allowBoolean: true`

**What it does (default):** Only allows `string` values inside template literal expressions (`${...}`). Flags numbers, booleans, and objects, since their `.toString()` may not produce useful output.

**What we allow:** Numbers and booleans in templates. Writing `` `port: ${port}` `` or `` `enabled: ${flag}` `` is clear and intentional — `Number.toString()` and `Boolean.toString()` are well-defined.

**Recommendation: Keep as-is.** The default is too strict for practical use. Objects and `any` are still flagged, which catches the real bugs.

---

### `@typescript-eslint/prefer-nullish-coalescing` — `ignorePrimitives: {string, number, boolean}`

**What it does (default):** Flags all uses of `||` where `??` could be used instead. The concern is that `||` treats `""`, `0`, and `false` as falsy, which may not be intended.

**What we allow:** `||` for string, number, and boolean operands. Patterns like `name || "Anonymous"` and `port || 3000` intentionally treat empty string and zero as "not set".

**Recommendation: Keep as-is.** The primitive cases are almost always intentional. The rule still enforces `??` for object types and union types where the distinction matters.

---

### `@typescript-eslint/no-misused-promises` — `checksVoidReturn: false`

**What it does (default):** Flags two things: (1) using a Promise where a boolean is expected (`if (promise)`), and (2) passing an async function where a void-returning callback is expected. The second check catches cases where a rejected promise would be silently swallowed.

**What we disabled:** The void-return check. This flags every `onClick={async () => ...}`, every `emitter.on("event", async () => ...)`, and every `Array.forEach(async ...)` — all pervasive patterns in both the server (event emitters) and client (React handlers).

**Recommendation: Low priority.** The void-return check produces too many false positives in event-driven code. The real risk (unhandled rejections) is better addressed by the global `unhandledRejection` handler and by the `no-floating-promises` rule (which we enforce as an error). Re-evaluate if Node or React provide better async callback support in the future.

---

## Summary

| Rule | Status | Fix priority |
|------|--------|-------------|
| `no-non-null-assertion` | off | Not worth fixing |
| `require-await` | off | Not worth fixing |
| `no-empty-function` | off | Not worth fixing |
| `no-unnecessary-condition` | off | Low — revisit after typing improves |
| `no-unsafe-*` (5 rules) | warn | **High — fix incrementally** |
| `use-unknown-in-catch-callback-variable` | warn | **High — fix with no-unsafe-\*** |
| `no-confusing-void-expression` | lenient | Keep as-is |
| `restrict-template-expressions` | lenient | Keep as-is |
| `prefer-nullish-coalescing` | lenient | Keep as-is |
| `no-misused-promises` | lenient | Keep as-is |
