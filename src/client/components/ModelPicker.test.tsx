import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
    authConfigured: true,
    models: ["claude-sonnet-5", "deepseek-v4-flash"],
    eligibleModels: [
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "sub",
        modelId: "claude-sonnet-5",
        label: "Sonnet 5",
      },
      {
        serviceId: "anthropic",
        serviceName: "Anthropic",
        billingMode: "key",
        modelId: "claude-sonnet-5",
        label: "Sonnet 5",
      },
      {
        serviceId: "deepseek",
        serviceName: "DeepSeek",
        billingMode: "key",
        modelId: "deepseek-v4-flash",
        label: "V4 Flash",
      },
    ],
    supportsReview: true,
    supportedPermissionModes: ["auto", "plan", "guarded"],
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    authConfigured: true,
    models: ["gpt-5.6-sol"],
    eligibleModels: [
      {
        serviceId: "openai",
        serviceName: "OpenAI",
        billingMode: "sub",
        modelId: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
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

beforeEach(() => {
  localStorage.removeItem("vibe-model-id");
  setSessionState(undefined);
});

describe("HarnessSelector", () => {
  it("lists installed harnesses with their model counts", async () => {
    const user = userEvent.setup();
    render(
      <HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />,
    );
    await user.click(screen.getByTestId("harness-trigger"));
    expect(screen.getByTestId("harness-option-claude")).toHaveTextContent("3 models");
    expect(screen.getByTestId("harness-option-codex")).toHaveTextContent("1 model");
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

  it("does NOT lock in a new-session picker even when a background session is pinned (docs/166)", () => {
    setSessionState(makeSession({ agentId: "claude", agentPinned: true }));
    render(
      <HarnessSelector agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />,
    );
    expect(screen.getByTestId("harness-trigger")).not.toBeDisabled();
  });
});

describe("ModelSelector", () => {
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

  it("shows the disambiguating pill only when the model id is genuinely ambiguous", () => {
    // `claude-sonnet-5` is offered by two modes of one service, so the pill
    // names the MODE. `deepseek-v4-flash` is offered once, so there is nothing
    // to disclose and no pill.
    setSessionState(
      makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "key" }),
    );
    const { unmount } = render(
      <ModelSelector agents={agents} activeAgentId="claude" modelInfo={null} hasActiveSession />,
    );
    expect(screen.getByTestId("model-trigger-service")).toHaveTextContent("API key");
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

    // The trigger's disambiguating pill is the visible half of the same fact.
    expect(screen.getByTestId("model-trigger-service")).toHaveTextContent("API key");
    await user.click(screen.getByTestId("model-trigger"));
    const after = screen.getAllByTestId("model-option-claude-sonnet-5");
    expect(after[1]!.className).toContain("color-accent-subtle");
    expect(after[0]!.className).not.toContain("color-accent-subtle");
  });

  it("drops the optimistic pick only once the session row matches the whole triple", async () => {
    // The complement: clearing on the model id alone would snap the checkmark
    // back to the old group the instant the server confirmed the (unchanged)
    // model, which is the same bug seen from the other side.
    const user = userEvent.setup();
    setSessionState(
      makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "sub" }),
    );
    const { rerender } = render(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={null}
        hasActiveSession
        onModelChange={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("model-trigger"));
    await user.click(screen.getAllByTestId("model-option-claude-sonnet-5")[1]!);
    expect(screen.getByTestId("model-trigger-service")).toHaveTextContent("API key");

    // The server confirms; the session row catches up with the whole triple.
    setSessionState(
      makeSession({ model: "claude-sonnet-5", serviceId: "anthropic", billingMode: "key" }),
    );
    rerender(
      <ModelSelector
        agents={agents}
        activeAgentId="claude"
        modelInfo={null}
        hasActiveSession
        onModelChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("model-trigger-service")).toHaveTextContent("API key");
  });
});
