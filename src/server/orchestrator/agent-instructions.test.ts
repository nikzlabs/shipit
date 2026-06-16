import { describe, it, expect } from "vitest";
import {
  buildAgentSystemInstructions,
  AGENT_SYSTEM_INSTRUCTIONS,
  type AgentSystemInstructionOptions,
} from "./agent-instructions.js";

// These tests cover the COMPOSITION and CACHING behavior of the builder — which
// fragment is selected for each `agentId`/`isOps` axis, that the variants are
// distinct, that the per-turn path is a pure lookup of a precomputed constant —
// NOT the literal wording of any prompt section. Assertions on specific prose
// (e.g. "the PR section contains this sentence") were intentionally removed:
// they churn on every copy-edit, test nothing the prompt files don't already
// state, and will move out to `.md` partials. When detecting whether a fragment
// is present/absent, key off a stable structural anchor (a `##` section header
// or a command token), never a phrase. See CLAUDE.md › "Prompts live in code".
describe("buildAgentSystemInstructions", () => {
  it("is static — every call returns the same string as AGENT_SYSTEM_INSTRUCTIONS", () => {
    expect(buildAgentSystemInstructions()).toBe(AGENT_SYSTEM_INSTRUCTIONS);
    expect(buildAgentSystemInstructions()).toBe(buildAgentSystemInstructions());
  });

  it("every variant is a precomputed constant — same reference each call (cache stability)", () => {
    // Reference equality (toBe on a string returned by two separate calls)
    // proves the per-turn path is a pure lookup of a frozen constant, not a
    // re-assembly. Re-assembly would produce an equal-but-distinct string and
    // still pass `toEqual`; only `toBe` on the precomputed instance catches a
    // regression back to per-call composition. Cover all axes.
    const variants: AgentSystemInstructionOptions[] = [
      {},
      { agentId: "claude" },
      { agentId: "codex" },
      { isOps: true },
      { agentId: "claude", isOps: true },
      { agentId: "codex", isOps: true },
      { isOps: false },
    ];
    for (const opts of variants) {
      expect(buildAgentSystemInstructions(opts)).toBe(
        buildAgentSystemInstructions(opts),
      );
    }
    // `isOps: false` must be the exact same instance as the no-options default.
    expect(buildAgentSystemInstructions({ isOps: false })).toBe(
      buildAgentSystemInstructions(),
    );
  });

  it("renders every variant with the .md fragments loaded and no unresolved tokens", () => {
    // Prompt text lives in `prompts/*.md` loaded at module init (see CLAUDE.md ›
    // "Prompts"). This guards the load + token-fill: a missing/renamed fragment
    // or an un-mapped `{{TOKEN}}` must fail here, not ship a literal placeholder
    // to the model. Covers all axes.
    const variants: AgentSystemInstructionOptions[] = [
      {},
      { agentId: "claude" },
      { agentId: "codex" },
      { isOps: true },
      { agentId: "claude", isOps: true },
      { agentId: "codex", isOps: true },
    ];
    for (const opts of variants) {
      const out = buildAgentSystemInstructions(opts);
      expect(out.length).toBeGreaterThan(1000);
      expect(out).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    }
  });

  // SHI-98 (docs/172 Gap 4) — untrusted-input lens. Structural anchors only
  // (## header, envelope-marker tokens, doc pointer), per this file's
  // convention of not asserting churny prose phrases.
  it("documents the untrusted-input lens and the provenance envelope", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("## Untrusted input");
    // The provenance envelope markers the agent must honour.
    expect(out).toContain("<<UNTRUSTED");
    expect(out).toContain("<<END UNTRUSTED");
    // Pointer to the platform doc.
    expect(out).toContain("/shipit-docs/untrusted-input.md");
  });

  // docs/117 Phase 2 — per-agent "Parallel sessions" guidance is composed in
  // only when an `agentId` is supplied, and the Claude/Codex fragments differ.

  it("omits the Parallel sessions section when no agentId is supplied", () => {
    const out = buildAgentSystemInstructions();
    expect(out).not.toContain("## Parallel sessions");
    expect(out).not.toContain("shipit session create");
  });

  it("selects a distinct per-agent fragment for Claude vs Codex", () => {
    const claudeOut = buildAgentSystemInstructions({ agentId: "claude" });
    const codexOut = buildAgentSystemInstructions({ agentId: "codex" });
    // Different agentId ⇒ different rendered prompt (right fragment dispatched).
    expect(claudeOut).not.toBe(codexOut);
    // The discriminator: Claude has the in-process `Task` tool, Codex does not.
    // This is the one phrase we assert, as the structural marker that the
    // correct fragment landed on the correct agent (not just that they differ).
    expect(claudeOut).toContain("`Task` tool");
    expect(codexOut).not.toContain("`Task` tool");
  });

  it("renders the unconditional sections alongside the per-agent Parallel sessions section", () => {
    const out = buildAgentSystemInstructions({ agentId: "claude" });
    expect(out).toContain("## Browser access");
    expect(out).toContain("## Pull requests");
    expect(out).toContain("## Parallel sessions");
  });

  // docs/128 — ops overlay. Both axes (agentId, isOps) are composition switches.

  it("omits the ops overlay by default and renders byte-identically", () => {
    // The non-ops rendering must be unchanged, so the prompt cache and the
    // existing static contract are preserved.
    expect(buildAgentSystemInstructions({ isOps: false })).toBe(
      buildAgentSystemInstructions(),
    );
    const out = buildAgentSystemInstructions();
    expect(out).not.toContain("## Ops session");
    expect(out).not.toContain("docker-socket-proxy");
  });

  it("ops overlay swaps the aggressive PR nudge for a read-only variant", () => {
    const out = buildAgentSystemInstructions({ isOps: true });
    // The section header still exists...
    expect(out).toContain("## Pull requests");
    // ...but the "edited a file ⇒ open a PR" reflex is replaced by the
    // read-only variant. We assert the swap happened (fragment selection), not
    // the full wording of either variant.
    expect(out).not.toContain("Do not ask first");
    expect(out).toMatch(/Do \*\*not\*\* open a PR/);
    // And the "scaffold a new project" best practice is dropped.
    expect(out).not.toContain("scaffold the essential files");
  });

  it("ops overlay replaces Live preview with an infra clarification", () => {
    const out = buildAgentSystemInstructions({ isOps: true });
    // The build-oriented preview guidance must be gone — there's no app here.
    expect(out).not.toContain("## Live preview");
    // ...and replaced by the compose-services infra note.
    expect(out).toContain("## Compose services");
    // The default (non-ops) prompt still has the real Live preview section.
    expect(buildAgentSystemInstructions()).toContain("## Live preview");
  });

  it("ops overlay composes with the per-agent Parallel sessions section", () => {
    const out = buildAgentSystemInstructions({ agentId: "claude", isOps: true });
    expect(out).toContain("## Ops session");
    expect(out).toContain("## Parallel sessions");
    // Shared base still present.
    expect(out).toContain("## Browser access");
  });
});
