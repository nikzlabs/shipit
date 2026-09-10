import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  buildAgentSystemInstructions,
  AGENT_SYSTEM_INSTRUCTIONS,
  type AgentSystemInstructionOptions,
} from "./agent-instructions.js";

describe("buildAgentSystemInstructions", () => {
  it("is static — every call returns the same string as AGENT_SYSTEM_INSTRUCTIONS", () => {
    expect(buildAgentSystemInstructions()).toBe(AGENT_SYSTEM_INSTRUCTIONS);
    expect(buildAgentSystemInstructions()).toBe(buildAgentSystemInstructions());
  });

  it("every variant is a precomputed constant — same reference each call (cache stability)", () => {
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
    expect(buildAgentSystemInstructions({ isOps: false })).toBe(
      buildAgentSystemInstructions(),
    );
  });

  it("renders every variant with the .md fragments loaded and no unresolved tokens", () => {
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

  it("composes a distinct variant per agentId, and omits per-agent guidance when none is given", () => {
    const none = buildAgentSystemInstructions();
    const claude = buildAgentSystemInstructions({ agentId: "claude" });
    const codex = buildAgentSystemInstructions({ agentId: "codex" });
    expect(claude).not.toBe(none);
    expect(codex).not.toBe(none);
    expect(claude).not.toBe(codex);
  });

  it("tells Codex, but not Claude, to execute clearly implied in-scope actions", () => {
    const fragment = fs.readFileSync(
      new URL("./agents/codex/implied-action.md", import.meta.url),
      "utf8",
    ).trim();

    expect(buildAgentSystemInstructions({ agentId: "codex" })).toContain(fragment);
    expect(buildAgentSystemInstructions({ agentId: "claude" })).not.toContain(fragment);
    expect(buildAgentSystemInstructions()).not.toContain(fragment);

    expect(fragment).toContain("answer the question and perform that action");
    expect(fragment).toContain("genuine information-only questions read-only");
    expect(fragment).toContain("ambiguous, destructive, externally consequential");
    expect(fragment).toContain("Treat that gate as an intermediate phase");
    expect(fragment).toContain("without requiring the user to ping you");
    expect(fragment).toContain("genuinely requires user input or new authority");

    expect(fragment).toContain("input to your work, not the deliverable");
    expect(fragment).toContain("shipit agent run");
    expect(fragment).toContain("do not relay them and stop");
  });

  it("keeps Claude's pre-existing section boundary byte-for-byte unchanged", () => {
    const claudeParallelSection = fs.readFileSync(
      new URL("./agents/claude/system-prompt.md", import.meta.url),
      "utf8",
    );

    expect(buildAgentSystemInstructions({ agentId: "claude" })).toContain(
      `${claudeParallelSection}\n## ShipIt platform docs`,
    );
  });

  it("omits the overlays by default and renders byte-identically", () => {
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
    expect(ops).not.toBe(std);
    expect(sandbox).not.toBe(std);
    expect(sandbox).not.toBe(ops);
    expect(buildAgentSystemInstructions({ isOps: true })).toBe(ops);
    expect(buildAgentSystemInstructions({ isSandbox: true })).toBe(sandbox);
  });

  it("ops wins when both ops and sandbox flags are set (mutually exclusive at the source)", () => {
    expect(buildAgentSystemInstructions({ isOps: true, isSandbox: true })).toBe(
      buildAgentSystemInstructions({ isOps: true }),
    );
  });

  it("composes the sandbox overlay, which overrides the spawn guidance, into every sandbox variant", () => {
    const fragment = fs.readFileSync(
      new URL("./prompts/sandbox-session.md", import.meta.url),
      "utf8",
    ).trim();
    expect(fragment).toContain("shipit session create");

    const sandboxVariants: AgentSystemInstructionOptions[] = [
      { isSandbox: true },
      { agentId: "claude", isSandbox: true },
      { agentId: "codex", isSandbox: true },
    ];
    for (const opts of sandboxVariants) {
      expect(buildAgentSystemInstructions(opts)).toContain(fragment);
    }
    expect(buildAgentSystemInstructions()).not.toContain(fragment);
    expect(buildAgentSystemInstructions({ agentId: "claude" })).not.toContain(fragment);
    expect(buildAgentSystemInstructions({ isOps: true })).not.toContain(fragment);
  });

  it("gives each kind its own Git fragment, and keeps auto-commit guidance out of ops and sandbox", () => {
    const read = (name: string) =>
      fs.readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trim();
    const standard = read("git-workflow.md");
    const ops = read("git-workflow-ops.md");
    const sandbox = read("git-workflow-sandbox.md");

    expect(new Set([standard, ops, sandbox]).size).toBe(3);

    for (const opts of [{}, { agentId: "claude" as const }, { agentId: "codex" as const }]) {
      expect(buildAgentSystemInstructions(opts)).toContain(standard);
      expect(buildAgentSystemInstructions({ ...opts, isOps: true })).toContain(ops);
      expect(buildAgentSystemInstructions({ ...opts, isSandbox: true })).toContain(sandbox);
      expect(buildAgentSystemInstructions({ ...opts, isOps: true })).not.toContain(standard);
      expect(buildAgentSystemInstructions({ ...opts, isSandbox: true })).not.toContain(standard);
    }
  });

  it("never tells an ops or sandbox agent that ShipIt commits for it", () => {
    const claim = fs
      .readFileSync(new URL("./prompts/git-workflow.md", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith("ShipIt "))!;
    expect(claim).toBeTruthy();
    expect(buildAgentSystemInstructions()).toContain(claim);
    for (const opts of [{}, { agentId: "claude" as const }, { agentId: "codex" as const }]) {
      expect(buildAgentSystemInstructions({ ...opts, isOps: true })).not.toContain(claim);
      expect(buildAgentSystemInstructions({ ...opts, isSandbox: true })).not.toContain(claim);
    }
  });

  it("composes each overlay with the per-agent axis into a distinct variant", () => {
    const opsClaude = buildAgentSystemInstructions({ agentId: "claude", isOps: true });
    const sandboxClaude = buildAgentSystemInstructions({ agentId: "claude", isSandbox: true });
    expect(opsClaude).not.toBe(buildAgentSystemInstructions({ isOps: true }));
    expect(sandboxClaude).not.toBe(buildAgentSystemInstructions({ isSandbox: true }));
    expect(opsClaude).not.toBe(sandboxClaude);
  });
});
