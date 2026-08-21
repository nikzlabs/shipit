import { describe, it, expect, beforeEach } from "vitest";
import { modelRowAfterHarnessPick, persistHarnessPick } from "./harness-seed.js";
import { getParkedHarness, getSavedModelId, saveParkedHarness } from "./local-storage.js";
import { newSessionAgentId } from "./new-session-agent.js";
import { useUiStore } from "../stores/ui-store.js";
import type { AgentOption, EligibleModelOption } from "../agent-types.js";

function row(over: Partial<EligibleModelOption> & Pick<EligibleModelOption, "modelId">): EligibleModelOption {
  return {
    serviceId: "anthropic",
    serviceName: "Anthropic",
    billingMode: "sub",
    label: over.modelId,
    canonicalModelKey: over.modelId,
    ...over,
  };
}

function agent(id: string, eligibleModels: EligibleModelOption[]): AgentOption {
  return {
    id,
    name: id === "claude" ? "Claude Code" : "Codex",
    installed: true,
    hasRunnableModels: eligibleModels.length > 0,
    models: eligibleModels.map((m) => m.modelId),
    eligibleModels,
    supportsReview: false,
  };
}

const claude = agent("claude", [
  row({ modelId: "claude-opus-5" }),
  row({ modelId: "deepseek-v4-pro", serviceId: "deepseek", serviceName: "DeepSeek", billingMode: "key" }),
]);
const codex = agent("codex", [
  row({ modelId: "gpt-5.6-sol", serviceId: "openai", serviceName: "OpenAI" }),
  row({ modelId: "deepseek-v4-pro", serviceId: "deepseek", serviceName: "DeepSeek", billingMode: "key" }),
]);
const agents = [claude, codex];

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ agentList: agents });
});

describe("modelRowAfterHarnessPick", () => {
  it("keeps the model when the new harness offers it", () => {
    // A harness switch is not a model switch — and the models that make this
    // matter are exactly the ones both harnesses run.
    const picked = modelRowAfterHarnessPick(codex.eligibleModels!, { modelId: "deepseek-v4-pro" });
    expect(picked?.modelId).toBe("deepseek-v4-pro");
  });

  it("prefers the same (service, billing mode) over the same id elsewhere", () => {
    // Otherwise a switch silently re-bills an identical id through another
    // service (docs/252 req 11).
    const rows = [
      row({ modelId: "shared", serviceId: "openrouter", serviceName: "OpenRouter", billingMode: "key" }),
      row({ modelId: "shared", serviceId: "vercel", serviceName: "Vercel", billingMode: "key" }),
    ];
    const picked = modelRowAfterHarnessPick(rows, {
      modelId: "shared",
      serviceId: "vercel",
      billingMode: "key",
    });
    expect(picked?.serviceId).toBe("vercel");
  });

  it("falls back to the harness's first row when it cannot run the model", () => {
    const picked = modelRowAfterHarnessPick(codex.eligibleModels!, { modelId: "claude-opus-5" });
    expect(picked?.modelId).toBe("gpt-5.6-sol");
  });

  it("returns undefined when the harness offers nothing", () => {
    expect(modelRowAfterHarnessPick([], { modelId: "claude-opus-5" })).toBeUndefined();
  });
});

describe("persistHarnessPick", () => {
  it("moves the model seed onto the picked harness", () => {
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    localStorage.setItem("vibe-agent-id", "codex");
    persistHarnessPick({ agentId: "claude", agents });
    expect(localStorage.getItem("vibe-agent-id")).toBe("claude");
    expect(getSavedModelId()).toBe("claude-opus-5");
  });

  it("keeps a shared model, moving only the harness", () => {
    localStorage.setItem("vibe-model-id", "deepseek-v4-pro");
    localStorage.setItem("vibe-agent-id", "claude");
    persistHarnessPick({ agentId: "codex", agents });
    expect(localStorage.getItem("vibe-agent-id")).toBe("codex");
    expect(getSavedModelId()).toBe("deepseek-v4-pro");
  });

  it("prefers an explicit current model over the saved seed", () => {
    // The composer passes the LIVE session model, so the switch keeps what the
    // user is looking at rather than whatever the slot last held.
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    persistHarnessPick({ agentId: "codex", agents, current: { modelId: "deepseek-v4-pro" } });
    expect(getSavedModelId()).toBe("deepseek-v4-pro");
  });

  it("clears a parked redirect — the user has spoken", () => {
    saveParkedHarness({ agentId: "claude", model: { modelId: "claude-opus-5" } });
    persistHarnessPick({ agentId: "codex", agents });
    expect(getParkedHarness()).toBeUndefined();
  });

  it("returns undefined and seeds nothing when the harness offers no model", () => {
    localStorage.setItem("vibe-model-id", "claude-opus-5");
    const empty = [claude, agent("codex", [])];
    expect(persistHarnessPick({ agentId: "codex", agents: empty })).toBeUndefined();
    expect(getSavedModelId()).toBe("claude-opus-5");
  });
});

describe("a harness pick survives the store reset", () => {
  // THE regression. `useUiStore.reset()` runs on every new session and every
  // session switch, and re-derives the harness from the SAVED MODEL
  // (`newSessionAgentId`). A pick that wrote only `vibe-agent-id` was therefore
  // discarded the moment the user started their next session — the dropdown
  // "switched back on its own" — while looking like it had worked.
  it("still names the picked harness after useUiStore.reset()", () => {
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    localStorage.setItem("vibe-agent-id", "codex");

    persistHarnessPick({ agentId: "claude", agents });
    useUiStore.getState().setActiveAgentId("claude");

    useUiStore.getState().reset();
    expect(useUiStore.getState().activeAgentId).toBe("claude");
    expect(newSessionAgentId(agents)).toBe("claude");
  });

  it("fails the same way the bug did when only the harness key is written", () => {
    // The counter-example, so the test above cannot pass for the wrong reason.
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    localStorage.setItem("vibe-agent-id", "claude");
    useUiStore.getState().setActiveAgentId("claude");

    useUiStore.getState().reset();
    expect(useUiStore.getState().activeAgentId).toBe("codex");
  });
});
