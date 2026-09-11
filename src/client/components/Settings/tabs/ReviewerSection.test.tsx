import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReviewerSection } from "./ReviewerSection.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { useUiStore } from "../../../stores/ui-store.js";
import type { AgentOption } from "../../../agent-types.js";
import type { ReviewerSlotView } from "../../../../server/shared/types/agent-types.js";

/**
 * docs/261 phase 3 (reqs 1, 5, 8) — what the Reviewer tab has to make visible.
 *
 * Req 8 is the demanding one and it is a UI requirement, not a storage one: for
 * each reviewer the tab says whether it is **auto-configured or pinned** and
 * **what it currently resolves to**, so a reviewer that changed because a
 * service was added is legible rather than surprising. The tests below are
 * mostly that sentence, split up.
 */

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["claude-opus-5", "claude-sonnet-5", "anthropic/claude-opus-5", "deepseek-v4"],
    eligibleModels: [
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-opus-5",
        label: "Opus 5",
        canonicalModelKey: "claude-opus-5",
      },
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-sonnet-5",
        label: "Sonnet 5",
        canonicalModelKey: "claude-sonnet-5",
      },
      {

        serviceId: "openrouter",
        serviceName: "OpenRouter",
        billingMode: "key",
        modelId: "anthropic/claude-opus-5",
        label: "Opus 5",
        canonicalModelKey: "claude-opus-5",
      },
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4",
        label: "V4",
        canonicalModelKey: "deepseek-v4",
      },
    ],
    supportsReview: true,
    reasoning: {
      label: "Reasoning",
      options: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    },
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: true,
    models: ["deepseek-v4"],

    // (req 3), so this must not become a second row the user picks between.
    eligibleModels: [
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4",
        label: "V4",
        canonicalModelKey: "deepseek-v4",
      },
    ],
    supportsReview: true,
    reasoning: {
      label: "Reasoning effort",
      options: [
        { value: "minimal", label: "Minimal" },
        { value: "high", label: "High" },
      ],
    },
  },
  {

    id: "grok",
    name: "Grok Build",
    installed: true,
    hasRunnableModels: true,
    models: ["grok-4.6"],
    eligibleModels: [
      {
        serviceId: "xai",
        serviceName: "xAI",
        billingMode: "key",
        modelId: "grok-4.6",
        label: "Grok 4.6",
        canonicalModelKey: "grok-4.6",
      },
    ],
    supportsReview: false,
    reasoning: {
      label: "Reasoning",
      options: [
        { value: "xhigh", label: "Extra high" },
        { value: "high", label: "High" },
      ],
    },
  },
];

const autoSlot = (slot: "first" | "second", over: Partial<ReviewerSlotView> = {}): ReviewerSlotView => ({
  slot,
  source: "auto",
  resolved: {
    serviceId: "anthropic",
    billingMode: "sub",
    modelId: "claude-opus-5",
    serviceName: "Anthropic",
    label: "Opus 5",
    harnessId: "claude",
    harnessName: "Claude Code",
    reasoningEffort: "high",
    reasoningLabel: "High",
  },
  ...over,
});

const deepseekResolution = {
  serviceId: "deepseek",
  billingMode: "key" as const,
  modelId: "deepseek-v4",
  serviceName: "DeepSeek",
  label: "V4",
  harnessId: "claude" as const,
  harnessName: "Claude Code",
  reasoningEffort: "high",
  reasoningLabel: "High",
};

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const args = fetchMock.mock.calls[call] as unknown as [string, { body: string }];
  return JSON.parse(args[1].body) as Record<string, unknown>;
}

function okFetch(reviewers: ReviewerSlotView[] = []) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ reviewers }) }));
}

