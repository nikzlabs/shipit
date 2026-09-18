import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  buildAgentSystemInstructions,
  type AgentSystemInstructionOptions,
} from "./agent-instructions.js";

// Match aliases as tokens: a substring match would count "sub-agent" as -a.
const EXPLICIT_FLAG_FORMS: readonly (readonly RegExp[])[] = [
  [/--agent\b/, /(^|\s)-a(?![\w-])/m],
  [/--service\b/],
  [/--billing-mode\b/],
  [/--model\b/],
  [/--effort\b/],
];

function namesFlag(text: string, forms: readonly RegExp[]): boolean {
  return forms.some((form) => form.test(text));
}

function commandLines(text: string): string[] {
  return text.replace(/\\\n\s*/g, " ").split("\n");
}

// A role does not exempt a product-authored harness override; only users choose overrides.
function incompleteExplicitRuns(text: string): string[] {
  return commandLines(text).filter(
    (line) =>
      /shipit agent run\b.*(^|\s)(--agent|-a)\s+\S/m.test(line)
      && !EXPLICIT_FLAG_FORMS.every((forms) => namesFlag(line, forms)),
  );
}

function completeExplicitRuns(text: string): string[] {
  return commandLines(text).filter(
    (line) =>
      /shipit agent run\b.*(^|\s)(--agent|-a)\s+\S/m.test(line)
      && EXPLICIT_FLAG_FORMS.every((forms) => namesFlag(line, forms)),
  );
}

const SHIPIT_DOC_PAGES = ["agent.md", "sandbox-session.md"] as const;

function readShipitDoc(name: string): string {
  return fs.readFileSync(new URL(`../shipit-docs/${name}`, import.meta.url), "utf8");
}

function readReviewerReference(): string {
  return fs.readFileSync(
    new URL("../../../docs/261-configurable-reviewer/plan.md", import.meta.url),
    "utf8",
  );
}

function readRepoInstructions(): string {
  return fs.readFileSync(new URL("../../../CLAUDE.md", import.meta.url), "utf8");
}

const ALL_VARIANTS: AgentSystemInstructionOptions[] = [
  {},
  { agentId: "claude" },
  { agentId: "codex" },
  { isOps: true },
  { agentId: "claude", isOps: true },
  { agentId: "codex", isOps: true },
  { isSandbox: true },
  { agentId: "claude", isSandbox: true },
  { agentId: "codex", isSandbox: true },
];

describe("product-owned review commands (docs/261 phase 5)", () => {
  it("tells every system-prompt variant with spawn guidance to ask for a review by role", () => {
    // The no-agent Settings baseline omits spawn guidance.
    const withGuidance = ALL_VARIANTS.filter((opts) => opts.agentId !== undefined);
    expect(withGuidance.length).toBeGreaterThan(0);
    for (const opts of withGuidance) {
      expect(buildAgentSystemInstructions(opts)).toContain("--role reviewer");
    }
  });

  it("never authors a bare `--agent <backend>` run in any system-prompt variant", () => {
    for (const opts of ALL_VARIANTS) {
      expect(incompleteExplicitRuns(buildAgentSystemInstructions(opts))).toEqual([]);
    }
  });

  it("documents the role — and no bare `--agent` run — on every agent-facing page", () => {
    for (const page of SHIPIT_DOC_PAGES) {
      const text = readShipitDoc(page);
      expect(text, `${page} must document --role reviewer`).toContain("--role reviewer");
      expect(incompleteExplicitRuns(text), `${page} authors an incomplete explicit run`).toEqual([]);
    }
  });

  it("names the role in this repository's own review rule", () => {
    const text = readRepoInstructions();
    expect(text).toContain("--role reviewer");
    expect(incompleteExplicitRuns(text)).toEqual([]);
  });

  it("keeps the child-session path documented as completing from the parent, not as a one-shot", () => {
    const text = readShipitDoc("agent.md");
    expect(text).toContain("shipit session create");
    expect(text).toContain("inherited from you");
  });
});

describe("the five-parameter shape is not what ShipIt teaches (docs/264-agent-roles req 15)", () => {
  it("tells the agent to name a role rather than assemble a target", () => {
    const withGuidance = ALL_VARIANTS.filter((opts) => opts.agentId !== undefined);
    expect(withGuidance.length).toBeGreaterThan(0);
    for (const opts of withGuidance) {
      const text = buildAgentSystemInstructions(opts);
      expect(text).toContain("--role NAME");
      expect(text).toContain("never decide one yourself");
      expect(text).toContain("shipit agent params");
    }
  });

  it("still documents the complete shape as ONE command in the human-facing reference", () => {
    expect(completeExplicitRuns(readReviewerReference()).length).toBeGreaterThan(0);
  });
});
