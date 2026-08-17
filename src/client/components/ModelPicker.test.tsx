import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarnessSelector, ModelSelector } from "./ModelPicker.js";
import { useSessionStore } from "../stores/session-store.js";
import type { AgentOption } from "../agent-types.js";
import type { SessionInfo } from "../../server/shared/types.js";

afterEach(cleanup);

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["claude-sonnet-5", "deepseek-v4-flash"],
    eligibleModels: [
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-sonnet-5",
        label: "Sonnet 5",
        canonicalModelKey: "claude-sonnet-5",
      },
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "key",
        modelId: "claude-sonnet-5",
        label: "Sonnet 5",
        canonicalModelKey: "claude-sonnet-5",
      },
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
    supportedPermissionModes: ["auto", "plan", "guarded"],
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    hasRunnableModels: true,
    models: ["gpt-5.6-sol"],
    eligibleModels: [
      {
        serviceId: "openai",
        serviceName: "OpenAI",
        billingMode: "sub",
        modelId: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        canonicalModelKey: "gpt-5.6-sol",
      },
    ],
    supportsReview: false,
    supportedPermissionModes: [],
  },
];

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "s1",
    title: "Test",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    remoteUrl: "https://github.com/example/repo.git",
    ...overrides,
  } as SessionInfo;
}

function setSessionState(session: SessionInfo | undefined) {
  useSessionStore.setState({
    sessionId: session?.id,
    sessions: session ? [session] : [],
  });
}

/** Reset the "server answered" counter so one test's echo can't clear another's pick. */
function resetSelectionEcho() {
  useSessionStore.setState({ modelSelectionEcho: {} });
}

beforeEach(() => {
  localStorage.removeItem("vibe-model-id");
  localStorage.removeItem("vibe-agent-id");
  setSessionState(undefined);
  resetSelectionEcho();
});

