import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { OnboardingWizard } from "./OnboardingWizard.js";

afterEach(cleanup);

const defaultProps = () => ({
  onGitIdentitySubmit: vi.fn(),
  onGitHubTokenSubmit: vi.fn().mockResolvedValue(true),
  agents: [
    { id: "claude", name: "Claude Code", installed: true, authConfigured: true, models: ["claude-sonnet"] },
    { id: "codex", name: "Codex", installed: true, authConfigured: false, models: ["codex-mini"] },
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
    it("renders step 1 with GitHub heading", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    });

    it("renders step dots with step 1 active", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByTestId("step-dots")).toBeInTheDocument();
    });

    it("renders a token input", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByTestId("github-token-input")).toBeInTheDocument();
    });

    it("Connect button is disabled when token is empty", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      expect(screen.getByTestId("github-connect")).toBeDisabled();
    });

    it("Connect button is enabled when token has a value", () => {
      render(<OnboardingWizard {...defaultProps()} />);
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      expect(screen.getByTestId("github-connect")).not.toBeDisabled();
    });

    it("calls onGitHubTokenSubmit with trimmed token when Connect is clicked", async () => {
      const props = defaultProps();
      render(<OnboardingWizard {...props} />);
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "  ghp_abc  " } });
      fireEvent.click(screen.getByTestId("github-connect"));
      await waitFor(() => {
        expect(props.onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_abc");
      });
    });

    it("calls onGitHubTokenSubmit when Enter is pressed with a token", async () => {
      const props = defaultProps();
      render(<OnboardingWizard {...props} />);
      const input = screen.getByTestId("github-token-input");
      fireEvent.change(input, { target: { value: "ghp_abc" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        expect(props.onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_abc");
      });
    });

    it("shows loading state while submitting", async () => {
      let resolve!: (value: boolean) => void;
      const promise = new Promise<boolean>((r) => { resolve = r; });
      const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockReturnValue(promise) };
      render(<OnboardingWizard {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByText("Connecting...")).toBeInTheDocument();
      });
      expect(screen.getByTestId("github-connect")).toBeDisabled();
      expect(screen.getByTestId("github-token-input")).toBeDisabled();

      resolve(true);
    });

    it("shows error when onGitHubTokenSubmit returns false", async () => {
      const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockResolvedValue(false) };
      render(<OnboardingWizard {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("github-error")).toBeInTheDocument();
      });
    });

    it("clears error when user edits token", async () => {
      const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockResolvedValue(false) };
      render(<OnboardingWizard {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("github-error")).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_retry" } });
      expect(screen.queryByTestId("github-error")).not.toBeInTheDocument();
    });

    it("shows error when onGitHubTokenSubmit throws", async () => {
      const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockRejectedValue(new Error("network")) };
      render(<OnboardingWizard {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("github-error")).toBeInTheDocument();
      });
    });

    it("advances to step 2 on successful GitHub connect", async () => {
      const props = defaultProps();
      render(<OnboardingWizard {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByText("Agent Setup")).toBeInTheDocument();
      });
      expect(props.onComplete).not.toHaveBeenCalled();
    });

    it("does NOT call onComplete when GitHub connect succeeds", async () => {
      const props = defaultProps();
      render(<OnboardingWizard {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByText("Agent Setup")).toBeInTheDocument();
      });
      expect(props.onComplete).not.toHaveBeenCalled();
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

    it("Save button is disabled when only name is filled", () => {
      renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
      expect(screen.getByTestId("manual-save")).toBeDisabled();
    });

    it("Save button is disabled when only email is filled", () => {
      renderManual();
      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
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

    it("calls onGitIdentitySubmit when Enter is pressed with both fields filled", () => {
      const { onGitIdentitySubmit } = renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
      const emailInput = screen.getByPlaceholderText("you@example.com");
      fireEvent.change(emailInput, { target: { value: "test@example.com" } });
      fireEvent.keyDown(emailInput, { key: "Enter" });
      expect(onGitIdentitySubmit).toHaveBeenCalledWith("Test", "test@example.com");
    });

    it("does not call onGitIdentitySubmit when Enter is pressed with empty fields", () => {
      const { onGitIdentitySubmit } = renderManual();
      fireEvent.keyDown(screen.getByPlaceholderText("Your Name"), { key: "Enter" });
      expect(onGitIdentitySubmit).not.toHaveBeenCalled();
    });

    it("renders 'Connect GitHub instead' link", () => {
      renderManual();
      expect(screen.getByTestId("switch-github")).toBeInTheDocument();
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
      fireEvent.click(screen.getByTestId("github-connect"));
      return { result, props };
    }

    it("renders Agent Setup heading", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByText("Agent Setup")).toBeInTheDocument();
      });
    });

    it("renders Claude agent card with status", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("claude-agent-card")).toBeInTheDocument();
        expect(screen.getByText("Claude Code")).toBeInTheDocument();
        expect(screen.getByText("Authenticated")).toBeInTheDocument();
      });
    });

    it("renders Codex agent card with needs-auth status", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("codex-agent-card")).toBeInTheDocument();
        expect(screen.getByText("Codex")).toBeInTheDocument();
        expect(screen.getByText("API key not set")).toBeInTheDocument();
      });
    });

    it("shows API key input for unauthenticated Codex", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("codex-api-key-input")).toBeInTheDocument();
        expect(screen.getByTestId("codex-api-key-submit")).toBeInTheDocument();
      });
    });

    it("does not show API key input for authenticated Claude", async () => {
      renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("claude-agent-card")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("claude-api-key-input")).not.toBeInTheDocument();
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
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [] },
          { id: "codex", name: "Codex", installed: true, authConfigured: false, models: [] },
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

    it("calls onCodexApiKeySubmit when Codex key is submitted", async () => {
      const { props } = renderStep2();
      await waitFor(() => {
        expect(screen.getByTestId("codex-api-key-input")).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId("codex-api-key-input"), { target: { value: "sk-test" } });
      fireEvent.click(screen.getByTestId("codex-api-key-submit"));
      await waitFor(() => {
        expect(props.onCodexApiKeySubmit).toHaveBeenCalledWith("sk-test");
      });
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

    it("shows Claude login button when Claude needs auth and no authUrl", async () => {
      renderStep2({
        agents: [
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [] },
        ],
      });
      await waitFor(() => {
        expect(screen.getByTestId("claude-start-auth")).toBeInTheDocument();
      });
    });

    it("calls onStartClaudeAuth when Login with Claude is clicked", async () => {
      const { props } = renderStep2({
        agents: [
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [] },
        ],
      });
      await waitFor(() => {
        expect(screen.getByTestId("claude-start-auth")).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId("claude-start-auth"));
      expect(props.onStartClaudeAuth).toHaveBeenCalled();
    });

    it("shows OAuth flow when authUrl is set and Claude needs auth", async () => {
      renderStep2({
        agents: [
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [] },
        ],
        authUrl: "https://auth.example.com/login",
      });
      await waitFor(() => {
        expect(screen.getByTestId("claude-oauth-flow")).toBeInTheDocument();
        expect(screen.getByTestId("claude-open-auth-url")).toBeInTheDocument();
        expect(screen.getByTestId("claude-auth-code-input")).toBeInTheDocument();
      });
    });

    it("calls onPasteAuthCode when auth code is submitted", async () => {
      const { props } = renderStep2({
        agents: [
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [] },
        ],
        authUrl: "https://auth.example.com/login",
      });
      await waitFor(() => {
        expect(screen.getByTestId("claude-auth-code-input")).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId("claude-auth-code-input"), { target: { value: "  auth-code-123  " } });
      fireEvent.click(screen.getByTestId("claude-auth-code-submit"));
      expect(props.onPasteAuthCode).toHaveBeenCalledWith("auth-code-123");
    });

    it("shows Claude API key input when Claude needs auth and no authUrl", async () => {
      renderStep2({
        agents: [
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [] },
        ],
      });
      await waitFor(() => {
        expect(screen.getByTestId("claude-api-key-input")).toBeInTheDocument();
      });
    });

    it("calls onClaudeApiKeySubmit when Claude key is submitted", async () => {
      const { props } = renderStep2({
        agents: [
          { id: "claude", name: "Claude Code", installed: true, authConfigured: false, models: [] },
        ],
      });
      await waitFor(() => {
        expect(screen.getByTestId("claude-api-key-input")).toBeInTheDocument();
      });
      fireEvent.change(screen.getByTestId("claude-api-key-input"), { target: { value: "sk-ant-test" } });
      fireEvent.click(screen.getByTestId("claude-api-key-submit"));
      await waitFor(() => {
        expect(props.onClaudeApiKeySubmit).toHaveBeenCalledWith("sk-ant-test");
      });
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
