import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { GitHubCreateRepoOverlay } from "./GitHubCreateRepoOverlay.js";

afterEach(cleanup);

describe("GitHubCreateRepoOverlay", () => {
  it("renders the dialog with heading", () => {
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Create GitHub Repository")).toBeInTheDocument();
  });

  it("displays the username", () => {
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("testuser")).toBeInTheDocument();
  });

  it("renders name and description inputs", () => {
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("A short description of the project")).toBeInTheDocument();
  });

  it("renders Public and Private visibility buttons", () => {
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("Private")).toBeInTheDocument();
  });

  it("Create Repository button is disabled when name is empty", () => {
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Create Repository")).toBeDisabled();
  });

  it("Create Repository button is enabled with valid name", () => {
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "valid-name" } });
    expect(screen.getByText("Create Repository")).not.toBeDisabled();
  });

  it("shows error for invalid repo name characters", () => {
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "invalid name!" } });
    expect(screen.getByText(/Only letters, numbers/)).toBeInTheDocument();
  });

  it("calls onSubmit with trimmed values when Create is clicked", () => {
    const onSubmit = vi.fn();
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={onSubmit} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "  my-repo  " } });
    fireEvent.change(screen.getByPlaceholderText("A short description of the project"), { target: { value: "  desc  " } });
    fireEvent.click(screen.getByText("Create Repository"));

    expect(onSubmit).toHaveBeenCalledWith("my-repo", "desc", false);
  });

  it("calls onSubmit with private=true when Private is selected", () => {
    const onSubmit = vi.fn();
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={onSubmit} onClose={vi.fn()} />);

    fireEvent.change(screen.getByPlaceholderText("my-project"), { target: { value: "my-repo" } });
    fireEvent.click(screen.getByText("Private"));
    fireEvent.click(screen.getByText("Create Repository"));

    expect(onSubmit).toHaveBeenCalledWith("my-repo", "", true);
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByPlaceholderText("my-project"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking the backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(<GitHubCreateRepoOverlay username="testuser" onSubmit={vi.fn()} onClose={onClose} />);
    const backdrop = container.firstElementChild!;
    fireEvent.mouseDown(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submits via Enter key when name is valid", () => {
    const onSubmit = vi.fn();
    render(<GitHubCreateRepoOverlay username="testuser" onSubmit={onSubmit} onClose={vi.fn()} />);

    const input = screen.getByPlaceholderText("my-project");
    fireEvent.change(input, { target: { value: "my-repo" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("my-repo", "", false);
  });
});
