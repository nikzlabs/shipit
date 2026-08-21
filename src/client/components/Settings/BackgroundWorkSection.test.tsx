import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackgroundWorkSection } from "./BackgroundWorkSection.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { AgentOption } from "../../agent-types.js";

/**
 * docs/252 req 9 — the setting has to be VISIBLE and changeable.
 *
 * It used to also have an unset state, which had to read as "follows the
 * install" rather than as an empty control. **That state is gone** (2026-08-13):
 * the server writes the setting the first time the install can run something,
 * so there is one state, no word to learn for it, and no "ShipIt's default" row
 * in the menu. The tests that pinned the unset state are replaced below by ones
 * pinning its absence — a menu that offers only models, and a section that
 * explains no rule.
 *
 * docs/261 phase 6 (reqs 11, 12, 13) — the control changed from a native
 * `<select>` to the shared `Picker`, with the service ahead of the model. Every
 * assertion below is the same requirement, asked of the new control.
 */

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-v4-flash", "deepseek-v4"],
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
        canonicalModelKey: "deepseek-v4-flash",
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
        canonicalModelKey: "deepseek-v4-flash",
      },
    ],
    supportsReview: true,
  },
];

const RESOLVED_FLASH = {
  serviceId: "deepseek",
  billingMode: "key" as const,
  modelId: "deepseek-v4-flash",
  serviceName: "DeepSeek",
  label: "V4 Flash",
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
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
      RESOLVED_FLASH,
    );

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));

    expect(screen.queryByTestId("background-work-model-default")).toBeNull();
    expect(screen.queryByText(/ShipIt's default/)).toBeNull();
    expect(screen.getByTestId("background-work-model-option-deepseek-v4-flash")).toBeTruthy();
  });

  /**
   * The section explains the work, not a rule. Every sentence about what the
   * unset value follows went with the state itself, and the examples stay
   * examples — the list of things ShipIt runs outside a turn is not closed.
   */
  it("describes the work without naming a state or a rule", () => {
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
      RESOLVED_FLASH,
    );

    render(<BackgroundWorkSection agentList={agents} />);
    const section = screen.getByTestId("background-work-section");

    expect(section.textContent).toContain("such as naming a session");
    expect(section.textContent).not.toMatch(/default/i);
    expect(section.textContent).not.toMatch(/pinned/i);
    // The controls state the service and the model, so the line beneath the
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
    // One model offered on two installed harnesses is ONE option, not two.
    await user.click(screen.getByTestId("background-work-model"));
    expect(screen.getAllByTestId("background-work-model-option-deepseek-v4-flash")).toHaveLength(1);
  });

  /**
   * docs/261 req 11 — the service is a control carrying its billing mode, not a
   * line of prose. A user asking "is this my subscription or my card" answers it
   * on the row they are about to click.
   */
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

  /** docs/261 req 12 — the model list is bounded by the chosen service. */
  it("lists only the chosen service's models", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setNonTurnModel(null, RESOLVED_FLASH);

    render(<BackgroundWorkSection agentList={agents} />);
    await user.click(screen.getByTestId("background-work-model"));

    expect(screen.getByTestId("background-work-model-option-deepseek-v4-flash")).toBeTruthy();
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
    // A bare model id could not say which service or mode is billed (req 5).
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

  /**
   * Every write from this section is a whole triple. The section could once
   * send `null` — "clear the setting and follow the install again" — and that
   * is the state req 9 no longer has, so no interaction here may produce it.
   */
  it("never sends a null, because there is no unset state to return to", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" },
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

  // Cross-backend review: a pin the install can no longer run is not among the
  // eligible choices, so the control read as the DEFAULT — while the server
  // still held the pin and failed it on every session. The two have to agree,
  // and the honest way is to name the pin the server is actually holding.
  it("names a stale pin instead of silently reading as the default", () => {
    useSettingsStore.getState().setNonTurnModel(
      { serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" },
      null,
    );

    render(<BackgroundWorkSection agentList={agents} />);

    // The pin is named in the warning, not on a control: its service is gone, so
    // the model picker has nothing to offer and req 14 removes it. What must not
    // happen is the control reading as the DEFAULT while the server holds a pin
    // it fails on every job — that is the regression this test was written for,
    // and it is still caught.
    expect(screen.getByText(/gpt-5.4-mini is no longer available/)).toBeTruthy();
    expect((screen.getByTestId("background-work-service-trigger") as HTMLButtonElement).textContent)
      .toContain("openai");
    expect(screen.queryByTestId("background-work-model")).toBeNull();
    expect(screen.queryByTestId("background-work-model-default")).toBeNull();
  });

  /**
   * Two dependent controls make overlapping writes ordinary — change the
   * service, then click a model before the response lands. The `<select>` this
   * replaced was one control and could not reach this state; cross-backend
   * review found the replacement had inherited neither a busy gate nor a
   * newest-write rule from the Reviewer tab, which learned both the same way.
   */
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
    // Write 1 — slow, and it will resolve LAST.
    await user.click(screen.getByTestId("background-work-service-trigger"));
    await user.click(screen.getByTestId("background-work-service-option-anthropic:sub"));
    // Write 2 — resolves immediately and is the newest.
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));
    expect(useSettingsStore.getState().nonTurnModel?.modelId).toBe("deepseek-v4");

    release?.();
    await slow;
    // The older answer must not win.
    expect(useSettingsStore.getState().nonTurnModel?.modelId).toBe("deepseek-v4");
  });
});
