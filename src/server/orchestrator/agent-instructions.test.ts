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
});
