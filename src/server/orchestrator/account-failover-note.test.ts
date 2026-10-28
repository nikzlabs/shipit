import { describe, it, expect } from "vitest";
import {
  buildAccountFailoverNote,
  buildParkedFailoverNotice,
  FAILED_SUB_AGENTS_NOTICE,
  withAccountFailoverNote,
} from "./account-failover-note.js";

describe("account failover note (planning#712)", () => {
  const subAgents = FAILED_SUB_AGENTS_NOTICE.replace(/^\[System\] /, "");

  it("carries the failed-sub-agents paragraph and no unfilled token", () => {
    // The paragraph names the tool whose results it is about.
    expect(subAgents).toMatch(/\bAgent\b/);
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

    expect(buildParkedFailoverNotice([])).toBe(FAILED_SUB_AGENTS_NOTICE);
    // The same task section as the replayed note, behind the parked paragraph.
    expect(buildParkedFailoverNotice(["npm test"]).slice(FAILED_SUB_AGENTS_NOTICE.length))
      .toBe(buildAccountFailoverNote(["npm test"]).slice(without.length));
  });

  it("goes before the prompt, and after a slash command", () => {
    expect(withAccountFailoverNote("do work", "NOTE")).toBe("NOTE\n\ndo work");
    expect(withAccountFailoverNote("/code-review high", "NOTE")).toBe("/code-review high\n\nNOTE");
  });
});
