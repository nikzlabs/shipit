import { describe, it, expect } from "vitest";
import { buildAgentRerouteNotice } from "./agent-reroute-notice.js";

describe("buildAgentRerouteNotice", () => {
  it("names both harnesses and the model in display form", () => {
    const notice = buildAgentRerouteNotice("codex", "claude", "claude-opus-5");
    expect(notice).toContain("Codex");
    expect(notice).toContain("Claude Code");
    expect(notice).not.toContain("claude-opus-5");
  });

  it("falls back to the raw id for a model the catalogue does not label", () => {
    const notice = buildAgentRerouteNotice("claude", "codex", "some-unlisted-model");
    expect(notice).toContain("some-unlisted-model");
  });

  it("tells the agent to relay it, since the slot delivers to the agent", () => {
    const notice = buildAgentRerouteNotice("codex", "claude", "claude-opus-5");
    expect(notice).toMatch(/tell the user/i);
  });
});
