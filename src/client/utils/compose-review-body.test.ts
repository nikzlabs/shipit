import { describe, it, expect } from "vitest";
import { composeReviewMessage } from "./compose-review-body.js";

describe("composeReviewMessage — shared shape", () => {
  it("names the target file and asks for material findings only", () => {
    const msg = composeReviewMessage("docs/plan.md");
    expect(msg).toContain("Review docs/plan.md.");
    expect(msg).toContain("MATERIAL issues");
    expect(msg).toContain("Skip nits");
    expect(msg).toContain('"No material issues found."');
  });

  it("tells the reviewer to read with its own tools but return markdown — and call NO tool (docs/220)", () => {
    const msg = composeReviewMessage("a.ts");
    expect(msg).toContain("MARKDOWN ONLY");

    expect(msg).toContain("READ the file");
    expect(msg).toContain("read-only tools");
    // ...but the reviewer must not call any MCP tool, and `submit_review` is gone.
    expect(msg).toContain("Do NOT call any MCP tool");
    expect(msg).not.toContain("submit_review");
  });

  it("instructs the parent to apply fixes — no card-patching tool involved (docs/220)", () => {
    const msg = composeReviewMessage("a.ts");
    expect(msg).toContain("Apply fixes for the material findings");
    expect(msg).toContain("describe the fixes you applied");
    expect(msg).not.toContain("submit_review");
    expect(msg).not.toContain("patches the SAME card");
  });

  it("embeds NO draft comments (decoupled from the user-comment system)", () => {
    const msg = composeReviewMessage("a.ts");
    expect(msg).not.toContain("Existing comments");
    expect(msg).not.toContain("[user]");
  });
});

describe("composeReviewMessage — the brokered reviewer (docs/220 + docs/261)", () => {
  it("asks for the ROLE and never names a reviewer (docs/261 req 6)", () => {
    const msg = composeReviewMessage("a.ts");
    expect(msg).toContain("shipit agent run --role reviewer --prompt-file -");

    // refused at the edge, so all five must stay out of the generated command.
    for (const flag of ["--agent", "--service", "--billing-mode", "--model", "--effort"]) {
      expect(msg, `role message must not pass ${flag}`).not.toMatch(
        new RegExp(`${flag}\\s+\\S`),
      );
    }

    expect(msg).toContain("consult card");
    expect(msg).not.toContain("submit_review");
    expect(msg).not.toContain("reviewer_label");
  });

  it("ends the review when the brokered run fails, quoting the reason (planning#571)", () => {
    // The message is hard-wrapped, so these sentences span lines.
    const msg = composeReviewMessage("a.ts").replace(/\s+/g, " ");
    expect(msg).toContain("exits non-zero");
    expect(msg).toContain("that is the end of the review");
    expect(msg).toContain("quote the reason the command printed");
    // No second reviewer of any shape: a review the agent writes about its own
    // work is the bias this feature exists to avoid, and a same-model subagent
    // is exactly that.
    expect(msg).toContain("Do NOT review the file yourself");
    expect(msg).toContain("do NOT substitute another reviewer");
  });
});
