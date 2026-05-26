import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarkdownSelectionComments, type SelectionCommentData } from "./MarkdownSelectionComments.js";

afterEach(cleanup);

const SAMPLE_DOC = `Intro paragraph.

## Architecture

Architecture body with details.

## Testing

Testing body lives here.
`;

function makeProps(overrides?: {
  comments?: SelectionCommentData[];
  onAddComment?: (quotedText: string, contextBefore: string, contextAfter: string, text: string) => void;
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

describe("MarkdownSelectionComments", () => {
  describe("rendering", () => {
    it("renders all top-level markdown blocks", () => {
      render(<MarkdownSelectionComments {...makeProps()} />);
      expect(screen.getByText("Architecture")).toBeInTheDocument();
      expect(screen.getByText("Testing")).toBeInTheDocument();
      expect(screen.getByText("Intro paragraph.")).toBeInTheDocument();
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
      render(<MarkdownSelectionComments {...makeProps({ content })} />);
      expect(screen.getByText("Planned")).toBeInTheDocument();
      expect(screen.getByText("High priority")).toBeInTheDocument();
      expect(
        screen.getByText("Align spawned sessions with the user path."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/status: planned/)).not.toBeInTheDocument();
    });

    it("does NOT render a per-section + button (selection-driven only)", () => {
      render(<MarkdownSelectionComments {...makeProps()} />);
      expect(screen.queryByTitle("Add comment to this section")).not.toBeInTheDocument();
    });
  });

  describe("displaying existing comments", () => {
    const comments: SelectionCommentData[] = [
      {
        id: "c1",
        quotedText: "Architecture body",
        contextBefore: "",
        contextAfter: "",
        text: "human comment",
        source: "human",
      },
      {
        id: "c2",
        quotedText: "Architecture body",
        contextBefore: "",
        contextAfter: "",
        text: "ai comment",
        source: "ai",
      },
    ];

    it("renders existing comment text", () => {
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      expect(screen.getByText("human comment")).toBeInTheDocument();
      expect(screen.getByText("ai comment")).toBeInTheDocument();
    });

    it("shows the quoted text inside each comment card", () => {
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      // Both the body paragraph and the two comment blockquotes contain this string.
      const matches = screen.getAllByText("Architecture body");
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    it("marks AI comments with an AI label", () => {
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      expect(screen.getByText("AI")).toBeInTheDocument();
    });

    it("does not show an AI label for human comments", () => {
      render(
        <MarkdownSelectionComments
          {...makeProps({
            comments: [
              {
                id: "c1",
                quotedText: "Architecture body",
                contextBefore: "",
                contextAfter: "",
                text: "x",
                source: "human",
              },
            ],
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
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "Architecture body",
          contextBefore: "",
          contextAfter: "",
          text: "old",
          source: "human",
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ comments, onEditComment })} />);

      await user.click(screen.getByTitle("Edit"));

      const textarea = screen.getByPlaceholderText(/Add a comment/) as HTMLTextAreaElement;
      expect(textarea.value).toBe("old");
      await user.clear(textarea);
      await user.type(textarea, "new text");
      await user.click(screen.getByText("Add"));
      expect(onEditComment).toHaveBeenCalledWith("c1", "new text");
    });

    it("closes the input on Escape", async () => {
      const user = userEvent.setup();
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "Architecture body",
          contextBefore: "",
          contextAfter: "",
          text: "old",
          source: "human",
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      await user.click(screen.getByTitle("Edit"));
      expect(screen.getByPlaceholderText(/Add a comment/)).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(screen.queryByPlaceholderText(/Add a comment/)).not.toBeInTheDocument();
    });
  });

  describe("deleting a comment", () => {
    it("calls onDeleteComment with the comment id", async () => {
      const user = userEvent.setup();
      const onDeleteComment = vi.fn();
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "Architecture body",
          contextBefore: "",
          contextAfter: "",
          text: "x",
          source: "human",
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ comments, onDeleteComment })} />);
      await user.click(screen.getByTitle("Delete"));
      expect(onDeleteComment).toHaveBeenCalledWith("c1");
    });
  });

  describe("orphaned comments", () => {
    it("renders comments whose quoted text is gone under a dedicated heading", () => {
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "this phrase has been deleted",
          contextBefore: "",
          contextAfter: "",
          text: "stale feedback",
          source: "human",
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      expect(screen.getByText("Orphaned comments")).toBeInTheDocument();
      expect(screen.getByText("stale feedback")).toBeInTheDocument();
    });

    it("anchored comments don't appear under the orphaned heading", () => {
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "Architecture body",
          contextBefore: "",
          contextAfter: "",
          text: "anchored note",
          source: "human",
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      expect(screen.queryByText("Orphaned comments")).not.toBeInTheDocument();
    });
  });

  describe("comment placement", () => {
    it("attaches each comment to the block whose text contains its quoted text", () => {
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "Testing body",
          contextBefore: "",
          contextAfter: "",
          text: "comment on testing",
          source: "human",
        },
      ];
      const { container } = render(
        <MarkdownSelectionComments {...makeProps({ comments })} />,
      );
      const testingPara = within(container).getByText("Testing body lives here.");
      // The comment card is rendered as a sibling of the paragraph's enclosing
      // block. Walk up to the block wrapper and confirm the comment text lives
      // in the same wrapper.
      const blockWrapper = testingPara.parentElement!.parentElement!;
      expect(within(blockWrapper).getByText("comment on testing")).toBeInTheDocument();
    });

    it("disambiguates duplicate quoted text by context", () => {
      const content = "First cat. Second cat.";
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "cat",
          contextBefore: "Second ",
          contextAfter: "",
          text: "about the second cat",
          source: "human",
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ content, comments })} />);
      expect(screen.getByText("about the second cat")).toBeInTheDocument();
      // Anchored (not orphaned) because the quoted text exists.
      expect(screen.queryByText("Orphaned comments")).not.toBeInTheDocument();
    });

    it("anchors comments to their own top-level block when quoted text is unique per block", () => {
      // docs/153 Phase 2: confirm the new mdast-split block boundaries route
      // each comment to the correct top-level block instead of dumping them
      // all onto the first one. Each comment quotes text that only appears in
      // one block so the assignment is unambiguous.
      const content = "First block mentions kestrels here.\n\nSecond block mentions albatross there.";
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "kestrels",
          contextBefore: "",
          contextAfter: "",
          text: "about kestrels",
          source: "human",
        },
        {
          id: "c2",
          quotedText: "albatross",
          contextBefore: "",
          contextAfter: "",
          text: "about albatross",
          source: "human",
        },
      ];
      const { container } = render(
        <MarkdownSelectionComments {...makeProps({ content, comments })} />,
      );
      const firstBlock = within(container).getByText(/First block/).parentElement!.parentElement!;
      const secondBlock = within(container).getByText(/Second block/).parentElement!.parentElement!;
      expect(within(firstBlock).getByText("about kestrels")).toBeInTheDocument();
      expect(within(firstBlock).queryByText("about albatross")).toBeNull();
      expect(within(secondBlock).getByText("about albatross")).toBeInTheDocument();
      expect(within(secondBlock).queryByText("about kestrels")).toBeNull();
    });

    it("anchors a comment that selects across a code-block boundary into the block whose text contains it", () => {
      // Selections near block boundaries (heading → fenced code, code → next
      // paragraph) used to be a hazard with the marked + DOMParser pipeline
      // because the splitter normalised whitespace differently than the
      // rendered DOM. Pin the mdast-split boundary so that quoted text from
      // inside a fenced code block routes to that code block's wrapper.
      const content = "Header text.\n\n```\nspecial_token_inside_code\n```\n\nFollowing paragraph.";
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "special_token_inside_code",
          contextBefore: "",
          contextAfter: "",
          text: "about the code",
          source: "human",
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ content, comments })} />);
      expect(screen.getByText("about the code")).toBeInTheDocument();
      expect(screen.queryByText("Orphaned comments")).not.toBeInTheDocument();
    });
  });

  describe("heading rendering", () => {
    it("renders headings as plain elements without wrapping anchors", () => {
      const { container } = render(<MarkdownSelectionComments {...makeProps()} />);
      const heading = container.querySelector("h2");
      expect(heading).toBeInTheDocument();
      expect(heading?.textContent).toBe("Architecture");
      // The docs viewer has no deep-linking affordance, so headings should not
      // be wrapped by `rehype-autolink-headings` anchors.
      expect(heading?.querySelector("a")).toBeNull();
    });
  });
});
