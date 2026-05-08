import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard.js";

afterEach(cleanup);

const defaultProps = () => ({
  onGitIdentitySubmit: vi.fn(),
  onGitHubTokenSubmit: vi.fn().mockResolvedValue(true),
  agents: [
    { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet"], supportsReview: true },
    { id: "codex", name: "Codex", installed: true, authConfigured: false, models: ["codex-mini"], supportsReview: false },
  ],
  onClaudeApiKeySubmit: vi.fn().mockResolvedValue(true),
  onCodexApiKeySubmit: vi.fn().mockResolvedValue(true),
  onStartClaudeAuth: vi.fn(),
  authUrl: null as string | null,
  onPasteAuthCode: vi.fn(),
  onRefreshAgents: vi.fn().mockResolvedValue(undefined),
  onComplete: vi.fn(),
});

describe("OnboardingWizard", () => {
  describe("Step 1 — GitHub mode (default)", () => {
    it("renders step 1 with GitHub heading and token form", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
    });

    it("renders step dots with step 1 active", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByTestId("step-dots")).toBeInTheDocument();
    });

    it("advances to step 2 on successful GitHub connect", async () => {
      const props = defaultProps();
      render(<OnboardingWizard {...props} />);
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-token-submit"));
      await waitFor(() => {
        expect(screen.getByText("Agent Setup")).toBeInTheDocument();
      });
      expect(props.onComplete).not.toHaveBeenCalled();
    });

    it("does not advance to step 2 when token is invalid", async () => {
      const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockResolvedValue(false) };
      render(<OnboardingWizard {...props} />);
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
      fireEvent.click(screen.getByTestId("github-token-submit"));
      await waitFor(() => {
        expect(screen.getByTestId("github-token-error")).toBeInTheDocument();
      });
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    });

    it("renders 'Set up manually instead' link", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByTestId("switch-manual")).toBeInTheDocument();
    });

    it("switches to manual mode when link is clicked", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      fireEvent.click(screen.getByTestId("switch-manual"));
      expect(screen.getByText("Git Identity")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Your Name")).toBeInTheDocument();
    });
  });

  describe("Step 1 — Manual mode", () => {
    function renderManual(overrides = {}) {
      const props = { ...defaultProps(), ...overrides };
      const result = render(<OnboardingWizard {...props} />);
      fireEvent.click(screen.getByTestId("switch-manual"));
      return { ...result, ...props };
    }

    it("renders name and email inputs", () => {
      renderManual();
      expect(screen.getByPlaceholderText("Your Name")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
    });

    it("Save button is disabled when both inputs are empty", () => {
      renderManual();
      expect(screen.getByTestId("manual-save")).toBeDisabled();
    });

    it("Save button is enabled when both inputs have values", () => {
      renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
      expect(screen.getByTestId("manual-save")).not.toBeDisabled();
    });

    it("calls onGitIdentitySubmit with trimmed values and advances to step 2", () => {
      const { onGitIdentitySubmit } = renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "  Test User  " } });
      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "  test@example.com  " } });
      fireEvent.click(screen.getByTestId("manual-save"));
      expect(onGitIdentitySubmit).toHaveBeenCalledWith("Test User", "test@example.com");
      expect(screen.getByText("Agent Setup")).toBeInTheDocument();
    });

    it("switches back to GitHub mode when link is clicked", () => {
      renderManual();
      fireEvent.click(screen.getByTestId("switch-github"));
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    });
  });

  describe("Step 2 — Agent Setup", () => {
    function renderStep2(overrides = {}) {
      const props = { ...defaultProps(), ...overrides };
      const result = render(<OnboardingWizard {...props} />);
      // Complete step 1 via GitHub
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-token-submit"));
      return { result, props };
    }

    it("renders Agent Setup heading", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByText("Agent Setup")).toBeInTheDocument();
      });
    });

    it("renders ClaudeAuthCard and CodexAuthCard", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("claude-auth-card")).toBeInTheDocument();
        expect(screen.getByTestId("codex-auth-card")).toBeInTheDocument();
      });
    });

    it("Get Started is enabled when at least one agent is ready", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("get-started")).not.toBeDisabled();
      });
    });

    it("Get Started is disabled when no agents are ready", async () => {
      renderStep2({
        agents: [
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [], supportsReview: true },
          { id: "codex", name: "Codex", installed: true, authConfigured: false, models: [], supportsReview: false },
        ],
      });
      await waitFor(() => {
        expect(screen.getByTestId("get-started")).toBeDisabled();
      });
    });

    it("calls onComplete when Get Started is clicked", async () => {
      const { props } = renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("get-started")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("get-started"));
      expect(props.onComplete).toHaveBeenCalled();
    });

    it("calls onRefreshAgents when Refresh is clicked", async () => {
      const { props } = renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("refresh-agents")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("refresh-agents"));
      await waitFor(() => {
        expect(props.onRefreshAgents).toHaveBeenCalled();
      });
    });
  });

  describe("initialStep", () => {
    it("starts at step 2 when initialStep is 2", () => {
      render(<OnboardingWizard {...defaultProps()} initialStep={2} />);
      expect(screen.getByText("Agent Setup")).toBeInTheDocument();
      expect(screen.queryByText("Connect GitHub")).not.toBeInTheDocument();
    });

    it("navigates back to step 1 when initialStep changes from 2 to 1", () => {
      const props = defaultProps();
      const { rerender } = render(<OnboardingWizard {...props} initialStep={2} />);
      expect(screen.getByText("Agent Setup")).toBeInTheDocument();

      // Simulate git_identity_required arriving after wizard already opened at step 2
      rerender(<OnboardingWizard {...props} initialStep={1} />);
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      expect(screen.queryByText("Agent Setup")).not.toBeInTheDocument();
    });
  });

  it("does not dismiss when clicking the backdrop", () => {
    const props = defaultProps();
    const { container } = render(<OnboardingWizard {...props} />);
    const backdrop = container.firstElementChild!;
    fireEvent.mouseDown(backdrop);
    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    expect(props.onComplete).not.toHaveBeenCalled();
  });
});
