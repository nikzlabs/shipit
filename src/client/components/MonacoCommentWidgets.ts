/**
 * MonacoCommentWidgets — adds comment UI to any Monaco editor instance.
 *
 * Used by FilePreviewModal (code files, server-persisted via the unified
 * file-review store) and DiffPanel (modified side, client-side via the
 * legacy comment-store). Renders:
 * - Glyph margin `+` affordance on hover
 * - Comment input ViewZone below a line
 * - Comment card ViewZones for saved comments
 *
 * Accepts a minimal `LineCommentLike` shape so the same widget works with
 * either store. Callers are responsible for filtering to comments that
 * belong on the current editor before passing them in.
 */

import type * as monaco from "monaco-editor";

/**
 * Minimal shape of comments the widget consumes. The widget filters to
 * `kind === "line"` internally, so callers can pass mixed arrays (e.g. the
 * union `FileComment[]` from the legacy comment-store, or a pre-filtered
 * `ReviewComment[]` line-only list).
 */
export interface LineCommentLike {
  id: string;
  /** Discriminator. Non-"line" entries are filtered out by the widget. */
  kind: "line" | "section";
  /** Required when `kind === "line"`. */
  line?: number;
  text: string;
  /** Present on legacy diff-panel comments; absent on per-file review comments. */
  filePath?: string;
}

export interface CommentWidgetManager {
  /** Render existing comments as ViewZones + decorations */
  setComments(comments: LineCommentLike[]): void;
  /** Show the "add comment" input below a line */
  openCommentInput(line: number): void;
  /** Clean up all ViewZones and decorations */
  dispose(): void;
}

interface ViewZoneEntry {
  id: string;
  line: number;
  domNode: HTMLDivElement;
}

