import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GitHubAuthOverlay } from "./GitHubAuthOverlay.js";

afterEach(cleanup);

const defaultProps = {
  onSubmit: vi.fn(),
  onClose: vi.fn(),
  onStartDeviceAuth: vi.fn(),
};

describe("GitHubAuthOverlay — default view", () => {
  it("renders the dialog with heading", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    expect(screen.getByText("Connect to GitHub")).toBeInTheDocument();
  });

  it("renders Sign in with GitHub button", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    expect(screen.getByText("Sign in with GitHub")).toBeInTheDocument();
  });

  it("Sign in with GitHub button calls onStartDeviceAuth", () => {
    const onStartDeviceAuth = vi.fn();
    render(<GitHubAuthOverlay {...defaultProps} onStartDeviceAuth={onStartDeviceAuth} />);
    fireEvent.click(screen.getByText("Sign in with GitHub"));
    expect(onStartDeviceAuth).toHaveBeenCalledOnce();
  });

  it("renders the manual token divider", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    expect(screen.getByText("or enter a token manually")).toBeInTheDocument();
  });

  it("renders a password input field", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("renders Cancel and Connect buttons", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  it("Connect button is disabled when input is empty", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    const connectBtn = screen.getByText("Connect");
    expect(connectBtn).toBeDisabled();
  });

  it("Connect button is enabled when input has a value", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.change(input, { target: { value: "ghp_test123" } });

    const connectBtn = screen.getByText("Connect");
    expect(connectBtn).not.toBeDisabled();
  });

  it("calls onSubmit with trimmed token when Connect is clicked", () => {
    const onSubmit = vi.fn();
    render(<GitHubAuthOverlay {...defaultProps} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.change(input, { target: { value: "  ghp_test123  " } });
    fireEvent.click(screen.getByText("Connect"));

    expect(onSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("calls onSubmit when Enter is pressed in the input", () => {
    const onSubmit = vi.fn();
    render(<GitHubAuthOverlay {...defaultProps} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.change(input, { target: { value: "ghp_test123" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("does not call onSubmit when Enter is pressed with empty input", () => {
    const onSubmit = vi.fn();
    render(<GitHubAuthOverlay {...defaultProps} onSubmit={onSubmit} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<GitHubAuthOverlay {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<GitHubAuthOverlay {...defaultProps} onClose={onClose} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking the backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(<GitHubAuthOverlay {...defaultProps} onClose={onClose} />);
    // The backdrop is the outermost div with the fixed class
    const backdrop = container.firstElementChild!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when clicking inside the modal", () => {
    const onClose = vi.fn();
    render(<GitHubAuthOverlay {...defaultProps} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("Connect to GitHub"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("links to GitHub token settings", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    const link = screen.getByText("GitHub Settings");
    expect(link).toHaveAttribute("href", "https://github.com/settings/tokens/new");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("mentions that a classic token is required", () => {
    render(<GitHubAuthOverlay {...defaultProps} />);
    expect(screen.getByText("classic")).toBeInTheDocument();
    expect(screen.getByText(/fine-grained tokens are not supported/i)).toBeInTheDocument();
  });
});

describe("GitHubAuthOverlay — device code view", () => {
  const deviceAuthCode = {
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
  };

  it("renders device code when deviceAuthCode is provided", () => {
    render(
      <GitHubAuthOverlay {...defaultProps} deviceAuthCode={deviceAuthCode} />,
    );
    expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
  });

  it("renders the instruction text", () => {
    render(
      <GitHubAuthOverlay {...defaultProps} deviceAuthCode={deviceAuthCode} />,
    );
    expect(screen.getByText("Enter this code on GitHub:")).toBeInTheDocument();
  });

  it("renders a Copy button", () => {
    render(
      <GitHubAuthOverlay {...defaultProps} deviceAuthCode={deviceAuthCode} />,
    );
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });

  it("renders the verification link", () => {
    render(
      <GitHubAuthOverlay {...defaultProps} deviceAuthCode={deviceAuthCode} />,
    );
    const link = screen.getByText(/Open github.com\/login\/device/);
    expect(link).toHaveAttribute("href", "https://github.com/login/device");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows waiting for authorization indicator", () => {
    render(
      <GitHubAuthOverlay {...defaultProps} deviceAuthCode={deviceAuthCode} />,
    );
    expect(screen.getByText("Waiting for authorization...")).toBeInTheDocument();
  });

  it("shows cancel button", () => {
    const onClose = vi.fn();
    render(
      <GitHubAuthOverlay {...defaultProps} onClose={onClose} deviceAuthCode={deviceAuthCode} />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not show PAT input in device code view", () => {
    render(
      <GitHubAuthOverlay {...defaultProps} deviceAuthCode={deviceAuthCode} />,
    );
    expect(screen.queryByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx")).not.toBeInTheDocument();
  });

  it("shows error message when device auth has error alongside code", () => {
    render(
      <GitHubAuthOverlay
        {...defaultProps}
        deviceAuthCode={deviceAuthCode}
        deviceAuthError="Something went wrong"
      />,
    );
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  });
});

describe("GitHubAuthOverlay — error view", () => {
  it("shows error message when device auth failed", () => {
    render(
      <GitHubAuthOverlay
        {...defaultProps}
        deviceAuthError="Authorization code expired. Please try again."
      />,
    );
    expect(screen.getByText("Authorization code expired. Please try again.")).toBeInTheDocument();
  });

  it("shows Try Again button", () => {
    const onStartDeviceAuth = vi.fn();
    render(
      <GitHubAuthOverlay
        {...defaultProps}
        onStartDeviceAuth={onStartDeviceAuth}
        deviceAuthError="Expired"
      />,
    );
    fireEvent.click(screen.getByText("Try Again"));
    expect(onStartDeviceAuth).toHaveBeenCalledOnce();
  });

  it("shows Cancel button", () => {
    const onClose = vi.fn();
    render(
      <GitHubAuthOverlay
        {...defaultProps}
        onClose={onClose}
        deviceAuthError="Expired"
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not show PAT input in error view", () => {
    render(
      <GitHubAuthOverlay
        {...defaultProps}
        deviceAuthError="Expired"
      />,
    );
    expect(screen.queryByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx")).not.toBeInTheDocument();
  });
});
