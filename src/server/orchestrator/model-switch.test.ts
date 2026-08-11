import { describe, it, expect } from "vitest";
import {
  conformSelectionToAgent,
  describeSelectionMove,
  isEligibleOnAgent,
  modelSelectionFrom,
  selectionFrom,
  verifyExplicitSelection,
} from "./model-switch.js";
import type { AgentInfo, EligibleModel } from "../shared/agent-registry.js";

/**
 * docs/252 phase 4 (req 4) — the rules a mid-session switch obeys.
 *
 * The catalogue rows used here are real ones, chosen because they are the case
 * this feature creates: `anthropic/claude-opus-5` is offered by BOTH OpenRouter
 * and Vercel AI Gateway, at different endpoints, on the same harness. A switch
 * between them changes everything about where a turn goes and nothing about the
 * model id — which is precisely why none of these rules may key on the id.
 */

const OPENROUTER_OPUS: EligibleModel = {
  serviceId: "openrouter",
  serviceName: "OpenRouter",
  billingMode: "key",
  modelId: "anthropic/claude-opus-5",
  label: "Opus 5",
  canonicalModelKey: "claude-opus-5",
};
const VERCEL_OPUS: EligibleModel = {
  serviceId: "vercel",
  serviceName: "Vercel AI Gateway",
  billingMode: "key",
  modelId: "anthropic/claude-opus-5",
  label: "Opus 5",
  canonicalModelKey: "claude-opus-5",
};
const ANTHROPIC_SUB_OPUS: EligibleModel = {
  serviceId: "anthropic",
  serviceName: "Anthropic",
  billingMode: "sub",
  modelId: "claude-opus-5",
  label: "Opus 5",
  canonicalModelKey: "claude-opus-5",
};

function agent(
  eligibleModels: EligibleModel[],
  reasoning?: { value: string; label: string }[],
): Pick<AgentInfo, "name" | "eligibleModels" | "capabilities"> {
  return {
    name: "Claude Code",
    eligibleModels,
    capabilities: {
      models: [...new Set(eligibleModels.map((m) => m.modelId))],
      ...(reasoning ? { reasoning: { label: "Effort", options: reasoning } } : {}),
    } as AgentInfo["capabilities"],
  };
}