describe("HarnessSelector", () => {
  it("lists installed harnesses with their model counts", async () => {
    const user = userEvent.setup();
    render(
      <HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("harness-trigger"));
    expect(screen.getByTestId("harness-option-claude")).toHaveTextContent("3 models available");
    expect(screen.getByTestId("harness-option-codex")).toHaveTextContent("1 model available");
  });

  it("puts the model count on its own line beneath the harness name (D10/D11)", async () => {
    // The count is a property OF the harness, not a second column to compare
    // across rows — right-aligning it on the same line invited exactly the
    // "how many models am I giving up" reading the control is not for.
    const user = userEvent.setup();
    render(<HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    await user.click(screen.getByTestId("harness-trigger"));

    const row = screen.getByTestId("harness-option-claude");
    const count = within(row).getByText("3 models available");
    expect(count.className).toContain("block");
    expect(within(row).getByText("Claude Code").className).toContain("block");
  });

  it("still says what an uncredentialed harness needs, and disables it", async () => {
    // An improvement over the mock, which never depicted the state: kept
    // deliberately when the row went to two lines.
    const user = userEvent.setup();
    render(
      <HarnessSelector
        agents={[agents[0], { ...agents[1], hasRunnableModels: false }]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("harness-trigger"));
    const row = screen.getByTestId("harness-option-codex");
    expect(row).toHaveTextContent("needs a credential");
    expect(row).toHaveAttribute("data-disabled");
  });

  it("omits a harness this deployment did not install (req 14)", async () => {
    const user = userEvent.setup();
    render(
      <HarnessSelector
        agents={[agents[0], { ...agents[1], installed: false }]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("harness-trigger"));
    expect(screen.queryByTestId("harness-option-codex")).toBeNull();
  });

  it("is disabled once the session has pinned a harness, with the reason on the control", () => {
    // The irreversibility is the whole reason the harness left the model menu:
    // as a greyed row behind a dropdown, the single most consequential fact
    // about the session was visible only to someone who opened it.
    setSessionState(makeSession({ agentId: "claude", agentPinned: true }));
    render(
      <HarnessSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        hasActiveSession
      />,
    );
    const trigger = screen.getByTestId("harness-trigger");
    expect(trigger).toBeDisabled();
    expect(trigger.getAttribute("title")).toMatch(/fixed for this session/i);
  });

  // docs/260 — the icon-only `compactTrigger` variant is gone. There is no
  // longer a width at which this control renders but is too narrow for its own
  // name: below 700px of composer width the harness moves into the composer's
  // settings menu, where it gets a full row. So this control always shows its
  // name, and `ComposerSettingsMenu.test.tsx` owns the narrow case.
  it("always shows the harness name", () => {
    render(
      <HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />,
    );
    const trigger = screen.getByTestId("harness-trigger");
    expect(trigger).toHaveTextContent("Claude Code");
    expect(trigger.getAttribute("aria-label")).toBe("Harness selector: Claude Code");
  });

  it("does NOT lock in a new-session picker even when a background session is pinned (docs/166)", () => {
    setSessionState(makeSession({ agentId: "claude", agentPinned: true }));
    render(
      <HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />,
    );
    expect(screen.getByTestId("harness-trigger")).not.toBeDisabled();
  });

  it("ignores the globally-active session and previews the persisted seed when no session is bound", () => {
    // Quick Capture over a Codex session: the overlay creates a session from the
    // saved seed, so naming the session sitting behind it says the new session
    // will be Codex when it will not.
    setSessionState(makeSession({ agentId: "codex" }));
    localStorage.setItem("vibe-agent-id", "claude");
    render(
      <HarnessSelector
        agents={agents}
        activeAgentId="codex"
        onAgentChange={vi.fn()}
        seedFromHistory
      />,
    );
    expect(screen.getByTestId("harness-trigger")).toHaveTextContent("Claude Code");
  });

  it("derives the seeded harness from the saved MODEL, which is what creates the session", () => {
    // `newSessionAgentId` — the model is the single source of truth, so a stale
    // `vibe-agent-id` must not out-vote it (docs/142 Problem C). Displaying the
    // stale one would name a harness the connect URL will not use.
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "gpt-5.6-sol");
    render(
      <HarnessSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        seedFromHistory
      />,
    );
    expect(screen.getByTestId("harness-trigger")).toHaveTextContent("Codex");
  });

  it("falls back to activeAgentId while the bound session is a WARM one, invisible in `sessions`", () => {
    // The claimed warm session is bound (`sessionId` is set, `set_agent` goes
    // over its socket) but `SessionManager.list` filters `warm = 0`, so it never
    // appears in `sessions` — the composer has a session it cannot see, and the
    // fallback is the caller's `activeAgentId`. That is deliberate: the fallback
    // has to carry an explicit harness pick made on the new-session route, which
    // the seed cannot when the saved model belongs to the other harness. Keeping
    // that fallback truthful is `useUiStore.reset()`'s job, pinned in
    // `ui-store.test.ts` — this pins that the picker does use it.
    useSessionStore.setState({ sessionId: "warm-1", sessions: [] });
    localStorage.setItem("vibe-agent-id", "claude");
    render(
      <HarnessSelector agents={agents} activeAgentId="codex" onAgentChange={vi.fn()} />,
    );
    expect(screen.getByTestId("harness-trigger")).toHaveTextContent("Codex");
  });

  it("still follows the bound session's harness when there IS one", () => {
    // The new-session route claims a warm session up front and talks to it, so
    // `hasActiveSession` is false while a session is nonetheless bound. Its
    // harness stays authoritative — this is the case `seedFromHistory` must not
    // swallow.
    setSessionState(makeSession({ agentId: "codex" }));
    localStorage.setItem("vibe-agent-id", "claude");
    render(
      <HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />,
    );
    expect(screen.getByTestId("harness-trigger")).toHaveTextContent("Codex");
  });
});

describe("ModelSelector", () => {
  it("says 'No model' when the install has none, and 'Loading' only while loading", () => {
    // Two unrelated states used to read alike, because the trigger printed
    // `displayName || "Loading..."`: one frame before the agent list arrives,
    // and the whole first-run state where nothing is configured — which is
    // permanent until the user adds a service, so the composer sat saying
    // "Loading…" for ever beside an input telling them to add one.
    const bare: AgentOption = {
      id: "claude",
      name: "Claude Code",
      installed: true,
      hasRunnableModels: false,
      models: [],
      eligibleModels: [],
      supportsReview: true,
    };
    const { rerender } = render(
      <ModelSelector agents={[bare]} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("No model");

    rerender(
      <ModelSelector agents={[]} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("Loading");
  });

  it("groups rows by service and billing mode (req 5)", async () => {
    const user = userEvent.setup();
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    const menu = screen.getByTestId("model-dropdown");
    expect(menu).toHaveTextContent("Anthropic");
    expect(menu).toHaveTextContent("DeepSeek");
    expect(menu).toHaveTextContent("Subscription");
    expect(menu).toHaveTextContent("API key");
  });

  it("states each group's billing mode as a pill, not as text after the name (D10)", async () => {
    // Plain tertiary text run on after the service name read as a qualifier of
    // the service. The mode is the other half of the pair a model is selected
    // by (req 5), so it gets its own pill — the same component Settings puts on
    // a service card. What the pill LOOKS like is `BillingModePill`'s own
    // contract and is pinned in its co-located test; what belongs here is that
    // each group gets one, carrying that group's mode.
    const user = userEvent.setup();
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));

    expect(screen.getByTestId("model-group-mode-sub")).toHaveTextContent("Subscription");
    expect(screen.getAllByTestId("model-group-mode-key")[0]).toHaveTextContent("API key");
  });

  it("draws each group's service mark beside its name", async () => {
    // The mark is the half of the header that can be recognised without
    // reading, and it is the same one Settings → Services draws — a model menu
    // that named the service differently from the card the credential lives on
    // would be two vocabularies for one thing. The NAME stays: the mark is a
    // second way to recognise a service, never the only one.
    const user = userEvent.setup();
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));

    // The mark's own 24×24 grid, not any `svg`: a header sits beside rows
    // carrying Phosphor checkmarks (256×256), so a bare svg query would pass
    // with the mark missing.
    const header = screen.getByTestId("model-group-mode-sub").parentElement;
    expect(header?.querySelector('svg[viewBox="0 0 24 24"]')).not.toBeNull();
    expect(header).toHaveTextContent("Anthropic");
  });

  it("hands the caller the whole triple, not a bare model id", async () => {
    // A bare id was ambiguous the moment two services could offer the same one:
    // the server would re-resolve it to whichever service sorts first, which is
    // the silent mis-billing req 11 exists to prevent.
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    render(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={null}
        onModelChange={onModelChange}
      />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    await user.click(screen.getByTestId("model-option-deepseek-v4-flash"));
    expect(onModelChange).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "deepseek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
      }),
    );
  });

  it("never puts the service or billing mode on the trigger, even when the id is ambiguous (docs/260-composer-toolbar-layout req 18)", () => {
    // docs/252 put a disambiguating pill here, because a bare id cannot say who
    // is billing you. docs/260-composer-toolbar-layout req 18 removed it: it cost 80.5px in exactly the
    // state that was already pushing Send off the edge. The fact is still in the
    // MENU — the grouping and the checkmark — one tap away.
    setSessionState(
      makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "key" }),
    );
    const { unmount } = render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} hasActiveSession />,
    );
    expect(screen.queryByTestId("model-trigger-service")).toBeNull();
    expect(screen.getByTestId("model-trigger")).not.toHaveTextContent("API key");
    unmount();

    setSessionState(
      makeSession({ model: "deepseek-v4-flash", serviceId: "deepseek", billingMode: "key" }),
    );
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} hasActiveSession />,
    );
    expect(screen.queryByTestId("model-trigger-service")).toBeNull();
  });

  it("checks the row the session actually chose, not every row sharing the id", async () => {
    const user = userEvent.setup();
    setSessionState(
      makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "key" }),
    );
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} hasActiveSession />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    const rows = screen.getAllByTestId("model-option-claude-sonnet-5");
    const checked = rows.filter((r) => r.className.includes("color-accent-subtle"));
    expect(checked).toHaveLength(1);
  });

  it("lists the seeded harness's models, not the globally-active session's, when no session is bound", async () => {
    // The harness is the axis that selects the list, so the harness bug showed
    // up here as the wrong LIST: Quick Capture over a Codex session offered
    // Codex's models while creating a Claude session from the saved seed.
    const user = userEvent.setup();
    setSessionState(makeSession({ agentId: "codex", model: "gpt-5.6-sol" }));
    localStorage.setItem("vibe-agent-id", "claude");
    render(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={null}
        onModelChange={vi.fn()}
        seedFromHistory
      />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    expect(screen.getByTestId("model-dropdown")).toHaveTextContent("DeepSeek");
    expect(screen.queryByTestId("model-option-gpt-5.6-sol")).toBeNull();
  });

  it("ignores the background session's live model even when it runs the seeded harness", async () => {
    // Scoping `modelInfo` by AGENT is not enough with no session of its own:
    // Quick Capture is handed the background session's live model, and when that
    // session runs the seeded harness the id passes the agent check and outranks
    // the seed — so the overlay showed Sonnet while creating DeepSeek.
    setSessionState(makeSession({ agentId: "claude", model: "claude-sonnet-5" }));
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "deepseek:key:deepseek-v4-flash");
    render(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={{ model: "claude-sonnet-5" } as never}
        onModelChange={vi.fn()}
        seedFromHistory
      />,
    );
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4 Flash");
  });

  it("checks exactly one row when nothing has pinned a group yet", async () => {
    // A brand-new session with no saved pick: the model falls back to the first
    // row, so the group has to fall back the same way. Resolving only the model
    // is what the live UI showed — the trigger's pill naming one service while a
    // checkmark sat on every row sharing the id.
    const user = userEvent.setup();
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    const rows = screen.getAllByTestId("model-option-claude-sonnet-5");
    expect(rows.filter((r) => r.className.includes("color-accent-subtle"))).toHaveLength(1);
    expect(rows[0]!.className).toContain("color-accent-subtle");
  });

  it("drops a saved seed the displayed harness cannot run", () => {
    // The slot is global and the harness is not. Switching harness on the
    // new-session composer used to leave the trigger naming the PREVIOUS
    // harness's model — a model this one cannot run, and one the server has
    // already moved away from, so the composer contradicted its own notice.
    localStorage.setItem("vibe-model-id", "anthropic:sub:claude-sonnet-5");
    render(<ModelSelector agents={agents} activeAgentId="codex" modelInfo={null} />);
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("GPT-5.6 Sol");
  });

  it("still honours a saved seed the displayed harness does offer", () => {
    localStorage.setItem("vibe-model-id", "deepseek:key:deepseek-v4-flash");
    render(<ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} />);
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4 Flash");
  });

  it("falls back to one unnamed group when the payload predates eligibleModels", async () => {
    const user = userEvent.setup();
    const legacy: AgentOption[] = [{ ...agents[0], eligibleModels: undefined }];
    render(
      <ModelSelector agents={legacy} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    expect(screen.getByTestId("model-option-claude-sonnet-5")).toBeTruthy();
    expect(screen.getByTestId("model-option-deepseek-v4-flash")).toBeTruthy();
  });

  it("reflects a freshly picked model immediately, ahead of the last turn's report", async () => {
    const user = userEvent.setup();
    setSessionState(makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "sub" }));
    render(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={{ model: "claude-sonnet-5", contextWindowTokens: 1_000_000 }}
        hasActiveSession
        onModelChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    await user.click(screen.getByTestId("model-option-deepseek-v4-flash"));
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4 Flash");
  });

  it("moves the checkmark on a switch that changes only the billing group", async () => {
    // docs/252 phase 4 — the optimistic pick is the whole TRIPLE. A mid-session
    // switch across services (or across one service's two modes) routinely keeps
    // the model id, so an id-keyed pending pick showed no change at all: the
    // checkmark stayed on the group the user had just left until an unrelated
    // session-list refresh happened to arrive.
    const user = userEvent.setup();
    setSessionState(
      makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "sub" }),
    );
    render(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={null}
        hasActiveSession
        onModelChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    // Two rows share this id — the subscription first, the key second.
    const rows = screen.getAllByTestId("model-option-claude-sonnet-5");
    expect(rows[0]!.className).toContain("color-accent-subtle");
    await user.click(rows[1]!);

    // The checkmark is now the only visible half of this fact (req 18 dropped
    // the trigger pill), so the menu is where the group has to be observed.
    await user.click(screen.getByTestId("model-trigger"));
    const after = screen.getAllByTestId("model-option-claude-sonnet-5");
    expect(after[1]!.className).toContain("color-accent-subtle");
    expect(after[0]!.className).not.toContain("color-accent-subtle");
  });

  it("really drops the optimistic pick once the row catches up, rather than lingering", async () => {
    // Asserting the pill before and after a MATCHING confirmation proves nothing
    // — it reads the same either way, so the test passes even if the pending
    // pick is never cleared (cross-backend review caught exactly that). The
    // honest check is to move the row somewhere the pending pick would mask,
    // and see the picker follow.
    const user = userEvent.setup();
    const render1 = (session: SessionInfo) => {
      setSessionState(session);
      return (
        <ModelSelector
          agents={agents}
          activeAgentId="claude"
          modelInfo={null}
          hasActiveSession
          onModelChange={vi.fn()}
        />
      );
    };
    const { rerender } = render(
      render1(makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "sub" })),
    );
    await user.click(screen.getByTestId("model-trigger"));
    await user.click(screen.getAllByTestId("model-option-claude-sonnet-5")[1]!);
    await user.click(screen.getByTestId("model-trigger"));
    expect(screen.getAllByTestId("model-option-claude-sonnet-5")[1]!.className)
      .toContain("color-accent-subtle");
    await user.keyboard("{Escape}");

    // The server confirms; the session row catches up with the whole triple.
    rerender(
      render1(makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "key" })),
    );
    // Now move the row to a DIFFERENT model. A pending pick that survived would
    // still be winning the precedence and the trigger would read "Sonnet 5".
    rerender(
      render1(makeSession({ model: "deepseek-v4-flash", serviceId: "deepseek", billingMode: "key" })),
    );
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4 Flash");
  });

  it("snaps back when the server REFUSES the pick and the row therefore never changes", async () => {
    // The pick that cannot clear itself: the server refused it, so the session
    // row is exactly what it was, and — because a cross-service pick keeps the
    // model id — nothing else on screen moves either. Without a separate "the
    // server answered" signal the trigger claims a service the session is not on
    // for as long as the tab stays open. Cross-backend review found this.
    const user = userEvent.setup();
    const session = makeSession({
      model: "claude-sonnet-5",
      serviceId: "anthropic",
      billingMode: "sub",
    });
    setSessionState(session);
    const view = (
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={null}
        hasActiveSession
        onModelChange={vi.fn()}
      />
    );
    const { rerender } = render(view);
    await user.click(screen.getByTestId("model-trigger"));
    await user.click(screen.getAllByTestId("model-option-claude-sonnet-5")[1]!);
    await user.click(screen.getByTestId("model-trigger"));
    expect(screen.getAllByTestId("model-option-claude-sonnet-5")[1]!.className)
      .toContain("color-accent-subtle");
    await user.keyboard("{Escape}");

    // The refusal: the row is untouched, and the only thing that arrives is the
    // server's answer.
    useSessionStore.getState().bumpModelSelectionEcho(session.id);
    rerender(view);
    await user.click(screen.getByTestId("model-trigger"));
    expect(screen.getAllByTestId("model-option-claude-sonnet-5")[0]!.className)
      .toContain("color-accent-subtle");
  });
});
