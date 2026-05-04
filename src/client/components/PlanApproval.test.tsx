import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanApproval } from "./PlanApproval.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useSessionStore } from "../stores/session-store.js";

beforeEach(() => {
  // Most tests assume we're "inside" a session — set a default session id.
  useSessionStore.getState().setSessionId("test-session");
  useSettingsStore.getState().setPermissionMode("test-session", "plan");
});

afterEach(() => {
  cleanup();
  useSessionStore.getState().setSessionId(undefined);
  // Reset the store's per-session map and default by writing fresh values.
  useSettingsStore.setState({ permissionMode: "auto", permissionModeBySession: {} });
});

describe("PlanApproval", () => {
  describe("rendering", () => {
    it("renders the plan approval card with accept and suggest buttons", () => {
      render(<PlanApproval onSend={vi.fn()} disabled={false} />);
      expect(screen.getByTestId("plan-approval")).toBeInTheDocument();
      expect(screen.getByTestId("accept-plan")).toBeInTheDocument();
      expect(screen.getByTestId("suggest-changes")).toBeInTheDocument();
      expect(screen.getByText("Plan Ready")).toBeInTheDocument();
    });

    it("renders plan content when planContent prop is provided", () => {
      render(<PlanApproval onSend={vi.fn()} disabled={false} planContent="# My Plan\n\nStep 1: Do something" />);
      const planEl = screen.getByTestId("plan-content");
      expect(planEl).toBeInTheDocument();
      expect(planEl.textContent).toContain("My Plan");
    });

    it("does not render plan content when planContent is not provided", () => {
      render(<PlanApproval onSend={vi.fn()} disabled={false} />);
      expect(screen.queryByTestId("plan-content")).not.toBeInTheDocument();
    });
  });

  describe("accept flow", () => {
    it("calls onSend with execute text and switches permission mode to auto", () => {
      const onSend = vi.fn();
      useSettingsStore.getState().setPermissionMode("test-session", "plan");
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("accept-plan"));

      expect(onSend).toHaveBeenCalledWith("Execute the plan you just described.");
      expect(useSettingsStore.getState().getPermissionMode("test-session")).toBe("auto");
    });

    it("only updates the current session's permission mode, not other sessions", () => {
      // Two sessions both in plan mode. Accepting the plan in session A must
      // not flip session B out of plan mode.
      useSettingsStore.getState().setPermissionMode("session-a", "plan");
      useSettingsStore.getState().setPermissionMode("session-b", "plan");
      useSessionStore.getState().setSessionId("session-a");

      render(<PlanApproval onSend={vi.fn()} disabled={false} />);
      fireEvent.click(screen.getByTestId("accept-plan"));

      expect(useSettingsStore.getState().getPermissionMode("session-a")).toBe("auto");
      expect(useSettingsStore.getState().getPermissionMode("session-b")).toBe("plan");
    });

    it("shows accepted confirmation after clicking accept", () => {
      const onSend = vi.fn();
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("accept-plan"));

      expect(screen.getByText(/Plan accepted/)).toBeInTheDocument();
      expect(screen.queryByTestId("accept-plan")).not.toBeInTheDocument();
      expect(screen.queryByTestId("suggest-changes")).not.toBeInTheDocument();
    });
  });

  describe("feedback flow", () => {
    it("shows feedback input when suggest changes is clicked", () => {
      render(<PlanApproval onSend={vi.fn()} disabled={false} />);

      fireEvent.click(screen.getByTestId("suggest-changes"));

      expect(screen.getByTestId("feedback-input")).toBeInTheDocument();
      expect(screen.getByTestId("send-feedback")).toBeInTheDocument();
    });

    it("calls onSend with feedback text without changing permission mode", () => {
      const onSend = vi.fn();
      useSettingsStore.getState().setPermissionMode("test-session", "plan");
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("suggest-changes"));
      fireEvent.change(screen.getByTestId("feedback-input"), { target: { value: "Add error handling" } });
      fireEvent.click(screen.getByTestId("send-feedback"));

      expect(onSend).toHaveBeenCalledWith("Add error handling");
      expect(useSettingsStore.getState().getPermissionMode("test-session")).toBe("plan");
    });

    it("submits feedback on Enter key", () => {
      const onSend = vi.fn();
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("suggest-changes"));
      const input = screen.getByTestId("feedback-input");
      fireEvent.change(input, { target: { value: "Use a different approach" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(onSend).toHaveBeenCalledWith("Use a different approach");
    });

    it("does not submit empty feedback", () => {
      const onSend = vi.fn();
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("suggest-changes"));
      fireEvent.click(screen.getByTestId("send-feedback"));

      expect(onSend).not.toHaveBeenCalled();
    });

    it("shows feedback confirmation after submitting", () => {
      const onSend = vi.fn();
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("suggest-changes"));
      fireEvent.change(screen.getByTestId("feedback-input"), { target: { value: "More tests" } });
      fireEvent.click(screen.getByTestId("send-feedback"));

      expect(screen.getByText(/Feedback sent/)).toBeInTheDocument();
      expect(screen.getByText("More tests")).toBeInTheDocument();
    });
  });

  describe("disabled state", () => {
    it("disables accept button when disabled", () => {
      render(<PlanApproval onSend={vi.fn()} disabled={true} />);
      expect(screen.getByTestId("accept-plan")).toBeDisabled();
    });

    it("does not call onSend when disabled", () => {
      const onSend = vi.fn();
      render(<PlanApproval onSend={onSend} disabled={true} />);

      fireEvent.click(screen.getByTestId("accept-plan"));

      expect(onSend).not.toHaveBeenCalled();
    });
  });

  // History-reload counterpart to AskUserQuestion's `resolvedAnswer` —
  // `resolved` is set when the agent's tool_result for ExitPlanMode has
  // already arrived, so the chat shouldn't expose the action buttons
  // again for a plan that's already been answered.
  describe("resolved (history reload)", () => {
    it("renders read-only confirmation when resolved is true", () => {
      const onSend = vi.fn();
      render(<PlanApproval onSend={onSend} disabled={false} resolved={true} />);
      expect(screen.queryByTestId("accept-plan")).not.toBeInTheDocument();
      expect(screen.queryByTestId("suggest-changes")).not.toBeInTheDocument();
      expect(screen.getByText(/Plan resolved/)).toBeInTheDocument();
    });

    it("local accept flow takes precedence over resolved when both are set", () => {
      // Imagine a tool_result arrives mid-render — the local accept message
      // should still be shown, since the user just saw their click.
      const onSend = vi.fn();
      const { rerender } = render(<PlanApproval onSend={onSend} disabled={false} />);
      fireEvent.click(screen.getByTestId("accept-plan"));
      rerender(<PlanApproval onSend={onSend} disabled={false} resolved={true} />);
      expect(screen.getByText(/Plan accepted/)).toBeInTheDocument();
    });
  });
});
