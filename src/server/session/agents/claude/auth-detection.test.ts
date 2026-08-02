import { describe, it, expect } from "vitest";
import {
  textIndicatesAuthFailure,
  resultEventIsError,
  resultEventIndicatesAuthFailure,
  assistantEventIndicatesAuthFailure,
} from "./process.js";
import type { ClaudeEvent } from "../../../shared/types.js";

/**
 * The two events a real, unauthenticated `claude -p --output-format stream-json`
 * run emits (captured from CLI 2.1.219, trimmed to the fields that matter).
 * They are the regression anchor for this suite: detection used to require
 * `subtype: "error"`, which the CLI never sends, so neither of these was
 * recognized and the "Not logged in · Please run /login" text was rendered as
 * the agent's own reply.
 */
const CLI_AUTH_FAILURE_ASSISTANT: ClaudeEvent = {
  type: "assistant",
  message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] },
  error: "authentication_failed",
  is_api_error_message: true,
};

const CLI_AUTH_FAILURE_RESULT: ClaudeEvent = {
  type: "result",
  subtype: "success",
  is_error: true,
  terminal_reason: "api_error",
  session_id: "7907f984",
  result: "Not logged in · Please run /login",
};

describe("claude auth-failure detection (docs/142 A1)", () => {
  it("matches the runtime 401 phrasing", () => {
    expect(textIndicatesAuthFailure("API Error: 401 Invalid authentication credentials")).toBe(true);
    expect(textIndicatesAuthFailure("authentication_error: invalid x-api-key")).toBe(true);
  });

  it("still matches the startup auth phrases", () => {
    expect(textIndicatesAuthFailure("Please login to continue")).toBe(true);
    expect(textIndicatesAuthFailure("Unauthorized")).toBe(true);
    expect(textIndicatesAuthFailure("Visit the OAuth URL to sign in")).toBe(true);
  });

  it("does not match unrelated output", () => {
    expect(textIndicatesAuthFailure("Edited 401 lines across 3 files")).toBe(false);
    expect(textIndicatesAuthFailure("All good")).toBe(false);
  });

  it("flags an error result event carrying a 401", () => {
    const event: ClaudeEvent = {
      type: "result",
      subtype: "error",
      session_id: "s1",
      result: "API Error: 401 Invalid authentication credentials",
    };
    expect(resultEventIndicatesAuthFailure(event)).toBe(true);
  });

  it("ignores successful results and non-result events", () => {
    expect(
      resultEventIndicatesAuthFailure({ type: "result", subtype: "success", session_id: "s1", result: "done" }),
    ).toBe(false);
    expect(
      resultEventIndicatesAuthFailure({ type: "result", subtype: "error", session_id: "s1", result: "Tool failed: ENOENT" }),
    ).toBe(false);
    expect(
      resultEventIndicatesAuthFailure({ type: "system", subtype: "init", session_id: "s1" } as ClaudeEvent),
    ).toBe(false);
  });
});

describe("claude auth-failure detection — real CLI payloads (docs/179)", () => {
  it("flags the result event the CLI actually sends: subtype success, is_error true", () => {
    expect(resultEventIndicatesAuthFailure(CLI_AUTH_FAILURE_RESULT)).toBe(true);
  });

  it("flags the synthetic assistant message that precedes it", () => {
    expect(assistantEventIndicatesAuthFailure(CLI_AUTH_FAILURE_ASSISTANT)).toBe(true);
  });

  it("flags a synthetic auth message from its error code alone", () => {
    expect(
      assistantEventIndicatesAuthFailure({
        type: "assistant",
        message: { content: [{ type: "text", text: "Something went wrong" }] },
        error: "authentication_failed",
        is_api_error_message: true,
      }),
    ).toBe(true);
  });

  it("does not flag a model reply that merely talks about signing in", () => {
    // The turn succeeded and the agent is explaining OAuth — no synthetic
    // envelope, so this must not tear the turn down and re-auth the session.
    expect(
      assistantEventIndicatesAuthFailure({
        type: "assistant",
        message: { content: [{ type: "text", text: "Open Settings and sign in with OAuth to continue." }] },
      }),
    ).toBe(false);
    expect(
      resultEventIndicatesAuthFailure({
        type: "result",
        subtype: "success",
        session_id: "s1",
        result: "I added a sign in button and wired up the OAuth callback.",
      }),
    ).toBe(false);
  });

  it("leaves non-auth API errors (quota, overload) to their own handling", () => {
    expect(
      assistantEventIndicatesAuthFailure({
        type: "assistant",
        message: { content: [{ type: "text", text: "Claude usage limit reached." }] },
        error: "usage_limit_reached",
        is_api_error_message: true,
      }),
    ).toBe(false);
  });
});

describe("resultEventIsError", () => {
  it("reads is_error, not subtype", () => {
    expect(resultEventIsError(CLI_AUTH_FAILURE_RESULT)).toBe(true);
    expect(
      resultEventIsError({ type: "result", subtype: "success", session_id: "s1", result: "done" }),
    ).toBe(false);
  });

  it("treats every non-success subtype as a failed turn", () => {
    // What an interrupt (AskUserQuestion / ExitPlanMode / stop) produces.
    expect(
      resultEventIsError({ type: "result", subtype: "error_during_execution", session_id: "s1" }),
    ).toBe(true);
    expect(
      resultEventIsError({ type: "result", subtype: "error_max_turns", session_id: "s1" }),
    ).toBe(true);
  });

  it("ignores non-result events", () => {
    expect(resultEventIsError(CLI_AUTH_FAILURE_ASSISTANT)).toBe(false);
  });
});