describe("selectionFrom", () => {
  it("needs all three parts — a row missing the service holds no selection", () => {
    expect(selectionFrom({ model: "claude-opus-5" })).toBeUndefined();
    expect(selectionFrom({ model: "claude-opus-5", serviceId: "anthropic" })).toBeUndefined();
    expect(
      selectionFrom({ model: "claude-opus-5", serviceId: "anthropic", billingMode: "sub" }),
    ).toEqual({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" });
  });
});

describe("isEligibleOnAgent — the whole triple, never the id", () => {
  it("distinguishes two services offering the SAME model id", () => {
    const a = agent([OPENROUTER_OPUS]);
    expect(isEligibleOnAgent(a, { ...OPENROUTER_OPUS })).toBe(true);
    // Same model id, different service — not the same row, and this is the
    // whole reason nothing here compares ids.
    expect(
      isEligibleOnAgent(a, {
        serviceId: "vercel",
        billingMode: "key",
        modelId: "anthropic/claude-opus-5",
      }),
    ).toBe(false);
  });

  it("distinguishes two billing modes of one service", () => {
    const a = agent([ANTHROPIC_SUB_OPUS]);
    expect(
      isEligibleOnAgent(a, { serviceId: "anthropic", billingMode: "key", modelId: "claude-opus-5" }),
    ).toBe(false);
  });
});

describe("verifyExplicitSelection — honoured or refused, never re-resolved", () => {
  const a = agent([OPENROUTER_OPUS]);

  it("passes an eligible triple through verbatim", () => {
    const verdict = verifyExplicitSelection(
      a,
      modelSelectionFrom("anthropic/claude-opus-5", "openrouter", "key"),
    );
    expect(verdict).toEqual({
      ok: true,
      selection: {
        serviceId: "openrouter",
        billingMode: "key",
        modelId: "anthropic/claude-opus-5",
      },
    });
  });

  it("REFUSES a catalogue-valid triple with no credential rather than falling back", () => {
    // The regression this rule exists for: the user picks Opus on Vercel with no
    // Vercel key. Falling through to bare-id resolution would silently land the
    // session on OpenRouter — a different service, a different bill, and a
    // selection the user never made (req 11).
    const verdict = verifyExplicitSelection(
      a,
      modelSelectionFrom("anthropic/claude-opus-5", "vercel", "key"),
    );
    expect(verdict?.ok).toBe(false);
    expect(verdict && !verdict.ok && verdict.message).toContain("vercel");
  });

  it("refuses a triple the catalogue does not carry at all", () => {
    const verdict = verifyExplicitSelection(
      a,
      modelSelectionFrom("not-a-model", "openrouter", "key"),
    );
    expect(verdict?.ok).toBe(false);
  });

  it("returns undefined when no triple was sent — the bare-id path is untouched", () => {
    expect(
      verifyExplicitSelection(a, modelSelectionFrom("anthropic/claude-opus-5", undefined, undefined)),
    ).toBeUndefined();
  });

  it("refuses HALF a triple rather than dropping the half it was given", () => {
    // The two fields are independently optional on the wire. Reading "one
    // missing" as "no triple" throws away the field that WAS sent and
    // re-resolves the bare id — so `{model: X, serviceId: "vercel"}` could
    // persist X on OpenRouter, which is the same mis-billing the refusal rule
    // exists to prevent, arriving through a malformed request rather than a
    // stale one. Found by cross-backend review.
    const noMode = verifyExplicitSelection(
      a,
      modelSelectionFrom("anthropic/claude-opus-5", "vercel", undefined),
    );
    const noService = verifyExplicitSelection(
      a,
      modelSelectionFrom("anthropic/claude-opus-5", undefined, "key"),
    );
    expect(noMode?.ok).toBe(false);
    expect(noService?.ok).toBe(false);
  });

  it("treats NEITHER field as the legacy shape, not as an error", () => {
    expect(modelSelectionFrom("x", undefined, undefined)).toBeUndefined();
  });
});

describe("conformSelectionToAgent — what a harness switch moves", () => {
  it("keeps an eligible triple untouched", () => {
    const move = conformSelectionToAgent({
      agent: agent([OPENROUTER_OPUS, VERCEL_OPUS]),
      current: { serviceId: "vercel", billingMode: "key", modelId: "anthropic/claude-opus-5" },
      currentReasoning: undefined,
    });
    expect(move.selection).toBeUndefined();
    expect(move.modelMoved).toBe(false);
    expect(move.serviceMoved).toBe(false);
  });

  it("moves a selection whose SERVICE the new harness cannot reach, keeping nothing", () => {
    // The id is in the new harness's list — through OpenRouter — while the
    // session is pinned to Vercel. An id-only test kept the Vercel pinning and
    // left the session on a service this harness has no credential for.
    const move = conformSelectionToAgent({
      agent: agent([OPENROUTER_OPUS]),
      current: { serviceId: "vercel", billingMode: "key", modelId: "anthropic/claude-opus-5" },
      currentReasoning: undefined,
    });
    expect(move.selection).toEqual({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
    });
    expect(move.serviceMoved).toBe(true);
    // The model id itself did NOT change — which is why the notice has to name
    // the service rather than only the model.
    expect(move.modelMoved).toBe(false);
  });

  it("moves to the first eligible entry when the model is gone entirely", () => {
    const move = conformSelectionToAgent({
      agent: agent([ANTHROPIC_SUB_OPUS]),
      current: { serviceId: "vercel", billingMode: "key", modelId: "anthropic/claude-opus-5" },
      currentReasoning: undefined,
    });
    expect(move.selection).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
    expect(move.modelMoved).toBe(true);
    expect(move.serviceMoved).toBe(true);
  });

  it("degrades to an id test when there is no triple (the new-session composer)", () => {
    const a = agent([OPENROUTER_OPUS]);
    // Known id, no session row — leave it alone rather than rewrite a selection
    // the composer never persisted.
    expect(
      conformSelectionToAgent({
        agent: a,
        current: undefined,
        currentModelId: "anthropic/claude-opus-5",
        currentReasoning: undefined,
      }).selection,
    ).toBeUndefined();
    // Unknown id — move, as before.
    expect(
      conformSelectionToAgent({
        agent: a,
        current: undefined,
        currentModelId: "gpt-5.5",
        currentReasoning: undefined,
      }).selection,
    ).toEqual({
      serviceId: "openrouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
    });
  });

  it("clears a reasoning effort the new harness does not offer, and keeps one it does", () => {
    const withMax = agent([OPENROUTER_OPUS], [{ value: "max", label: "Max" }]);
    expect(
      conformSelectionToAgent({
        agent: withMax,
        current: { ...OPENROUTER_OPUS },
        currentReasoning: "max",
      }).reasoningCleared,
    ).toBe(false);
    expect(
      conformSelectionToAgent({
        agent: withMax,
        current: { ...OPENROUTER_OPUS },
        currentReasoning: "xhigh",
      }).reasoningCleared,
    ).toBe(true);
  });

  it("leaves the selection alone when the new harness has nothing eligible", () => {
    const move = conformSelectionToAgent({
      agent: agent([]),
      current: { ...OPENROUTER_OPUS },
      currentReasoning: undefined,
    });
    expect(move.selection).toBeUndefined();
  });
});

describe("describeSelectionMove — one sentence, not three messages", () => {
  it("names the model, its billing group and the effort together", () => {
    const notice = describeSelectionMove({
      agentName: "Codex",
      move: { modelMoved: true, serviceMoved: true, reasoningCleared: true },
      movedTo: { label: "GPT-5.6 Sol", serviceName: "OpenAI", billingMode: "sub" },
    });
    expect(notice).toBe(
      "Codex moved to GPT-5.6 Sol on OpenAI subscription and reset the reasoning effort to its default.",
    );
  });

  it("reports a service-only move — the model id is unchanged and would read as no move", () => {
    expect(
      describeSelectionMove({
        agentName: "Claude Code",
        move: { modelMoved: false, serviceMoved: true, reasoningCleared: false },
        movedTo: { label: "Opus 5", serviceName: "OpenRouter", billingMode: "key" },
      }),
    ).toBe("Claude Code moved to Opus 5 on OpenRouter API key.");
  });

  it("says nothing when nothing moved", () => {
    expect(
      describeSelectionMove({
        agentName: "Claude Code",
        move: { modelMoved: false, serviceMoved: false, reasoningCleared: false },
      }),
    ).toBeUndefined();
  });
});