export function createCommentWidgetManager(
  editorOrDiff: monaco.editor.IStandaloneCodeEditor | monaco.editor.IDiffEditor,
  options: {
    filePath: string;
    onAddComment: (line: number, text: string) => void;
    onEditComment: (commentId: string, text: string) => void;
    onDeleteComment: (commentId: string) => void;
    side?: "modified";
  },
): CommentWidgetManager {
  // Resolve the actual code editor instance
  const editor: monaco.editor.ICodeEditor = options.side
    ? (editorOrDiff as monaco.editor.IDiffEditor).getModifiedEditor()
    : (editorOrDiff as monaco.editor.IStandaloneCodeEditor);

  const commentZones: ViewZoneEntry[] = [];
  let inputZone: { id: string; domNode: HTMLDivElement } | null = null;
  let decorationCollection: monaco.editor.IEditorDecorationsCollection | null = null;

  function clearAllZones(): void {
    editor.changeViewZones((accessor) => {
      for (const zone of commentZones) {
        accessor.removeZone(zone.id);
      }
      if (inputZone) {
        accessor.removeZone(inputZone.id);
        inputZone = null;
      }
    });
    commentZones.length = 0;
  }

  function clearDecorations(): void {
    if (decorationCollection) {
      decorationCollection.clear();
      decorationCollection = null;
    }
  }

  function removeInputZone(): void {
    if (!inputZone) return;
    editor.changeViewZones((accessor) => {
      if (inputZone) {
        accessor.removeZone(inputZone.id);
        inputZone = null;
      }
    });
  }

  function createCommentCard(
    comment: LineCommentLike,
    afterLineNumber: number,
  ): void {
    const domNode = document.createElement("div");
    domNode.style.cssText = "padding: 4px 12px 4px 16px; margin: 4px 0 4px 40px;";
    domNode.className = "monaco-comment-card";

    const card = document.createElement("div");
    card.style.cssText = `
      border-left: 2px solid #60a5fa;
      background: rgba(30, 58, 138, 0.3);
      border-radius: 0 6px 6px 0;
      padding: 8px 12px;
      font-size: 12px;
      color: #e2e8f0;
      position: relative;
    `;

    const header = document.createElement("div");
    header.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;";

    const label = document.createElement("span");
    label.style.cssText = "font-size: 10px; color: #94a3b8; font-weight: 600;";
    const line = "line" in comment ? comment.line : 0;
    label.textContent = `Line ${line}`;

    const buttons = document.createElement("div");
    buttons.style.cssText = "display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s;";

    card.addEventListener("mouseenter", () => { buttons.style.opacity = "1"; });
    card.addEventListener("mouseleave", () => { buttons.style.opacity = "0"; });

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.style.cssText = "font-size: 10px; color: #94a3b8; cursor: pointer; background: none; border: none; padding: 2px 4px; border-radius: 3px;";
    editBtn.addEventListener("mouseenter", () => { editBtn.style.color = "#e2e8f0"; editBtn.style.background = "rgba(255,255,255,0.1)"; });
    editBtn.addEventListener("mouseleave", () => { editBtn.style.color = "#94a3b8"; editBtn.style.background = "none"; });
    editBtn.addEventListener("click", () => {
      // Replace card with edit input
      card.innerHTML = "";
      const textarea = document.createElement("textarea");
      textarea.value = comment.text;
      textarea.style.cssText = "width: 100%; background: transparent; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 6px; font-size: 12px; resize: none; min-height: 50px; outline: none; font-family: inherit;";

      const editButtons = document.createElement("div");
      editButtons.style.cssText = "display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px;";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = "font-size: 11px; color: #94a3b8; cursor: pointer; background: none; border: none; padding: 4px 8px;";
      cancelBtn.addEventListener("click", () => {
        // Re-render the card
        manager.setComments(currentComments);
      });

      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.style.cssText = "font-size: 11px; color: #e2e8f0; cursor: pointer; background: #3b82f6; border: none; padding: 4px 8px; border-radius: 4px;";
      saveBtn.addEventListener("click", () => {
        if (textarea.value.trim()) {
          options.onEditComment(comment.id, textarea.value.trim());
        }
      });

      textarea.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          if (textarea.value.trim()) {
            options.onEditComment(comment.id, textarea.value.trim());
          }
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          manager.setComments(currentComments);
        }
      });

      editButtons.appendChild(cancelBtn);
      editButtons.appendChild(saveBtn);
      card.appendChild(textarea);
      card.appendChild(editButtons);
      textarea.focus();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Del";
    deleteBtn.style.cssText = "font-size: 10px; color: #94a3b8; cursor: pointer; background: none; border: none; padding: 2px 4px; border-radius: 3px;";
    deleteBtn.addEventListener("mouseenter", () => { deleteBtn.style.color = "#ef4444"; deleteBtn.style.background = "rgba(255,255,255,0.1)"; });
    deleteBtn.addEventListener("mouseleave", () => { deleteBtn.style.color = "#94a3b8"; deleteBtn.style.background = "none"; });
    deleteBtn.addEventListener("click", () => {
      options.onDeleteComment(comment.id);
    });

    buttons.appendChild(editBtn);
    buttons.appendChild(deleteBtn);
    header.appendChild(label);
    header.appendChild(buttons);

    const body = document.createElement("div");
    body.style.cssText = "white-space: pre-wrap; line-height: 1.4;";
    body.textContent = comment.text;

    card.appendChild(header);
    card.appendChild(body);
    domNode.appendChild(card);

    editor.changeViewZones((accessor) => {
      const zoneId = accessor.addZone({
        afterLineNumber,
        heightInPx: 80,
        domNode,
        suppressMouseDown: true,
      });
      commentZones.push({ id: zoneId, line: afterLineNumber, domNode });
    });
  }

  function createInputZone(line: number): void {
    removeInputZone();

    const domNode = document.createElement("div");
    domNode.style.cssText = "padding: 4px 12px 4px 16px; margin: 4px 0 4px 40px;";

    const wrapper = document.createElement("div");
    wrapper.style.cssText = `
      border: 1px solid #475569;
      background: rgba(30, 41, 59, 0.8);
      border-radius: 6px;
      padding: 8px 12px;
    `;

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Add a comment... (Cmd+Enter to submit, Escape to cancel)";
    textarea.style.cssText = "width: 100%; background: transparent; color: #e2e8f0; border: none; outline: none; font-size: 12px; resize: none; min-height: 50px; font-family: inherit;";

    const buttons = document.createElement("div");
    buttons.style.cssText = "display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px;";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.cssText = "font-size: 11px; color: #94a3b8; cursor: pointer; background: none; border: none; padding: 4px 8px;";
    cancelBtn.addEventListener("click", removeInputZone);

    const addBtn = document.createElement("button");
    addBtn.textContent = "Add";
    addBtn.style.cssText = "font-size: 11px; color: #e2e8f0; cursor: pointer; background: #3b82f6; border: none; padding: 4px 8px; border-radius: 4px;";
    addBtn.addEventListener("click", () => {
      if (textarea.value.trim()) {
        options.onAddComment(line, textarea.value.trim());
        removeInputZone();
      }
    });

    textarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (textarea.value.trim()) {
          options.onAddComment(line, textarea.value.trim());
          removeInputZone();
        }
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        removeInputZone();
      }
    });

    buttons.appendChild(cancelBtn);
    buttons.appendChild(addBtn);
    wrapper.appendChild(textarea);
    wrapper.appendChild(buttons);
    domNode.appendChild(wrapper);

    editor.changeViewZones((accessor) => {
      const zoneId = accessor.addZone({
        afterLineNumber: line,
        heightInPx: 90,
        domNode,
        suppressMouseDown: true,
      });
      inputZone = { id: zoneId, domNode };
    });

    // Focus the textarea after zone is rendered
    setTimeout(() => textarea.focus(), 50);
  }

  // Glyph margin click handler
  const GLYPH_MARGIN_TYPE = 2; // Monaco MouseTargetType.GUTTER_GLYPH_MARGIN
  const glyphDisposable = editor.onMouseDown((e) => {
    if (
      (e.target.type as number) === GLYPH_MARGIN_TYPE &&
      e.target.position
    ) {
      createInputZone(e.target.position.lineNumber);
    }
  });

  // Enable glyph margin
  editor.updateOptions({ glyphMargin: true });

  let currentComments: LineCommentLike[] = [];

  const manager: CommentWidgetManager = {
    setComments(comments: LineCommentLike[]) {
      currentComments = comments;
      clearAllZones();
      clearDecorations();

      // Filter to line comments. Legacy callers (DiffPanel) pass the full
      // session comment list, so we still match on filePath when present.
      const lineComments = comments.filter(
        (c): c is LineCommentLike & { kind: "line"; line: number } =>
          c.kind === "line" &&
          typeof c.line === "number" &&
          (c.filePath === undefined || c.filePath === options.filePath),
      );
      const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];

      for (const comment of lineComments) {
        createCommentCard(comment, comment.line);

        // Add glyph decoration for lines with comments
        newDecorations.push({
          range: {
            startLineNumber: comment.line,
            startColumn: 1,
            endLineNumber: comment.line,
            endColumn: 1,
          },
          options: {
            glyphMarginClassName: "monaco-comment-glyph",
            stickiness: 1, // NeverGrowsWhenTypingAtEdges
          },
        });
      }

      if (newDecorations.length > 0) {
        decorationCollection = editor.createDecorationsCollection(newDecorations);
      }
    },

    openCommentInput(line: number) {
      createInputZone(line);
    },

    dispose() {
      clearAllZones();
      clearDecorations();
      glyphDisposable.dispose();
    },
  };

  return manager;
}
