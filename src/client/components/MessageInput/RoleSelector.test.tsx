import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RoleSelector, useRolePickerState } from "./RoleSelector.js";
import { ComposerSettingsMenu } from "./ComposerSettingsMenu.js";
import { MessageInput } from "./MessageInput.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { AgentOption } from "../../agent-types.js";
import type { RoleView } from "../../../server/shared/types/agent-types.js";

/**
 * docs/272-user-selectable-roles — the composer's role control, in both layouts.
 *
 * The three things this covers are the three the design turns on: the control is
 * absent until the user has a role (req 16), the reviewer is never offered
 * (req 10), and a role that cannot run is **shown with its reason** rather than
 * hidden (req 9) — a role the user configured vanishing reads as a fault in
 * ShipIt.
 */

const REVIEWER: RoleView = {
  name: "reviewer",
  params: { kind: "auto" },
  reserved: true,
};

function pinnedRole(over: Partial<RoleView> & { name: string }): RoleView {
  return {
    params: {
      kind: "pinned",
      harnessId: "claude",
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
    },
    reserved: false,
    resolved: {
      harnessId: "claude",
      harnessName: "Claude Code",
      serviceId: "anthropic",
      billingMode: "sub",
      serviceName: "Anthropic",
      modelId: "claude-opus-5",
      label: "Opus 5",
      reasoningEffort: "high",
    },
    ...over,
  };
}

const DEEP_DIVE = pinnedRole({ name: "deep dive", description: "Long-form investigation" });

function setRoles(roles: RoleView[]) {
  useSettingsStore.setState({ roles } as never);
}

afterEach(() => {
  cleanup();
  setRoles([]);
});

describe("useRolePickerState", () => {
  function Probe() {
    const { roles, hasRoles } = useRolePickerState();
    return <span data-testid="probe">{`${hasRoles}:${roles.map((r) => r.name).join(",")}`}</span>;
  }

  it("does not count the reviewer as 'the user has a role' (reqs 10, 16)", () => {
    // The reviewer is on every install, including one where nobody configured
    // anything — counting it would make req 16 permanently true.
    setRoles([REVIEWER]);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("false:");
  });

  it("offers the user's own roles and filters the reviewer out", () => {
    setRoles([REVIEWER, DEEP_DIVE]);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("true:deep dive");
  });
});

