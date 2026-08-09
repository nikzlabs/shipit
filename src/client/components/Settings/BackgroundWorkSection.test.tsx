import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackgroundWorkSection } from "./BackgroundWorkSection.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { AgentOption } from "../../agent-types.js";

/**
 * docs/252 phase 7 (req 9) — the setting has to be VISIBLE, and its unset state
 * has to read as "follows the install" rather than as an empty control. That is
 * the whole reason a default is acceptable here where a hidden dependency is
 * not: the user can see what background work runs on and change it.
 */

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    authConfigured: true,
    models: ["deepseek-v4-flash"],
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
      },
    ],
    supportsReview: true,
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    authConfigured: true,
    models: ["deepseek-v4-flash"],
    // The SAME triple on a second installed harness. The harness is derived
    // (req 9), so this must not become a second row the user picks between.
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
      },
    ],
    supportsReview: true,
  },
];

beforeEach(() => {
  useSettingsStore.getState().setNonTurnModel(null, null);
  vi.restoreAllMocks();
});

describe("BackgroundWorkSection", () => {
  it("labels the unset state with what it currently resolves to", () => {
    useSettingsStore.getState().setNonTurnModel(null, {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
      serviceName: "DeepSeek",
      label: "V4 Flash",
      harnessId: "claude",
      source: "default",
    });

    render(<BackgroundWorkSection agentList={agents} />);

    const select = screen.getByTestId("background-work-model") as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.options[0].text).toContain("DeepSeek");
    expect(select.options[0].text).toContain("V4 Flash");
  });

  // The derivation is stated as a fact, never offered as a control.
  it("shows the derived harness without offering a choice of harness", () => {
    useSettingsStore.getState().setNonTurnModel(null, {
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
      serviceName: "DeepSeek",
      label: "V4 Flash",
      harnessId: "claude",
      source: "default",
    });

    render(<BackgroundWorkSection agentList={agents} />);

    expect(screen.getByText(/runs on Claude Code/)).toBeTruthy();
    // One model offered on two installed harnesses is ONE option, not two.
    const select = screen.getByTestId("background-work-model") as HTMLSelectElement;
    expect(select.options).toHaveLength(2); // the default + the single triple
  });

  it("sends the whole triple when the user pins a model", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nonTurnModel: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.selectOptions(
      screen.getByTestId("background-work-model"),
      "deepseek|key|deepseek-v4-flash",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      nonTurnModel: unknown;
    };
    // A bare model id could not say which service or mode is billed (req 5).
    expect(body.nonTurnModel).toEqual({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4-flash",
    });
    vi.unstubAllGlobals();
  });

  it("clears the pin when the user picks the default", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
      null,
    );

    render(<BackgroundWorkSection agentList={agents} />);
    await user.selectOptions(screen.getByTestId("background-work-model"), "");

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body) as {
      nonTurnModel: unknown;
    };
    expect(body.nonTurnModel).toBeNull();
    vi.unstubAllGlobals();
  });
});
