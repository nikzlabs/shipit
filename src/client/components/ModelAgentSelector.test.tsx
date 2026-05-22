import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModelAgentSelector } from "./ModelAgentSelector.js";
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
    models: ["sonnet", "opus", "haiku"],
    supportsReview: true,
    supportedPermissionModes: ["auto", "plan", "guarded"],
  },
  {
    id: "codex",
    name: "Codex",
    installed: true,
    authConfigured: true,
    models: ["gpt-5.5", "gpt-5.4"],
    supportsReview: false,
    supportedPermissionModes: [],
  },
];

const sonnet = { model: "sonnet", contextWindowTokens: 200000 };

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "s1",
    title: "Test",
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    remoteUrl: "https://github.com/example/repo.git",
    ...overrides,
  };
}

function setSessionState(session: SessionInfo | undefined) {
  useSessionStore.setState({
    sessionId: session?.id,
    sessions: session ? [session] : [],
  });
}

beforeEach(() => {
  setSessionState(undefined);
});

describe("ModelAgentSelector — mid-session model picking", () => {
  it("opens the dropdown when no session has been pinned yet", async () => {
    const user = userEvent.setup();
    render(
      <ModelAgentSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        modelInfo={sonnet}
        hasActiveSession={false}
      />,
    );
    await user.click(screen.getByTestId("model-agent-trigger"));
    expect(screen.getByTestId("model-option-sonnet")).toBeInTheDocument();
    expect(screen.getByTestId("model-option-opus")).toBeInTheDocument();
    expect(screen.getByTestId("model-option-gpt-5.5")).toBeInTheDocument();
  });

  it("still opens after the session is active (regression: used to be disabled)", async () => {
    setSessionState(makeSession({ id: "s1", model: "sonnet", agentId: "claude", agentPinned: true }));
    const user = userEvent.setup();
    render(
      <ModelAgentSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        modelInfo={sonnet}
        hasActiveSession={true}
      />,
    );
    const trigger = screen.getByTestId("model-agent-trigger");
    expect(trigger).not.toBeDisabled();
    await user.click(trigger);
    // The picker is open: a model option from the pinned agent is visible.
    expect(screen.getByTestId("model-option-opus")).toBeInTheDocument();
  });

  it("disables models from the locked agent once the session has pinned an agent", async () => {
    setSessionState(makeSession({ id: "s1", model: "sonnet", agentId: "claude", agentPinned: true }));
    const user = userEvent.setup();
    render(
      <ModelAgentSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        modelInfo={sonnet}
        hasActiveSession={true}
      />,
    );
    await user.click(screen.getByTestId("model-agent-trigger"));
    // Claude rows: enabled (same agent as the pinned one) — Radix omits the
    // aria-disabled attribute on enabled items rather than setting "false".
    expect(screen.getByTestId("model-option-opus")).not.toHaveAttribute("aria-disabled", "true");
    // Codex rows: disabled (other agent — locked).
    expect(screen.getByTestId("model-option-gpt-5.5")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("model-option-gpt-5.4")).toHaveAttribute("aria-disabled", "true");
  });

  it("picking a model in the pinned agent emits onModelChange but NOT onAgentChange", async () => {
    setSessionState(makeSession({ id: "s1", model: "sonnet", agentId: "claude", agentPinned: true }));
    const onAgentChange = vi.fn();
    const onModelChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelAgentSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={onAgentChange}
        onModelChange={onModelChange}
        modelInfo={sonnet}
        hasActiveSession={true}
      />,
    );
    await user.click(screen.getByTestId("model-agent-trigger"));
    await user.click(screen.getByTestId("model-option-opus"));
    expect(onModelChange).toHaveBeenCalledWith("opus");
    // Agent must not move — it's pinned. Defends docs/138 from the client side.
    expect(onAgentChange).not.toHaveBeenCalled();
  });

  it("picking a model pre-pin still emits both onAgentChange and onModelChange", async () => {
    // No session — pre-pin grouped picker should switch agent + model atomically.
    const onAgentChange = vi.fn();
    const onModelChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ModelAgentSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={onAgentChange}
        onModelChange={onModelChange}
        modelInfo={null}
        hasActiveSession={false}
      />,
    );
    await user.click(screen.getByTestId("model-agent-trigger"));
    await user.click(screen.getByTestId("model-option-gpt-5.5"));
    expect(onAgentChange).toHaveBeenCalledWith("codex");
    expect(onModelChange).toHaveBeenCalledWith("gpt-5.5");
  });

  it("trigger reflects a freshly picked model immediately (pending wins over the last turn's report)", async () => {
    // Session is on sonnet (last turn's resolved model). User picks opus
    // mid-session — the trigger label should update right away, not wait for
    // the next turn's agent_init.
    setSessionState(makeSession({ id: "s1", model: "sonnet", agentId: "claude", agentPinned: true }));
    const user = userEvent.setup();
    render(
      <ModelAgentSelector
        agents={agents}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        modelInfo={sonnet}
        hasActiveSession={true}
      />,
    );
    await user.click(screen.getByTestId("model-agent-trigger"));
    await user.click(screen.getByTestId("model-option-opus"));
    expect(screen.getByTestId("model-agent-trigger")).toHaveTextContent(/opus/i);
  });
});
