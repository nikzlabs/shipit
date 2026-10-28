import { describe, it, expect } from "vitest";
import { buildAccountFailoverNote, FAILED_SUB_AGENTS_NOTICE } from "./account-failover-note.js";

describe("account failover note (planning#712)", () => {
  const subAgents = FAILED_SUB_AGENTS_NOTICE.replace(/^\[System\] /, "");

  it("carries the failed-sub-agents paragraph and no unfilled token", () => {
    for (const note of [buildAccountFailoverNote([]), buildAccountFailoverNote(["npm test"])]) {
      expect(note).toContain(subAgents);
      expect(note).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
      expect(note).toBe(note.trim());
    }
    expect(FAILED_SUB_AGENTS_NOTICE).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  it("adds a list of the stopped tasks only when there are some", () => {
    const without = buildAccountFailoverNote([]);
    const withTasks = buildAccountFailoverNote(["npm test", "sleep\n600"]);

    expect(withTasks.startsWith(`${without}\n\n`)).toBe(true);
    expect(withTasks).toContain("- npm test\n- sleep 600");
  });
});
