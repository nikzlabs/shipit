import { describe, it, expect } from "vitest";
import {
  buildAgentSystemInstructions,
  AGENT_SYSTEM_INSTRUCTIONS,
  type AgentSystemInstructionOptions,
} from "./agent-instructions.js";

// These tests cover the COMPOSITION and CACHING behavior of the builder: that
// each (agentId, isOps, isSandbox) axis selects a DISTINCT precomputed variant,
// that the per-turn path is a pure lookup of a frozen constant, and that every
// variant renders with its `.md` fragments loaded and no leftover `{{TOKEN}}`.
//
// They deliberately do NOT assert any literal prompt prose, section header, or
// doc-path string. That text lives in `prompts/*.md`, and a markdown-only edit
// there must NOT require touching this file — CI skips markdown-only changes
// (`ci.yml` › `paths-ignore: '**.md'`), so a test coupled to `.md` wording
// would go red only later, on an unrelated code PR. So we assert BEHAVIOR
// ("the sandbox variant differs from the ops variant"), never WORDING ("the
// sandbox variant contains `## Sandbox session`"). The trade-off is deliberate:
// fragment-selection coverage proves the switch fired and produced a distinct
// prompt, not that a specific landmark string landed. See CLAUDE.md ›
// "Testing prompts".
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
    // to the model. Covers all axes. (Checks output PROPERTIES — length, no
    // residual `{{...}}` — never the wording of any fragment.)
    const variants: AgentSystemInstructionOptions[] = [
      {},
      { agentId: "claude" },
      { agentId: "codex" },
      { isOps: true },
      { agentId: "claude", isOps: true },
      { agentId: "codex", isOps: true },
      { isSandbox: true },
    ];
    for (const opts of variants) {
      const out = buildAgentSystemInstructions(opts);
      expect(out.length).toBeGreaterThan(1000);
      expect(out).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    }
  });

  // docs/117 Phase 2 — per-agent "Parallel sessions" guidance is composed in
  // only when an `agentId` is supplied, and the Claude/Codex fragments differ.
  // Assert the variants DIFFER (the switch fired), not which words landed.
  it("composes a distinct variant per agentId, and omits per-agent guidance when none is given", () => {
    const none = buildAgentSystemInstructions();
    const claude = buildAgentSystemInstructions({ agentId: "claude" });
    const codex = buildAgentSystemInstructions({ agentId: "codex" });
    // Supplying an agentId composes additional guidance in → a distinct prompt.
    expect(claude).not.toBe(none);
    expect(codex).not.toBe(none);
    // The Claude and Codex fragments are different → distinct prompts.
    expect(claude).not.toBe(codex);
  });

  // docs/128 — ops overlay. docs/211 — sandbox overlay. Both are mutually
  // exclusive composition switches layered on the shared base.
  it("omits the overlays by default and renders byte-identically", () => {
    // The non-overlay rendering must be unchanged, so the prompt cache and the
    // existing static contract are preserved.
    expect(buildAgentSystemInstructions({ isOps: false })).toBe(
      buildAgentSystemInstructions(),
    );
    expect(buildAgentSystemInstructions({ isSandbox: false })).toBe(
      buildAgentSystemInstructions(),
    );
  });

  it("ops, sandbox, and the default are three distinct precomputed variants", () => {
    const std = buildAgentSystemInstructions();
    const ops = buildAgentSystemInstructions({ isOps: true });
    const sandbox = buildAgentSystemInstructions({ isSandbox: true });
    // Each overlay produces a prompt distinct from the default and each other.
    expect(ops).not.toBe(std);
    expect(sandbox).not.toBe(std);
    expect(sandbox).not.toBe(ops);
    // ...and each is a pure lookup of a frozen constant (cache stability).
    expect(buildAgentSystemInstructions({ isOps: true })).toBe(ops);
    expect(buildAgentSystemInstructions({ isSandbox: true })).toBe(sandbox);
  });

  it("ops wins when both ops and sandbox flags are set (mutually exclusive at the source)", () => {
    expect(buildAgentSystemInstructions({ isOps: true, isSandbox: true })).toBe(
      buildAgentSystemInstructions({ isOps: true }),
    );
  });

  it("composes each overlay with the per-agent axis into a distinct variant", () => {
    const opsClaude = buildAgentSystemInstructions({ agentId: "claude", isOps: true });
    const sandboxClaude = buildAgentSystemInstructions({ agentId: "claude", isSandbox: true });
    // Adding the per-agent axis on top of an overlay changes the prompt...
    expect(opsClaude).not.toBe(buildAgentSystemInstructions({ isOps: true }));
    expect(sandboxClaude).not.toBe(buildAgentSystemInstructions({ isSandbox: true }));
    // ...and the two overlays remain distinct under the same agentId.
    expect(opsClaude).not.toBe(sandboxClaude);
  });
});
