import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { PullRequestModal, type PullRequestModalProps } from "./PullRequestModal.js";

afterEach(cleanup);

const defaultProps: PullRequestModalProps = {
  currentBranch: "feature-branch",
  remoteBranches: ["main", "develop"],
  onSubmit: vi.fn(),
  onRequestBranches: vi.fn(),
  onClose: vi.fn(),
  result: null,
};

describe("PullRequestModal", () => {
  it("renders with branch and title fields", () => {
    render(<PullRequestModal {...defaultProps} />);
    expect(screen.getByText("Create Pull Request")).toBeInTheDocument();
    expect(screen.getByText("feature-branch")).toBeInTheDocument();
    expect(screen.getByLabelText("Base branch")).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeInTheDocument();
    expect(screen.getByLabelText("Description")).toBeInTheDocument();
  });

  it("calls onRequestBranches on mount", () => {
    const onRequestBranches = vi.fn();
    render(<PullRequestModal {...defaultProps} onRequestBranches={onRequestBranches} />);
    expect(onRequestBranches).toHaveBeenCalled();
  });

  it("submits with correct data", () => {
    const onSubmit = vi.fn();
    render(<PullRequestModal {...defaultProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Add authentication" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Added JWT auth" },
    });
    fireEvent.click(screen.getByText("Create PR"));

    expect(onSubmit).toHaveBeenCalledWith({
      title: "Add authentication",
      body: "Added JWT auth",
      base: "main",
      draft: false,
    });
  });

  it("shows validation error when title is empty", () => {
    const onSubmit = vi.fn();
    render(<PullRequestModal {...defaultProps} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByText("Create PR"));

    expect(screen.getByText("PR title is required")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("draft checkbox toggles draft state", () => {
    const onSubmit = vi.fn();
    render(<PullRequestModal {...defaultProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Draft PR" },
    });
    fireEvent.click(screen.getByLabelText("Create as draft"));
    fireEvent.click(screen.getByText("Create PR"));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ draft: true }),
    );
  });

  it("shows success state with PR URL", () => {
    render(
      <PullRequestModal
        {...defaultProps}
        result={{
          success: true,
          url: "https://github.com/user/repo/pull/42",
          number: 42,
        }}
      />,
    );

    expect(screen.getByText(/Pull request #42 created successfully/)).toBeInTheDocument();
    const link = screen.getByText("https://github.com/user/repo/pull/42");
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://github.com/user/repo/pull/42");
  });

  it("shows error message from server", () => {
    render(
      <PullRequestModal
        {...defaultProps}
        result={{
          success: false,
          message: "Validation Failed",
        }}
      />,
    );

    expect(screen.getByText("Validation Failed")).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<PullRequestModal {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    render(<PullRequestModal {...defaultProps} onClose={onClose} />);

    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("auto-selects 'main' as default base branch", () => {
    render(<PullRequestModal {...defaultProps} />);
    const select = screen.getByLabelText("Base branch") as HTMLSelectElement;
    expect(select.value).toBe("main");
  });

  it("auto-selects 'master' when main is not available", () => {
    render(
      <PullRequestModal
        {...defaultProps}
        remoteBranches={["master", "develop"]}
      />,
    );
    const select = screen.getByLabelText("Base branch") as HTMLSelectElement;
    expect(select.value).toBe("master");
  });

  it("uses defaultTitle prop when provided", () => {
    render(
      <PullRequestModal
        {...defaultProps}
        defaultTitle="My PR Title"
      />,
    );
    const input = screen.getByLabelText("Title") as HTMLInputElement;
    expect(input.value).toBe("My PR Title");
  });

  // ---- AI PR Description tests ----

  it("shows 'Ask Claude to write description' button when onGenerateDescription is provided", () => {
    const onGenerate = vi.fn();
    render(
      <PullRequestModal {...defaultProps} onGenerateDescription={onGenerate} />,
    );
    expect(screen.getByText("Ask Claude to write description")).toBeInTheDocument();
  });

  it("does not show generate button when onGenerateDescription is not provided", () => {
    render(<PullRequestModal {...defaultProps} />);
    expect(screen.queryByText("Ask Claude to write description")).not.toBeInTheDocument();
  });

  it("calls onGenerateDescription when button is clicked with empty description", () => {
    const onGenerate = vi.fn();
    render(
      <PullRequestModal {...defaultProps} onGenerateDescription={onGenerate} />,
    );

    fireEvent.click(screen.getByText("Ask Claude to write description"));
    expect(onGenerate).toHaveBeenCalled();
  });

  it("shows loading state while generating description", () => {
    const onGenerate = vi.fn();
    render(
      <PullRequestModal
        {...defaultProps}
        onGenerateDescription={onGenerate}
        isGeneratingDescription={true}
      />,
    );

    const btn = screen.getByText("Generating...");
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("populates description textarea when generatedDescription arrives", () => {
    const desc = "## Summary\n\nGenerated text";
    render(
      <PullRequestModal
        {...defaultProps}
        onGenerateDescription={vi.fn()}
        generatedDescription={desc}
      />,
    );

    const textarea = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(textarea.value).toBe(desc);
  });

  it("shows replace confirmation when description already has content", () => {
    const onGenerate = vi.fn();
    render(
      <PullRequestModal {...defaultProps} onGenerateDescription={onGenerate} />,
    );

    // Type some existing description
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Existing description" },
    });

    // Click generate — should show confirmation
    fireEvent.click(screen.getByText("Ask Claude to write description"));
    expect(onGenerate).not.toHaveBeenCalled();
    expect(screen.getByText("Replace current description?")).toBeInTheDocument();

    // Confirm replacement
    fireEvent.click(screen.getByText("Yes, replace"));
    expect(onGenerate).toHaveBeenCalled();
    expect(screen.queryByText("Replace current description?")).not.toBeInTheDocument();
  });

  it("hides replace confirmation when 'No, keep it' is clicked", () => {
    render(
      <PullRequestModal {...defaultProps} onGenerateDescription={vi.fn()} />,
    );

    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Existing description" },
    });
    fireEvent.click(screen.getByText("Ask Claude to write description"));
    expect(screen.getByText("Replace current description?")).toBeInTheDocument();

    fireEvent.click(screen.getByText("No, keep it"));
    expect(screen.queryByText("Replace current description?")).not.toBeInTheDocument();
  });

  it("shows error message when description generation fails", () => {
    render(
      <PullRequestModal
        {...defaultProps}
        onGenerateDescription={vi.fn()}
        generateDescriptionError="Failed to generate description: timeout"
      />,
    );

    expect(screen.getByText("Failed to generate description: timeout")).toBeInTheDocument();
  });
});
