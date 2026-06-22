import { describe, it, expect } from "vitest";
import {
  composeReviewMessage,
  resolveReviewer,
  displayAgentName,
  type ReviewComposition,
} from "./compose-review-body.js";

function agent(id: string, over: Partial<{ installed: boolean; authConfigured: boolean }> = {}) {
  return {
    id,
    name: `${id} CLI`,
    installed: over.installed ?? true,
    authConfigured: over.authConfigured ?? true,
  };
}

describe("resolveReviewer", () => {
  it("picks cross-agent when Multi-agent is on AND a different agent is signed in", () => {
    const r = resolveReviewer({
      enableSubAgents: true,
      agentList: [agent("claude"), agent("codex")],
      activeAgentId: "claude",
    });
    expect(r).toEqual({
      mode: "cross-agent",
      reviewerAgentId: "codex",
      reviewerName: "Codex",
      selfName: "Claude",
    });
  });

  it("falls back to subagent when Multi-agent is off (even if another agent is authed)", () => {
    const r = resolveReviewer({
      enableSubAgents: false,
      agentList: [agent("claude"), agent("codex")],
      activeAgentId: "claude",
    });
    expect(r).toEqual({ mode: "subagent", selfName: "Claude" });
  });

  it("falls back to subagent when the other agent is not auth-configured", () => {
    const r = resolveReviewer({
      enableSubAgents: true,
      agentList: [agent("claude"), agent("codex", { authConfigured: false })],
      activeAgentId: "claude",
    });
    expect(r).toEqual({ mode: "subagent", selfName: "Claude" });
  });

  it("falls back to subagent when the other agent is not installed", () => {
    const r = resolveReviewer({
      enableSubAgents: true,
      agentList: [agent("claude"), agent("codex", { installed: false })],
      activeAgentId: "claude",
    });
    expect(r).toEqual({ mode: "subagent", selfName: "Claude" });
  });

  it("falls back to subagent when the only signed-in agent IS the active one", () => {
    const r = resolveReviewer({
      enableSubAgents: true,
      agentList: [agent("claude")],
      activeAgentId: "claude",
    });
    expect(r).toEqual({ mode: "subagent", selfName: "Claude" });
  });

  it("resolves cross-agent symmetrically when Codex is the active agent", () => {
    const r = resolveReviewer({
      enableSubAgents: true,
      agentList: [agent("claude"), agent("codex")],
      activeAgentId: "codex",
    });
    expect(r).toEqual({
      mode: "cross-agent",
      reviewerAgentId: "claude",
      reviewerName: "Claude",
      selfName: "Codex",
    });
  });
});

describe("displayAgentName", () => {
  it("capitalizes the agent id", () => {
    expect(displayAgentName("claude")).toBe("Claude");
    expect(displayAgentName("codex")).toBe("Codex");
  });
});

const crossAgent: ReviewComposition = {
  mode: "cross-agent",
  reviewerAgentId: "codex",
  reviewerName: "Codex",
  selfName: "Claude",
};
const subagent: ReviewComposition = { mode: "subagent", selfName: "Claude" };

describe("composeReviewMessage — shared shape", () => {
  it("names the target file and asks for material findings only", () => {
    const msg = composeReviewMessage("docs/plan.md", subagent);
    expect(msg).toContain("Review docs/plan.md.");
    expect(msg).toContain("MATERIAL issues");
    expect(msg).toContain("Skip nits");
    expect(msg).toContain('"No material issues found."');
  });

  it("tells the reviewer to read with its own tools but return markdown — and call NO tool (docs/220)", () => {
    const msg = composeReviewMessage("a.ts", subagent);
    expect(msg).toContain("MARKDOWN ONLY");
    // Reading the repo with read-only tools is explicitly allowed...
    expect(msg).toContain("READ the file");
    expect(msg).toContain("read-only tools");
    // ...but the reviewer must not call any MCP tool, and `submit_review` is gone.
    expect(msg).toContain("Do NOT call any MCP tool");
    expect(msg).not.toContain("submit_review");
  });

  it("instructs the parent to apply fixes — no card-patching tool involved (docs/220)", () => {
    const msg = composeReviewMessage("a.ts", subagent);
    expect(msg).toContain("Apply fixes for the material findings");
    expect(msg).toContain("describe the fixes you applied");
    expect(msg).not.toContain("submit_review");
    expect(msg).not.toContain("patches the SAME card");
  });

  it("embeds NO draft comments (decoupled from the user-comment system)", () => {
    const msg = composeReviewMessage("a.ts", subagent);
    expect(msg).not.toContain("Existing comments");
    expect(msg).not.toContain("[user]");
  });
});

describe("composeReviewMessage — subagent mode (same-model → prose, docs/220)", () => {
  it("delegates to a fresh Task subagent and presents findings as prose, no tool", () => {
    const msg = composeReviewMessage("a.ts", subagent);
    expect(msg).toContain("fresh Task subagent");
    expect(msg).toContain("do not review it");
    // same-model review is narrated as prose — no card, no tool, no cross-agent spawn
    expect(msg).toContain("present");
    expect(msg).toContain("prose");
    expect(msg).not.toContain("submit_review");
    expect(msg).not.toContain("shipit agent run");
  });
});

describe("composeReviewMessage — cross-agent mode (consult card, docs/220)", () => {
  it("delegates to the other agent via shipit agent run and relies on the consult card", () => {
    const msg = composeReviewMessage("a.ts", crossAgent);
    expect(msg).toContain("shipit agent run --agent codex --prompt-file -");
    // ShipIt surfaces the reviewer's output in the consult card; the parent records nothing
    expect(msg).toContain("consult card");
    expect(msg).not.toContain("submit_review");
    expect(msg).not.toContain("reviewer_label");
  });

  it("makes cross-agent failure a first-class fallback to a same-model Task review (prose)", () => {
    const msg = composeReviewMessage("a.ts", crossAgent);
    expect(msg).toContain("exits non-zero");
    expect(msg).toContain("do NOT abort");
    expect(msg).toContain("fresh same-model Task");
    expect(msg).toContain("prose");
    expect(msg).toContain("Codex was unavailable");
  });
});
