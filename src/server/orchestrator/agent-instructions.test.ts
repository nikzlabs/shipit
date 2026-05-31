import { describe, it, expect } from "vitest";
import {
  buildAgentSystemInstructions,
  AGENT_SYSTEM_INSTRUCTIONS,
} from "./agent-instructions.js";

describe("buildAgentSystemInstructions", () => {
  it("is static — every call returns the same string as AGENT_SYSTEM_INSTRUCTIONS", () => {
    expect(buildAgentSystemInstructions()).toBe(AGENT_SYSTEM_INSTRUCTIONS);
    expect(buildAgentSystemInstructions()).toBe(buildAgentSystemInstructions());
  });

  it("describes the browser tools unconditionally", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("## Browser access");
    expect(out).toContain("browser_navigate");
    expect(out).toContain("browser_snapshot");
    expect(out).toContain("/tmp/");
  });

  it("includes the gh pr create nudge unconditionally", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("## Pull requests");
    expect(out).toContain("gh pr create");
    // Required sections the agent should write in the body.
    expect(out).toContain("## Summary");
    expect(out).toContain("## Rationale");
    expect(out).toContain("## Changes");
    expect(out).toContain("## Test plan");
    // Mentions that this is a ShipIt shim, not the real gh CLI.
    expect(out).toContain("ShipIt");
    expect(out).toContain("/shipit-docs/github.md");
  });

  it("uses imperative language and an explicit anti-pattern in the PR section", () => {
    const out = buildAgentSystemInstructions();
    // Pulls the action-oriented principle into this section.
    expect(out).toContain("action-oriented");
    // Imperative — do, don't ask — and the explicit anti-pattern.
    expect(out).toContain("Do not ask first");
    expect(out).toMatch(/want me to open a PR\??/i);
    // Any-change threshold: the agent must not talk itself out of opening a
    // PR by calling a change "trivial". Typos, config tweaks, one-line bug
    // fixes all qualify — the prompt must say so explicitly.
    expect(out).toContain("no \"this change is too small\" exception");
    expect(out).toContain("typo");
    expect(out).toContain("config");
    expect(out).toContain("one-line");
  });

  it("requires rationale-rich PR bodies and static update guidance", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("the user goal and why this change exists");
    expect(out).toContain("key implementation decisions");
    expect(out).toContain("rejected simpler alternatives");
    expect(out).toContain("Do not only describe what changed");
    expect(out).toContain("Explain why the change was made");
    expect(out).toContain("gh pr edit");
    expect(out).toContain("stable rationale section");
    expect(out).toContain("raw logs");
    expect(out).toContain("--body-file -");
    expect(out).toContain("single-quoted heredoc");
    expect(out).toContain("Shells evaluate backticks");
  });

  it("tells the agent not to use git state to decide whether to open a PR", () => {
    const out = buildAgentSystemInstructions();
    // The auto-commit timing must be called out: it happens AFTER the turn,
    // so the in-turn working tree is not a signal of "nothing to PR".
    expect(out).toContain("after");
    expect(out).toMatch(/auto-commit/i);
    // The agent must be told explicitly not to consult git plumbing to
    // decide. Naming the commands the agent reaches for blocks the failure
    // mode where it runs `git status` / `git log` and skips the PR.
    expect(out).toContain("git status");
    expect(out).toContain("git diff");
    expect(out).toContain("git log");
    // And it must be told what to use INSTEAD — its own edit history.
    expect(out).toMatch(/Edit\/Write\/MultiEdit/);
    // The mid-turn flush behavior is spelled out so the agent trusts that
    // calling `gh pr create` mid-turn captures its just-made edits.
    expect(out).toMatch(/flush/i);
  });

  it("tells the agent to stay on the session branch and not create branches", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("git checkout -b");
    expect(out).toMatch(/do not create.*branch/i);
    expect(out).toMatch(/do not create or switch branches/i);
  });

  it("AGENT_SYSTEM_INSTRUCTIONS contains the ShipIt preamble and the PR nudge", () => {
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain("ShipIt");
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain("gh pr create");
  });

  it("documents the typed design-doc status values and points at the full doc", () => {
    const out = buildAgentSystemInstructions();
    // Section header is present so the agent can find it.
    expect(out).toContain("## Design docs");
    // The five typed status values are all called out by name.
    expect(out).toContain("`planned`");
    expect(out).toContain("`in-progress`");
    expect(out).toContain("`done`");
    expect(out).toContain("`paused`");
    expect(out).toContain("`rejected`");
    // Anti-patterns: the values agents tend to invent are explicitly named so
    // the prompt nudges them away from those strings.
    expect(out).toContain("`proposed`");
    expect(out).toContain("`design`");
    expect(out).toContain("`implemented`");
    // Pointer to the full schema doc.
    expect(out).toContain("/shipit-docs/design-docs.md");
  });

  // docs/117 Phase 2 — per-agent "Parallel sessions" guidance.

  it("omits the Parallel sessions section when no agentId is supplied", () => {
    const out = buildAgentSystemInstructions();
    expect(out).not.toContain("## Parallel sessions");
    expect(out).not.toContain("shipit session create");
  });

  it("Claude branch tells the agent to prefer `Task` for in-turn fan-out", () => {
    const out = buildAgentSystemInstructions({ agentId: "claude" });
    expect(out).toContain("## Parallel sessions");
    // Claude has Task — the section must contrast Task vs shipit session create.
    expect(out).toContain("`Task` tool");
    expect(out).toContain("in-turn fan-out");
    expect(out).toContain("shipit session create");
    expect(out).toContain("NOT interchangeable");
    // Decision rule: only spawn when the user has signaled they want a
    // separate session / branch / PR.
    expect(out).toContain("another session");
    expect(out).toContain("a separate branch");
    expect(out).toContain("a parallel workspace");
    expect(out).toContain("review independently as its own pull request");
    // Pointer to the platform doc so the agent can read the full surface.
    expect(out).toContain("/shipit-docs/sessions.md");
  });

  it("Codex branch tells the agent shipit session create is its ONLY fan-out primitive", () => {
    const out = buildAgentSystemInstructions({ agentId: "codex" });
    expect(out).toContain("## Parallel sessions");
    // Codex has no Task tool — the section must NOT recommend it.
    expect(out).not.toContain("`Task` tool");
    // It must say this is Codex's only fan-out primitive.
    expect(out).toContain("only fan-out primitive");
    expect(out).toContain("shipit session create");
    // Same "only when the user asked" decision rule.
    expect(out).toContain("another session");
    expect(out).toContain("a separate branch");
    expect(out).toContain("review independently as its own pull request");
    // Same caution about cost.
    expect(out).toContain("heavy and user-visible");
    // Pointer to the platform doc.
    expect(out).toContain("/shipit-docs/sessions.md");
  });

  it("Claude and Codex variants are distinct (different fan-out story)", () => {
    const claudeOut = buildAgentSystemInstructions({ agentId: "claude" });
    const codexOut = buildAgentSystemInstructions({ agentId: "codex" });
    expect(claudeOut).not.toBe(codexOut);
    // The Claude variant talks about Task; the Codex one does not.
    expect(claudeOut).toContain("`Task` tool");
    expect(codexOut).not.toContain("`Task` tool");
    // The Codex variant emphasizes "only fan-out primitive"; the Claude one frames it as a choice between two.
    expect(codexOut).toContain("only fan-out primitive");
    expect(claudeOut).toContain("two fan-out primitives");
  });

  it("renders the unconditional sections alongside the per-agent Parallel sessions section", () => {
    const out = buildAgentSystemInstructions({ agentId: "claude" });
    expect(out).toContain("## Browser access");
    expect(out).toContain("## Pull requests");
    expect(out).toContain("## Parallel sessions");
  });
});
