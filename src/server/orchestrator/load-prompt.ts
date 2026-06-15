import fs from "node:fs";

/**
 * Load a co-located prompt `.md` file as a string, once, at module init.
 *
 * Prompt *text* lives in `.md` files next to the code that composes it (see
 * CLAUDE.md › "Prompts"). Callers pass their own `import.meta.url` so the path
 * resolves relative to the importing module, exactly like a relative `import`.
 *
 * The read is synchronous and intended to run at module top level — NOT
 * per-call — so the cost is paid once at startup and a missing/renamed file
 * fails loudly the moment the module is initialized (server won't boot) rather
 * than crashing mid-turn. We deliberately do NOT use a bundler `?raw` import:
 * the orchestrator runs straight from TypeScript source via tsx in production
 * (`node --import tsx …`, see docker/Dockerfile.prod), so there is no bundler to
 * inline the asset. `fs.readFileSync(new URL(...))` works identically under
 * tsx, plain Node, and vitest, and the `.md` ships with the source tree.
 */
export function loadPrompt(metaUrl: string, relativePath: string): string {
  return fs.readFileSync(new URL(relativePath, metaUrl), "utf8");
}

/**
 * Substitute `{{TOKEN}}` placeholders in a skeleton prompt with the given
 * values. Used by composers that interleave fragments into a base `.md`
 * skeleton (see `agent-instructions.ts`).
 *
 * - A token present in the skeleton but missing from `values` throws — this is
 *   the "no unresolved placeholders" guard, so a renamed fragment fails loudly
 *   instead of shipping a literal `{{FOO}}` to the model.
 * - An empty-string value is valid (a fragment that's dropped for this
 *   variant), so the check is `=== undefined`, not falsiness.
 * - The replacer is a FUNCTION, so `$`-sequences in fragment text (e.g.
 *   `${SHIPIT_HOST}`) are inserted literally rather than interpreted as
 *   `String.prototype.replace` special patterns.
 *
 * Matches double-brace tokens only (`{{FOO}}`), so single-brace JSON like
 * `{"action":"propose"}` in the prompt text is left untouched.
 */
export function fillPromptTokens(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Unfilled prompt token {{${key}}} in skeleton`);
    }
    return value;
  });
}
