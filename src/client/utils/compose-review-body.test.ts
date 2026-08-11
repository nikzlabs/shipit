import { describe, it, expect } from "vitest";
import {
  composeReviewMessage,
  resolveReviewer,
  displayAgentName,
  type ReviewComposition,
} from "./compose-review-body.js";

describe("resolveReviewer", () => {
  it("asks for the reviewer role when Multi-agent sessions is on", () => {
    const r = resolveReviewer({ enableSubAgents: true, activeAgentId: "claude" });
    expect(r).toEqual({ mode: "role", selfName: "Claude" });
  });

  it("falls back to a same-model subagent when Multi-agent sessions is off", () => {
    const r = resolveReviewer({ enableSubAgents: false, activeAgentId: "claude" });
    expect(r).toEqual({ mode: "subagent", selfName: "Claude" });
  });

  it("resolves the same way whichever agent is active — the reviewer is not this side's choice", () => {
    // docs/261 req 6: which model reviews is ShipIt's setting, resolved
    // server-side. The client used to pick "the other installed backend" here,
    // so the active agent changed the answer; now it changes only `selfName`.
    const claude = resolveReviewer({ enableSubAgents: true, activeAgentId: "claude" });
    const codex = resolveReviewer({ enableSubAgents: true, activeAgentId: "codex" });
    expect(claude.mode).toBe(codex.mode);
    expect(claude.selfName).toBe("Claude");
    expect(codex.selfName).toBe("Codex");
  });
});

describe("displayAgentName", () => {
  it("capitalizes the agent id", () => {
    expect(displayAgentName("claude")).toBe("Claude");
    expect(displayAgentName("codex")).toBe("Codex");
  });
});

const role: ReviewComposition = { mode: "role", selfName: "Claude" };
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
    // same-model review is narrated as prose — no card, no tool, no brokered spawn
    expect(msg).toContain("present");
    expect(msg).toContain("prose");
    expect(msg).not.toContain("submit_review");
    expect(msg).not.toContain("shipit agent run");
  });
});

describe("composeReviewMessage — role mode (consult card, docs/220 + docs/261)", () => {
  it("asks for the ROLE and never names a reviewer (docs/261 req 6)", () => {
    const msg = composeReviewMessage("a.ts", role);
    expect(msg).toContain("shipit agent run --role reviewer --prompt-file -");
    // The regression this pins: ShipIt generating `--agent <backend>` in its own
    // words, which is exactly the reviewer choice the role took away from the
    // client. Matched as "flag followed by a VALUE" so the message may still
    // name the flags it forbids ("no --agent, no --model") — the bug is a
    // generated command that passes one, not prose that mentions one. The whole
    // explicit set, not just `--agent`: a role call carrying any of them is
    // refused at the edge, so all five must stay out of the generated command.
    for (const flag of ["--agent", "--service", "--billing-mode", "--model", "--effort"]) {
      expect(msg, `role message must not pass ${flag}`).not.toMatch(
        new RegExp(`${flag}\\s+\\S`),
      );
    }
    // ShipIt surfaces the reviewer's output in the consult card; the parent records nothing
    expect(msg).toContain("consult card");
    expect(msg).not.toContain("submit_review");
    expect(msg).not.toContain("reviewer_label");
  });

  it("makes a failed role spawn a first-class fallback to a same-model Task review (prose)", () => {
    const msg = composeReviewMessage("a.ts", role);
    expect(msg).toContain("exits non-zero");
    expect(msg).toContain("do NOT abort");
    expect(msg).toContain("Task subagent");
    expect(msg).toContain("prose");
  });
});
