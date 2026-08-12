import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

/**
 * Guards the React hooks lint rules against the one failure mode a reviewer
 * would NOT catch from an `eslint.config.js` diff: flat-config cascade ordering.
 *
 * Deleting the plugin is a visible edit to a small config file, and needs no
 * test. Silently *narrowing* the rules is the real hazard. `eslint.config.js`
 * layers six blocks that re-declare rules over overlapping globs — a client
 * block, per-agent folder blocks, a `**\/*.test.ts(x)` block that deliberately
 * relaxes several rules — and its own top-of-file comment records that this has
 * bitten before:
 *
 *   "ESLint flat config replaces the array wholesale when a later block
 *    re-declares the rule, so anything that wants to keep these has to spread
 *    them in."
 *
 * Adding a block, reordering one, or extending the test-file relaxation can
 * therefore drop enforcement for some paths while every line of the diff still
 * looks reasonable. These two tests resolve the *whole* cascade for a real path
 * and confirm the rules survive it.
 *
 * Deliberately not asserted here: that the config says what the config says.
 * Re-reading a severity straight back out of `eslint.config.js` tests nothing
 * the file itself does not already state.
 */

// Only the paths are used — to resolve the flat-config cascade and the TS
// project. File contents are never read by these tests.
const CLIENT_TSX = "src/client/App.tsx";
const CLIENT_TEST = "src/client/components/DiffPanel.test.tsx";

const eslint = new ESLint({ cwd: process.cwd() });

/** ESLint reports severity numerically: 2 = error, 1 = warn. */
async function severityOf(filePath: string, rule: string): Promise<unknown> {
  const config = await eslint.calculateConfigForFile(filePath);
  const entry: unknown = config.rules?.[rule];
  return Array.isArray(entry) ? entry[0] : entry;
}

describe("react-hooks lint rules", () => {
  it("survives the test-file relaxation block", { timeout: 60_000 }, async () => {
    // The `**/*.test.ts(x)` block later in the config turns off several rules
    // for tests. It must not take these with it — component tests render hooks
    // too, and a conditional hook is just as wrong there.
    expect(await severityOf(CLIENT_TEST, "react-hooks/rules-of-hooks")).toBe(2);
    expect(await severityOf(CLIENT_TEST, "react-hooks/exhaustive-deps")).toBe(2);
  });

  it("actually reports a conditional hook through the real config", { timeout: 60_000 }, async () => {
    // Proves the rule *executes* — that the plugin is wired, the `files` glob
    // still matches client code, and parsing works — rather than only that a
    // severity is configured somewhere.
    //
    // Linted as text against an existing client path so the flat config and the
    // TS project service both resolve, without writing a fixture to disk: a
    // committed one would fail `npm run lint`, and a temp one could survive a
    // crashed run and break it.
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
