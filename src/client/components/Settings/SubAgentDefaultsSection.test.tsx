/**
 * docs/252 phase 4 — the sub-agent defaults model picker gains the service axis.
 *
 * This is the third persisted model selection and the last one still speaking
 * bare model ids. Phase 3 narrowed the LIST to what the install can run and left
 * the ambiguity: once two services offer the same id, a bare id cannot say which
 * one the user meant (req 5), so the server guessed and could only ever produce
 * one of the two.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings-store.js";
import { SubAgentDefaultsSection } from "./SubAgentDefaultsSection.js";
import type { AgentOption } from "../../agent-types.js";

const agent: AgentOption = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  authConfigured: true,
  models: ["anthropic/claude-opus-5"],
  eligibleModels: [
    {
      serviceId: "openrouter",
      serviceName: "OpenRouter",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
      label: "Opus 5",
    },
    {
      serviceId: "vercel",
      serviceName: "Vercel AI Gateway",
      billingMode: "key",
      modelId: "anthropic/claude-opus-5",
      label: "Opus 5",
    },
  ],
  supportsReview: true,
};

let fetchCalls: { body: unknown }[] = [];

beforeEach(() => {
  fetchCalls = [];
  useSettingsStore.getState().setAgentSubAgentDefaults({});
  vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
    fetchCalls.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SubAgentDefaultsSection — the service axis", () => {
  it("offers one option per (service, billing mode), not one per model id", async () => {
    render(<SubAgentDefaultsSection agent={agent} />);
    const select = screen.getByTestId("subagent-model-claude") as HTMLSelectElement;
    // Default + the same id from two services. A bare-id list would show one.
    expect(select.querySelectorAll("option")).toHaveLength(3);
    const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
    expect(groups).toEqual(["OpenRouter — API key", "Vercel AI Gateway — API key"]);
  });

  it("sends the whole triple so the server does not have to guess", async () => {
    const user = userEvent.setup();
    render(<SubAgentDefaultsSection agent={agent} />);
    await user.selectOptions(
      screen.getByTestId("subagent-model-claude"),
      "vercel:key:anthropic/claude-opus-5",
    );
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0]!.body).toEqual({
      agentSubAgentDefaults: {
        claude: {
          model: "anthropic/claude-opus-5",
          serviceId: "vercel",
          billingMode: "key",
        },
      },
    });
  });

  it("selects the row the stored default was chosen from", () => {
    useSettingsStore.getState().setAgentSubAgentDefaults({
      claude: {
        model: "anthropic/claude-opus-5",
        serviceId: "vercel",
        billingMode: "key",
      },
    });
    render(<SubAgentDefaultsSection agent={agent} />);
    expect((screen.getByTestId("subagent-model-claude") as HTMLSelectElement).value).toBe(
      "vercel:key:anthropic/claude-opus-5",
    );
  });

  it("clearing sends a null model and drops the service with it", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setAgentSubAgentDefaults({
      claude: { model: "anthropic/claude-opus-5", serviceId: "vercel", billingMode: "key" },
    });
    render(<SubAgentDefaultsSection agent={agent} />);
    await user.selectOptions(screen.getByTestId("subagent-model-claude"), "");
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0]!.body).toEqual({
      agentSubAgentDefaults: { claude: { model: null } },
    });
  });

  it("falls back to a flat id list when the payload predates eligibleModels", () => {
    render(<SubAgentDefaultsSection agent={{ ...agent, eligibleModels: undefined }} />);
    const select = screen.getByTestId("subagent-model-claude") as HTMLSelectElement;
    expect(select.querySelectorAll("option")).toHaveLength(2);
    expect(select.querySelectorAll("optgroup")).toHaveLength(0);
  });
});