beforeEach(() => {
  useSettingsStore.getState().setReviewers([]);

  // *previous* test's toast — the assertion that must not be blind.
  useUiStore.getState().setToast(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReviewerSection", () => {

  it("labels an untouched slot auto-configured and names what it resolves to", () => {
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);
    render(<ReviewerSection agentList={agents} />);

    expect(screen.getByTestId("reviewer-state-first").textContent).toBe("Auto-configured");
    expect(screen.getByTestId("reviewer-state-second").textContent).toBe("Auto-configured");
    const resolution = screen.getByTestId("reviewer-resolution-first").textContent ?? "";
    expect(resolution).toContain("Anthropic");
    expect(resolution).toContain("Opus 5");

    expect(resolution).toContain("Claude Code");
    expect(resolution).toContain("High");

    // this the "what it resolves to" check passes over a resolution that cannot

    expect(screen.getByTestId("reviewer-mode-pill-first").textContent).toBe("Subscription");
  });

  it("states the derived harness as a per-review choice, not as settled fact", () => {
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        source: "pinned",
        pin: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-flash",
          reasoningEffort: "max",
        },
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-flash",
          serviceName: "DeepSeek",
          label: "V4.1 Flash",

          harnessId: "claude",
          harnessName: "Claude Code",
          reasoningEffort: "max",
          reasoningLabel: "Max",
        },
      }),
      autoSlot("second"),
    ]);
    render(<ReviewerSection agentList={agents} />);

    const harness = screen.getByTestId("reviewer-harness-first").textContent ?? "";

    expect(harness).toContain("Claude Code");

    expect(harness).toMatch(/per review/i);
    expect(harness).toMatch(/reviewed session/i);

    expect(screen.getByTestId("reviewer-resolution-first").textContent).not.toMatch(
      /running on Claude Code/i,
    );
  });

  it("names where a pinned level does not survive, and what it becomes", () => {
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        source: "pinned",
        pin: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-flash",
          reasoningEffort: "max",
        },
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-flash",
          serviceName: "DeepSeek",
          label: "V4.1 Flash",
          harnessId: "claude",
          harnessName: "Claude Code",
          reasoningEffort: "max",
          reasoningLabel: "Max",
          effortSubstitutions: [
            { harnessId: "codex", harnessName: "Codex", reasoningEffort: "high", reasoningLabel: "High" },
            { harnessId: "grok", harnessName: "Grok Build" },
          ],
        },
      }),
      autoSlot("second"),
    ]);
    render(<ReviewerSection agentList={agents} />);

    const codex = screen.getByTestId("reviewer-effort-substituted-first-codex").textContent ?? "";
    expect(codex).toContain("Codex");

    expect(codex).toContain("Max");
    expect(codex).toContain("High");

    const grok = screen.getByTestId("reviewer-effort-substituted-first-grok").textContent ?? "";
    expect(grok).toMatch(/no level/i);
    // The slot's own resolution still reads as the pin, because here it is one.
    expect(screen.getByTestId("reviewer-resolution-first").textContent).toContain("at Max");
  });

  it("says nothing about substitutions when the pinned level survives", () => {
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        source: "pinned",
        pin: { serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5", reasoningEffort: "high" },
      }),
      autoSlot("second"),
    ]);
    render(<ReviewerSection agentList={agents} />);

    expect(screen.queryByTestId("reviewer-effort-substituted-first-codex")).toBeNull();
    expect(screen.getByTestId("reviewer-resolution-first").textContent).not.toMatch(
      /does not offer/i,
    );
  });

  it("says so when the server stored a different level than the one sent", async () => {
    const user = userEvent.setup();
    const answered: ReviewerSlotView[] = [
      autoSlot("first", {
        source: "pinned",
        // Sent `high` with the model; stored `medium`, because the newly

        pin: {
          serviceId: "openrouter",
          billingMode: "key",
          modelId: "anthropic/claude-opus-5",
          reasoningEffort: "medium",
        },
        resolved: {
          serviceId: "openrouter",
          billingMode: "key",
          modelId: "anthropic/claude-opus-5",
          serviceName: "OpenRouter",
          label: "Opus 5",
          harnessId: "codex",
          harnessName: "Codex",
          reasoningEffort: "medium",
          reasoningLabel: "Medium",
        },
      }),
      autoSlot("second"),
    ];
    const fetchMock = okFetch(answered);
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);

    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-openrouter:key"));

    expect(bodyOf(fetchMock)).toMatchObject({
      reviewers: { first: { reasoningEffort: "high" } },
    });
    const { useUiStore } = await import("../../../stores/ui-store.js");
    const toast = useUiStore.getState().toast?.message ?? "";
    expect(toast).toContain("high");
    expect(toast).toContain("Medium");
  });

  it("stays quiet when the level came back unchanged", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      okFetch([
        autoSlot("first", {
          source: "pinned",
          pin: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4", reasoningEffort: "high" },
          resolved: deepseekResolution,
        }),
        autoSlot("second"),
      ]),
    );
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-reasoning-trigger-first"));
    await user.click(screen.getByTestId("reviewer-reasoning-option-first-high"));

    const { useUiStore } = await import("../../../stores/ui-store.js");
    expect(useUiStore.getState().toast).toBeNull();
  });

  it("labels a pinned slot pinned, and offers the way back", () => {
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        source: "pinned",
        pin: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4",
          reasoningEffort: "low",
        },
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4",
          serviceName: "DeepSeek",
          label: "V4",
          harnessId: "claude",
          harnessName: "Claude Code",
          reasoningEffort: "low",
          reasoningLabel: "Low",
        },
      }),
      autoSlot("second"),
    ]);
    render(<ReviewerSection agentList={agents} />);

    expect(screen.getByTestId("reviewer-state-first").textContent).toBe("Pinned");
    expect(screen.getByTestId("reviewer-reset-first")).toBeTruthy();

    expect(screen.queryByTestId("reviewer-reset-second")).toBeNull();
  });

  it("renders the derived default as a labelled option at the top of the menu", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);
    render(<ReviewerSection agentList={agents} />);

    await user.click(screen.getByTestId("reviewer-model-trigger-first"));
    const auto = screen.getByTestId("reviewer-model-auto-first");
    expect(auto.textContent).toContain("Auto-configured");
    expect(auto.textContent).toContain("Anthropic");
    expect(auto.textContent).toContain("Opus 5");
  });

  it("offers a model reachable on both harnesses exactly once", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([
      autoSlot("first", { resolved: deepseekResolution }),
      autoSlot("second"),
    ]);
    render(<ReviewerSection agentList={agents} />);

    await user.click(screen.getByTestId("reviewer-model-trigger-first"));
    expect(screen.getAllByTestId("reviewer-model-option-first-deepseek-v4")).toHaveLength(1);
  });

  /**
   * Pinning is atomic (req 8), and this is the model half of it. The level is
   * deliberately omitted from the patch: the new model may resolve on a
   * different harness with a different level set, and deriving that here is the
   * client-side re-derivation req 8 rules out. The server completes the tuple.
   */
  it("pins the whole triple when the model changes, leaving the level to the server", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-model-trigger-first"));
    await user.click(screen.getByTestId("reviewer-model-option-first-claude-sonnet-5"));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(bodyOf(fetchMock)).toEqual({
      reviewers: {
        first: { serviceId: "anthropic", billingMode: "sub", modelId: "claude-sonnet-5" },
      },
    });
  });

  /**
   * The level half of the same rule: editing the reasoning pins the model too,
   * so a slot can never end up half-pinned — a pinned level over a model that
   * silently re-derives when a service is added.
   */
  it("pins the model alongside the level when only the reasoning changes", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-reasoning-trigger-first"));
    await user.click(screen.getByTestId("reviewer-reasoning-option-first-low"));

    expect(bodyOf(fetchMock)).toEqual({
      reviewers: {
        first: {
          serviceId: "anthropic",
          billingMode: "sub",
          modelId: "claude-opus-5",
          reasoningEffort: "low",
        },
      },
    });
  });

  /**
   * The levels offered are the DERIVED harness's, not the other one's — asked of
   * the real catalogue rather than of this file's `agents` fixture.
   *
   * Since planning#435 the menu reads `reasoningOptionsFor(harness, selection)`,
   * because the harness vocabulary alone over-promises: grok declares four
   * levels and honours none of them on a key-billed row (docs/274 req 14). A
   * fixture cannot answer that question, and one that disagrees with the
   * catalogue would assert something ShipIt does not do — so the distinguishing
   * levels below are real ones. Codex has `minimal`, while Claude does not;
   * both now offer `max`.
   */
  it("offers the derived harness's own reasoning levels", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([

      autoSlot("first", {
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4",
          serviceName: "DeepSeek",
          label: "V4",
          harnessId: "codex",
          harnessName: "Codex",
          reasoningEffort: "high",
          reasoningLabel: "High",
        },
      }),
      autoSlot("second"),
    ]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-reasoning-trigger-first"));
    expect(screen.getByTestId("reviewer-reasoning-option-first-minimal")).toBeTruthy();
    expect(screen.getByTestId("reviewer-reasoning-option-first-max")).toBeTruthy();
  });

  it("offers no reasoning menu for a selection whose harness sends no level", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        resolved: {
          serviceId: "xai",
          billingMode: "key",
          modelId: "grok-4.6",
          serviceName: "xAI",
          label: "Grok 4.6",
          harnessId: "grok",
          harnessName: "Grok Build",
        },
      }),
      autoSlot("second"),
    ]);

    render(<ReviewerSection agentList={agents} />);

    expect(agents.find((a) => a.id === "grok")?.reasoning?.options.length).toBeGreaterThan(0);
    expect(screen.queryByTestId("reviewer-reasoning-trigger-first")).toBeNull();
    void user;
  });

  it("offers the levels on a selection whose harness does send them", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        resolved: {
          serviceId: "xai",
          billingMode: "sub",
          modelId: "grok-4.6",
          serviceName: "xAI",
          label: "Grok 4.6",
          harnessId: "grok",
          harnessName: "Grok Build",
          reasoningEffort: "high",
          reasoningLabel: "High",
        },
      }),
      autoSlot("second"),
    ]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-reasoning-trigger-first"));
    expect(screen.getByTestId("reviewer-reasoning-option-first-xhigh")).toBeTruthy();
  });

  it("resets a pinned slot to auto-configuration with a null patch", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        source: "pinned",
        pin: {
          serviceId: "anthropic",
          billingMode: "sub",
          modelId: "claude-opus-5",
          reasoningEffort: "high",
        },
      }),
      autoSlot("second"),
    ]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-reset-first"));

    expect(bodyOf(fetchMock)).toEqual({ reviewers: { first: null } });
  });

  it("adopts the server's answer for both slots after a write", async () => {
    const user = userEvent.setup();
    const answered: ReviewerSlotView[] = [
      autoSlot("first", { source: "pinned", pin: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4", reasoningEffort: "high" } }),
      autoSlot("second", {
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4",
          serviceName: "DeepSeek",
          label: "V4",
          harnessId: "codex",
          harnessName: "Codex",
          reasoningEffort: "high",
          reasoningLabel: "High",
        },
      }),
    ];
    vi.stubGlobal("fetch", okFetch(answered));
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-deepseek:key"));

    expect(useSettingsStore.getState().reviewers).toEqual(answered);
    expect(await screen.findByText(/Codex/)).toBeTruthy();
  });

  it("explains an unavailable pin and an install with nothing to run, differently", () => {
    useSettingsStore.getState().setReviewers([
      {
        slot: "first",
        source: "pinned",
        pin: { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6-sol", reasoningEffort: "high" },
        unavailableReason: "pin_unavailable",
      },
      { slot: "second", source: "auto", unavailableReason: "nothing_eligible" },
    ]);
    render(<ReviewerSection agentList={agents} />);

    expect(screen.getByTestId("reviewer-resolution-first").textContent).toContain(
      "no longer available",
    );
    expect(screen.getByTestId("reviewer-resolution-second").textContent).toContain(
      "Nothing to review with yet",
    );
  });

  it("follows a pushed re-resolution while open, still auto-configured", () => {
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);
    const { rerender } = render(<ReviewerSection agentList={agents} />);
    expect(screen.getByTestId("reviewer-resolution-second").textContent).toContain("Anthropic");

    useSettingsStore.getState().setReviewers([
      autoSlot("first"),
      autoSlot("second", {
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4",
          serviceName: "DeepSeek",
          label: "V4",
          harnessId: "codex",
          harnessName: "Codex",
          reasoningEffort: "high",
          reasoningLabel: "High",
        },
      }),
    ]);
    rerender(<ReviewerSection agentList={agents} />);

    expect(screen.getByTestId("reviewer-resolution-second").textContent).toContain("DeepSeek");
    expect(screen.getByTestId("reviewer-state-second").textContent).toBe("Auto-configured");
  });

  it("ignores a stale response that lands after a newer write", async () => {
    const user = userEvent.setup();
    const stale: ReviewerSlotView[] = [autoSlot("first"), autoSlot("second")];
    const fresh: ReviewerSlotView[] = [
      autoSlot("first", { source: "pinned", pin: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4", reasoningEffort: "high" } }),
      autoSlot("second"),
    ];

    let releaseStale: (() => void) | undefined;
    const staleGate = new Promise<void>((resolve) => { releaseStale = resolve; });
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const which = call++;
        if (which === 0) {
          await staleGate;
          return { ok: true, json: async () => ({ reviewers: stale }) };
        }
        return { ok: true, json: async () => ({ reviewers: fresh }) };
      }),
    );
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);

    await user.click(screen.getByTestId("reviewer-reasoning-trigger-second"));
    await user.click(screen.getByTestId("reviewer-reasoning-option-second-low"));

    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-deepseek:key"));
    expect(useSettingsStore.getState().reviewers).toEqual(fresh);

    // Now let the older one land. It must NOT win.
    releaseStale?.();
    await vi.waitFor(() => expect(useSettingsStore.getState().reviewers).toEqual(fresh));
  });

  it("keeps a slot disabled while its own write is in flight", async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return { ok: true, json: async () => ({ reviewers: [autoSlot("first"), autoSlot("second")] }) };
      }),
    );
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-deepseek:key"));

    const first = screen.getByTestId("reviewer-model-trigger-first") as HTMLButtonElement;
    const second = screen.getByTestId("reviewer-model-trigger-second") as HTMLButtonElement;
    expect(first.disabled).toBe(true);

    expect(second.disabled).toBe(false);

    release?.();
    await vi.waitFor(() => {
      expect((screen.getByTestId("reviewer-model-trigger-first") as HTMLButtonElement).disabled)
        .toBe(false);
    });
  });

  it("surfaces the server's refusal rather than silently keeping the old value", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "No installed harness can run deepseek/key/deepseek-v4" }),
      })),
    );
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-deepseek:key"));

    const { useUiStore } = await import("../../../stores/ui-store.js");
    expect(useUiStore.getState().toast?.message).toContain("No installed harness can run");

    expect(useSettingsStore.getState().reviewers[0].source).toBe("auto");
  });

  it("offers the service as its own control, with its billing mode on each row", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);
    render(<ReviewerSection agentList={agents} />);

    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    expect(screen.getByTestId("reviewer-first-service-option-anthropic:sub").textContent)
      .toContain("Subscription");
    expect(screen.getByTestId("reviewer-first-service-option-deepseek:key").textContent)
      .toContain("API key");

    // rows because the fixture's four harnesses reach four `(service, mode)`

    expect(screen.getAllByTestId(/^reviewer-first-service-option-/)).toHaveLength(4);
    expect(screen.getByTestId("reviewer-first-service-option-xai:key").textContent)
      .toContain("API key");
  });

  it("lists only the chosen service's models", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);
    render(<ReviewerSection agentList={agents} />);

    await user.click(screen.getByTestId("reviewer-model-trigger-first"));
    expect(screen.getByTestId("reviewer-model-option-first-claude-opus-5")).toBeTruthy();
    expect(screen.getByTestId("reviewer-model-option-first-claude-sonnet-5")).toBeTruthy();
    expect(screen.queryByTestId("reviewer-model-option-first-deepseek-v4")).toBeNull();
  });

  /**
   * The deciding case for the service switch, and the reason it cannot compare
   * model ids: Anthropic's `claude-opus-5` and OpenRouter's
   * `anthropic/claude-opus-5` are two strings and one set of weights. A user
   * changing only who pays keeps the model they chose — and therefore keeps the
   * level too, since neither the model nor its harness moved.
   */
  it("keeps the model when the new service offers the same one", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-openrouter:key"));

    expect(bodyOf(fetchMock)).toEqual({
      reviewers: {
        first: {
          serviceId: "openrouter",
          billingMode: "key",
          modelId: "anthropic/claude-opus-5",
          reasoningEffort: "high",
        },
      },
    });
  });

  it("falls back to the service's first model, leaving the level to the server", async () => {
    const user = userEvent.setup();
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);

    render(<ReviewerSection agentList={agents} />);
    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-deepseek:key"));

    expect(bodyOf(fetchMock)).toEqual({
      reviewers: {
        first: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4" },
      },
    });
  });
});
