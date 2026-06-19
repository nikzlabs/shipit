import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard.js";

afterEach(cleanup);

const defaultProps = () => ({
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
  describe("Step 1 — Connect GitHub", () => {
    it("renders step 1 with GitHub heading and token form", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      expect(screen.getByTestId("github-token-form")).toBeInTheDocument();
    });

    it("renders step dots", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByTestId("step-dots")).toBeInTheDocument();
    });

    it("is GitHub-only — no manual / sandbox fallback door", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.queryByTestId("switch-manual")).not.toBeInTheDocument();
      expect(screen.queryByText("Set up manually instead")).not.toBeInTheDocument();
    });

    it("advances to step 2 on successful GitHub connect", async () => {
      const props = defaultProps();
      render(<OnboardingWizard {...props} />);
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-token-submit"));
      await waitFor(() => {
        expect(screen.getByText("Connect an agent")).toBeInTheDocument();
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
  });

  describe("Step 2 — Connect an agent", () => {
    function renderStep2(overrides = {}) {
      const props = { ...defaultProps(), ...overrides };
      const result = render(<OnboardingWizard {...props} />);
      // Complete step 1 via GitHub
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-token-submit"));
      return { result, props };
    }

    it("renders the agent heading", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByText("Connect an agent")).toBeInTheDocument();
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
      expect(screen.getByText("Connect an agent")).toBeInTheDocument();
      expect(screen.queryByText("Connect GitHub")).not.toBeInTheDocument();
    });

    it("navigates back to step 1 when initialStep changes from 2 to 1", () => {
      const props = defaultProps();
      const { rerender } = render(<OnboardingWizard {...props} initialStep={2} />);
      expect(screen.getByText("Connect an agent")).toBeInTheDocument();

      // Simulate git_identity_required arriving after wizard already opened at step 2
      rerender(<OnboardingWizard {...props} initialStep={1} />);
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
      expect(screen.queryByText("Connect an agent")).not.toBeInTheDocument();
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
