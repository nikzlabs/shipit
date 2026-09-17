import { describe, it, expect } from "vitest";
import {
  isReviewCommand,
  resolveReviewRequest,
  REVIEW_NEEDS_SUB_AGENTS,
} from "./review-command.js";
import {
  GLOBAL_SETTINGS,
  settingPath,
} from "../../server/shared/settings-catalogue/index.js";

describe("isReviewCommand", () => {
  it("recognizes the bare command and the argument form", () => {
    expect(isReviewCommand("/review")).toBe(true);
    expect(isReviewCommand("/review @src/a.ts")).toBe(true);
    expect(isReviewCommand("/review src/a.ts")).toBe(true);
  });

  it("does not fire on a longer word or on a mention of the command", () => {
    expect(isReviewCommand("/reviewer")).toBe(false);
    expect(isReviewCommand("please run /review")).toBe(false);
  });
});

describe("resolveReviewRequest", () => {
  const ready = {
    text: "/review",
    sessionId: "s1",
    turnRunning: false,
    previewFile: "src/a.ts",
    subAgentsEnabled: true,
  };

  // with a message that was never sent. None of the three had a test.
  it("refuses with no session", () => {
    expect(resolveReviewRequest({ ...ready, sessionId: null })).toEqual({
      ok: false,
      message: expect.stringMatching(/Start a session/),
    });
  });

  it("refuses while a turn is running", () => {
    expect(resolveReviewRequest({ ...ready, turnRunning: true })).toEqual({
      ok: false,
      message: expect.stringMatching(/Wait for the current turn/),
    });
  });

  // The refusal tells the user which row to turn on, so it has to name the row
  // the dialog renders. Asserting against the declaration is what goes red if
  // anyone writes the words out by hand again (planning#580).
  const declared = GLOBAL_SETTINGS["advanced.enableSubAgents"];

  it("refuses while sub-agents are off — the review has no other path", () => {
    const refusal = resolveReviewRequest({ ...ready, subAgentsEnabled: false });
    if (refusal.ok) throw new Error("expected a refusal");

    expect(refusal.message).toContain(`"${declared.label}"`);
    expect(refusal.message).toContain(settingPath(declared.tab));
  });

  it("names the setting before the missing file, because it blocks every file", () => {
    expect(
      resolveReviewRequest({ ...ready, subAgentsEnabled: false, previewFile: null }),
    ).toEqual({ ok: false, message: REVIEW_NEEDS_SUB_AGENTS });
  });

  it("refuses with no target file", () => {
    expect(resolveReviewRequest({ ...ready, previewFile: null })).toEqual({
      ok: false,
      message: expect.stringMatching(/needs a file/),
    });
  });

  it("refuses the missing session before it looks for a file", () => {
    // Order matters: a user with neither gets told the thing they must fix
    // first, not a file error they cannot act on without a session.
    expect(
      resolveReviewRequest({ ...ready, sessionId: undefined, previewFile: undefined }),
    ).toEqual({ ok: false, message: expect.stringMatching(/Start a session/) });
  });

  it("takes the target from the preview when the command carries no argument", () => {
    expect(resolveReviewRequest(ready)).toEqual({
      ok: true,
      sessionId: "s1",
      targetFile: "src/a.ts",
    });
  });

  it("prefers an explicit argument over the preview, with or without the @", () => {
    expect(
      resolveReviewRequest({ ...ready, text: "/review @src/b.ts" }),
    ).toEqual({ ok: true, sessionId: "s1", targetFile: "src/b.ts" });
    expect(resolveReviewRequest({ ...ready, text: "/review src/b.ts" })).toEqual(
      { ok: true, sessionId: "s1", targetFile: "src/b.ts" },
    );
  });

  it("accepts an argument when nothing is open in preview", () => {
    expect(
      resolveReviewRequest({
        ...ready,
        text: "/review @src/b.ts",
        previewFile: null,
      }),
    ).toEqual({ ok: true, sessionId: "s1", targetFile: "src/b.ts" });
  });
});
