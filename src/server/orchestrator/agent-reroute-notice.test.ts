import { describe, it, expect } from "vitest";
import { buildAgentRerouteNotice } from "./agent-reroute-notice.js";

describe("buildAgentRerouteNotice", () => {
  it("names both harnesses and the model in display form", () => {
    const notice = buildAgentRerouteNotice("codex", "claude", "claude-opus-5");
    expect(notice).toContain("Codex");
    expect(notice).toContain("Claude Code");
    // The catalogue label, not the raw id — the user picked a row in the model
    // picker and never saw the id.
    expect(notice).not.toContain("claude-opus-5");
  });

  it("falls back to the raw id for a model the catalogue does not label", () => {
    // A retired or vendor-versioned id can reach here; a notice that silently
    // dropped the model name would be worse than an ugly one.
    const notice = buildAgentRerouteNotice("claude", "codex", "some-unlisted-model");
    expect(notice).toContain("some-unlisted-model");
  });

  it("tells the agent to relay it, since the slot delivers to the agent", () => {
    // The whole point is ending the silence: a notice the agent reads and says
    // nothing about leaves the user exactly where planning#389 found them.
    const notice = buildAgentRerouteNotice("codex", "claude", "claude-opus-5");
    expect(notice).toMatch(/tell the user/i);
  });
});
