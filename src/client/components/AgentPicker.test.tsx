import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { AgentPicker, type AgentOption } from "./AgentPicker.js";

afterEach(cleanup);

const agents: AgentOption[] = [
  { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet-4"] },
  { id: "codex", name: "Codex", installed: true, authConfigured: true, models: ["o4-mini"] },
];

describe("AgentPicker", () => {
  it("renders the trigger button with the active agent name", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    expect(screen.getByTestId("agent-picker-trigger")).toHaveTextContent("Claude Code");
  });

  it("does not render when there are no agents", () => {
    render(<AgentPicker agents={[]} activeAgentId="claude" onAgentChange={vi.fn()} />);
    expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
  });

  it("does not render when only one agent is installed", () => {
    const singleAgent: AgentOption[] = [
      { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: [] },
      { id: "codex", name: "Codex", installed: false, authConfigured: false, models: [] },
    ];
    render(<AgentPicker agents={singleAgent} activeAgentId="claude" onAgentChange={vi.fn()} />);
    expect(screen.queryByTestId("agent-picker")).not.toBeInTheDocument();
  });

  it("opens the dropdown when clicked", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    expect(screen.queryByTestId("agent-picker-dropdown")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    expect(screen.getByTestId("agent-picker-dropdown")).toBeInTheDocument();
  });

  it("shows all agents in the dropdown", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    expect(screen.getByTestId("agent-option-claude")).toBeInTheDocument();
    expect(screen.getByTestId("agent-option-codex")).toBeInTheDocument();
  });

  it("calls onAgentChange when an available agent is selected", () => {
    const onAgentChange = vi.fn();
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={onAgentChange} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    fireEvent.click(screen.getByTestId("agent-option-codex"));
    expect(onAgentChange).toHaveBeenCalledWith("codex");
  });

  it("closes the dropdown after selecting an agent", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    fireEvent.click(screen.getByTestId("agent-option-codex"));
    expect(screen.queryByTestId("agent-picker-dropdown")).not.toBeInTheDocument();
  });

  it("does not call onAgentChange for uninstalled agents", () => {
    const agentsWithUninstalled: AgentOption[] = [
      { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: [] },
      { id: "codex", name: "Codex", installed: true, authConfigured: true, models: [] },
      { id: "other", name: "Other", installed: false, authConfigured: false, models: [] },
    ];
    const onAgentChange = vi.fn();
    render(<AgentPicker agents={agentsWithUninstalled} activeAgentId="claude" onAgentChange={onAgentChange} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    fireEvent.click(screen.getByTestId("agent-option-other"));
    expect(onAgentChange).not.toHaveBeenCalled();
  });

  it("shows 'not installed' label for uninstalled agents", () => {
    const agentsWithUninstalled: AgentOption[] = [
      { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: [] },
      { id: "codex", name: "Codex", installed: true, authConfigured: true, models: [] },
      { id: "other", name: "Other", installed: false, authConfigured: false, models: [] },
    ];
    render(<AgentPicker agents={agentsWithUninstalled} activeAgentId="claude" onAgentChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    expect(screen.getByTestId("agent-option-other")).toHaveTextContent("not installed");
  });

  it("shows 'needs auth' label for installed but unconfigured agents", () => {
    const agentsNeedAuth: AgentOption[] = [
      { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: [] },
      { id: "codex", name: "Codex", installed: true, authConfigured: false, models: [] },
    ];
    render(<AgentPicker agents={agentsNeedAuth} activeAgentId="claude" onAgentChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    expect(screen.getByTestId("agent-option-codex")).toHaveTextContent("needs auth");
  });

  it("shows a checkmark next to the active agent", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    // The active agent option should contain an SVG checkmark
    const activeOption = screen.getByTestId("agent-option-claude");
    expect(activeOption.querySelector("svg")).not.toBeNull();
    // Non-active available agent should not have a checkmark
    const codexOption = screen.getByTestId("agent-option-codex");
    expect(codexOption.querySelector("svg")).toBeNull();
  });

  it("disables the trigger button when disabled prop is true", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} disabled />);
    expect(screen.getByTestId("agent-picker-trigger")).toBeDisabled();
  });

  it("closes the dropdown on Escape key", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    expect(screen.getByTestId("agent-picker-dropdown")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("agent-picker-dropdown")).not.toBeInTheDocument();
  });

  it("closes the dropdown on outside click", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(screen.getByTestId("agent-picker-trigger"));
    expect(screen.getByTestId("agent-picker-dropdown")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("agent-picker-dropdown")).not.toBeInTheDocument();
  });

  it("shows green status dot for ready agents", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    // Trigger button should have a green dot
    const trigger = screen.getByTestId("agent-picker-trigger");
    expect(trigger.querySelector("[data-testid='status-dot-ready']")).not.toBeNull();
  });

  it("has correct aria-expanded attribute", () => {
    render(<AgentPicker agents={agents} activeAgentId="claude" onAgentChange={vi.fn()} />);
    const trigger = screen.getByTestId("agent-picker-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });
});
