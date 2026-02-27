import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { GitIdentityOverlay } from "./GitIdentityOverlay.js";

afterEach(cleanup);

const defaultProps = () => ({
  onSubmit: vi.fn(),
  onGitHubTokenSubmit: vi.fn().mockResolvedValue(true),
});

describe("GitIdentityOverlay", () => {
  describe("GitHub mode (default)", () => {
    it("renders the GitHub heading", () => {
      render(<GitIdentityOverlay {...defaultProps()} />);
      expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    });

    it("renders a token input", () => {
      render(<GitIdentityOverlay {...defaultProps()} />);
      expect(screen.getByTestId("github-token-input")).toBeInTheDocument();
    });

    it("Connect button is disabled when token is empty", () => {
      render(<GitIdentityOverlay {...defaultProps()} />);
      expect(screen.getByTestId("github-connect")).toBeDisabled();
    });

    it("Connect button is enabled when token has a value", () => {
      render(<GitIdentityOverlay {...defaultProps()} />);
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      expect(screen.getByTestId("github-connect")).not.toBeDisabled();
    });

    it("calls onGitHubTokenSubmit with trimmed token when Connect is clicked", async () => {
      const props = defaultProps();
      render(<GitIdentityOverlay {...props} />);
      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "  ghp_abc  " } });
      fireEvent.click(screen.getByTestId("github-connect"));
      await waitFor(() => {
        expect(props.onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_abc");
      });
    });

    it("calls onGitHubTokenSubmit when Enter is pressed with a token", async () => {
      const props = defaultProps();
      render(<GitIdentityOverlay {...props} />);
      const input = screen.getByTestId("github-token-input");
      fireEvent.change(input, { target: { value: "ghp_abc" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => {
        expect(props.onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_abc");
      });
    });

    it("does not call onGitHubTokenSubmit when Enter is pressed with empty token", () => {
      const props = defaultProps();
      render(<GitIdentityOverlay {...props} />);
      fireEvent.keyDown(screen.getByTestId("github-token-input"), { key: "Enter" });
      expect(props.onGitHubTokenSubmit).not.toHaveBeenCalled();
    });

    it("shows loading state while submitting", async () => {
      let resolve!: (value: boolean) => void;
      const promise = new Promise<boolean>((r) => { resolve = r; });
      const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockReturnValue(promise) };
      render(<GitIdentityOverlay {...props} />);

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
      render(<GitIdentityOverlay {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_bad" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("github-error")).toBeInTheDocument();
      });
    });

    it("clears error when user edits token", async () => {
      const props = { ...defaultProps(), onGitHubTokenSubmit: vi.fn().mockResolvedValue(false) };
      render(<GitIdentityOverlay {...props} />);

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
      render(<GitIdentityOverlay {...props} />);

      fireEvent.change(screen.getByTestId("github-token-input"), { target: { value: "ghp_abc" } });
      fireEvent.click(screen.getByTestId("github-connect"));

      await waitFor(() => {
        expect(screen.getByTestId("github-error")).toBeInTheDocument();
      });
    });

    it("renders 'Set up manually instead' link", () => {
      render(<GitIdentityOverlay {...defaultProps()} />);
      expect(screen.getByTestId("switch-manual")).toBeInTheDocument();
      expect(screen.getByText("Set up manually instead")).toBeInTheDocument();
    });

    it("switches to manual mode when link is clicked", () => {
      render(<GitIdentityOverlay {...defaultProps()} />);
      fireEvent.click(screen.getByTestId("switch-manual"));
      expect(screen.getByText("Git Identity")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Your Name")).toBeInTheDocument();
    });
  });

  describe("Manual mode", () => {
    function renderManual(overrides = {}) {
      const props = { ...defaultProps(), ...overrides };
      const result = render(<GitIdentityOverlay {...props} />);
      fireEvent.click(screen.getByTestId("switch-manual"));
      return { ...result, ...props };
    }

    it("renders name and email inputs", () => {
      renderManual();
      expect(screen.getByPlaceholderText("Your Name")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
    });

    it("renders a Save button", () => {
      renderManual();
      expect(screen.getByText("Save")).toBeInTheDocument();
    });

    it("Save button is disabled when both inputs are empty", () => {
      renderManual();
      expect(screen.getByText("Save")).toBeDisabled();
    });

    it("Save button is disabled when only name is filled", () => {
      renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
      expect(screen.getByText("Save")).toBeDisabled();
    });

    it("Save button is disabled when only email is filled", () => {
      renderManual();
      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
      expect(screen.getByText("Save")).toBeDisabled();
    });

    it("Save button is enabled when both inputs have values", () => {
      renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "a@b.com" } });
      expect(screen.getByText("Save")).not.toBeDisabled();
    });

    it("calls onSubmit with trimmed name and email when Save is clicked", () => {
      const { onSubmit } = renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "  Test User  " } });
      fireEvent.change(screen.getByPlaceholderText("you@example.com"), { target: { value: "  test@example.com  " } });
      fireEvent.click(screen.getByText("Save"));
      expect(onSubmit).toHaveBeenCalledWith("Test User", "test@example.com");
    });

    it("calls onSubmit when Enter is pressed with both fields filled", () => {
      const { onSubmit } = renderManual();
      fireEvent.change(screen.getByPlaceholderText("Your Name"), { target: { value: "Test" } });
      const emailInput = screen.getByPlaceholderText("you@example.com");
      fireEvent.change(emailInput, { target: { value: "test@example.com" } });
      fireEvent.keyDown(emailInput, { key: "Enter" });
      expect(onSubmit).toHaveBeenCalledWith("Test", "test@example.com");
    });

    it("does not call onSubmit when Enter is pressed with empty fields", () => {
      const { onSubmit } = renderManual();
      fireEvent.keyDown(screen.getByPlaceholderText("Your Name"), { key: "Enter" });
      expect(onSubmit).not.toHaveBeenCalled();
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

  it("does not dismiss when clicking the backdrop", () => {
    const props = defaultProps();
    const { container } = render(<GitIdentityOverlay {...props} />);
    const backdrop = container.firstElementChild!;
    fireEvent.mouseDown(backdrop);
    expect(screen.getByText("Connect GitHub")).toBeInTheDocument();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onGitHubTokenSubmit).not.toHaveBeenCalled();
  });
});
