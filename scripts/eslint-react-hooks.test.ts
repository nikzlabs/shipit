import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";
import fs from "node:fs";

/**
 * Regression guard for the React hooks lint rules.
 *
 * `react-hooks/rules-of-hooks` catches a bug class that is invisible to both
 * TypeScript and code review — a hook behind a condition or an early return
 * changes the hook count between renders, so React pairs up the wrong state.
 * The plugin was absent from this repo entirely until it was added, and the gap
 * was only noticed because a human read their own diff closely enough to spot
 * `accountId ? useStore(…) : undefined`.
 *
 * Nothing about a missing lint rule is self-announcing: dropping the plugin, or
 * softening the rule to `warn` (which `npm run lint` would not fail on — it has
 * no `--max-warnings` budget), would restore the silent state with a green
 * build. These tests are what makes that loud.
 *
 * A `calculateConfigForFile` assertion is deliberately the primary guard rather
 * than linting a fixture: it resolves the *whole* flat-config cascade for a
 * real path, so it catches a removed plugin, a downgraded severity, a `files`
 * glob that stops matching, and a later block that overrides the rule — all of
 * which a single fixture file would miss.
 */

// A long-lived client file. Only its path is used (to resolve the flat-config
// cascade and the TS project); its contents are never read by these tests.
const CLIENT_TSX = "src/client/App.tsx";
const CLIENT_TS = "src/client/hooks/useConnectionSync.ts";
const CLIENT_TEST = "src/client/components/DiffPanel.test.tsx";
const SERVER_TS = "src/server/orchestrator/index.ts";

const eslint = new ESLint({ cwd: process.cwd() });

/** ESLint reports severity numerically: 2 = error, 1 = warn. */
async function severityOf(filePath: string, rule: string): Promise<unknown> {
  const config = await eslint.calculateConfigForFile(filePath);
  const entry: unknown = config.rules?.[rule];
  return Array.isArray(entry) ? entry[0] : entry;
}

describe("react-hooks lint rules", () => {
  it("uses paths that still exist", () => {
    for (const p of [CLIENT_TSX, CLIENT_TS, SERVER_TS]) {
      expect(fs.existsSync(p), `${p} moved — update this test's path constants`).toBe(true);
    }
  });

  it("enforces rules-of-hooks as an error on client code", { timeout: 60_000 }, async () => {
    expect(await severityOf(CLIENT_TSX, "react-hooks/rules-of-hooks")).toBe(2);
    expect(await severityOf(CLIENT_TS, "react-hooks/rules-of-hooks")).toBe(2);
  });

  it("enforces exhaustive-deps as an error on client code", { timeout: 60_000 }, async () => {
    // `warn` would not fail `npm run lint`, so it is not enforcement.
    expect(await severityOf(CLIENT_TSX, "react-hooks/exhaustive-deps")).toBe(2);
    expect(await severityOf(CLIENT_TS, "react-hooks/exhaustive-deps")).toBe(2);
  });

  it("keeps both rules on for client test files", { timeout: 60_000 }, async () => {
    // The `**/*.test.tsx` block later in the config relaxes several rules; it
    // must not take these with it. Component tests render hooks too.
    expect(await severityOf(CLIENT_TEST, "react-hooks/rules-of-hooks")).toBe(2);
    expect(await severityOf(CLIENT_TEST, "react-hooks/exhaustive-deps")).toBe(2);
  });

  it("does not apply the rules to server code", { timeout: 60_000 }, async () => {
    // Documents the intended scope: the plugin is wired for `src/client/**`
    // only, so a server file resolves no react-hooks rule at all.
    expect(await severityOf(SERVER_TS, "react-hooks/rules-of-hooks")).toBeUndefined();
  });

  it("actually reports a conditional hook through the real config", { timeout: 60_000 }, async () => {
    // End-to-end: proves the rule executes, not just that it is configured.
    // Linted as text against an existing client path so the flat config and the
    // TS project service both resolve, without writing a fixture to disk (a
    // committed one would fail `npm run lint`, and a temp one could survive a
    // crashed run and break it).
    const results = await eslint.lintText(
      [
        `import { useState } from "react";`,
        `export function Probe({ on }: { on: boolean }) {`,
        `  if (on) {`,
        `    const [x] = useState(0);`,
        `    return <div>{x}</div>;`,
        `  }`,
        `  return null;`,
        `}`,
      ].join("\n"),
      { filePath: CLIENT_TSX, warnIgnored: false },
    );

    const ruleIds = results[0].messages.map((m) => m.ruleId);
    expect(ruleIds).toContain("react-hooks/rules-of-hooks");
  });
});
