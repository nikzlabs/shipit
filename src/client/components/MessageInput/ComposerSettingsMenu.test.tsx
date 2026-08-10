import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComposerSettingsMenu } from "./ComposerSettingsMenu.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { AgentOption } from "../../agent-types.js";

/**
 * docs/260 — the composer's single settings control, used below 700px of
 * composer width. These cover what the narrow row gives up and must therefore
 * hand back: the model name on the anchor (req 4), and every control it hid
 * still reachable and named (req 9).
 */

const claude: AgentOption = {
  id: "claude",
  name: "Claude Code",
  installed: true,
  hasRunnableModels: true,
  models: ["claude-opus-5", "claude-sonnet-5"],
  eligibleModels: [
    { serviceId: "anthropic", serviceName: "Anthropic", billingMode: "sub", modelId: "claude-opus-5", label: "Opus 5" },
    { serviceId: "anthropic", serviceName: "Anthropic", billingMode: "sub", modelId: "claude-sonnet-5", label: "Sonnet 5" },
  ],
  supportsReview: true,
  supportedPermissionModes: ["plan", "guarded", "auto"],
  reasoning: {
    label: "Reasoning",
    options: [
      { value: "low", label: "Low" },
      { value: "high", label: "High" },
    ],
  },
};

const codex: AgentOption = {
  id: "codex",
  name: "Codex",
  installed: true,
  hasRunnableModels: true,
  models: ["gpt-5-codex"],
  eligibleModels: [
    { serviceId: "openai", serviceName: "OpenAI", billingMode: "sub", modelId: "gpt-5-codex", label: "GPT-5 Codex" },
  ],
  supportsReview: true,
  supportedPermissionModes: [],
};

const SESSION_ID = "11111111-1111-1111-1111-111111111111";

function setSession(overrides: Record<string, unknown> = {}) {
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
        ...overrides,
      },
    ] as never,
  });
}

function renderMenu(props: Partial<React.ComponentProps<typeof ComposerSettingsMenu>> = {}) {
  return render(
    <ComposerSettingsMenu
      agents={[claude, codex]}
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

beforeEach(() => {
  setSession();
});
afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessionId: null, sessions: [] } as never);
});

