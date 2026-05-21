import { describe, it, expect } from "vitest";
import {
  buildAgentSystemInstructions,
  AGENT_SYSTEM_INSTRUCTIONS,
} from "./agent-instructions.js";

describe("buildAgentSystemInstructions", () => {
  it("returns the default no-options output by default", () => {
    expect(buildAgentSystemInstructions()).toBe(AGENT_SYSTEM_INSTRUCTIONS);
  });

  it("treats a string argument as previewUrl for backwards compatibility", () => {
    const a = buildAgentSystemInstructions("http://preview.example/");
    const b = buildAgentSystemInstructions({ previewUrl: "http://preview.example/" });
    expect(a).toBe(b);
  });

  it("includes the preview URL when provided", () => {
    const out = buildAgentSystemInstructions({ previewUrl: "http://preview.example/" });
    expect(out).toContain("The preview is running at:");
    expect(out).toContain("http://preview.example/");
    expect(out).not.toContain("The preview is not running yet");
  });

  it("uses the no-preview wording when previewUrl is omitted", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("The preview is not running yet");
    expect(out).not.toContain("The preview is running at:");
  });

  it("does NOT include the gh pr create nudge by default", () => {
    const out = buildAgentSystemInstructions();
    expect(out).not.toContain("gh pr create");
    expect(out).not.toContain("## Pull requests");
  });

  it("does NOT include the gh pr create nudge when autoCreatePr is false", () => {
    const out = buildAgentSystemInstructions({ autoCreatePr: false });
    expect(out).not.toContain("gh pr create");
    expect(out).not.toContain("## Pull requests");
  });

  it("includes the gh pr create nudge when autoCreatePr is true", () => {
    const out = buildAgentSystemInstructions({ autoCreatePr: true });
    expect(out).toContain("## Pull requests");
    expect(out).toContain("gh pr create");
    // Required sections that the agent should write in the body.
    expect(out).toContain("## Summary");
    expect(out).toContain("## Changes");
    expect(out).toContain("## Test plan");
    // Mentions that this is a ShipIt shim, not the real gh CLI.
    expect(out).toContain("ShipIt");
    expect(out).toContain("/shipit-docs/github.md");
  });

  it("uses imperative language and an explicit anti-pattern for autoCreatePr", () => {
    const out = buildAgentSystemInstructions({ autoCreatePr: true });
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

  it("tells the agent to stay on the session branch and not create branches", () => {
    const out = buildAgentSystemInstructions();
    expect(out).toContain("git checkout -b");
    expect(out).toMatch(/do not create.*branch/i);
  });

  it("repeats the no-branch guidance in the autoCreatePr section", () => {
    const out = buildAgentSystemInstructions({ autoCreatePr: true });
    expect(out).toMatch(/do not create or switch branches/i);
  });

  it("composes preview + autoCreatePr sections together", () => {
    const out = buildAgentSystemInstructions({
      previewUrl: "http://preview.example/",
      autoCreatePr: true,
    });
    expect(out).toContain("The preview is running at:");
    expect(out).toContain("http://preview.example/");
    expect(out).toContain("## Pull requests");
    expect(out).toContain("gh pr create");
  });

  it("AGENT_SYSTEM_INSTRUCTIONS is the no-options rendering", () => {
    expect(AGENT_SYSTEM_INSTRUCTIONS).toContain("ShipIt");
    expect(AGENT_SYSTEM_INSTRUCTIONS).not.toContain("gh pr create");
    expect(AGENT_SYSTEM_INSTRUCTIONS).not.toContain("The preview is running at:");
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
});
