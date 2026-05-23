import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownSectionComments, type SectionCommentData } from "./MarkdownSectionComments.js";

afterEach(cleanup);

const SAMPLE_DOC = `Intro paragraph.

## Architecture

Architecture body.

## Testing

Testing body.
`;

function makeProps(overrides?: {
  comments?: SectionCommentData[];
  onAddComment?: (sectionHeading: string, sectionIndex: number, text: string) => void;
  onEditComment?: (commentId: string, text: string) => void;
  onDeleteComment?: (commentId: string) => void;
  content?: string;
}) {
  return {
    content: overrides?.content ?? SAMPLE_DOC,
    comments: overrides?.comments ?? [],
    onAddComment: overrides?.onAddComment ?? (() => {}),
    onEditComment: overrides?.onEditComment ?? (() => {}),
    onDeleteComment: overrides?.onDeleteComment ?? (() => {}),
  };
}

describe("MarkdownSectionComments", () => {
  describe("rendering", () => {
    it("renders all H2 sections from the markdown", () => {
      render(<MarkdownSectionComments {...makeProps()} />);
      expect(screen.getByText("Architecture")).toBeInTheDocument();
      expect(screen.getByText("Testing")).toBeInTheDocument();
    });

    it("renders the preamble (content before the first ## heading)", () => {
      render(<MarkdownSectionComments {...makeProps()} />);
      expect(screen.getByText("Intro paragraph.")).toBeInTheDocument();
    });

    it("shows an add button for each section", () => {
      render(<MarkdownSectionComments {...makeProps()} />);
      const buttons = screen.getAllByTitle("Add comment to this section");
      // 1 preamble + 2 sections = 3 buttons
      expect(buttons).toHaveLength(3);
    });

    it("renders YAML frontmatter as a styled header and strips it from the body", () => {
      const content = `---
status: planned
priority: high
description: Align spawned sessions with the user path.
---

# Align agent-spawned session startup

Context body.
`;
      render(<MarkdownSectionComments {...makeProps({ content })} />);
      // Typed fields render as badges / description, not as raw text.
      expect(screen.getByText("Planned")).toBeInTheDocument();
      expect(screen.getByText("High priority")).toBeInTheDocument();
      expect(
        screen.getByText("Align spawned sessions with the user path."),
      ).toBeInTheDocument();
      // And the raw `status: planned …` paragraph should be gone.
      expect(screen.queryByText(/status: planned/)).not.toBeInTheDocument();
    });
  });

  describe("adding a comment", () => {
    it("opens an input when [+] is clicked", async () => {
      const user = userEvent.setup();
      render(<MarkdownSectionComments {...makeProps()} />);
      const buttons = screen.getAllByTitle("Add comment to this section");
      await user.click(buttons[1]); // first ## section
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeInTheDocument();
    });

    it("calls onAddComment with section heading and index when submitted", async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(<MarkdownSectionComments {...makeProps({ onAddComment })} />);
      const buttons = screen.getAllByTitle("Add comment to this section");
      await user.click(buttons[1]); // ## Architecture
      const textarea = screen.getByPlaceholderText(/Add a comment/);
      await user.type(textarea, "needs work");
      await user.click(screen.getByText("Add"));
      expect(onAddComment).toHaveBeenCalledWith("## Architecture", 1, "needs work");
    });

    it("submits via Cmd+Enter", async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(<MarkdownSectionComments {...makeProps({ onAddComment })} />);
      await user.click(screen.getAllByTitle("Add comment to this section")[1]);
      const textarea = screen.getByPlaceholderText(/Add a comment/);
      await user.type(textarea, "feedback");
      // Use fireEvent for keyDown with metaKey since user-event lacks meta+enter shorthand on textarea
      fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
      expect(onAddComment).toHaveBeenCalledWith("## Architecture", 1, "feedback");
    });

    it("does not submit empty text", async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(<MarkdownSectionComments {...makeProps({ onAddComment })} />);
      await user.click(screen.getAllByTitle("Add comment to this section")[1]);
      const addBtn = screen.getByText("Add") as HTMLButtonElement;
      expect(addBtn.disabled).toBe(true);
      await user.click(addBtn);
      expect(onAddComment).not.toHaveBeenCalled();
    });

    it("closes the input on Cancel without calling onAddComment", async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(<MarkdownSectionComments {...makeProps({ onAddComment })} />);
      await user.click(screen.getAllByTitle("Add comment to this section")[1]);
      await user.click(screen.getByText("Cancel"));
      expect(screen.queryByPlaceholderText(/Add a comment/)).not.toBeInTheDocument();
      expect(onAddComment).not.toHaveBeenCalled();
    });

    it("closes the input on Escape", async () => {
      const user = userEvent.setup();
      const onAddComment = vi.fn();
      render(<MarkdownSectionComments {...makeProps({ onAddComment })} />);
      await user.click(screen.getAllByTitle("Add comment to this section")[1]);
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByPlaceholderText(/Add a comment/)).not.toBeInTheDocument();
      expect(onAddComment).not.toHaveBeenCalled();
    });
  });

  describe("displaying existing comments", () => {
    const comments: SectionCommentData[] = [
      { id: "c1", sectionHeading: "## Architecture", sectionIndex: 1, text: "human comment", source: "human" },
      { id: "c2", sectionHeading: "## Architecture", sectionIndex: 1, text: "ai comment", source: "ai" },
    ];

    it("renders existing comment text", () => {
      render(<MarkdownSectionComments {...makeProps({ comments })} />);
      expect(screen.getByText("human comment")).toBeInTheDocument();
      expect(screen.getByText("ai comment")).toBeInTheDocument();
    });

    it("marks AI comments with an AI label", () => {
      render(<MarkdownSectionComments {...makeProps({ comments })} />);
      expect(screen.getByText("AI")).toBeInTheDocument();
    });

    it("does not show an AI label for human comments", () => {
      render(
        <MarkdownSectionComments
          {...makeProps({
            comments: [{ id: "c1", sectionHeading: "## Architecture", sectionIndex: 1, text: "x", source: "human" }],
          })}
        />,
      );
      expect(screen.queryByText("AI")).not.toBeInTheDocument();
    });
  });

  describe("editing a comment", () => {
    it("calls onEditComment with new text", async () => {
      const user = userEvent.setup();
      const onEditComment = vi.fn();
      const comments: SectionCommentData[] = [
        { id: "c1", sectionHeading: "## Architecture", sectionIndex: 1, text: "old", source: "human" },
      ];
      render(<MarkdownSectionComments {...makeProps({ comments, onEditComment })} />);

      // Edit button is hover-only — find it by title
      await user.click(screen.getByTitle("Edit"));

      const textarea = screen.getByPlaceholderText(/Add a comment/) as HTMLTextAreaElement;
      expect(textarea.value).toBe("old");
      await user.clear(textarea);
      await user.type(textarea, "new text");
      await user.click(screen.getByText("Add"));
      expect(onEditComment).toHaveBeenCalledWith("c1", "new text");
    });
  });

  describe("deleting a comment", () => {
    it("calls onDeleteComment with the comment id", async () => {
      const user = userEvent.setup();
      const onDeleteComment = vi.fn();
      const comments: SectionCommentData[] = [
        { id: "c1", sectionHeading: "## Architecture", sectionIndex: 1, text: "x", source: "human" },
      ];
      render(<MarkdownSectionComments {...makeProps({ comments, onDeleteComment })} />);
      await user.click(screen.getByTitle("Delete"));
      expect(onDeleteComment).toHaveBeenCalledWith("c1");
    });
  });

  describe("comment placement", () => {
    it("renders comments by matching the heading text first", () => {
      // Reordering sections: comment.sectionIndex points at original 1, but heading still matches
      const reordered = `## Testing\n\nT body.\n\n## Architecture\n\nA body.\n`;
      const comments: SectionCommentData[] = [
        { id: "c1", sectionHeading: "## Architecture", sectionIndex: 1, text: "anchored", source: "human" },
      ];
      const { container } = render(
        <MarkdownSectionComments {...makeProps({ content: reordered, comments })} />,
      );
      // Find the "Architecture" heading and verify the comment is rendered in the same section
      const archHeading = within(container).getByText("Architecture");
      // climb up to the section wrapper
      const section = archHeading.closest(".group\\/section");
      expect(section).not.toBeNull();
      expect(within(section as HTMLElement).getByText("anchored")).toBeInTheDocument();
    });
  });
});
