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
        // The SAME model as Anthropic's Opus 5, through a gateway, spelled
        // differently. Two strings, one set of weights — which is why changing
        // the service compares `canonicalModelKey` and not the id.
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
    // The SAME triple on a second installed harness. The harness is derived
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
    // planning#435 — a harness that DECLARES levels and honours none of them on
    // a key-billed row. It is in this fixture so the "no menu" case below tests
    // the mode gate rather than a missing `reasoning` prop, which would pass for
    // the wrong reason.
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

/** A slot that has resolved onto DeepSeek — the fixture's other service. */
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

/** A PUT that echoes the slots back, as the real route does. */
function okFetch(reviewers: ReviewerSlotView[] = []) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ reviewers }) }));
}

beforeEach(() => {
  useSettingsStore.getState().setReviewers([]);
  // Toasts outlive a test otherwise, so "no toast was raised" would pass on the
  // *previous* test's toast — the assertion that must not be blind.
  useUiStore.getState().setToast(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ReviewerSection", () => {
  /**
   * Req 8's visible state, both halves at once: the label AND what the slot
   * resolves to. An untouched install has to read as "auto-configured, and here
   * is the reviewer you have" rather than as an empty control.
   */
  it("labels an untouched slot auto-configured and names what it resolves to", () => {
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);
    render(<ReviewerSection agentList={agents} />);

    expect(screen.getByTestId("reviewer-state-first").textContent).toBe("Auto-configured");
    expect(screen.getByTestId("reviewer-state-second").textContent).toBe("Auto-configured");
    const resolution = screen.getByTestId("reviewer-resolution-first").textContent ?? "";
    expect(resolution).toContain("Anthropic");
    expect(resolution).toContain("Opus 5");
    // The derived harness (req 3) and the derived level (req 5) are both stated
    // — a reviewer that named a model and left the level to the CLI would be
    // the one thing req 5 rules out, and here that would look like a missing
    // clause.
    expect(resolution).toContain("Claude Code");
    expect(resolution).toContain("High");
    // And the billing mode, as the pill every other model surface uses. Without
    // this the "what it resolves to" check passes over a resolution that cannot
    // say which credential pays — and a model is selected by the whole triple.
    expect(screen.getByTestId("reviewer-mode-pill-first").textContent).toBe("Subscription");
  });

  /**
   * The harness is the one field on this row that is a PREDICTION, and the row
   * shipped stating it flat: "running on Claude Code".
   *
   * It is not a fact. `resolveReviewerSlots` derives it implementer-independently
   * (`resolveSlotPlan(plan, …, undefined)`); `selectReviewer` passes the
   * implementer's harness as `avoidHarnessId`. Where both installed harnesses
   * carry the model — the shipped `deepseek-v4-flash` does — this view answers
   * Claude Code and a Claude session's review actually runs on Codex. Users read
   * the mismatch as their pin failing to apply.
   *
   * The fixture is the INCIDENT's own shape rather than the file's default
   * Claude-only slot: `deepseek-v4-flash` is really carried by both installed
   * harnesses, so it is the row where this view and the review genuinely
   * disagree — the same pairing `RolesTab.test.tsx` uses for the same reason.
   *
   * So this asserts the CLAIM rather than the sentence: the harness is still
   * named (req 8 keeps it legible) AND what it depends on is said. Only the
   * hedge's *subject* is pinned, not its exact phrasing — a reword that keeps
   * the conditional should not have to touch this test. The pre-fix assertions
   * could not fail on any of it: they were `toContain("Claude Code")`, which a
   * flat prediction satisfies exactly as well as a qualified one.
   */
  it("states the derived harness as a per-review choice, not as settled fact", () => {
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        source: "pinned",
        pin: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4-flash",
          reasoningEffort: "max",
        },
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4-flash",
          serviceName: "DeepSeek",
          label: "V4 Flash",
          // Derived with no implementer to avoid. A Claude session's review of
          // this very slot resolves to Codex instead.
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
    // Req 8 — the harness stays on the row. Dropping it would make Settings
    // silent about the axis this feature took away from `CLAUDE.md`.
    expect(harness).toContain("Claude Code");
    // ...and it is tied to the thing it actually varies with. Naming the
    // reviewed session is the whole correction: without it the row answers for
    // every session, including the ones it is wrong for.
    expect(harness).toMatch(/per review/i);
    expect(harness).toMatch(/reviewed session/i);
    // And the unqualified claim is gone from the row entirely.
    expect(screen.getByTestId("reviewer-resolution-first").textContent).not.toMatch(
      /running on Claude Code/i,
    );
  });

  /**
   * planning#352 — the pin applies partially, and the tab says where.
   *
   * The same incident row as above, and the same reason it is used: this view
   * resolves onto Claude Code, which offers `max`, while a Claude session's
   * review runs on Codex, which does not. Stating "at Max" and stopping there is
   * what made the substitution silent, so the harness that re-derives is named
   * along with what the level becomes there.
   */
  it("names where a pinned level does not survive, and what it becomes", () => {
    useSettingsStore.getState().setReviewers([
      autoSlot("first", {
        source: "pinned",
        pin: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4-flash",
          reasoningEffort: "max",
        },
        resolved: {
          serviceId: "deepseek",
          billingMode: "key",
          modelId: "deepseek-v4-flash",
          serviceName: "DeepSeek",
          label: "V4 Flash",
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
    // Both halves: the level that does not apply, and the one that does there.
    expect(codex).toContain("Max");
    expect(codex).toContain("High");
    // A harness that sends no level at all says that rather than naming one.
    const grok = screen.getByTestId("reviewer-effort-substituted-first-grok").textContent ?? "";
    expect(grok).toMatch(/no level/i);
    // The slot's own resolution still reads as the pin, because here it is one.
    expect(screen.getByTestId("reviewer-resolution-first").textContent).toContain("at Max");
  });

  /** Nothing to warn about when the pin applies wherever a review could land. */
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

  /**
   * planning#352's settings-path half. A service change that keeps the model
   * carries the level along; where the newly derived selection does not offer
   * it, the server re-derives rather than refusing — so the edit lands, and the
   * one thing that changed under it has to be said out loud.
   *
   * A COMPARISON of what was sent against what came back, which is all this file
   * is allowed to know: which harness offers which level stays the server's rule
   * (req 8).
   */
  it("says so when the server stored a different level than the one sent", async () => {
    const user = userEvent.setup();
    const answered: ReviewerSlotView[] = [
      autoSlot("first", {
        source: "pinned",
        // Sent `high` with the model; stored `medium`, because the newly
        // derived selection does not offer `high`.
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
    // The same model on another service, so the level rides along — the exact
    // edit the old refusal made impossible without lowering the level first.
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

  /** No toast when the level the server stored is the level that was sent. */
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
    // Auto-configured slots have nothing to reset.
    expect(screen.queryByTestId("reviewer-reset-second")).toBeNull();
  });

  /**
   * "The derived default rendered as a labelled option, not a blank." The first
   * entry of the model menu is auto-configuration, and on an unpinned slot it
   * names what that currently resolves to.
   */
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

  /**
   * The harness is derived (req 3), so one model offered on two installed
   * harnesses is ONE choice. Two rows would imply a decision the user does not
   * make here.
   */
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
      // Resolves on Codex, whose level set includes both `minimal` and `max`.
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

  /**
   * docs/274 req 14 — a reviewer on a selection that honours NO level offers no
   * menu at all, even though its harness declares four.
   *
   * grok on `xai/key` is that selection: the CLI drops `--reasoning-effort`
   * before the wire there, and `resolveReviewerPinPatch` refuses a level for it —
   * so a menu here would be four options whose every value comes back a 400.
   */
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
    // The harness's `reasoning` capability IS present (see the fixture), so what
    // hides the menu is the selection gate and nothing else.
    expect(agents.find((a) => a.id === "grok")?.reasoning?.options.length).toBeGreaterThan(0);
    expect(screen.queryByTestId("reviewer-reasoning-trigger-first")).toBeNull();
    void user;
  });

  /** …and the SAME harness on its subscription row does offer them. */
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

  /**
   * The server sends the resolution and the client does not re-derive it, so
   * the response replaces BOTH slots — slot 2 is ranked against slot 1, and
   * editing one legitimately changes what the other reports.
   */
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

  /**
   * A pin whose credential went away and an install that can run nothing read
   * very differently, so the tab says which one happened rather than rendering
   * the same blank for both.
   */
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

  /**
   * Req 8's re-derivation, as the tab experiences it: the store is pushed a new
   * resolution (by the `agent_list` SSE, when a credential changes) and the
   * open tab follows it without a reload and without becoming "pinned".
   */
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

  /**
   * Last-response-wins, pinned. Every response replaces BOTH slots (slot 2 is
   * ranked against slot 1), so a slow first response landing after a fast
   * second one would overwrite the newer snapshot — silently undoing an edit
   * the user watched succeed. Cross-backend review found it; only the newest
   * write's response is applied.
   */
  it("ignores a stale response that lands after a newer write", async () => {
    const user = userEvent.setup();
    const stale: ReviewerSlotView[] = [autoSlot("first"), autoSlot("second")];
    const fresh: ReviewerSlotView[] = [
      autoSlot("first", { source: "pinned", pin: { serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4", reasoningEffort: "high" } }),
      autoSlot("second"),
    ];

    // First call resolves LAST; second call resolves first.
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
    // Write 1 — hangs.
    await user.click(screen.getByTestId("reviewer-reasoning-trigger-second"));
    await user.click(screen.getByTestId("reviewer-reasoning-option-second-low"));
    // Write 2 — resolves immediately and is the newest.
    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    await user.click(screen.getByTestId("reviewer-first-service-option-deepseek:key"));
    expect(useSettingsStore.getState().reviewers).toEqual(fresh);

    // Now let the older one land. It must NOT win.
    releaseStale?.();
    await vi.waitFor(() => expect(useSettingsStore.getState().reviewers).toEqual(fresh));
  });

  /**
   * Busy is per slot. A single in-flight slot id meant starting a second write
   * re-enabled the first control mid-flight, and whichever request finished
   * first cleared the flag for the one still running.
   */
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
    // The OTHER slot is untouched — the two are independently editable.
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
    // The store is untouched, so the tab still shows what the server holds.
    expect(useSettingsStore.getState().reviewers[0].source).toBe("auto");
  });

  /**
   * docs/261 req 11 — the service is a CONTROL, and the billing mode rides on
   * the row that acts on it. The tab shipped naming both in prose and offering
   * neither, which answers "who reviews" and leaves "who pays" as something to
   * read.
   */
  it("offers the service as its own control, with its billing mode on each row", async () => {
    const user = userEvent.setup();
    useSettingsStore.getState().setReviewers([autoSlot("first"), autoSlot("second")]);
    render(<ReviewerSection agentList={agents} />);

    await user.click(screen.getByTestId("reviewer-first-service-trigger"));
    expect(screen.getByTestId("reviewer-first-service-option-anthropic:sub").textContent)
      .toContain("Subscription");
    expect(screen.getByTestId("reviewer-first-service-option-deepseek:key").textContent)
      .toContain("API key");
    // Two modes of one service would be two rows; one mode is one row. Four
    // rows because the fixture's four harnesses reach four `(service, mode)`
    // pairs between them — anthropic:sub, anthropic:key, deepseek:key, xai:key.
    expect(screen.getAllByTestId(/^reviewer-first-service-option-/)).toHaveLength(4);
    expect(screen.getByTestId("reviewer-first-service-option-xai:key").textContent)
      .toContain("API key");
  });

  /**
   * docs/261 req 12 — the model list is bounded by the chosen service. The
   * catalogue is meant to grow, so a menu holding every model of every service
   * is a control that stops working later rather than one that works now.
   */
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

  /**
   * And the other half: a service that does not offer the model takes its own
   * first one, without the level — the new model may resolve on a different
   * harness with a different level set, and deriving that here is the
   * client-side re-derivation req 8 rules out.
   */
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
