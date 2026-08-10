import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, within, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { MarkdownSelectionComments, type SelectionCommentData } from "./MarkdownSelectionComments.js";
import { useIssuesStore } from "../stores/issues-store.js";
import { useFileStore } from "../stores/file-store.js";
import { useUiStore } from "../stores/ui-store.js";

afterEach(cleanup);

/**
 * docs/248 — the doc's `issue:` pointer resolves against the trackers this
 * repository declares, and the browser's view of those is the Issues store's
 * tracker list. Declaring one is what makes the chip an in-app jump rather than
 * a legible badge.
 */
const DECLARED_LINEAR = {
  id: "linear:TRACKER" as const,
  kind: "linear" as const,
  label: "roadmap",
  name: "roadmap",
  configured: true,
  binding: { key: "TRACKER", name: "TRACKER" },
};

const SAMPLE_DOC = `Intro paragraph.

## Architecture

Architecture body with details.

## Testing

Testing body lives here.
`;

function makeProps(overrides?: {
  comments?: SelectionCommentData[];
  onAddComment?: (
    quotedText: string,
    contextBefore: string,
    contextAfter: string,
    text: string,
  ) => { id: string } | null | undefined | Promise<{ id: string } | null | undefined>;
  onEditComment?: (commentId: string, text: string) => void;
  onDeleteComment?: (commentId: string) => void;
  content?: string;
}) {
  return {
    content: overrides?.content ?? SAMPLE_DOC,
    comments: overrides?.comments ?? [],
    onAddComment: overrides?.onAddComment ?? (() => undefined),
    onEditComment: overrides?.onEditComment ?? (() => {}),
    onDeleteComment: overrides?.onDeleteComment ?? (() => {}),
  };
}

function textNodeContaining(root: HTMLElement, text: string, occurrence = 0): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes(text)) {
      if (seen === occurrence) return node;
      seen += 1;
    }
  }
  throw new Error(`Text node not found: ${text}`);
}

