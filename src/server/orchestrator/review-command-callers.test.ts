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
 * the agent-facing pages baked into the session image, and this repository's own
 * `CLAUDE.md`. Each used to hand the
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

/**
 * The five parameters that together name an explicit run (req 7), each as every
 * spelling the CLI accepts.
 *
 * **`-a` is a real alias for `--agent`** (`shipit-agent.ts`'s `parseFlags` map),
 * and a guard that only knows the long form can be walked straight past: `shipit
 * agent run -a codex --service … --billing-mode … --model … --effort …` is a
 * complete, runnable, five-parameter command that a `--agent`-only matcher scores
 * as naming four. Cross-agent review found that. Matched as **tokens**, not
 * substrings — `-a` as a substring occurs inside `sub-agent` and would otherwise
 * mark the slot satisfied on almost any page, weakening the check instead of
 * tightening it.
 *
 * As a token it can still match an unrelated `-a` (`git tag -a` on
 * `release.md`), and that is the acceptable direction: a false positive only
 * makes the page-level check **stricter**, and it can only fail a page that also
 * names the other four.
 */
const EXPLICIT_FLAG_FORMS: readonly (readonly RegExp[])[] = [
  [/--agent\b/, /(^|\s)-a(?![\w-])/m],
  [/--service\b/],
  [/--billing-mode\b/],
  [/--model\b/],
  [/--effort\b/],
];

/** Does this text name the parameter, in any spelling the CLI accepts? */
function namesFlag(text: string, forms: readonly RegExp[]): boolean {
  return forms.some((form) => form.test(text));
}

/** Split into commands, joining `\` continuations so a wrapped example is one. */
function commandLines(text: string): string[] {
  return text.replace(/\\\n\s*/g, " ").split("\n");
}

/**
 * Lines that invoke `shipit agent run` with an `--agent VALUE` but not all five
 * explicit flags — i.e. the pre-docs/261 shape, which the orchestrator refuses. A
 * line that merely *names* the flag (`no --agent`, `` `--agent` ``) does not
 * match: the value is what makes it a generated command.
 *
 * **A line naming a `--role` is NOT excluded, and that is deliberate** (docs/264
 * phase 4). Such a call is now *accepted* by the orchestrator — a role is the
 * base and the harness is an override over it (req 10) — so an exclusion would be
 * defensible as a validity check. It is refused here anyway, because this guard's
 * subject is not validity but **authorship**: docs/261's rule is that no command
 * ShipIt itself writes picks the reviewer by harness. An override is legitimate
 * precisely because a *user* asked for it, and a line compiled into a page or a
 * system prompt has no user behind it — so `--role reviewer --agent codex`
 * authored by ShipIt is exactly what docs/261 removed, wearing a role as cover.
 * The injected pages therefore say "relay the override the user named" in prose
 * and spell no harness, which costs nothing: `shipit agent params` lists the
 * harnesses, and the user supplies the value at the moment it is needed.
 */
function incompleteExplicitRuns(text: string): string[] {
  return commandLines(text).filter(
    (line) =>
      /shipit agent run\b.*(^|\s)(--agent|-a)\s+\S/m.test(line)
      && !EXPLICIT_FLAG_FORMS.every((forms) => namesFlag(line, forms)),
  );
}

/** Lines that invoke `shipit agent run` with all five explicit parameters. */
function completeExplicitRuns(text: string): string[] {
  return commandLines(text).filter(
    (line) =>
      /shipit agent run\b.*(^|\s)(--agent|-a)\s+\S/m.test(line)
      && EXPLICIT_FLAG_FORMS.every((forms) => namesFlag(line, forms)),
  );
}

/**
 * The pages that must mention the role positively. A subset, deliberately: not
 * every page has a reason to talk about reviews.
 */
const SHIPIT_DOC_PAGES = ["agent.md", "sandbox-session.md"] as const;

function readShipitDoc(name: string): string {
  return fs.readFileSync(new URL(`../shipit-docs/${name}`, import.meta.url), "utf8");
}

