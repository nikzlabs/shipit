import { describe, it, expect } from "vitest";
import { textIndicatesAuthFailure, resultEventIndicatesAuthFailure } from "./claude.js";
import type { ClaudeEvent } from "../shared/types.js";

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