function selectText(root: HTMLElement, text: string, occurrence = 0): void {
  const node = textNodeContaining(root, text, occurrence);
  const start = node.data.indexOf(text);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  Object.defineProperty(range, "getClientRects", {
    value: vi.fn(() => [
      {
        width: 24,
        height: 16,
        top: 10,
        right: 34,
        bottom: 26,
        left: 10,
        x: 10,
        y: 10,
        toJSON: () => ({}),
      },
    ] as unknown as DOMRectList),
  });
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent(document, new Event("selectionchange"));
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
issue: https://linear.app/example/issue/TRACKER-28/decouple
description: Align spawned sessions with the user path.
---

# Align agent-spawned session startup

Context body.
`;
      useIssuesStore.setState({ trackers: [DECLARED_LINEAR] });
      render(<MarkdownSelectionComments {...makeProps({ content })} />);
      // The issue pointer renders as a jump-to-issue chip in the destination's
      // name form (req 15). A declared tracker opens the inline Issues view, so
      // it must NOT be an external link.
      const chip = screen.getByText("roadmap#TRACKER-28");
      expect(chip.closest("a")).toBeNull();
      expect(chip.closest("button")).toHaveAttribute("title", "Open roadmap#TRACKER-28 in ShipIt");
      expect(
        screen.getByText("Align spawned sessions with the user path."),
      ).toBeInTheDocument();
      expect(screen.queryByText(/issue: https/)).not.toBeInTheDocument();
    });

    it("opens the frontmatter issue pointer inline (Issues tab), not in a new tab", () => {
      const openIssue = vi.fn();
      useIssuesStore.setState({ openIssue, trackers: [DECLARED_LINEAR] });
      const closePreview = vi.fn();
      useFileStore.setState({ closePreview });
      const content = `---
issue: https://linear.app/example/issue/TRACKER-28/decouple
---

# Title
`;
      render(<MarkdownSelectionComments {...makeProps({ content })} />);
      fireEvent.click(screen.getByText("roadmap#TRACKER-28"));
      expect(openIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          tracker: "linear:TRACKER",
          identifier: "roadmap#TRACKER-28",
          id: "TRACKER-28",
          url: "https://linear.app/example/issue/TRACKER-28/decouple",
        }),
      );
      expect(useUiStore.getState().rightTab).toBe("issues");
      // The doc is usually read in the preview modal — it must get out of the way.
      expect(closePreview).toHaveBeenCalled();
    });

    it("keeps the external-link escape hatch for an unknown-shape pointer", () => {
      const content = `---
issue: https://example.com/tickets/42
---

# Title
`;
      render(<MarkdownSelectionComments {...makeProps({ content })} />);
      const chip = screen.getByText("https://example.com/tickets/42");
      expect(chip.closest("a")).toHaveAttribute("href", "https://example.com/tickets/42");
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
      },
      {
        id: "c2",
        quotedText: "Architecture body",
        contextBefore: "",
        contextAfter: "",
        text: "second comment",
      },
    ];

    it("renders existing comment text", () => {
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      expect(screen.getByText("human comment")).toBeInTheDocument();
      expect(screen.getByText("second comment")).toBeInTheDocument();
    });

    it("shows the quoted text inside each comment card", () => {
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
      // Both the body paragraph and the two comment blockquotes contain this string.
      const matches = screen.getAllByText("Architecture body");
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    // Every review comment is human-authored (the AI write path was removed in
    // docs/203 + docs/220), so no card carries an author label.
    it("does not label a comment with an author", () => {
      render(<MarkdownSelectionComments {...makeProps({ comments })} />);
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
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ content, comments })} />);
      expect(screen.getByText("about the second cat")).toBeInTheDocument();
      // Anchored (not orphaned) because the quoted text exists.
      expect(screen.queryByText("Orphaned comments")).not.toBeInTheDocument();
    });

    it("disambiguates duplicate quoted text across top-level blocks by same-block context", () => {
      const content = [
        "Alpha section repeats the selected phrase.",
        "",
        "Beta section repeats the selected phrase.",
      ].join("\n");
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "selected phrase",
          contextBefore: "Beta section repeats the ",
          contextAfter: ".",
          text: "about the beta occurrence",
        },
      ];
      const { container } = render(
        <MarkdownSelectionComments {...makeProps({ content, comments })} />,
      );
      const firstBlock = within(container).getByText(/Alpha section/).parentElement!.parentElement!;
      const secondBlock = within(container).getByText(/Beta section/).parentElement!.parentElement!;

      expect(within(firstBlock).queryByText("about the beta occurrence")).toBeNull();
      expect(within(secondBlock).getByText("about the beta occurrence")).toBeInTheDocument();
      expect(screen.queryByText("Orphaned comments")).not.toBeInTheDocument();
    });

    it("disambiguates duplicate quoted text with context crossing top-level block boundaries", () => {
      const content = [
        "Shared token appears in the opening block.",
        "",
        "A bridge paragraph provides unique prior context.",
        "",
        "Shared token appears in the final block.",
      ].join("\n");
      const comments: SelectionCommentData[] = [
        {
          id: "c1",
          quotedText: "Shared token",
          contextBefore: "unique prior context.",
          contextAfter: " appears in the final block.",
          text: "about the final occurrence",
        },
      ];
      const { container } = render(
        <MarkdownSelectionComments {...makeProps({ content, comments })} />,
      );
      const openingBlock = within(container).getByText(/opening block/).parentElement!.parentElement!;
      const finalBlock = within(container).getByText(/final block/).parentElement!.parentElement!;

      expect(within(openingBlock).queryByText("about the final occurrence")).toBeNull();
      expect(within(finalBlock).getByText("about the final occurrence")).toBeInTheDocument();
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
        },
        {
          id: "c2",
          quotedText: "albatross",
          contextBefore: "",
          contextAfter: "",
          text: "about albatross",
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

    it("opens the pending editor under the selected duplicate text occurrence", () => {
      const content = "Repeat target appears first.\n\nRepeat target appears second.";
      const { container } = render(
        <MarkdownSelectionComments {...makeProps({ content })} />,
      );

      selectText(container, "Repeat target", 1);
      fireEvent.mouseDown(screen.getByTitle("Comment on this selection"));

      const blocks = container.querySelectorAll("[data-markdown-block-index]");
      expect(within(blocks[0] as HTMLElement).queryByPlaceholderText(/Add a comment/)).toBeNull();
      expect(
        within(blocks[1] as HTMLElement).getByPlaceholderText(/Add a comment/),
      ).toBeInTheDocument();
    });

    it("keeps a newly added duplicate-text comment pinned to the selected block after saving", async () => {
      function Harness() {
        const [comments, setComments] = useState<SelectionCommentData[]>([]);
        return (
          <MarkdownSelectionComments
            {...makeProps({
              content: "Repeat target appears first.\n\nRepeat target appears second.",
              comments,
              onAddComment: (quotedText, contextBefore, contextAfter, text) => {
                const comment = {
                  id: "c1",
                  quotedText,
                  contextBefore,
                  contextAfter,
                  text,
                };
                setComments([comment]);
                return Promise.resolve({ id: comment.id });
              },
            })}
          />
        );
      }

      const user = userEvent.setup();
      const { container } = render(<Harness />);
      selectText(container, "Repeat target", 1);
      fireEvent.mouseDown(screen.getByTitle("Comment on this selection"));

      await user.type(screen.getByPlaceholderText(/Add a comment/), "second occurrence note");
      await user.click(screen.getByText("Add"));

      await waitFor(() => {
        const blocks = container.querySelectorAll("[data-markdown-block-index]");
        expect(within(blocks[0] as HTMLElement).queryByText("second occurrence note")).toBeNull();
        expect(
          within(blocks[1] as HTMLElement).getByText("second occurrence note"),
        ).toBeInTheDocument();
      });
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
        },
      ];
      render(<MarkdownSelectionComments {...makeProps({ content, comments })} />);
      expect(screen.getByText("about the code")).toBeInTheDocument();
      expect(screen.queryByText("Orphaned comments")).not.toBeInTheDocument();
    });
  });

  describe("onComposingChange (blocks Send while an editor is open)", () => {
    const oneComment: SelectionCommentData[] = [
      {
        id: "c1",
        quotedText: "Architecture body",
        contextBefore: "",
        contextAfter: "",
        text: "old",
      },
    ];

    function last(fn: ReturnType<typeof vi.fn>): unknown {
      return fn.mock.calls.at(-1)?.[0];
    }

    it("reports false while idle", () => {
      const onComposingChange = vi.fn();
      render(
        <MarkdownSelectionComments {...makeProps()} onComposingChange={onComposingChange} />,
      );
      expect(last(onComposingChange)).toBe(false);
    });

    it("reports true when the add-comment input opens, false once submitted", async () => {
      const user = userEvent.setup();
      const onComposingChange = vi.fn();
      const { container } = render(
        <MarkdownSelectionComments
          {...makeProps({ onAddComment: () => ({ id: "c-new" }) })}
          onComposingChange={onComposingChange}
        />,
      );

      selectText(container, "Architecture body");
      fireEvent.mouseDown(screen.getByTitle("Comment on this selection"));
      expect(last(onComposingChange)).toBe(true);

      await user.type(screen.getByPlaceholderText(/Add a comment/), "a note");
      await user.click(screen.getByText("Add"));
      expect(last(onComposingChange)).toBe(false);
    });

    it("reports false when the add-comment input is cancelled with Escape", () => {
      const onComposingChange = vi.fn();
      const { container } = render(
        <MarkdownSelectionComments {...makeProps()} onComposingChange={onComposingChange} />,
      );

      selectText(container, "Architecture body");
      fireEvent.mouseDown(screen.getByTitle("Comment on this selection"));
      expect(last(onComposingChange)).toBe(true);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(last(onComposingChange)).toBe(false);
    });

    it("reports true while an existing comment is being edited", async () => {
      const user = userEvent.setup();
      const onComposingChange = vi.fn();
      render(
        <MarkdownSelectionComments
          {...makeProps({ comments: oneComment })}
          onComposingChange={onComposingChange}
        />,
      );

      await user.click(screen.getByTitle("Edit"));
      expect(last(onComposingChange)).toBe(true);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(last(onComposingChange)).toBe(false);
    });

    it("reports false on unmount so closing the viewer mid-compose can't strand it", async () => {
      const user = userEvent.setup();
      const onComposingChange = vi.fn();
      const { unmount } = render(
        <MarkdownSelectionComments
          {...makeProps({ comments: oneComment })}
          onComposingChange={onComposingChange}
        />,
      );

      await user.click(screen.getByTitle("Edit"));
      expect(last(onComposingChange)).toBe(true);

      unmount();
      expect(last(onComposingChange)).toBe(false);
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
