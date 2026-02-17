import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GitHubAuthOverlay } from "./GitHubAuthOverlay.js";

afterEach(cleanup);

describe("GitHubAuthOverlay", () => {
  it("renders the dialog with heading", () => {
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Connect to GitHub")).toBeInTheDocument();
  });

  it("renders a password input field", () => {
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("renders Cancel and Connect buttons", () => {
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Cancel")).toBeInTheDocument();
    expect(screen.getByText("Connect")).toBeInTheDocument();
  });

  it("Connect button is disabled when input is empty", () => {
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={vi.fn()} />);
    const connectBtn = screen.getByText("Connect");
    expect(connectBtn).toBeDisabled();
  });

  it("Connect button is enabled when input has a value", () => {
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={vi.fn()} />);
    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.change(input, { target: { value: "ghp_test123" } });

    const connectBtn = screen.getByText("Connect");
    expect(connectBtn).not.toBeDisabled();
  });

  it("calls onSubmit with trimmed token when Connect is clicked", () => {
    const onSubmit = vi.fn();
    render(<GitHubAuthOverlay onSubmit={onSubmit} onClose={vi.fn()} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.change(input, { target: { value: "  ghp_test123  " } });
    fireEvent.click(screen.getByText("Connect"));

    expect(onSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("calls onSubmit when Enter is pressed in the input", () => {
    const onSubmit = vi.fn();
    render(<GitHubAuthOverlay onSubmit={onSubmit} onClose={vi.fn()} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.change(input, { target: { value: "ghp_test123" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("does not call onSubmit when Enter is pressed with empty input", () => {
    const onSubmit = vi.fn();
    render(<GitHubAuthOverlay onSubmit={onSubmit} onClose={vi.fn()} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={onClose} />);

    const input = screen.getByPlaceholderText("ghp_xxxxxxxxxxxxxxxxxxxx");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking the backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={onClose} />);
    // The backdrop is the outermost div with the fixed class
    const backdrop = container.firstElementChild!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not call onClose when clicking inside the modal", () => {
    const onClose = vi.fn();
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByText("Connect to GitHub"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("links to GitHub token settings", () => {
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={vi.fn()} />);
    const link = screen.getByText("GitHub Settings");
    expect(link).toHaveAttribute("href", "https://github.com/settings/tokens/new");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("mentions that a classic token is required", () => {
    render(<GitHubAuthOverlay onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("classic")).toBeInTheDocument();
    expect(screen.getByText(/fine-grained tokens are not supported/i)).toBeInTheDocument();
  });
});
