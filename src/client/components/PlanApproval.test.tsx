import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PlanApproval } from "./PlanApproval.js";
import { useSettingsStore } from "../stores/settings-store.js";

afterEach(() => {
  cleanup();
  useSettingsStore.getState().setPermissionMode("plan");
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
      useSettingsStore.getState().setPermissionMode("plan");
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("accept-plan"));

      expect(onSend).toHaveBeenCalledWith("Execute the plan you just described.");
      expect(useSettingsStore.getState().permissionMode).toBe("auto");
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
      useSettingsStore.getState().setPermissionMode("plan");
      render(<PlanApproval onSend={onSend} disabled={false} />);

      fireEvent.click(screen.getByTestId("suggest-changes"));
      fireEvent.change(screen.getByTestId("feedback-input"), { target: { value: "Add error handling" } });
      fireEvent.click(screen.getByTestId("send-feedback"));

      expect(onSend).toHaveBeenCalledWith("Add error handling");
      expect(useSettingsStore.getState().permissionMode).toBe("plan");
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
});
