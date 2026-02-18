import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProjectSettings, type ProjectSettingsProps } from "./ProjectSettings.js";

afterEach(cleanup);

const defaultProps: ProjectSettingsProps = {
  initialContent: "",
  onSaveInstructions: vi.fn(),
  githubStatus: { authenticated: false },
  onGitHubTokenSubmit: vi.fn(),
  onGitHubLogout: vi.fn(),
  onClose: vi.fn(),
};

describe("ProjectSettings", () => {
  it("renders dialog with correct role and aria-label", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Project Settings");
  });

  it("renders header title", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("Project Settings")).toBeInTheDocument();
  });

  it("calls onClose on backdrop click", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("project-settings-backdrop"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does not close when clicking inside the modal", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText("Project Settings"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape key", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose on close button (x) click", () => {
    const onClose = vi.fn();
    render(<ProjectSettings {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ProjectSettings - GitHub tab", () => {
  it("shows GitHub tab by default", () => {
    render(<ProjectSettings {...defaultProps} />);
    const tab = screen.getByText("GitHub");
    expect(tab.className).toContain("font-medium");
  });

  it("shows token input when not authenticated", () => {
    render(<ProjectSettings {...defaultProps} />);
    const input = screen.getByTestId("project-settings-token-input");
    expect(input).toBeInTheDocument();
    expect(input).toHaveAttribute("type", "password");
  });

  it("Connect button is disabled when input is empty", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByTestId("project-settings-connect")).toBeDisabled();
  });

  it("Connect button is enabled when input has a value", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.change(screen.getByTestId("project-settings-token-input"), {
      target: { value: "ghp_test123" },
    });
    expect(screen.getByTestId("project-settings-connect")).not.toBeDisabled();
  });

  it("calls onGitHubTokenSubmit with trimmed token on Connect click", () => {
    const onGitHubTokenSubmit = vi.fn();
    render(<ProjectSettings {...defaultProps} onGitHubTokenSubmit={onGitHubTokenSubmit} />);
    fireEvent.change(screen.getByTestId("project-settings-token-input"), {
      target: { value: "  ghp_test123  " },
    });
    fireEvent.click(screen.getByTestId("project-settings-connect"));
    expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("calls onGitHubTokenSubmit on Enter in input", () => {
    const onGitHubTokenSubmit = vi.fn();
    render(<ProjectSettings {...defaultProps} onGitHubTokenSubmit={onGitHubTokenSubmit} />);
    const input = screen.getByTestId("project-settings-token-input");
    fireEvent.change(input, { target: { value: "ghp_test123" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onGitHubTokenSubmit).toHaveBeenCalledWith("ghp_test123");
  });

  it("does not call onGitHubTokenSubmit on Enter with empty input", () => {
    const onGitHubTokenSubmit = vi.fn();
    render(<ProjectSettings {...defaultProps} onGitHubTokenSubmit={onGitHubTokenSubmit} />);
    fireEvent.keyDown(screen.getByTestId("project-settings-token-input"), { key: "Enter" });
    expect(onGitHubTokenSubmit).not.toHaveBeenCalled();
  });

  it("shows connected state with username when authenticated", () => {
    render(
      <ProjectSettings
        {...defaultProps}
        githubStatus={{ authenticated: true, username: "octocat" }}
      />,
    );
    expect(screen.getByText("octocat")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("shows Disconnect button when authenticated", () => {
    render(
      <ProjectSettings
        {...defaultProps}
        githubStatus={{ authenticated: true, username: "octocat" }}
      />,
    );
    expect(screen.getByTestId("project-settings-disconnect")).toHaveTextContent("Disconnect");
  });

  it("Disconnect button requires double-click confirmation", () => {
    const onGitHubLogout = vi.fn();
    render(
      <ProjectSettings
        {...defaultProps}
        githubStatus={{ authenticated: true, username: "octocat" }}
        onGitHubLogout={onGitHubLogout}
      />,
    );
    const btn = screen.getByTestId("project-settings-disconnect");
    fireEvent.click(btn);
    expect(onGitHubLogout).not.toHaveBeenCalled();
    expect(btn).toHaveTextContent("Click again to disconnect");
    fireEvent.click(btn);
    expect(onGitHubLogout).toHaveBeenCalledOnce();
  });

  it("Disconnect confirmation resets on blur", () => {
    render(
      <ProjectSettings
        {...defaultProps}
        githubStatus={{ authenticated: true, username: "octocat" }}
      />,
    );
    const btn = screen.getByTestId("project-settings-disconnect");
    fireEvent.click(btn);
    expect(btn).toHaveTextContent("Click again to disconnect");
    fireEvent.blur(btn);
    expect(btn).toHaveTextContent("Disconnect");
  });

  it("links to GitHub token settings page", () => {
    render(<ProjectSettings {...defaultProps} />);
    const link = screen.getByText("GitHub Settings");
    expect(link).toHaveAttribute("href", "https://github.com/settings/tokens/new");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("mentions classic token requirement", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByText("classic")).toBeInTheDocument();
    expect(screen.getByText(/fine-grained tokens are not supported/i)).toBeInTheDocument();
  });
});

describe("ProjectSettings - Instructions tab", () => {
  function renderOnInstructionsTab(props: Partial<ProjectSettingsProps> = {}) {
    const result = render(<ProjectSettings {...defaultProps} {...props} />);
    fireEvent.click(screen.getByText("Instructions"));
    return result;
  }

  it("renders textarea with placeholder", () => {
    renderOnInstructionsTab();
    const textarea = screen.getByTestId("project-settings-textarea");
    expect(textarea).toHaveValue("");
    expect(textarea).toHaveAttribute("placeholder");
  });

  it("renders with existing content from initialContent", () => {
    renderOnInstructionsTab({ initialContent: "Always use TypeScript." });
    expect(screen.getByTestId("project-settings-textarea")).toHaveValue("Always use TypeScript.");
  });

  it("displays character count", () => {
    renderOnInstructionsTab({ initialContent: "Hello" });
    expect(screen.getByText("5 / 50,000")).toBeInTheDocument();
  });

  it("updates character count as user types", () => {
    renderOnInstructionsTab();
    fireEvent.change(screen.getByTestId("project-settings-textarea"), {
      target: { value: "Use strict mode." },
    });
    expect(screen.getByText("16 / 50,000")).toBeInTheDocument();
  });

  it("calls onSaveInstructions when Save is clicked", () => {
    const onSaveInstructions = vi.fn();
    renderOnInstructionsTab({ initialContent: "Original", onSaveInstructions });
    fireEvent.change(screen.getByTestId("project-settings-textarea"), {
      target: { value: "Updated content" },
    });
    fireEvent.click(screen.getByTestId("project-settings-save"));
    expect(onSaveInstructions).toHaveBeenCalledWith("Updated content");
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    renderOnInstructionsTab({ onClose });
    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("disables Save when content exceeds 50,000 characters", () => {
    renderOnInstructionsTab({ initialContent: "x".repeat(50_001) });
    expect(screen.getByTestId("project-settings-save")).toBeDisabled();
  });

  it("shows CLAUDE.md note", () => {
    renderOnInstructionsTab();
    expect(screen.getByText(/CLAUDE\.md/)).toBeInTheDocument();
  });

  it("calls onSaveInstructions on Ctrl+Enter", () => {
    const onSaveInstructions = vi.fn();
    renderOnInstructionsTab({ initialContent: "Test content", onSaveInstructions });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter", ctrlKey: true });
    expect(onSaveInstructions).toHaveBeenCalledWith("Test content");
  });

  it("saves with empty string when content is cleared", () => {
    const onSaveInstructions = vi.fn();
    renderOnInstructionsTab({ initialContent: "Existing", onSaveInstructions });
    fireEvent.change(screen.getByTestId("project-settings-textarea"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("project-settings-save"));
    expect(onSaveInstructions).toHaveBeenCalledWith("");
  });
});

describe("ProjectSettings - Tab switching", () => {
  it("GitHub tab is selected by default", () => {
    render(<ProjectSettings {...defaultProps} />);
    expect(screen.getByTestId("project-settings-token-input")).toBeInTheDocument();
  });

  it("clicking Instructions tab switches to instructions section", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByText("Instructions"));
    expect(screen.getByTestId("project-settings-textarea")).toBeInTheDocument();
    expect(screen.queryByTestId("project-settings-token-input")).not.toBeInTheDocument();
  });

  it("clicking GitHub tab switches back", () => {
    render(<ProjectSettings {...defaultProps} />);
    fireEvent.click(screen.getByText("Instructions"));
    fireEvent.click(screen.getByText("GitHub"));
    expect(screen.getByTestId("project-settings-token-input")).toBeInTheDocument();
    expect(screen.queryByTestId("project-settings-textarea")).not.toBeInTheDocument();
  });
});
