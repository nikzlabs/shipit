import { describe, it, expect } from "vitest";
import {
  validateSessionMessageProposal,
  MAX_PROPOSED_MESSAGE_LEN,
  MAX_TARGET_SESSION_ID_LEN,
} from "./session-message-proposal-validation.js";

const valid = { sessionId: "6f1c1b4e-0000-4000-8000-000000000001", message: "Build is green on main." };

describe("validateSessionMessageProposal (docs/314)", () => {
  it("accepts and trims a well-formed proposal", () => {
    expect(validateSessionMessageProposal({ sessionId: ` ${valid.sessionId} `, message: `\n${valid.message}\n` }))
      .toEqual(valid);
  });

  it.each([
    ["sessionId missing", { message: valid.message }],
    ["sessionId blank", { sessionId: "   ", message: valid.message }],
    ["sessionId not a string", { sessionId: 42, message: valid.message }],
    ["message missing", { sessionId: valid.sessionId }],
    ["message blank", { sessionId: valid.sessionId, message: "  " }],
  ])("refuses when %s", (_label, body) => {
    expect(validateSessionMessageProposal(body)).toHaveProperty("error");
  });

  it("refuses a sessionId carrying whitespace, which is two arguments run together", () => {
    const out = validateSessionMessageProposal({ sessionId: "abc def", message: valid.message });
    expect(out).toMatchObject({ error: expect.stringContaining("whitespace") });
  });

  it("caps the sessionId", () => {
    const out = validateSessionMessageProposal({
      sessionId: "a".repeat(MAX_TARGET_SESSION_ID_LEN + 1),
      message: valid.message,
    });
    expect(out).toMatchObject({ error: expect.stringContaining(String(MAX_TARGET_SESSION_ID_LEN)) });
  });

  // The user reads this text in full before approving it (req 2).
  it("caps the message and says why", () => {
    const out = validateSessionMessageProposal({
      sessionId: valid.sessionId,
      message: "x".repeat(MAX_PROPOSED_MESSAGE_LEN + 1),
    });
    expect(out).toMatchObject({ error: expect.stringContaining("summarize") });
  });

  it("counts code points, so an emoji message at the cap is accepted", () => {
    const message = "🛳".repeat(MAX_PROPOSED_MESSAGE_LEN);
    expect(validateSessionMessageProposal({ sessionId: valid.sessionId, message }))
      .toEqual({ sessionId: valid.sessionId, message });
  });
});