/** The human-facing reference the complete shape moved to (docs/264 phase 4). */
function readReviewerReference(): string {
  return fs.readFileSync(
    new URL("../../../docs/261-configurable-reviewer/plan.md", import.meta.url),
    "utf8",
  );
}

/**
 * This repository's own agent instructions. Not shipped to a user's session, but
 * it is where ShipIt's review rule was written for years and it is the caller
 * most likely to be reverted by hand, so it is scanned like any other.
 */
function readRepoInstructions(): string {
  return fs.readFileSync(new URL("../../../CLAUDE.md", import.meta.url), "utf8");
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
  it("tells every system-prompt variant with spawn guidance to ask for a review by role", () => {
    // Scoped to the variants that HAVE the guidance, not a narrowing of the rule.
    // The review command lives in the per-agent "Parallel sessions" section, and a
    // render with no `agentId` omits that section entirely — it is the Settings
    // baseline and this file's fixture, never a session (`session-agent-run-params.ts`
    // and `services/settings.ts` both pass one). The bare render used to name the
    // role anyway, from the requirements-discipline fragment; docs/241-spec-discipline
    // req 11 deleted that fragment, so the assertion follows the guidance that
    // remains rather than outliving it.
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
    // The paths must not collapse into one rule: `shipit session create --model
    // X` is complete because a child has a parent to complete it from, while the
    // same flag alone is refused on a one-shot run. docs/264-agent-roles req 16 unified the
    // *surface*, deliberately not the completion semantics.
    const text = readShipitDoc("agent.md");
    expect(text).toContain("shipit session create");
    expect(text).toContain("inherited from you");
  });
});

/**
 * docs/264-agent-roles req 15 — **a role is the path ShipIt teaches; assembling a target
 * from five parameters is not.**
 *
 * What this file asserted for docs/261 required `agent.md` to carry one
 * *complete* five-flag invocation, precisely so a repository's override stayed
 * documented. Req 15 removes that shape from the pages ShipIt injects into a
 * session, so the audiences separate — the complete shape belongs to whoever
 * writes repository policy, and the assertion moves **with** it rather than
 * being dropped.
 *
 * The reason the shape left is no longer "the agent cannot use it": req 12's
 * inventory (`shipit agent params`) means it could. It is that a role plus an
 * override does the same job in less and keeps what runs anchored to something
 * the user configured.
 */
describe("the five-parameter shape is not what ShipIt teaches (docs/264-agent-roles req 15)", () => {
  it("tells the agent to name a role rather than assemble a target", () => {
    // The spawn guidance lives in the per-agent "Parallel sessions" section, and
    // a render with no `agentId` omits that section entirely — so this is the
    // set of variants that HAS spawn guidance to check, not a narrowing of the
    // rule. Both real callers pass an `agentId`
    // (`session-agent-run-params.ts`, `services/settings.ts`); the bare render is
    // the no-options test fixture.
    const withGuidance = ALL_VARIANTS.filter((opts) => opts.agentId !== undefined);
    expect(withGuidance.length).toBeGreaterThan(0);
    for (const opts of withGuidance) {
      const text = buildAgentSystemInstructions(opts);
      expect(text).toContain("--role NAME");
      // The rule ShipIt cannot enforce anywhere else: an override is the USER's,
      // and the agent relays it (req 10). It exists only in what the agent is
      // told, so its absence is invisible until an agent picks a model for
      // itself. The anchor is the command token plus this clause.
      expect(text).toContain("never decide one yourself");
      expect(text).toContain("shipit agent params");
    }
  });

  it("still documents the complete shape as ONE command in the human-facing reference", () => {
    // Named target, not "somewhere" (docs/264 phase 4): without a destination
    // the positive assertion is dropped rather than moved, and the repository
    // override req 2 guarantees stops being documented at all. Asserting each
    // flag appears *somewhere on the page* would pass on a page that never shows
    // them together — which is precisely the call the orchestrator refuses — so
    // require at least one invocation carrying all five at once.
    expect(completeExplicitRuns(readReviewerReference()).length).toBeGreaterThan(0);
  });
});
