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
 * `kind === "line"` internally, so callers can pass mixed arrays (e.g. a
 * `ReviewComment[]` containing both line and selection kinds) without having
 * to pre-filter at the call site.
 */
export interface LineCommentLike {
  id: string;
  /** Discriminator. Non-"line" entries are filtered out by the widget. */
  kind: "line" | "selection";
  /** Local comments are editable; GitHub comments are synced, read-only review threads. */
  source?: "local" | "github";
  /** Required when `kind === "line"`. */
  line?: number;
  text: string;
  /** Present on legacy diff-panel comments; absent on per-file review comments. */
  filePath?: string;
  author?: { login: string; avatarUrl?: string };
  createdAt?: string;
  isResolved?: boolean;
  isOutdated?: boolean;
  replies?: {
    id: string;
    author: { login: string; avatarUrl?: string };
    body: string;
    createdAt: string;
  }[];
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
    const isGitHub = comment.source === "github";
    const domNode = document.createElement("div");
    domNode.style.cssText = "padding: 4px 12px 4px 16px; margin: 4px 0 4px 40px;";
    domNode.className = "monaco-comment-card";

    const card = document.createElement("div");
    card.style.cssText = `
      border-left: 2px solid ${isGitHub ? "#22c55e" : "#60a5fa"};
      background: ${isGitHub ? "rgba(20, 83, 45, 0.26)" : "rgba(30, 58, 138, 0.3)"};
      border-radius: 0 6px 6px 0;
      padding: 8px 12px;
      font-size: 12px;
      color: #e2e8f0;
      position: relative;
    `;

    const header = document.createElement("div");
    header.style.cssText = "display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;";

    const label = document.createElement("span");
    label.style.cssText = "font-size: 10px; color: #94a3b8; font-weight: 600; display: flex; align-items: center; gap: 6px; min-width: 0;";
    const line = "line" in comment ? comment.line : 0;
    const location = document.createElement("span");
    location.textContent = `Line ${line}`;
    label.appendChild(location);

    if (isGitHub) {
      const badge = document.createElement("span");
      badge.textContent = "GitHub";
      badge.style.cssText = "color: #bbf7d0; background: rgba(34, 197, 94, 0.16); border: 1px solid rgba(34, 197, 94, 0.32); border-radius: 999px; padding: 1px 6px;";
      label.appendChild(badge);
      if (comment.isResolved) {
        const resolved = document.createElement("span");
        resolved.textContent = "resolved";
        resolved.style.cssText = "color: #86efac;";
        label.appendChild(resolved);
      }
      if (comment.isOutdated) {
        const outdated = document.createElement("span");
        outdated.textContent = "outdated";
        outdated.style.cssText = "color: #cbd5e1;";
        label.appendChild(outdated);
      }
    }

    const buttons = document.createElement("div");
    buttons.style.cssText = "display: flex; gap: 4px; opacity: 0; transition: opacity 0.15s;";

    if (!isGitHub) {
      card.addEventListener("mouseenter", () => { buttons.style.opacity = "1"; });
      card.addEventListener("mouseleave", () => { buttons.style.opacity = "0"; });
    }

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

    if (!isGitHub) {
      buttons.appendChild(editBtn);
      buttons.appendChild(deleteBtn);
    }
    header.appendChild(label);
    header.appendChild(buttons);

    const body = document.createElement("div");
    body.style.cssText = "white-space: pre-wrap; line-height: 1.4; display: flex; flex-direction: column; gap: 8px;";

    const replies = comment.replies?.length
      ? comment.replies
      : [{
          id: comment.id,
          author: comment.author ?? { login: isGitHub ? "github" : "user" },
          body: comment.text,
          createdAt: comment.createdAt ?? "",
        }];
    for (const reply of replies) {
      const replyNode = document.createElement("div");
      replyNode.style.cssText = "display: flex; gap: 8px; min-width: 0;";

      const avatar = document.createElement("div");
      avatar.style.cssText = "width: 18px; height: 18px; border-radius: 999px; overflow: hidden; flex: 0 0 auto; background: #334155; color: #cbd5e1; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600;";
      if (reply.author.avatarUrl) {
        const img = document.createElement("img");
        img.src = reply.author.avatarUrl;
        img.alt = reply.author.login;
        img.style.cssText = "width: 100%; height: 100%; object-fit: cover;";
        avatar.appendChild(img);
      } else {
        avatar.textContent = reply.author.login.charAt(0).toUpperCase();
      }

      const content = document.createElement("div");
      content.style.cssText = "min-width: 0; flex: 1;";
      const meta = document.createElement("div");
      meta.style.cssText = "font-size: 10px; color: #94a3b8; margin-bottom: 2px;";
      meta.textContent = reply.createdAt ? `${reply.author.login} · ${new Date(reply.createdAt).toLocaleDateString()}` : reply.author.login;
      const text = document.createElement("div");
      text.style.cssText = "white-space: pre-wrap; line-height: 1.4;";
      text.textContent = reply.body;
      content.appendChild(meta);
      content.appendChild(text);
      replyNode.appendChild(avatar);
      replyNode.appendChild(content);
      body.appendChild(replyNode);
    }

    card.appendChild(header);
    card.appendChild(body);
    domNode.appendChild(card);

    editor.changeViewZones((accessor) => {
      const zoneId = accessor.addZone({
        afterLineNumber,
        heightInPx: Math.min(220, 68 + replies.length * 42),
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
