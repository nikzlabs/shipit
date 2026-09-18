import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BackgroundWorkSection } from "./BackgroundWorkSection.js";
import { resetDeclaredSaves } from "./declared-setting.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { initialSettingValues } from "../../stores/setting-values.js";
import type { AgentOption, EligibleModelOption } from "../../agent-types.js";

const KEY = "services.nonTurnModel" as const;
type Pin = { serviceId: string; billingMode: "sub" | "key"; modelId: string } | null;
type Resolved = ReturnType<typeof useSettingsStore.getState>["nonTurnModelResolved"];

/**
 * The pin is the declared value and the resolution beside it is not, so they are
 * seeded through two different doors: the record, and the one setter that is
 * left (docs/308 slice 6b).
 */
function seed(pin: Pin, resolved: Resolved) {
  useSettingsStore.getState().setSettingValue(KEY, pin);
  useSettingsStore.getState().setNonTurnModelResolved(resolved);
}

function renderSection() {
  return render(<BackgroundWorkSection settingKey={KEY} />);
}

/**
 * The agent list is here for ONE thing: naming the harness in the derived line.
 * The options come from the server's `backgroundWorkModels` (docs/299 req 3),
 * which is why Claude Code below declares no eligible models and the pickers
 * are full anyway — that mismatch is the feature.
 */
const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: [],
    eligibleModels: [],
    supportsReview: true,
  },
];

const OPTIONS: EligibleModelOption[] = [
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
];

const RESOLVED_FLASH = {
  serviceId: "deepseek",
  billingMode: "key" as const,
  modelId: "deepseek-flash",
  serviceName: "DeepSeek",
  label: "V4.1 Flash",
  harnessId: "claude",
  execution: "harness" as const,
  source: "default" as const,
};

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): { nonTurnModel: unknown } {
  const args = fetchMock.mock.calls[call] as unknown as [string, { body: string }];
  return JSON.parse(args[1].body) as { nonTurnModel: unknown };
}

