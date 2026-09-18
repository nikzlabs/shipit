import { describe, it, expect } from "vitest";
import { ESLint } from "eslint";

const CLIENT_TSX = "src/client/App.tsx";
const CLIENT_TEST = "src/client/components/DiffPanel.test.tsx";

const eslint = new ESLint({ cwd: process.cwd() });

async function severityOf(filePath: string, rule: string): Promise<unknown> {
  const config = await eslint.calculateConfigForFile(filePath);
  const entry: unknown = config.rules?.[rule];
  return Array.isArray(entry) ? entry[0] : entry;
}

describe("react-hooks lint rules", () => {
  it("survives the test-file relaxation block", { timeout: 60_000 }, async () => {
    expect(await severityOf(CLIENT_TEST, "react-hooks/rules-of-hooks")).toBe(2);
    expect(await severityOf(CLIENT_TEST, "react-hooks/exhaustive-deps")).toBe(2);
  });

  it("actually reports a conditional hook through the real config", { timeout: 60_000 }, async () => {
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
