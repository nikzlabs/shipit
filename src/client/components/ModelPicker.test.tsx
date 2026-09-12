import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarnessSelector, ModelSelector } from "./ModelPicker.js";
import { useSessionStore } from "../stores/session-store.js";
import type { AgentOption } from "../agent-types.js";
import type { SessionInfo } from "../../server/shared/types.js";
import { queryServiceMark } from "./service-mark.testing.js";

afterEach(cleanup);

const agents: AgentOption[] = [
  {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: true,
    models: ["claude-sonnet-5", "deepseek-flash"],
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
        modelId: "deepseek-flash",
        label: "V4.1 Flash",
        canonicalModelKey: "deepseek-v4.1-flash",
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

  it("opens no menu once pinned, and stays legible while it says so", async () => {

    const user = userEvent.setup();
    setSessionState(makeSession({ agentId: "claude", agentPinned: true }));
    render(
      <HarnessSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        hasActiveSession
      />,
    );

    await user.click(screen.getByTestId("harness-trigger"));

    expect(screen.queryByTestId("harness-dropdown")).toBeNull();
    expect(screen.queryByTestId("harness-option-codex")).toBeNull();
    expect(screen.getByTestId("harness-trigger").className).not.toContain("opacity-50");
  });

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

    // `vibe-agent-id` must not out-vote it (docs/142 Problem C). Displaying the

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

    // over its socket) but `SessionManager.list` filters `warm = 0`, so it never
    // appears in `sessions` — the composer has a session it cannot see, and the

    // the seed cannot when the saved model belongs to the other harness. Keeping

    useSessionStore.setState({ sessionId: "warm-1", sessions: [] });
    localStorage.setItem("vibe-agent-id", "claude");
    render(
      <HarnessSelector agents={agents} activeAgentId="codex" onAgentChange={vi.fn()} />,
    );
    expect(screen.getByTestId("harness-trigger")).toHaveTextContent("Codex");
  });

  it("still follows the bound session's harness when there IS one", () => {

    // harness stays authoritative — this is the case `seedFromHistory` must not

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

    const user = userEvent.setup();
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));

    expect(screen.getByTestId("model-group-mode-sub")).toHaveTextContent("Subscription");
    expect(screen.getAllByTestId("model-group-mode-key")[0]).toHaveTextContent("API key");
  });

  it("draws each group's service mark beside its name", async () => {

    // second way to recognise a service, never the only one.
    const user = userEvent.setup();
    render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));

    const header = screen.getByTestId("model-group-mode-sub").parentElement;
    expect(header && queryServiceMark(header)).not.toBeNull();
    expect(header).toHaveTextContent("Anthropic");
  });

  it("hands the caller the whole triple, not a bare model id", async () => {

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
    await user.click(screen.getByTestId("model-option-deepseek-flash"));
    expect(onModelChange).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "deepseek",
        billingMode: "key",
        modelId: "deepseek-flash",
      }),
    );
  });

  it("never puts the service or billing mode on the trigger, even when the id is ambiguous (docs/260-composer-toolbar-layout req 18)", () => {
    // docs/252 put a disambiguating pill here, because a bare id cannot say who

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
      makeSession({ model: "deepseek-flash", serviceId: "deepseek", billingMode: "key" }),
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

    setSessionState(makeSession({ agentId: "claude", model: "claude-sonnet-5" }));
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem("vibe-model-id", "deepseek:key:deepseek-flash");
    render(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={{ model: "claude-sonnet-5" } as never}
        onModelChange={vi.fn()}
        seedFromHistory
      />,
    );
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4.1 Flash");
  });

  it("checks exactly one row when nothing has pinned a group yet", async () => {

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

    // harness's model — a model this one cannot run, and one the server has

    localStorage.setItem("vibe-model-id", "anthropic:sub:claude-sonnet-5");
    render(<ModelSelector agents={agents} activeAgentId="codex" modelInfo={null} />);
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("GPT-5.6 Sol");
  });

  it("still honours a saved seed the displayed harness does offer", () => {
    localStorage.setItem("vibe-model-id", "deepseek:key:deepseek-flash");
    render(<ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} />);
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4.1 Flash");
  });

  it("falls back to one unnamed group when the payload predates eligibleModels", async () => {
    const user = userEvent.setup();
    const legacy: AgentOption[] = [{ ...agents[0], eligibleModels: undefined }];
    render(
      <ModelSelector agents={legacy} activeAgentId="claude" modelInfo={null} onModelChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    expect(screen.getByTestId("model-option-claude-sonnet-5")).toBeTruthy();
    expect(screen.getByTestId("model-option-deepseek-flash")).toBeTruthy();
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
    await user.click(screen.getByTestId("model-option-deepseek-flash"));
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4.1 Flash");
  });

  it("moves the checkmark on a switch that changes only the billing group", async () => {

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

    const rows = screen.getAllByTestId("model-option-claude-sonnet-5");
    expect(rows[0]!.className).toContain("color-accent-subtle");
    await user.click(rows[1]!);

    await user.click(screen.getByTestId("model-trigger"));
    const after = screen.getAllByTestId("model-option-claude-sonnet-5");
    expect(after[1]!.className).toContain("color-accent-subtle");
    expect(after[0]!.className).not.toContain("color-accent-subtle");
  });

  it("really drops the optimistic pick once the row catches up, rather than lingering", async () => {

    // pick is never cleared (cross-backend review caught exactly that). The

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

    rerender(
      render1(makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "key" })),
    );

    rerender(
      render1(makeSession({ model: "deepseek-flash", serviceId: "deepseek", billingMode: "key" })),
    );
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("V4.1 Flash");
  });

  it("snaps back when the server REFUSES the pick and the row therefore never changes", async () => {
    // The pick that cannot clear itself: the server refused it, so the session
    // row is exactly what it was, and — because a cross-service pick keeps the

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

    useSessionStore.getState().bumpModelSelectionEcho(session.id);
    rerender(view);
    await user.click(screen.getByTestId("model-trigger"));
    expect(screen.getAllByTestId("model-option-claude-sonnet-5")[0]!.className)
      .toContain("color-accent-subtle");
  });
});