beforeEach(() => {
  useSettingsStore.setState({ settingValues: initialSettingValues(), settingDrafts: {} });
  resetDeclaredSaves();
  seed(null, null);
  useSettingsStore.getState().setBackgroundWorkModels(OPTIONS);
  // The harness names come from the UI store now, not from a prop.
  useUiStore.setState({ agentList: agents });
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
    seed(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      RESOLVED_FLASH,
    );

    renderSection();
    await user.click(screen.getByTestId("background-work-model"));

    expect(screen.queryByTestId("background-work-model-default")).toBeNull();
    expect(screen.queryByText(/ShipIt's default/)).toBeNull();
    expect(screen.getByTestId("background-work-model-option-deepseek-flash")).toBeTruthy();
  });

  it("describes the work without naming a state or a rule", () => {
    seed(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      RESOLVED_FLASH,
    );

    renderSection();
    const section = screen.getByTestId("background-work-section");

    expect(section.textContent).toContain("such as naming a session");
    expect(section.textContent).not.toMatch(/default/i);
    expect(section.textContent).not.toMatch(/pinned/i);

    // description carries only what they cannot.
    expect(section.textContent).not.toContain("Currently:");
  });

  /**
   * docs/299 req 3 — the pickers are the server's background-work list, not the
   * union of the installed harnesses' models. `agents` here declares no eligible
   * models at all, so a picker with rows in it can only have got them from the
   * store: that is exactly the install where a model provider is reachable by a
   * direct call and by nothing else.
   */
  it("offers a model provider no installed harness can reach", async () => {
    const user = userEvent.setup();
    seed(null, {
      ...RESOLVED_FLASH,
      harnessId: undefined,
      execution: "direct",
    });

    renderSection();
    await user.click(screen.getByTestId("background-work-service-trigger"));

    expect(screen.getByTestId("background-work-service-option-deepseek:key")).toBeTruthy();
  });

  /**
   * The line carries the consequence, not the provider — the control beside it
   * already names that. Both states are rendered from one field, so neither can
   * be read off the absence of the other.
   */
  it("says the work is called directly where no harness runs it", () => {
    seed(null, {
      ...RESOLVED_FLASH,
      harnessId: undefined,
      execution: "direct",
    });

    renderSection();

    expect(screen.getByTestId("background-work-execution").textContent)
      .toBe("Called directly · no harness, no container");
    expect(screen.queryByText(/Runs on/)).toBeNull();
  });

  it("keeps naming the harness where one runs it", () => {
    seed(null, RESOLVED_FLASH);

    renderSection();

    expect(screen.getByTestId("background-work-execution").textContent).toBe("Runs on Claude Code");
    expect(screen.queryByText(/Called directly/)).toBeNull();
  });

  // The derivation is stated as a fact, never offered as a control.
  it("shows the derived harness without offering a choice of harness", async () => {
    const user = userEvent.setup();
    seed(null, RESOLVED_FLASH);

    renderSection();

    expect(screen.getByText(/Runs on Claude Code/)).toBeTruthy();
    expect(screen.queryByTestId("harness-trigger")).toBeNull();

    await user.click(screen.getByTestId("background-work-model"));
    expect(screen.getAllByTestId("background-work-model-option-deepseek-flash")).toHaveLength(1);
  });

  it("offers the service as its own control, with its billing mode on the row", async () => {
    const user = userEvent.setup();
    seed(null, RESOLVED_FLASH);

    renderSection();
    await user.click(screen.getByTestId("background-work-service-trigger"));

    expect(screen.getByTestId("background-work-service-option-deepseek:key").textContent)
      .toContain("API key");
    expect(screen.getByTestId("background-work-service-option-anthropic:sub").textContent)
      .toContain("Subscription");
  });

  it("lists only the chosen service's models", async () => {
    const user = userEvent.setup();
    seed(null, RESOLVED_FLASH);

    renderSection();
    await user.click(screen.getByTestId("background-work-model"));

    expect(screen.getByTestId("background-work-model-option-deepseek-flash")).toBeTruthy();
    expect(screen.getByTestId("background-work-model-option-deepseek-v4")).toBeTruthy();
    expect(screen.queryByTestId("background-work-model-option-claude-opus-5")).toBeNull();
  });

  /**
   * The triple is the unit, and where it goes comes from the declaration
   * (docs/308 slice 6b): the shared writer builds `PUT /api/settings` with the
   * declared `wire`, and this component names no path, no method and no field.
   * The record moves with it, and the named field the rest of the app reads is a
   * view over the record.
   */
  it("sends the whole triple to the declared destination when the user pins a model", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    seed(null, RESOLVED_FLASH);

    renderSection();
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { method: string }];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PUT");

    const pinned = { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" };
    expect(bodyOf(fetchMock).nonTurnModel).toEqual(pinned);
    expect(useSettingsStore.getState().settingValues[KEY]).toEqual(pinned);
    expect(useSettingsStore.getState().nonTurnModel).toEqual(pinned);
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
    seed(null, RESOLVED_FLASH);

    renderSection();
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
    seed(
      { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" },
      RESOLVED_FLASH,
    );

    renderSection();
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));
    await user.click(screen.getByTestId("background-work-service-trigger"));
    await user.click(screen.getByTestId("background-work-service-option-anthropic:sub"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of [0, 1]) expect(bodyOf(fetchMock, call).nonTurnModel).not.toBeNull();
  });

  it("names a stale pin instead of silently reading as the default", () => {
    seed(
      { serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" },
      null,
    );

    renderSection();

    // the model picker has nothing to offer and req 14 removes it. What must not

    expect(screen.getByText(/gpt-5.4-mini can no longer run background work/)).toBeTruthy();
    // The panel cannot tell a missing credential from a carrier that cannot run
    // it, so it claims neither (docs/299-direct-provider-calls req 3).
    expect(screen.queryByText(/credential or its harness is gone/)).toBeNull();
    expect((screen.getByTestId("background-work-service-trigger") as HTMLButtonElement).textContent)
      .toContain("openai");
    expect(screen.queryByTestId("background-work-model")).toBeNull();
    expect(screen.queryByTestId("background-work-model-default")).toBeNull();
  });

  /*
    The resolution no longer rides the write's own response — it arrives with the
    next settings refresh — so the controls have to follow the PIN. Reading the
    resolution first left them showing the model the user had just replaced: for
    the round trip, and for ever if that refresh failed. Nothing here settles the
    resolution, which is exactly the window.
  */
  it("shows the model just picked, before the resolution catches up", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    seed(null, RESOLVED_FLASH);

    renderSection();
    await user.click(screen.getByTestId("background-work-service-trigger"));
    await user.click(screen.getByTestId("background-work-service-option-anthropic:sub"));

    expect(screen.getByTestId("background-work-service-trigger").textContent).toContain("Anthropic");
    expect(screen.getByTestId("background-work-model").textContent).toContain("Opus 5");
    // The resolution still describes DeepSeek, so it says nothing about how this
    // selection runs rather than naming the harness of the one it replaced.
    expect(useSettingsStore.getState().nonTurnModelResolved).toBe(RESOLVED_FLASH);
    expect(screen.queryByTestId("background-work-execution")).toBeNull();
  });

  /*
    Sequencing two overlapping writes and rolling a refused one back to the value
    the SERVER last accepted belongs to the shared writer, which
    `declared-setting.test.tsx` covers over the declared booleans. What is left to
    prove here is that a refusal reaches this control: it holds no copy of the
    pin, so the record putting the old triple back is the whole of it.
  */
  it("shows the stored model again when the write is refused", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const stored = { serviceId: "deepseek", billingMode: "key" as const, modelId: "deepseek-flash" };
    seed(stored, RESOLVED_FLASH);

    renderSection();
    await user.click(screen.getByTestId("background-work-model"));
    await user.click(screen.getByTestId("background-work-model-option-deepseek-v4"));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(useSettingsStore.getState().settingValues[KEY]).toEqual(stored);
    expect(screen.getByTestId("background-work-model").textContent).toContain("V4.1 Flash");
  });
});
