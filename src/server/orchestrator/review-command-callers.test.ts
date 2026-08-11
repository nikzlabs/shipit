import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  buildAgentSystemInstructions,
  type AgentSystemInstructionOptions,
} from "./agent-instructions.js";

/**
 * docs/261 phase 5 — **every command ShipIt itself authors names the ROLE, not a
 * backend** (reqs 2, 6).
 *
 * ShipIt writes review commands in several places the user never sees as code:
 * the two harness system prompts, the shared requirements-discipline fragment,
 * and the agent-facing pages baked into the session image. Each used to hand the
 * agent `--agent codex` — ShipIt choosing the reviewer by harness, in the
 * product's own words, which is exactly what `--role reviewer` replaces. Phase 2
 * also made a bare `--agent <id>` an incomplete explicit call, so a caller that
 * regresses does not merely bypass the reviewer: it is refused at the edge and
 * the review does not happen at all.
 *
 * The anchor is a **command token**, never wording — see CLAUDE.md › "Testing
 * prompts". These files are prose and are meant to be re-worded freely; what
 * must not change is which command comes out the other end.
 */

/** The five flags that together name an explicit run (req 7). */
const EXPLICIT_FLAGS = ["--agent", "--service", "--billing-mode", "--model", "--effort"];

/** Split into commands, joining `\` continuations so a wrapped example is one. */
function commandLines(text: string): string[] {
  return text.replace(/\\\n\s*/g, " ").split("\n");
}

/**
 * Lines that invoke `shipit agent run` with an `--agent VALUE` but not all five
 * explicit flags — i.e. the pre-docs/261 shape, which the orchestrator now
 * refuses. A line that merely *names* the flag (`no --agent`, `` `--agent` ``)
 * does not match: the value is what makes it a generated command.
 */
function incompleteExplicitRuns(text: string): string[] {
  return commandLines(text).filter(
    (line) =>
      /shipit agent run\b.*--agent\s+\S/.test(line)
      && !EXPLICIT_FLAGS.every((flag) => line.includes(flag)),
  );
}

const SHIPIT_DOC_PAGES = ["agent.md", "spec-discipline.md", "sandbox-session.md"] as const;

function readShipitDoc(name: string): string {
  return fs.readFileSync(new URL(`../shipit-docs/${name}`, import.meta.url), "utf8");
}

/** Every axis, since the review instruction must reach all of them. */
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
  it("tells every system-prompt variant to ask for a review by role", () => {
    for (const opts of ALL_VARIANTS) {
      expect(buildAgentSystemInstructions(opts)).toContain("--role reviewer");
    }
  });

  it("never authors a bare `--agent <backend>` run in any system-prompt variant", () => {
    for (const opts of ALL_VARIANTS) {
      expect(incompleteExplicitRuns(buildAgentSystemInstructions(opts))).toEqual([]);
    }
  });

  it("keeps the requirements-discipline fragment on the role in every variant", () => {
    const fragment = fs
      .readFileSync(new URL("./prompts/spec-discipline.md", import.meta.url), "utf8")
      .trim();
    // The fragment is what makes the independent check reproducible across
    // backends; a backend named here would re-introduce the choice the role took
    // away, on the one call the discipline mandates.
    expect(fragment).toContain("--role reviewer");
    expect(incompleteExplicitRuns(fragment)).toEqual([]);
    for (const opts of ALL_VARIANTS) {
      expect(buildAgentSystemInstructions(opts)).toContain(fragment);
    }
  });

  it("documents the role — and no bare `--agent` run — on every agent-facing page", () => {
    for (const page of SHIPIT_DOC_PAGES) {
      const text = readShipitDoc(page);
      expect(text, `${page} must document --role reviewer`).toContain("--role reviewer");
      expect(incompleteExplicitRuns(text), `${page} authors an incomplete explicit run`).toEqual([]);
    }
  });

  it("still documents the explicit shape in full, so the override path stays reachable", () => {
    // req 2: a repository may override ShipIt's reviewer, and req 7 makes that
    // an explicit call naming every parameter. If the reference page stopped
    // describing it, the only documented way to override would be one the
    // orchestrator refuses.
    const text = readShipitDoc("agent.md");
    for (const flag of EXPLICIT_FLAGS) {
      expect(text, `agent.md must document ${flag}`).toContain(flag);
    }
  });

  it("keeps the child-session path documented as inheriting, not as a one-shot", () => {
    // The three paths must not collapse into one rule: `shipit session create
    // --agent codex` is complete because a child has a parent to inherit the
    // rest from, while the same flags alone are refused on a one-shot run.
    const text = readShipitDoc("agent.md");
    expect(text).toContain("shipit session create");
    expect(text).toContain("Inherited from you");
  });
});
