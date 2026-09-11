import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackgroundWorkSection } from "./BackgroundWorkSection.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { AgentOption } from "../../agent-types.js";

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-flash", "deepseek-v4"],
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-flash",
        label: "V4.1 Flash",
        canonicalModelKey: "deepseek-v4.1-flash",
      },
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4",
        label: "V4",
        canonicalModelKey: "deepseek-v4",
      },
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
        label: "Opus 5",
        canonicalModelKey: "claude-opus-5",
      },
    ],
    supportsReview: true,
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-flash"],

    // (req 9), so this must not become a second row the user picks between.
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-flash",
        label: "V4.1 Flash",
        canonicalModelKey: "deepseek-v4.1-flash",
      },
    ],
    supportsReview: true,
  },
];

const RESOLVED_FLASH = {
  serviceId: "deepseek",
  billingMode: "key" as const,
  modelId: "deepseek-flash",
  serviceName: "DeepSeek",
  label: "V4.1 Flash",
  harnessId: "claude",
  source: "default" as const,
};

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): { nonTurnModel: unknown } {
  const args = fetchMock.mock.calls[call] as unknown as [string, { body: string }];
  return JSON.parse(args[1].body) as { nonTurnModel: unknown };
}

beforeEach(() => {
  useSettingsStore.getState().setNonTurnModel(null, null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BackgroundWorkSection", () => {
  /**
   * The menu offers models and nothing else. Its first row used to be "ShipIt's
   * default" — the unset state, made selectable so the user could return to it.
   * With the setting written once there is no such state, and a row offering to
   * restore it would be an offer ShipIt cannot keep.
   */
  it("offers only models, with no row for a default", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      RESOLVED_FLASH,
    );

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));

    expect(screen.queryByTestId("background-work-model-default")).toBeNull();
    expect(screen.queryByText(/ShipIt's default/)).toBeNull();
    expect(screen.getByTestId("background-work-model-option-deepseek-flash")).toBeTruthy();
  });

  it("describes the work without naming a state or a rule", () => {
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      RESOLVED_FLASH,
    );

    render(<BackgroundWorkSection agentList={agents} />);
    const section = screen.getByTestId("background-work-section");

    expect(section.textContent).toContain("such as naming a session");
    expect(section.textContent).not.toMatch(/default/i);
    expect(section.textContent).not.toMatch(/pinned/i);

    // description carries only what they cannot.
    expect(section.textContent).not.toContain("Currently:");
  });

  // The derivation is stated as a fact, never offered as a control.
  it("shows the derived harness without offering a choice of harness", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);

    expect(screen.getByText(/Runs on Claude Code/)).toBeTruthy();
    expect(screen.queryByTestId("harness-trigger")).toBeNull();

    await user.click(screen.getByTestId("background-work-model"));
    expect(screen.getAllByTestId("background-work-model-option-deepseek-flash")).toHaveLength(1);
  });

  it("offers the service as its own control, with its billing mode on the row", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-service-trigger"));

    expect(screen.getByTestId("background-work-service-option-deepseek:key").textContent)
      .toContain("API key");
    expect(screen.getByTestId("background-work-service-option-anthropic:sub").textContent)
      .toContain("Subscription");
  });

  it("lists only the chosen service's models", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));

    expect(screen.getByTestId("background-work-model-option-deepseek-flash")).toBeTruthy();
    expect(screen.getByTestId("background-work-model-option-deepseek-v4")).toBeTruthy();
    expect(screen.queryByTestId("background-work-model-option-claude-opus-5")).toBeNull();
  });

  it("sends the whole triple when the user pins a model", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ nonTurnModel: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));

    expect(fetchMock).toHaveBeenCalledOnce();

    expect(bodyOf(fetchMock).nonTurnModel).toEqual({
      serviceId: "deepseek",
      billingMode: "key",
      modelId: "deepseek-v4",
    });
  });

  /**
   * docs/261 phase 6 — changing the service is a pin like any other, and it
   * carries a model, because a slot with a service and no model is not a
   * setting anything can run.
   */
  it("pins the new service's first model when the service changes", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-service-trigger"));
    await user.click(screen.getByTestId("background-work-service-option-anthropic:sub"));

    expect(bodyOf(fetchMock).nonTurnModel).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
    });
  });

  it("never sends a null, because there is no unset state to return to", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      RESOLVED_FLASH,
    );

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));
    await user.click(screen.getByTestId("background-work-service-trigger"));
    await user.click(screen.getByTestId("background-work-service-option-anthropic:sub"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) expect(bodyOf(fetchMock, call).nonTurnModel).not.toBeNull();
  });

  it("names a stale pin instead of silently reading as the default", () => {
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" },
      null,
    );

    render(<BackgroundWorkSection agentList={agents} />);

    // the model picker has nothing to offer and req 14 removes it. What must not

    expect(screen.getByText(/gpt-5.4-mini is no longer available/)).toBeTruthy();
    expect((screen.getByTestId("background-work-service-trigger") as HTMLButtonElement).textContent)
      .toContain("openai");
    expect(screen.queryByTestId("background-work-model")).toBeNull();
    expect(screen.queryByTestId("background-work-model-default")).toBeNull();
  });

  it("ignores a stale response that lands after a newer write", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        await slow;
        return { ok: true, json: async () => ({ nonTurnModel: { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" } }) };
      }
      return { ok: true, json: async () => ({ nonTurnModel: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" } }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);

    await user.click(screen.getByTestId("background-work-service-trigger"));
    await user.click(screen.getByTestId("background-work-service-option-anthropic:sub"));

    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));
    expect(useSettingsStore.getState().nonTurnModel?.modelId).toBe("deepseek-v4");

    release?.();
    await slow;
    // The older answer must not win.
    expect(useSettingsStore.getState().nonTurnModel?.modelId).toBe("deepseek-v4");
  });
});
