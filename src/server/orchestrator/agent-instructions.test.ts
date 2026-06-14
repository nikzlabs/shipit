import { describe, it, expect } from "vitest";
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

  it("describes the browser tools unconditionally", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("## Browser access");
    expect(out).toContain("browser_navigate");
    expect(out).toContain("browser_snapshot");
    expect(out).toContain("/tmp/");
  });

  it("tells the agent to resolve preview URLs through the service registry", () => {
    const out = buildAgentSystemInstructions();
    const sessionIdToken = ["$", "{SHIPIT_SESSION_ID}"].join("");
    expect(out).toContain("Do not assume the app is reachable on `127.0.0.1:<port>`");
    expect(out).toContain(`/api/sessions/${sessionIdToken}/services`);
    expect(out).toContain("containerIp");
    expect(out).toContain("http://<containerIp>:<port>");
  });

  it("documents shipit issue as the tracker interface", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("## Issue Trackers");
    expect(out).toContain("Use `shipit issue`");
    expect(out).toContain("both Linear and GitHub Issues");
    expect(out).toContain("Do not conclude you lack Linear access");
    expect(out).toContain("shipit issue status <pointer> completed");
    expect(out).toContain("/shipit-docs/issues.md");
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

  it("documents the design-doc frontmatter fields and points at the full doc", () => {
    const out = buildAgentSystemInstructions();
    // Section header is present so the agent can find it.
    expect(out).toContain("## Design docs");
    // The recognized frontmatter fields are called out by name.
    expect(out).toContain("`issue`");
    expect(out).toContain("`title`");
    expect(out).toContain("`description`");
    // Checklist drives the Active/Done grouping.
    expect(out).toContain("checklist.md");
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

  it("Claude branch tells the agent to delegate to Task by pointer, not by pasting the diff", () => {
    const out = buildAgentSystemInstructions({ agentId: "claude" });
    // "with a different agent" must resolve to a Task subagent, not a session.
    expect(out).toContain("different agent");
    // The core rule: pass pointers, never paste file contents/diffs.
    expect(out).toContain("pass pointers");
    expect(out).toContain("never paste");
    // The subagent shares the workspace and can fetch the diff itself.
    expect(out).toContain("git diff main...HEAD");
    // Concrete worked example anchors the behaviour.
    expect(out).toContain("review the current PR with a different agent");
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

  it("both variants document `shipit agent run` as the cross-agent consultation primitive", () => {
    // docs/144 — a Claude-pinned session asked to "consult Codex" must reach
    // for the brokered shim, not the raw CLI. Both backends document the path.
    for (const agentId of ["claude", "codex"] as const) {
      const out = buildAgentSystemInstructions({ agentId });
      // The brokered one-shot, stdin-only (never inline -p).
      expect(out).toContain("shipit agent run --agent");
      expect(out).toContain("--prompt-file -");
      // It is gated behind the Multi-agent sessions setting.
      expect(out).toContain("Multi-agent sessions");
      // The incident's root cause: the raw CLI is unauthenticated in-container.
      expect(out).toContain("401 Unauthorized");
      expect(out).toContain("credential isolation");
      // Pointer to the full surface.
      expect(out).toContain("docs/144-cross-agent-review/");
    }
  });

  it("targets the OTHER backend in each variant's `shipit agent run` example", () => {
    // From Claude you consult Codex; from Codex you consult Claude.
    const claudeOut = buildAgentSystemInstructions({ agentId: "claude" });
    expect(claudeOut).toContain("shipit agent run --agent codex");
    const codexOut = buildAgentSystemInstructions({ agentId: "codex" });
    expect(codexOut).toContain("shipit agent run --agent claude");
  });

  it("renders the unconditional sections alongside the per-agent Parallel sessions section", () => {
    const out = buildAgentSystemInstructions({ agentId: "claude" });
    expect(out).toContain("## Browser access");
    expect(out).toContain("## Pull requests");
    expect(out).toContain("## Parallel sessions");
  });

  it("tells the agent to put any drafted prompt in a fenced code block (agent-agnostic, no Parallel-sessions dependence)", () => {
    // General output-formatting guidance — applies to any request to write a
    // prompt, not just `shipit session create`. Lives in the shared base
    // prompt, so it renders even with no agentId (no Parallel sessions section).
    const baseline = buildAgentSystemInstructions();
    expect(baseline).not.toContain("## Parallel sessions");
    expect(baseline).toContain("write or draft a prompt");
    expect(baseline).toContain("fenced code block");
    // And it's present for both backends, unchanged.
    expect(buildAgentSystemInstructions({ agentId: "claude" })).toContain("write or draft a prompt");
    expect(buildAgentSystemInstructions({ agentId: "codex" })).toContain("write or draft a prompt");
  });

  // docs/128 — ops overlay.

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

  it("ops overlay names the read-only privilege surface and the journalctl -D rule", () => {
    const out = buildAgentSystemInstructions({ isOps: true });
    expect(out).toContain("## Ops session");
    // It must tell the agent what it is — a read-only privileged session.
    expect(out).toContain("privileged ops session");
    expect(out).toContain("read-only");
    // Docker is reachable only through the proxy, and mutations are rejected.
    expect(out).toContain("tcp://docker-socket-proxy:2375");
    expect(out).toMatch(/Mutations are rejected/i);
    // The journalctl quirk that makes agents think the mount is broken.
    expect(out).toContain("journalctl -D /var/log/journal");
    expect(out).toContain("No journal files were found");
    // Pointers to the contract doc and the in-workspace recipes.
    expect(out).toContain("/shipit-docs/ops-session.md");
    expect(out).toContain("prompts/");
  });

  it("ops overlay swaps the aggressive PR nudge for a read-only variant", () => {
    const out = buildAgentSystemInstructions({ isOps: true });
    // The section header still exists...
    expect(out).toContain("## Pull requests");
    // ...but the "edited a file ⇒ open a PR" reflex is gone.
    expect(out).not.toContain("Do not ask first");
    expect(out).not.toContain("no \"this change is too small\" exception");
    expect(out).toMatch(/Do \*\*not\*\* open a PR/);
    // And the "scaffold a new project" best practice is dropped.
    expect(out).not.toContain("scaffold the essential files");
  });

  it("ops overlay replaces Live preview with an infra clarification", () => {
    const out = buildAgentSystemInstructions({ isOps: true });
    // The build-oriented preview guidance must be gone — there's no app here.
    expect(out).not.toContain("## Live preview");
    expect(out).not.toContain("If the project needs a preview");
    // ...and replaced by a note that the compose service is host infra, not a
    // frontend preview, so the agent doesn't misread the proxy.
    expect(out).toContain("## Compose services");
    expect(out).toContain("docker-socket-proxy");
    expect(out).toMatch(/not an app preview/i);
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
