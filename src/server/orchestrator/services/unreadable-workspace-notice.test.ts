import { describe, it, expect } from "vitest";
import {
  formatUnreadableWorkspaceNotice,
  formatUncommittedTurnNotice,
} from "./unreadable-workspace-notice.js";

describe("formatUnreadableWorkspaceNotice", () => {
  it("says a commit is SHORT for an unreadable directory, and names the path", () => {
    const text = formatUnreadableWorkspaceNotice({ kind: "omitted", detail: "pgdata/" }, { committed: true });
    expect(text).toContain("pgdata/");
    expect(text).toContain("short");
    expect(text).toContain("everything else was committed normally");
    expect(text).not.toContain("NOT committed");
  });

  it("does NOT claim a short commit when there was no commit at all", () => {
    const text = formatUnreadableWorkspaceNotice({ kind: "omitted", detail: "pgdata/" }, { committed: false });
    expect(text).toContain("pgdata/");
    expect(text).toContain("NO commit");
    expect(text).not.toContain("everything else was committed normally");
    expect(text).not.toContain("This commit is short");
  });

  it("says NOTHING was committed for an unreadable file, and names the path", () => {
    const text = formatUnreadableWorkspaceNotice({ kind: "blocked", detail: "d/server.key" }, { committed: false });
    expect(text).toContain("d/server.key");
    expect(text).toContain("NOT committed");
    expect(text).not.toContain("committed normally");
  });

  it("names the caller's unit of work, so a file save does not read as a turn", () => {
    const text = formatUnreadableWorkspaceNotice(
      { kind: "blocked", detail: "x" },
      { committed: false, what: "This file edit" },
    );
    expect(text).toContain("This file edit was NOT committed");
  });
});

describe("formatUncommittedTurnNotice", () => {
  it("quotes git's own message rather than guessing at a cause", () => {
    const text = formatUncommittedTurnNotice("fatal: Unable to create '/w/.git/index.lock': File exists.");
    expect(text).toContain("NOT committed");
    expect(text).toContain("index.lock");
    expect(text).toContain("still in the working tree");
  });

  it("redacts the quoted message — it is arbitrary text from a failing command", () => {
    const fakePat = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"; // gitleaks:allow
    const text = formatUncommittedTurnNotice(`fatal: credential helper rejected ${fakePat}`);
    expect(text).not.toContain(fakePat);
    expect(text).toContain("ghp_");
  });

  it("bounds the quote, so a runaway git message cannot flood the transcript", () => {
    const text = formatUncommittedTurnNotice("x".repeat(5000));
    expect(text.length).toBeLessThan(1500);
  });
});