describe("ComposerSettingsMenu", () => {
  describe("the anchor", () => {
    it("shows the current model's name (req 4)", () => {
      renderMenu();
      expect(screen.getByTestId("composer-settings-model-name")).toHaveTextContent("Opus 5");
    });

    it("names both the model and what it opens, for a screen reader (req 9)", () => {
      // The anchor shows one name but stands for four settings, so the visible
      // label alone would understate it.
      renderMenu();
      const label = screen.getByTestId("composer-settings-trigger").getAttribute("aria-label");
      expect(label).toContain("Opus 5");
      expect(label).toMatch(/settings/i);
    });

    it("can shrink and truncate, so the buttons beside it never move (req 8)", () => {
      // The class contract is the mechanism: the anchor is the ONLY elastic item
      // in the clipping group, so the name ellipsises before anything is cut.
      renderMenu();
      const trigger = screen.getByTestId("composer-settings-trigger");
      expect(trigger.className).toContain("min-w-0");
      expect(trigger.className).toContain("flex-[0_1_auto]");
      expect(trigger.querySelector(".truncate")).not.toBeNull();
    });

    it("does NOT change with the permission mode (req 12)", async () => {
      // Decided explicitly: the mode's icon belongs on the menu row, not here.
      const auto = renderMenu({ permissionMode: "auto" });
      const autoHtml = screen.getByTestId("composer-settings-trigger").innerHTML;
      auto.unmount();
      renderMenu({ permissionMode: "guarded" });
      expect(screen.getByTestId("composer-settings-trigger").innerHTML).toBe(autoHtml);
    });
  });

  describe("the root", () => {
    it("shows every setting's current value without drilling in", async () => {
      const user = userEvent.setup();
      renderMenu({ permissionMode: "guarded", sessionReasoning: "high" });
      await user.click(screen.getByTestId("composer-settings-trigger"));

      expect(screen.getByTestId("composer-settings-row-mode")).toHaveTextContent("Guarded");
      expect(screen.getByTestId("composer-settings-row-harness")).toHaveTextContent("Claude Code");
      expect(screen.getByTestId("composer-settings-row-model")).toHaveTextContent("Opus 5");
      expect(screen.getByTestId("composer-settings-row-reasoning")).toHaveTextContent("High");
    });

    it("stays four rows — it does not inline the choices (req 11)", async () => {
      // The whole reason for two levels: the root must not grow with the
      // catalogue. Sonnet 5 exists but must not be on the root.
      const user = userEvent.setup();
      renderMenu();
      await user.click(screen.getByTestId("composer-settings-trigger"));
      expect(screen.queryByTestId("composer-settings-model-claude-sonnet-5")).toBeNull();
      expect(screen.queryByTestId("composer-settings-reasoning-low")).toBeNull();
    });

    it("does not offer the harness once the session has pinned it, and says why", async () => {
      const user = userEvent.setup();
      setSession({ agentPinned: true });
      renderMenu();
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-harness"));
      // No harness panel — the row is inert, and the reason is on the root.
      expect(screen.queryByTestId("composer-settings-harness-codex")).toBeNull();
      expect(screen.getByTestId("composer-settings-menu")).toHaveTextContent(/fixed after the first message/i);
    });

    it("stays open and keeps the mode changeable while a turn runs", async () => {
      // The wide row disables the harness/model/reasoning triggers during a turn
      // but leaves the permission mode alone. Disabling the whole anchor here
      // would have silently taken the mode away too, and made every setting
      // unreadable mid-turn.
      const user = userEvent.setup();
      const onPermissionModeChange = vi.fn();
      renderMenu({ pickersLocked: true, onPermissionModeChange });
      await user.click(screen.getByTestId("composer-settings-trigger"));
      expect(screen.getByTestId("composer-settings-menu")).toBeInTheDocument();

      await user.click(screen.getByTestId("composer-settings-row-mode"));
      await user.click(screen.getByTestId("composer-settings-mode-plan"));
      expect(onPermissionModeChange).toHaveBeenCalledWith("plan");
    });

    it("locks harness, model and reasoning while a turn runs, and says so", async () => {
      const user = userEvent.setup();
      renderMenu({ pickersLocked: true });
      await user.click(screen.getByTestId("composer-settings-trigger"));
      expect(screen.getByTestId("composer-settings-turn-notice")).toBeInTheDocument();

      await user.click(screen.getByTestId("composer-settings-row-model"));
      expect(screen.queryByTestId("composer-settings-model-claude-sonnet-5")).toBeNull();
      await user.click(screen.getByTestId("composer-settings-row-reasoning"));
      expect(screen.queryByTestId("composer-settings-reasoning-high")).toBeNull();
    });

    it("omits the mode row's drill-down for a harness with no modes to pick", async () => {
      const user = userEvent.setup();
      setSession({ agentId: "codex" });
      renderMenu({ activeAgentId: "codex" });
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-mode"));
      expect(screen.queryByTestId("composer-settings-mode-plan")).toBeNull();
    });
  });

  describe("drilling in", () => {
    it("opens the model panel and reports the pick as a whole selection", async () => {
      const user = userEvent.setup();
      const onModelChange = vi.fn();
      renderMenu({ onModelChange });
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-model"));
      await user.click(screen.getByTestId("composer-settings-model-claude-sonnet-5"));
      // The triple, not a bare id — a bare id cannot say who is billing the turn.
      expect(onModelChange).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: "claude-sonnet-5",
          serviceId: "anthropic",
          billingMode: "sub",
        }),
      );
    });

    it("groups models by service and billing mode, as the wide picker does", async () => {
      const user = userEvent.setup();
      renderMenu();
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-model"));
      expect(screen.getByTestId("composer-settings-menu")).toHaveTextContent("Anthropic");
      expect(screen.getByTestId("composer-settings-menu")).toHaveTextContent("Subscription");
    });

    it("changes the permission mode", async () => {
      const user = userEvent.setup();
      const onPermissionModeChange = vi.fn();
      renderMenu({ onPermissionModeChange });
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-mode"));
      await user.click(screen.getByTestId("composer-settings-mode-plan"));
      expect(onPermissionModeChange).toHaveBeenCalledWith("plan");
    });

    it("refuses guarded when the model cannot run it, with the reason", async () => {
      const user = userEvent.setup();
      const onPermissionModeChange = vi.fn();
      renderMenu({ onPermissionModeChange, guardedModelOk: false });
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-mode"));
      const guarded = screen.getByTestId("composer-settings-mode-guarded");
      expect(guarded).toHaveTextContent(/needs a Sonnet or Opus model/i);
      await user.click(guarded);
      expect(onPermissionModeChange).not.toHaveBeenCalled();
    });

    it("changes the reasoning level", async () => {
      const user = userEvent.setup();
      const onReasoningChange = vi.fn();
      renderMenu({ onReasoningChange, sessionReasoning: "low" });
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-reasoning"));
      await user.click(screen.getByTestId("composer-settings-reasoning-high"));
      expect(onReasoningChange).toHaveBeenCalledWith("high");
    });

    it("goes back to the root without closing the menu", async () => {
      const user = userEvent.setup();
      renderMenu();
      await user.click(screen.getByTestId("composer-settings-trigger"));
      await user.click(screen.getByTestId("composer-settings-row-model"));
      expect(screen.queryByTestId("composer-settings-row-model")).toBeNull();
      await user.click(screen.getByTestId("composer-settings-back"));
      expect(screen.getByTestId("composer-settings-row-model")).toBeInTheDocument();
    });
  });
});