describe("RoleSelector (wide row)", () => {
  it("renders nothing when the user has no roles (req 16)", () => {
    render(<RoleSelector roles={[]} onSelectRole={vi.fn()} />);
    expect(screen.queryByTestId("role-selector-trigger")).toBeNull();
  });

  it("is the mark alone with no role selected — no label to learn here (req 16)", () => {
    render(<RoleSelector roles={[DEEP_DIVE]} onSelectRole={vi.fn()} />);
    const trigger = screen.getByTestId("role-selector-trigger");
    // The word "Role" is deliberately absent: the mark is learned in Settings,
    // where roles are created and it appears with its name.
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Choose a role");
  });

  it("shows the role's NAME once one is in force (req 5)", () => {
    render(
      <RoleSelector roles={[DEEP_DIVE]} selectedRole="deep dive" onSelectRole={vi.fn()} />,
    );
    expect(screen.getByTestId("role-selector-trigger")).toHaveTextContent("deep dive");
  });

  it("opens the LIST of roles, like every other control in the row (req 14)", async () => {
    const onSelectRole = vi.fn();
    render(
      <RoleSelector
        roles={[DEEP_DIVE, pinnedRole({ name: "triage" })]}
        selectedRole="deep dive"
        onSelectRole={onSelectRole}
      />,
    );
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    await userEvent.click(screen.getByTestId("role-option-triage"));
    expect(onSelectRole).toHaveBeenCalledWith("triage");
  });

  it("shows an unrunnable role with its reason instead of hiding it (req 9)", async () => {
    render(
      <RoleSelector
        roles={[pinnedRole({ name: "offline", unavailableReason: "disconnected" })]}
        onSelectRole={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    const row = screen.getByTestId("role-option-offline");
    expect(row).toHaveTextContent("Its service is disconnected");
    expect(row).toHaveAttribute("aria-disabled", "true");
  });

  it("offers the parameters from INSIDE the list, not as a second control (req 15)", async () => {
    const onAdjustParameters = vi.fn();
    render(
      <RoleSelector
        roles={[DEEP_DIVE]}
        selectedRole="deep dive"
        onSelectRole={vi.fn()}
        onAdjustParameters={onAdjustParameters}
      />,
    );
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    // …and there is no "no role" entry to leave by (req 15).
    expect(screen.queryByText(/no role/i)).toBeNull();
    await userEvent.click(screen.getByTestId("role-adjust-parameters"));
    expect(onAdjustParameters).toHaveBeenCalled();
  });
});

// ---- The narrow layout (docs/260's one menu) --------------------------------

const claude: AgentOption = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  hasRunnableModels: true,
  models: ["claude-opus-5"],
  eligibleModels: [
    {
      serviceId: "anthropic",
      serviceName: "Anthropic",
      billingMode: "sub",
      modelId: "claude-opus-5",
      label: "Opus 5",
      canonicalModelKey: "claude-opus-5",
    },
  ],
  supportsReview: true,
  supportedPermissionModes: ["plan", "guarded", "auto"],
  reasoning: { label: "Reasoning", options: [{ value: "high", label: "High" }] },
};

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function renderMenu(props: Partial<React.ComponentProps<typeof ComposerSettingsMenu>> = {}) {
  return render(
    <ComposerSettingsMenu
      agents={[claude]}
      activeAgentId="claude"
      onAgentChange={vi.fn()}
      onModelChange={vi.fn()}
      onReasoningChange={vi.fn()}
      modelInfo={null}
      hasActiveSession
      permissionMode="auto"
      onPermissionModeChange={vi.fn()}
      {...props}
    />,
  );
}

describe("the composer before a session is active (docs/272 reqs 5, 12)", () => {
  afterEach(() => {
    localStorage.removeItem("shipit-role-name");
  });

  it("names the role from the SEED, because there is no session row to read", () => {
    // This is the bug this test exists for. `/{repo}/new` sits on a WARM
    // session, and `SessionManager.list()` filters `warm = 0` — so the browser
    // has no row for it, the server's answer to `set_role` lands on nothing, and
    // the control read "None" forever however many times it was clicked. Before
    // a session is active the seed IS the display, exactly as it is for the
    // harness, model and reasoning pickers on that same route.
    localStorage.setItem("shipit-role-name", "deep dive");
    setRoles([DEEP_DIVE]);
    render(
      <MessageInput
        onSend={vi.fn()}
        disabled={false}
        agents={[claude]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        onRoleChange={vi.fn()}
        hasActiveSession={false}
      />,
    );
    expect(screen.getByTestId("role-selector-trigger")).toHaveTextContent("deep dive");
  });

  it("ignores the seed once a session IS active — the server is the only authority (req 13)", () => {
    // The seed names the role the NEXT session starts on. Reading it for a live
    // session would name a role that session never took.
    localStorage.setItem("shipit-role-name", "deep dive");
    setRoles([DEEP_DIVE]);
    render(
      <MessageInput
        onSend={vi.fn()}
        disabled={false}
        agents={[claude]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        onRoleChange={vi.fn()}
        hasActiveSession
        sessionId={SESSION_ID}
      />,
    );
    expect(screen.getByTestId("role-selector-trigger").textContent).toBe("");
  });

  it("stops naming the role when a parameter moves, with no server to ask (req 15)", async () => {
    localStorage.setItem("shipit-role-name", "deep dive");
    setRoles([DEEP_DIVE]);
    render(
      <MessageInput
        onSend={vi.fn()}
        disabled={false}
        agents={[claude]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        onRoleChange={vi.fn()}
        hasActiveSession={false}
      />,
    );
    // Reveal the parameters, then move one.
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    await userEvent.click(screen.getByTestId("role-adjust-parameters"));
    await userEvent.click(screen.getByTestId("reasoning-trigger"));
    await userEvent.click(screen.getByTestId("reasoning-option-high"));
    expect(screen.getByTestId("role-selector-trigger").textContent).toBe("");
  });
});

describe("ComposerSettingsMenu — the role row (docs/272 req 15)", () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessionId: SESSION_ID,
      sessions: [
        {
          id: SESSION_ID,
          name: "s",
          agentId: "claude",
          model: "claude-opus-5",
          serviceId: "anthropic",
          billingMode: "sub",
        },
      ] as never,
    });
  });
  afterEach(() => {
    useSessionStore.setState({ sessionId: null, sessions: [] } as never);
  });

  it("has no Role row when the user has no roles (req 16)", async () => {
    setRoles([REVIEWER]);
    renderMenu({ onRoleChange: vi.fn() });
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    expect(screen.queryByTestId("composer-settings-row-role")).toBeNull();
  });

  it("REPLACES the three rows a role set, and brings them back on request (reqs 5, 15)", async () => {
    setRoles([DEEP_DIVE]);
    const onAdjustRoleParameters = vi.fn();
    const { rerender } = renderMenu({
      onRoleChange: vi.fn(),
      sessionRoleName: "deep dive",
      roleParamsRevealed: false,
      onAdjustRoleParameters,
    });
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    expect(screen.getByTestId("composer-settings-row-role")).toHaveTextContent("deep dive");
    expect(screen.queryByTestId("composer-settings-row-harness")).toBeNull();
    expect(screen.queryByTestId("composer-settings-row-model")).toBeNull();
    expect(screen.queryByTestId("composer-settings-row-reasoning")).toBeNull();

    // "Adjust parameters…" lives inside the Role panel, and the harness is in it
    // — it pins irreversibly, and switching role can switch it.
    await userEvent.click(screen.getByTestId("composer-settings-row-role"));
    await userEvent.click(screen.getByTestId("composer-settings-role-adjust"));
    expect(onAdjustRoleParameters).toHaveBeenCalled();

    rerender(
      <ComposerSettingsMenu
        agents={[claude]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        modelInfo={null}
        hasActiveSession
        permissionMode="auto"
        onPermissionModeChange={vi.fn()}
        onRoleChange={vi.fn()}
        sessionRoleName="deep dive"
        roleParamsRevealed
      />,
    );
    expect(screen.getByTestId("composer-settings-row-harness")).toBeInTheDocument();
  });

  it("cannot be opened once the session has taken its first turn (req 4)", async () => {
    setRoles([DEEP_DIVE]);
    renderMenu({ onRoleChange: vi.fn(), roleLocked: true });
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    const row = screen.getByTestId("composer-settings-row-role");
    expect(row).toHaveAttribute("aria-disabled", "true");
  });
});
