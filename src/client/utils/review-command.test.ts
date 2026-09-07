import { describe, it, expect } from "vitest";
import { isReviewCommand, resolveReviewRequest } from "./review-command.js";

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
  };

  // docs/293 req 4 — each refusal below used to return from `App.handleSend`
  // while `MessageInput` cleared the composer anyway, so the attachment went
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
