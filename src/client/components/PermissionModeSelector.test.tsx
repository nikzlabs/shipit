import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PermissionModeSelector } from "./PermissionModeSelector.js";
import type { AgentOption } from "../agent-types.js";

afterEach(cleanup);

const claudeAll: AgentOption[] = [
  {
    id: "claude", name: "Claude Code", installed: true, authConfigured: true,
    models: ["sonnet"], supportsReview: true,
    supportedPermissionModes: ["auto", "plan", "guarded"],
  },
];

const sonnet = { model: "sonnet", contextWindowTokens: 200000 };
const haiku = { model: "haiku", contextWindowTokens: 200000 };

describe("PermissionModeSelector", () => {
  it("renders the trigger when the agent supports more than auto", () => {
    render(
      <PermissionModeSelector mode="auto" onChange={vi.fn()} agents={claudeAll} activeAgentId="claude" modelInfo={sonnet} />,
    );
    expect(screen.getByTestId("permission-mode-selector")).toBeInTheDocument();
  });

  it("hides entirely for an agent that advertises no permission modes (Codex)", () => {
    const codex: AgentOption[] = [
      { id: "codex", name: "Codex", installed: true, authConfigured: true, models: ["gpt-5"], supportsReview: false, supportedPermissionModes: [] },
    ];
    render(
      <PermissionModeSelector mode="auto" onChange={vi.fn()} agents={codex} activeAgentId="codex" modelInfo={null} />,
    );
    expect(screen.queryByTestId("permission-mode-selector")).not.toBeInTheDocument();
  });

  it("shows the mode label on the trigger when not in auto", () => {
    render(
      <PermissionModeSelector mode="guarded" onChange={vi.fn()} agents={claudeAll} activeAgentId="claude" modelInfo={sonnet} />,
    );
    expect(screen.getByTestId("permission-mode-selector")).toHaveTextContent("Guarded mode");
  });

  it("offers plan, guarded, and auto in the menu", async () => {
    const user = userEvent.setup();
    render(
      <PermissionModeSelector mode="auto" onChange={vi.fn()} agents={claudeAll} activeAgentId="claude" modelInfo={sonnet} />,
    );
    await user.click(screen.getByTestId("permission-mode-selector"));
    expect(screen.getByTestId("permission-mode-option-plan")).toBeInTheDocument();
    expect(screen.getByTestId("permission-mode-option-guarded")).toBeInTheDocument();
    expect(screen.getByTestId("permission-mode-option-auto")).toBeInTheDocument();
  });

  it("calls onChange when a mode is selected", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PermissionModeSelector mode="auto" onChange={onChange} agents={claudeAll} activeAgentId="claude" modelInfo={sonnet} />,
    );
    await user.click(screen.getByTestId("permission-mode-selector"));
    await user.click(screen.getByTestId("permission-mode-option-guarded"));
    expect(onChange).toHaveBeenCalledWith("guarded");
  });

  it("disables guarded and does not call onChange when the model is Haiku", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PermissionModeSelector mode="auto" onChange={onChange} agents={claudeAll} activeAgentId="claude" modelInfo={haiku} />,
    );
    await user.click(screen.getByTestId("permission-mode-selector"));
    const guarded = screen.getByTestId("permission-mode-option-guarded");
    expect(guarded).toHaveAttribute("aria-disabled", "true");
    await user.click(guarded);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("only offers plan + auto when the agent doesn't support guarded", async () => {
    const user = userEvent.setup();
    const claudePlanOnly: AgentOption[] = [
      { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["sonnet"], supportsReview: true, supportedPermissionModes: ["auto", "plan"] },
    ];
    render(
      <PermissionModeSelector mode="auto" onChange={vi.fn()} agents={claudePlanOnly} activeAgentId="claude" modelInfo={sonnet} />,
    );
    await user.click(screen.getByTestId("permission-mode-selector"));
    expect(screen.getByTestId("permission-mode-option-plan")).toBeInTheDocument();
    expect(screen.queryByTestId("permission-mode-option-guarded")).not.toBeInTheDocument();
  });
});
