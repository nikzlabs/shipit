import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PermissionModeSelector, type NetworkSectionProps } from "./PermissionModeSelector.js";
import type { AgentOption } from "../agent-types.js";

afterEach(cleanup);

const claudeAll: AgentOption[] = [
  {
    id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true,
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
      { id: "codex", name: "Codex", installed: true, hasRunnableModels: true, models: ["gpt-5"], supportsReview: false, supportedPermissionModes: [] },
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
    // docs/260-composer-toolbar-layout req 17 — the badge names the mode alone; "mode" was 34px of nothing.
    expect(screen.getByTestId("permission-mode-selector")).toHaveTextContent("Guarded");
    expect(screen.getByTestId("permission-mode-selector")).not.toHaveTextContent("Guarded mode");
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
      { id: "claude", name: "Claude Code", installed: true, hasRunnableModels: true, models: ["sonnet"], supportsReview: true, supportedPermissionModes: ["auto", "plan"] },
    ];
    render(
      <PermissionModeSelector mode="auto" onChange={vi.fn()} agents={claudePlanOnly} activeAgentId="claude" modelInfo={sonnet} />,
    );
    await user.click(screen.getByTestId("permission-mode-selector"));
    expect(screen.getByTestId("permission-mode-option-plan")).toBeInTheDocument();
    expect(screen.queryByTestId("permission-mode-option-guarded")).not.toBeInTheDocument();
  });
});

/**
 * docs/285 — the control's second job. Network containment shares this menu
 * rather than taking a pill of its own in the composer row (reqs 5, 6).
 */
describe("PermissionModeSelector — the Network section (docs/285)", () => {
  const network = (over: Partial<NetworkSectionProps> = {}): NetworkSectionProps => ({
    mode: "inherit",
    onChange: vi.fn(),
    globalEnabled: true,
    enforcementStatus: "active",
    pendingRestart: false,
    beforeFirstTurn: true,
    loaded: true,
    ...over,
  });

  const renderWith = (n: NetworkSectionProps, agents = claudeAll, agentId: "claude" | "codex" = "claude") =>
    render(
      <PermissionModeSelector
        mode="auto"
        onChange={vi.fn()}
        agents={agents}
        activeAgentId={agentId}
        modelInfo={sonnet}
        network={n}
      />,
    );

  it("offers both settings in ONE flat menu — no drill-down (reqs 5, 6)", async () => {
    const user = userEvent.setup();
    renderWith(network());
    await user.click(screen.getByTestId("permission-mode-selector"));
    // Both sections are reachable in a single open, which is the whole shape:
    // a setting reached this rarely should not also cost a navigation step.
    expect(screen.getByTestId("permission-mode-option-plan")).toBeInTheDocument();
    expect(screen.getByTestId("network-mode-option-contained")).toBeInTheDocument();
  });

  it("keeps the control for a harness with one permission mode, for the network alone", () => {
    const codex: AgentOption[] = [
      { id: "codex", name: "Codex", installed: true, hasRunnableModels: true, models: ["gpt-5"], supportsReview: false, supportedPermissionModes: [] },
    ];
    // Without a network section this control hides for Codex (asserted above).
    // With one it must not, or picking the harness would take the session's
    // network setting away as a side effect.
    renderWith(network(), codex, "codex");
    expect(screen.getByTestId("permission-mode-selector")).toBeInTheDocument();
  });

  it("names what Inherit currently resolves to, without presenting it as pinned (req 10)", async () => {
    const user = userEvent.setup();
    renderWith(network({ globalEnabled: false }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    expect(screen.getByTestId("network-mode-option-inherit")).toHaveTextContent(/currently Open/i);
  });

  it("states the effective mode on the trigger in BOTH states, and says an explicit pick overrides (req 10)", () => {
    // The common state has to be readable too, and there is no hover on touch —
    // so the accessible name carries it rather than a tint.
    const { unmount } = renderWith(network());
    expect(screen.getByTestId("permission-mode-selector")).toHaveAccessibleName(
      /inheriting the workspace setting \(currently Contained\)/i,
    );
    unmount();

    renderWith(network({ mode: "open" }));
    const trigger = screen.getByTestId("permission-mode-selector");
    // "Open" alone would not say the choice is PINNED, which is the part req 10
    // asks to be stated and exactly what a colour cannot carry.
    expect(trigger).toHaveAccessibleName(/Open, overriding the workspace setting/i);
    expect(trigger).toHaveTextContent("Open");
  });

  it("leaves the trigger unworded while the network is inherited", () => {
    renderWith(network());
    const trigger = screen.getByTestId("permission-mode-selector");
    expect(trigger).not.toHaveTextContent(/Inherit|Contained|Open/);
  });

  it("names the ENFORCEMENT-OFF case and its remediation — not a fail-to-start claim", async () => {
    const user = userEvent.setup();
    renderWith(network({ mode: "contained", enforcementStatus: "disabled" }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    const warning = screen.getByTestId("network-enforcement-warning");
    // The two inactive deployments have OPPOSITE consequences. This one starts
    // the session and runs it open; saying it "will not start" is the other case.
    expect(warning).toHaveTextContent(/still runs with open network access/i);
    expect(warning).toHaveTextContent(/SESSION_EGRESS_ENFORCE=0/);
    expect(warning).not.toHaveTextContent(/will not start/i);
  });

  it("names the MISSING-SIDECAR case as fail-to-start", async () => {
    const user = userEvent.setup();
    renderWith(network({ mode: "contained", enforcementStatus: "no-sidecar" }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    const warning = screen.getByTestId("network-enforcement-warning");
    expect(warning).toHaveTextContent(/will not start/i);
    expect(warning).toHaveTextContent(/SESSION_EGRESS_SIDECAR_IMAGE/);
  });

  it("says nothing about enforcement while the session resolves to Open", async () => {
    const user = userEvent.setup();
    // Open is not claiming protection, so there is no gap between claim and
    // reality to report — even on a deployment that cannot enforce.
    renderWith(network({ mode: "open", enforcementStatus: "disabled" }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    expect(screen.queryByTestId("network-enforcement-warning")).not.toBeInTheDocument();
  });

  it("promises the first TURN, not the session's setup (req 11)", async () => {
    const user = userEvent.setup();
    renderWith(network({ beforeFirstTurn: true }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    const note = screen.getByTestId("network-mode-first-turn-note");
    expect(note).toHaveTextContent(/In force from this session.s first turn/i);
    // A trusted repo's `agent.install` may already have run in the warm
    // container under the workspace default — stated rather than left implied.
    expect(note).toHaveTextContent(/Setup that has already run/i);
  });

  it("reports a pending restart on a running session, and only when the server says so", async () => {
    const user = userEvent.setup();
    const { unmount } = renderWith(network({ beforeFirstTurn: false, pendingRestart: true }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    expect(screen.getByTestId("network-mode-pending-note")).toBeInTheDocument();
    unmount();

    // `pendingRestart` is the server's verdict about the LIVE container, not a
    // re-derivation from "the mode is non-default": a session already started in
    // the resolved containment has nothing pending.
    renderWith(network({ beforeFirstTurn: false, pendingRestart: false, mode: "contained" }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    expect(screen.queryByTestId("network-mode-pending-note")).not.toBeInTheDocument();
  });

  it("changes the network mode", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWith(network({ onChange }));
    await user.click(screen.getByTestId("permission-mode-selector"));
    await user.click(screen.getByTestId("network-mode-option-open"));
    expect(onChange).toHaveBeenCalledWith("open");
  });
});
