import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ROLE_PILL_CLASS, RoleSelector, useRolePickerState } from "./RoleSelector.js";
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

  /**
   * req 4 — a locked role is a READOUT. The two failures below shipped together
   * and are one mistake: `locked` was handed to the button's `disabled`, which
   * dimmed it to half contrast while leaving Radix's menu bound to it.
   */
  describe("locked (req 4)", () => {
    it("opens nothing, because the menu is not rendered at all", async () => {
      render(
        <RoleSelector
          roles={[DEEP_DIVE, pinnedRole({ name: "triage" })]}
          selectedRole="deep dive"
          onSelectRole={vi.fn()}
          locked
        />,
      );

      // ABSENCE, not a disabled attribute — Radix binds the trigger on
      // `pointerdown`, so a test for the latter passes against the bug.
      expect(screen.queryByTestId("role-selector-menu")).toBeNull();
      await userEvent.click(screen.getByTestId("role-selector-trigger"));
      expect(screen.queryByTestId("role-selector-menu")).toBeNull();
      expect(screen.queryByTestId("role-option-triage")).toBeNull();
    });

    it("keeps the pill's own contrast — it reports the session, permanently", () => {
      render(
        <RoleSelector roles={[DEEP_DIVE]} selectedRole="deep dive" onSelectRole={vi.fn()} locked />,
      );
      const trigger = screen.getByTestId("role-selector-trigger");

      expect(trigger).toHaveTextContent("deep dive");
      expect(trigger.className).not.toContain("opacity-50");
      // Same pill, not a second appearance for the same state.
      expect(trigger.className).toContain("bg-(--color-accent-subtle)");
      expect(trigger.className).toContain("text-(--color-accent)");
    });

    it("goes entirely when there is no role to report", () => {
      // The mark's only job is to offer the list; locked, it offers nothing.
      render(<RoleSelector roles={[DEEP_DIVE]} onSelectRole={vi.fn()} locked />);
      expect(screen.queryByTestId("role-selector-trigger")).toBeNull();
    });

    it("says what is still changeable, not only what is not", () => {
      // A lock stating a prohibition alone was read as "this session's settings
      // are frozen" — the reading the vanished parameters appeared to confirm.
      render(
        <RoleSelector roles={[DEEP_DIVE]} selectedRole="deep dive" onSelectRole={vi.fn()} locked />,
      );
      expect(screen.getByTestId("role-selector-trigger").getAttribute("title")).toContain(
        "stay changeable",
      );
    });
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

describe("one appearance for 'a role is in force' (docs/272 req 5)", () => {
  it("dresses the wide row's control and the narrow anchor identically", () => {
    // They had drifted: the wide row followed the approved prototype's tinted
    // pill, the narrow anchor inherited docs/260's plain settings control, and
    // the same state wore two faces on nothing but the composer's width.
    //
    // Asserting they IMPORT the constant would not catch the regression this
    // exists to catch — an import can be present and the class overridden at the
    // call site — so it compares what was actually rendered, exactly as
    // `picker-consistency.test.tsx` does for the three pickers.
    setRoles([DEEP_DIVE]);
    const { unmount } = render(
      <RoleSelector roles={[DEEP_DIVE]} selectedRole="deep dive" onSelectRole={vi.fn()} />,
    );
    const wide = screen.getByTestId("role-selector-trigger").className;
    unmount();

    renderMenu({ onRoleChange: vi.fn(), sessionRoleName: "deep dive" });
    const narrow = screen.getByTestId("composer-settings-trigger").className;

    // Everything the shared constant carries — colour, radius, padding, type —
    // is on both. What differs is layout, which is each call site's own and must
    // be: the wide control is `shrink-0`, the narrow anchor is the row's one
    // elastic item (docs/260 req 8).
    for (const cls of ROLE_PILL_CLASS.split(/\s+/).filter(Boolean)) {
      expect(narrow, `narrow anchor is missing "${cls}"`).toContain(cls);
      expect(wide, `wide control is missing "${cls}"`).toContain(cls);
    }
    expect(wide).toContain("shrink-0");
    expect(narrow).toContain("flex-[0_1_auto]");
  });
});

describe("the composer before a session is active (docs/272 reqs 5, 12)", () => {
  afterEach(() => {
    localStorage.removeItem("shipit-role-name");
    localStorage.removeItem("vibe-model-id");
    localStorage.removeItem("vibe-agent-id");
    localStorage.removeItem("shipit-reasoning-by-agent");
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

  it("corrects a stale seed to the role's own parameters (req 15)", async () => {
    // The seed slots are what the three pickers DISPLAY here, so a seed left
    // over from earlier work showed a model the role would not run — reported as
    // "the model name is incorrect". A role picked in this browser writes them;
    // a role arriving from the slot on a page load has nothing that did, so the
    // composer reconciles them.
    localStorage.setItem("shipit-role-name", "deep dive");
    localStorage.setItem(
      "vibe-model-id",
      JSON.stringify({ serviceId: "deepseek", billingMode: "key", modelId: "deepseek-v4-flash" }),
    );
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
    await waitFor(() => {
      expect(localStorage.getItem("vibe-model-id")).toBe("anthropic:sub:claude-opus-5");
    });
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

describe("a locked role keeps the ROUTE to the parameters (docs/272 reqs 4, 5, 15)", () => {
  /*
    Two opposite bugs, one row. First: a locked role had no menu at all, and
    "Adjust parameters…" lives inside that menu — so a session started on a role
    lost its model and reasoning controls at the first turn and never got them
    back, while an identical hand-configured session kept both. Then the repair
    (`roleParamsRevealed || roleLocked`) put all three controls on the row
    unconditionally, which grows the row a role exists to shorten, at the first
    turn, uninvited.

    What is asserted here is the door: the pill opens, offers the parameters and
    no roles, and the row stays short until the user asks.

    Rendered through `MessageInput` rather than the pickers directly, because the
    condition under test is the composer's own (`roleParamsRevealed`), and it is
    the single place both layouts read.
  */
  beforeEach(() => {
    useSessionStore.setState({
      sessionId: SESSION_ID,
      sessions: [
        {
          id: SESSION_ID,
          name: "s",
          agentId: "claude",
          agentPinned: true,
          model: "claude-opus-5",
          serviceId: "anthropic",
          billingMode: "sub",
          roleName: "deep dive",
        },
      ] as never,
    });
    setRoles([DEEP_DIVE]);
  });
  afterEach(() => {
    useSessionStore.setState({ sessionId: null, sessions: [] } as never);
  });

  function renderLocked() {
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
        sessionRoleName="deep dive"
        roleLocked
      />,
    );
  }

  it("keeps the row short until the parameters are asked for (req 5)", () => {
    renderLocked();
    expect(screen.getByTestId("role-selector-trigger")).toHaveTextContent("deep dive");
    expect(screen.queryByTestId("model-trigger")).toBeNull();
    expect(screen.queryByTestId("reasoning-trigger")).toBeNull();
  });

  it("opens, and brings the parameters back when asked (req 15)", async () => {
    renderLocked();
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    await userEvent.click(screen.getByTestId("role-adjust-parameters"));
    expect(screen.getByTestId("model-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("reasoning-trigger")).toBeInTheDocument();
    // The one parameter the lock genuinely reaches — and it reaches it for every
    // session alike, role or no role.
    expect(screen.getByTestId("harness-trigger").getAttribute("title")).toContain(
      "fixed for this session",
    );
  });

  it("offers no OTHER role while it is open (req 4)", async () => {
    // req 4 is unchanged: what loosened is what the lock reaches, not the lock.
    // The menu exists, and there is nothing in it but the parameters.
    renderLocked();
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    expect(screen.getByTestId("role-selector-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("role-option-deep dive")).toBeNull();
  });

  it("stops opening once the parameters are out — no caret onto an empty menu", async () => {
    renderLocked();
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    await userEvent.click(screen.getByTestId("role-adjust-parameters"));
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    expect(screen.queryByTestId("role-selector-menu")).toBeNull();
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

  it("carries the ROLE's name on the anchor, not the model's (req 5)", () => {
    // docs/260 gave the anchor the model name as the most consequential of the
    // four things behind it. A role outranks it on that test — it IS the
    // harness, the model and the level — and leaving the model there put two
    // answers to "what does this session run on" on one row.
    setRoles([DEEP_DIVE]);
    renderMenu({ onRoleChange: vi.fn(), sessionRoleName: "deep dive", roleParamsRevealed: false });
    expect(screen.getByTestId("composer-settings-model-name")).toHaveTextContent("deep dive");
    expect(screen.getByTestId("composer-settings-trigger").getAttribute("aria-label")).toContain(
      "role: deep dive",
    );
  });

  it("cannot be opened once the session has taken its first turn (req 4)", async () => {
    setRoles([DEEP_DIVE]);
    renderMenu({ onRoleChange: vi.fn(), roleLocked: true });
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    const row = screen.getByTestId("composer-settings-row-role");
    expect(row).toHaveAttribute("aria-disabled", "true");
  });

  it("still reaches the parameters under a locked role, and offers no role (reqs 4, 15)", async () => {
    // The same door as the wide row, reaching here for free: this menu takes
    // `roleParamsRevealed` as a prop rather than recomputing it, which is why one
    // condition in `MessageInput` governs both layouts.
    setRoles([DEEP_DIVE]);
    const onAdjustRoleParameters = vi.fn();
    renderMenu({
      onRoleChange: vi.fn(),
      sessionRoleName: "deep dive",
      roleLocked: true,
      roleParamsRevealed: false,
      onAdjustRoleParameters,
    });
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    expect(screen.queryByTestId("composer-settings-row-model")).toBeNull();
    await userEvent.click(screen.getByTestId("composer-settings-row-role"));
    expect(screen.getByTestId("composer-settings-role-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-settings-role-deep dive")).toBeNull();
    await userEvent.click(screen.getByTestId("composer-settings-role-adjust"));
    expect(onAdjustRoleParameters).toHaveBeenCalled();
  });

  it("goes inert once the locked role's parameters are out", async () => {
    setRoles([DEEP_DIVE]);
    renderMenu({
      onRoleChange: vi.fn(),
      sessionRoleName: "deep dive",
      roleLocked: true,
      roleParamsRevealed: true,
    });
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    expect(screen.getByTestId("composer-settings-row-role")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByTestId("composer-settings-row-model")).toBeInTheDocument();
    expect(screen.getByTestId("composer-settings-row-reasoning")).toBeInTheDocument();
  });
});
