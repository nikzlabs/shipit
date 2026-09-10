import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ROLE_PILL_CLASS, RoleSelector, useRolePickerState } from "./RoleSelector.js";
import { ComposerSettingsMenu } from "./ComposerSettingsMenu.js";
import { MessageInput } from "./MessageInput.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { handleModelSelectionChanged } from "../../hooks/message-handlers/model-selection-changed.js";
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

async function openRoleMenu() {
  /*
    **Let any scheduled textarea focus run BEFORE opening the menu.**

    `MessageInput` focuses its textarea from a `requestAnimationFrame` whenever
    `focusKey` changes — on first mount and on every session switch
    (`MessageInput.tsx`, "Auto-focus textarea on mount and on session change").
    Radix closes a dropdown as soon as focus leaves it, so a frame callback still
    pending when the menu opens closes the menu again a few milliseconds later.

    In CI that surfaced as "found `role-selector-menu`, could not find
    `role-option-triage`" — the container outliving its rows by the moment Radix
    takes to unmount them. It passed locally only because the synchronous
    `getByTestId` ran before the frame callback did; the ordering was never
    guaranteed. The `waitFor` below makes the same failure deterministic, which is
    how this was finally pinned down: without this drain, two tests here fail
    every run.

    An rAF queued here runs after any already queued, so awaiting one means
    "whatever focus was scheduled has now happened" — no timer constant to guess,
    and it stays correct if the component changes how it schedules.
  */
  await new Promise((resolve) => {
    requestAnimationFrame(() => resolve(null));
  });
  // Radix opens dropdown triggers on pointerdown. Using the complete synthetic
  // click sequence can race focus work when the full client suite runs.
  fireEvent.pointerDown(screen.getByTestId("role-selector-trigger"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  const menu = await screen.findByTestId("role-selector-menu", {}, { timeout: 2000 });
  /*
    **Wait for the menu to be POPULATED, not merely mounted.**

    The container carrying `role-selector-menu` and the rows inside it are not
    guaranteed to be queryable in the same tick, and callers go straight from
    here to `getByTestId("role-option-…")` / `role-adjust-parameters`. In CI this
    failed as "found `role-selector-menu`, could not find `role-option-triage`" —
    the container present with its rows absent, on a run of the full 16k-test
    suite.

    Kept alongside the focus drain above rather than replaced by it: the drain
    fixes the cause we found, and this asserts the property the callers actually
    depend on. It cannot hide a real fault — a menu that never populates still
    fails, just with an honest timeout instead of a race — and it is what turns
    a regression in the drain back into a deterministic failure rather than a
    once-per-few-thousand-runs flake.
  */
  await waitFor(() => {
    expect(menu.querySelector('[role="menuitem"]')).not.toBeNull();
  });
  return menu;
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
    await userEvent.click(screen.getByTestId("role-adjust-parameters"));
    expect(onAdjustParameters).toHaveBeenCalled();
  });

  describe("No role (req 18)", () => {
    it("offers it in the list, and calls back with nothing selected", async () => {
      // The act req 15's "changing a parameter is the whole of leaving a role"
      // cannot express: keep what the role set, drop the brief it carries.
      const onSelectRole = vi.fn();
      render(
        <RoleSelector roles={[DEEP_DIVE]} selectedRole="deep dive" onSelectRole={onSelectRole} />,
      );
      await userEvent.click(screen.getByTestId("role-selector-trigger"));
      await userEvent.click(screen.getByTestId("role-option-none"));
      expect(onSelectRole).toHaveBeenCalledWith(undefined);
    });

    it("is what the list shows as chosen while no role is in force", async () => {
      render(<RoleSelector roles={[DEEP_DIVE]} onSelectRole={vi.fn()} />);
      await userEvent.click(screen.getByTestId("role-selector-trigger"));
      // The same selected treatment every picker row wears, asserted the way
      // this file already asserts the pill's tint.
      expect(screen.getByTestId("role-option-none").className).toContain("bg-(--color-accent-subtle)");
      expect(screen.getByTestId("role-option-deep dive").className).not.toContain(
        "bg-(--color-accent-subtle)",
      );
    });

    it("is not offered once the choice of role has locked (req 4)", async () => {
      // Clearing IS a choice of role. By the first turn the standing
      // instructions have been delivered, so un-naming them states nothing.
      render(
        <RoleSelector
          roles={[DEEP_DIVE]}
          selectedRole="deep dive"
          onSelectRole={vi.fn()}
          onAdjustParameters={vi.fn()}
          locked
        />,
      );
      await userEvent.click(screen.getByTestId("role-selector-trigger"));
      expect(screen.queryByTestId("role-option-none")).toBeNull();
      expect(screen.getByTestId("role-adjust-parameters")).toBeTruthy();
    });
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

/** A second harness, so "which role am I looking at" has a visible answer. */
const codex: AgentOption = {
  id: "codex",
  name: "Codex",
  installed: true,
  hasRunnableModels: true,
  models: ["gpt-6-astra"],
  eligibleModels: [
    {
      serviceId: "openai",
      serviceName: "OpenAI",
      billingMode: "sub",
      modelId: "gpt-6-astra",
      label: "GPT-6 Astra",
      canonicalModelKey: "gpt-6-astra",
    },
  ],
  supportsReview: true,
  supportedPermissionModes: [],
  reasoning: { label: "Reasoning effort", options: [{ value: "low", label: "Low" }] },
};

/** …and a role that runs on it, so switching roles switches all three parameters. */
const TRIAGE: RoleView = pinnedRole({
  name: "triage",
  params: {
    kind: "pinned",
    harnessId: "codex",
    serviceId: "openai",
    billingMode: "sub",
    modelId: "gpt-6-astra",
    reasoningEffort: "low",
  },
  resolved: {
    harnessId: "codex",
    harnessName: "Codex",
    serviceId: "openai",
    billingMode: "sub",
    serviceName: "OpenAI",
    modelId: "gpt-6-astra",
    label: "GPT-6 Astra",
    reasoningEffort: "low",
  },
});

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
        onSend={vi.fn().mockReturnValue(true)}
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
        onSend={vi.fn().mockReturnValue(true)}
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
      JSON.stringify({ serviceId: "deepseek", billingMode: "key", modelId: "deepseek-flash" }),
    );
    setRoles([DEEP_DIVE]);
    render(
      <MessageInput
        onSend={vi.fn().mockReturnValue(true)}
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
        onSend={vi.fn().mockReturnValue(true)}
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

  it("shows the parameters of the role JUST PICKED, not the one before it", async () => {
    /*
      **The new-session route is its own case, and it is where this broke.**

      `/{repo}/new` claims a WARM session, so the composer has a `sessionId`
      while `hasActiveSession` is false — and `SessionManager.list()` filters
      `warm = 0`, so there is no row for it to read. The three pickers therefore
      fall through to the ui store's `activeAgentId`, which `useUiStore.reset()`
      seeds ONCE, on arrival, and which `useConnectionSync` only ever syncs from
      a session row. Choosing a role rewrote the three seeds
      (`utils/role-seed.ts`) and nothing moved that field, so "Adjust
      parameters…" showed the harness, model and level of the role selected
      BEFORE this one.

      So this drives the whole client half: pick the role, deliver the server's
      answer to it, then ask to see what it set. `activeAgentId` starts as the
      snapshot the route arrived with, exactly as it would in the app — the
      wrapper reads it from the store the way `App.tsx` does, or the fix would
      have nothing to move.
    */
    localStorage.setItem("shipit-role-name", "deep dive");
    localStorage.setItem("vibe-agent-id", "claude");
    localStorage.setItem(
      "vibe-model-id",
      JSON.stringify({ serviceId: "anthropic", billingMode: "sub", modelId: "claude-opus-5" }),
    );
    useUiStore.setState({ activeAgentId: "claude" });
    useSessionStore.setState({ sessionId: SESSION_ID, sessions: [] });
    setRoles([DEEP_DIVE, TRIAGE]);

    function Composer() {
      const activeAgentId = useUiStore((s) => s.activeAgentId);
      return (
        <MessageInput
          onSend={vi.fn().mockReturnValue(true)}
          disabled={false}
          agents={[claude, codex]}
          activeAgentId={activeAgentId}
          onAgentChange={vi.fn()}
          onModelChange={vi.fn()}
          onReasoningChange={vi.fn()}
          onRoleChange={vi.fn()}
          hasActiveSession={false}
          sessionId={SESSION_ID}
        />
      );
    }
    render(<Composer />);

    await openRoleMenu();
    await userEvent.click(screen.getByTestId("role-option-triage"));
    // The server applies the role and answers with what the session moved to.
    act(() => {
      handleModelSelectionChanged(undefined as never, {
        type: "model_selection_changed",
        sessionId: SESSION_ID,
        agentId: "codex",
        selection: { serviceId: "openai", billingMode: "sub", modelId: "gpt-6-astra" },
        modelId: "gpt-6-astra",
        reasoningEffort: "low",
        roleName: "triage",
      });
    });

    // A fresh pick folds the parameters away, so this is the reported flow in
    // full: choose a role, then ask to see what it set.
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    await userEvent.click(screen.getByTestId("role-adjust-parameters"));

    await waitFor(() => {
      expect(screen.getByTestId("harness-trigger")).toHaveTextContent("Codex");
    });
    expect(screen.getByTestId("model-trigger")).toHaveTextContent("GPT-6 Astra");
    expect(screen.getByTestId("reasoning-trigger")).toHaveTextContent("Low");
  });

  it("takes the level from the harness the row NAMES, not from the store's active one", async () => {
    /*
      The wide row's reasoning control resolved its harness by a second rule —
      `agents.find(a => a.id === activeAgentId)` — where the harness picker
      beside it uses `displayedHarness`. With **no session bound at all** (Quick
      Capture, and the new-session route before its warm session is claimed) those
      two disagree by design: the picker previews the seed, while `activeAgentId`
      belongs to whichever session is running behind the overlay. So a role picked
      here named its own harness and model and the level of somebody else's.

      There is no session to echo an answer for, which is exactly why this case is
      separate from the one above: the store write cannot reach it, and the second
      rule is the whole defect.
    */
    localStorage.setItem("shipit-role-name", "triage");
    localStorage.setItem("shipit-reasoning-by-agent", JSON.stringify({ claude: "high" }));
    setRoles([DEEP_DIVE, TRIAGE]);
    useSessionStore.setState({ sessionId: undefined, sessions: [] });
    render(
      <MessageInput
        onSend={vi.fn().mockReturnValue(true)}
        disabled={false}
        agents={[claude, codex]}
        // The background session's harness — what Quick Capture is handed.
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        onRoleChange={vi.fn()}
        hasActiveSession={false}
      />,
    );

    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    await userEvent.click(screen.getByTestId("role-adjust-parameters"));

    await waitFor(() => {
      expect(screen.getByTestId("harness-trigger")).toHaveTextContent("Codex");
    });
    const reasoning = screen.getByTestId("reasoning-trigger");
    // Both halves: the level itself, and the knob's NAME — each harness calls it
    // something different, so the label alone says which one is being described.
    expect(reasoning).toHaveTextContent("Low");
    expect(reasoning.getAttribute("aria-label")).toBe("Reasoning effort selector");
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
        onSend={vi.fn().mockReturnValue(true)}
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
    await openRoleMenu();
    fireEvent.click(screen.getByTestId("role-adjust-parameters"));
    expect(screen.getByTestId("model-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("reasoning-trigger")).toBeInTheDocument();
    // The one parameter the lock genuinely reaches — and it reaches it for every
    // session alike, role or no role.
    expect(screen.getByTestId("harness-trigger").getAttribute("title")).toContain(
      "fixed for this session",
    );
  });

  it("keeps the revealed parameters in the session where they were requested", async () => {
    const renderSession = (sessionId: string) => (
      <MessageInput
        onSend={vi.fn().mockReturnValue(true)}
        disabled={false}
        agents={[claude]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        onRoleChange={vi.fn()}
        hasActiveSession
        focusKey={sessionId}
        sessionId={sessionId}
        sessionRoleName="deep dive"
        roleLocked
      />
    );
    const { rerender } = render(renderSession("session-a"));

    await openRoleMenu();
    fireEvent.click(screen.getByTestId("role-adjust-parameters"));
    expect(screen.getByTestId("model-trigger")).toBeInTheDocument();

    rerender(renderSession("session-b"));
    expect(screen.getByTestId("role-selector-trigger")).toHaveTextContent("deep dive");
    expect(screen.queryByTestId("model-trigger")).toBeNull();
    expect(screen.queryByTestId("reasoning-trigger")).toBeNull();

    rerender(renderSession("session-a"));
    expect(screen.getByTestId("model-trigger")).toBeInTheDocument();
    expect(screen.getByTestId("reasoning-trigger")).toBeInTheDocument();
  });

  it("offers no OTHER role while it is open (req 4)", async () => {
    // req 4 is unchanged: what loosened is what the lock reaches, not the lock.
    // The menu exists, and there is nothing in it but the parameters.
    renderLocked();
    await openRoleMenu();
    expect(screen.getByTestId("role-selector-menu")).toBeInTheDocument();
    expect(screen.queryByTestId("role-option-deep dive")).toBeNull();
  });

  it("stops opening once the parameters are out — no caret onto an empty menu", async () => {
    renderLocked();
    await openRoleMenu();
    fireEvent.click(screen.getByTestId("role-adjust-parameters"));
    await userEvent.click(screen.getByTestId("role-selector-trigger"));
    expect(screen.queryByTestId("role-selector-menu")).toBeNull();
  });
});

describe("role parameter reveal is scoped to one session", () => {
  const TRIAGE = pinnedRole({ name: "triage" });

  beforeEach(() => {
    setRoles([DEEP_DIVE, TRIAGE]);
  });

  it("folds a fresh role pick without clearing another session's reveal", async () => {
    const onRoleChange = vi.fn();
    const renderSession = (sessionId: string, sessionRoleName: string) => (
      <MessageInput
        onSend={vi.fn().mockReturnValue(true)}
        disabled={false}
        agents={[claude]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        onRoleChange={onRoleChange}
        hasActiveSession
        focusKey={sessionId}
        sessionId={sessionId}
        sessionRoleName={sessionRoleName}
      />
    );
    const { rerender } = render(renderSession("session-a", "deep dive"));

    await openRoleMenu();
    fireEvent.click(screen.getByTestId("role-adjust-parameters"));
    expect(screen.getByTestId("model-trigger")).toBeInTheDocument();

    rerender(renderSession("session-b", "deep dive"));
    await openRoleMenu();
    fireEvent.click(screen.getByTestId("role-option-triage"));
    expect(onRoleChange).toHaveBeenLastCalledWith("triage");
    rerender(renderSession("session-b", "triage"));
    expect(screen.queryByTestId("model-trigger")).toBeNull();

    rerender(renderSession("session-a", "deep dive"));
    expect(screen.getByTestId("model-trigger")).toBeInTheDocument();
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
    // docs/285 req 9 — with the parameters folded away the root would hold only
    // the Role row, so the menu opens ONTO the role list rather than making the
    // user traverse a level whose only purpose is to lead here. The three rows
    // are still absent, which is what req 5 is about.
    expect(screen.queryByTestId("composer-settings-row-harness")).toBeNull();
    expect(screen.queryByTestId("composer-settings-row-model")).toBeNull();
    expect(screen.queryByTestId("composer-settings-row-reasoning")).toBeNull();
    expect(screen.getByTestId("composer-settings-trigger")).toHaveTextContent("deep dive");

    // "Adjust parameters…" is in that list, and the harness is named in it — it
    // pins irreversibly, and switching role can switch it.
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
    // req 9 — opens straight onto the role panel; there is no root to traverse.
    expect(screen.getByTestId("composer-settings-role-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-settings-role-deep dive")).toBeNull();
    await userEvent.click(screen.getByTestId("composer-settings-role-adjust"));
    expect(onAdjustRoleParameters).toHaveBeenCalled();
  });

  it("offers No role in the panel, and not once the choice has locked (req 18)", async () => {
    // One fact, both layouts: the narrow menu is where a role is chosen below
    // 700px, so a clear reachable only in the wide row would be no clear at all
    // on a phone.
    setRoles([DEEP_DIVE]);
    const onRoleChange = vi.fn();
    const { rerender } = renderMenu({ onRoleChange, sessionRoleName: "deep dive" });
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    // The parameters are revealed here (the default), so the root is a real
    // four-row choice and the Role row is the way in — req 9's collapse applies
    // only when Role would be the ONLY row.
    await userEvent.click(screen.getByTestId("composer-settings-row-role"));
    await userEvent.click(screen.getByTestId("composer-settings-role-none"));
    expect(onRoleChange).toHaveBeenCalledWith(undefined);

    rerender(
      <ComposerSettingsMenu
        agents={[claude]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        modelInfo={null}
        hasActiveSession
        onRoleChange={vi.fn()}
        sessionRoleName="deep dive"
        roleLocked
        roleParamsRevealed={false}
        onAdjustRoleParameters={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    // Locked, parameters folded → req 9's collapse applies, so the list is the
    // menu. "No role" is absent because the choice is locked, not because the
    // panel was never reached.
    expect(screen.getByTestId("composer-settings-role-locked")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-settings-role-none")).toBeNull();
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

/**
 * docs/272 req 15, in the NARROW layout — the one place a role's parameters are
 * reached without unmounting anything.
 *
 * The wide row drops an optimistic pick for free: choosing a role folds the
 * parameters away, which unmounts the three selectors. `ComposerSettingsMenu`
 * keeps its hooks mounted and only stops rendering their rows, so the picks
 * outlived the role that replaced them.
 *
 * `useNarrowContainer` reports `false` where `ResizeObserver` is missing, which
 * is jsdom — so every other test in this file sees the wide row, and this one
 * opts in by stubbing the observer and faking the composer's measured width.
 */
describe("a role folds away hand-picked parameters in the narrow menu too", () => {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 400,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // @ts-expect-error -- restoring the jsdom default (always 0)
    delete HTMLElement.prototype.clientWidth;
    localStorage.removeItem("shipit-role-name");
    localStorage.removeItem("vibe-model-id");
    localStorage.removeItem("vibe-agent-id");
    localStorage.removeItem("shipit-reasoning-by-agent");
  });

  it("shows the role's level, not the one picked by hand before it", async () => {
    setRoles([DEEP_DIVE, TRIAGE]);
    useSessionStore.setState({ sessionId: undefined, sessions: [] });
    render(
      <MessageInput
        onSend={vi.fn().mockReturnValue(true)}
        disabled={false}
        agents={[claude, codex]}
        activeAgentId="claude"
        onAgentChange={vi.fn()}
        onModelChange={vi.fn()}
        onReasoningChange={vi.fn()}
        onRoleChange={vi.fn()}
        hasActiveSession={false}
      />,
    );
    // The narrow layout really is the one on screen.
    expect(screen.getByTestId("composer-settings-trigger")).toBeInTheDocument();

    // Pick a MODEL and a level by hand — the menu holds an optimistic value for
    // each, through two different hooks, and the key has to clear both.
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    await userEvent.click(screen.getByTestId("composer-settings-row-model"));
    await userEvent.click(screen.getByTestId("composer-settings-model-claude-opus-5"));
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    await userEvent.click(screen.getByTestId("composer-settings-row-reasoning"));
    await userEvent.click(screen.getByTestId("composer-settings-reasoning-max"));

    // Then choose a role that sets a different one, and ask to see what it set.
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    await userEvent.click(screen.getByTestId("composer-settings-row-role"));
    await userEvent.click(screen.getByTestId("composer-settings-role-triage"));
    await userEvent.click(screen.getByTestId("composer-settings-trigger"));
    await userEvent.click(screen.getByTestId("composer-settings-role-adjust"));

    await waitFor(() => {
      expect(screen.getByTestId("composer-settings-row-reasoning")).toHaveTextContent("Low");
    });
    expect(screen.getByTestId("composer-settings-row-harness")).toHaveTextContent("Codex");
    expect(screen.getByTestId("composer-settings-row-model")).toHaveTextContent("GPT-6 Astra");
  });
});
