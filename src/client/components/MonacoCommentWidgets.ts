/**
 * MonacoCommentWidgets — adds comment UI to any Monaco editor instance.
 *
 * Used by FilePreviewModal (code files, server-persisted via the unified
 * file-review store) and DiffPanel (modified side, client-side via the
 * legacy comment-store). Renders:
 * - Glyph margin `+` affordance on the hovered line, which is the only visible
 *   entry point to the add-comment gesture (suppressed in `readOnly` mode)
 * - Glyph margin dot on lines that already carry a comment
 * - Comment input ViewZone below a line
 * - Comment card ViewZones for saved comments
 *
 * Accepts a minimal `LineCommentLike` shape so the same widget works with
 * either store. Callers are responsible for filtering to comments that
 * belong on the current editor before passing them in.
 *
 * The glyph-margin affordances (`monaco-comment-add-glyph`,
 * `monaco-comment-glyph`) are styled in `src/client/index.css` — Monaco's DOM
 * is outside the React tree, so its decoration classes cannot use Tailwind
 * utilities.
 */

import type * as monaco from "monaco-editor";

export const ADD_COMMENT_TOOLTIP = "Click to add a comment on this line";

export const HAS_COMMENT_TOOLTIP = "This line has a comment";

/**
 * Monaco `MouseTargetType` values that count as "the pointer is on this line".
 * Literals because the monaco import is type-only — the editor instance is
 * passed in by the caller, so the runtime enum is not in scope.
 *
 * GUTTER_GLYPH_MARGIN(2), GUTTER_LINE_NUMBERS(3), GUTTER_LINE_DECORATIONS(4),
 * CONTENT_TEXT(6), CONTENT_EMPTY(7). The view-zone types (5, 8) are excluded
 * so hovering a comment card does not mark the line it hangs off.
 */
const LINE_HOVER_TYPES: ReadonlySet<number> = new Set([2, 3, 4, 6, 7]);

function isPastEndOfFile(target: monaco.editor.IMouseTarget): boolean {
  return (
    "detail" in target &&
    typeof target.detail === "object" &&
    target.detail !== null &&
    "isAfterLines" in target.detail &&
    target.detail.isAfterLines
  );
}

export interface LineCommentLike {
  id: string;

  kind: "line" | "selection";

  source?: "local" | "github";

  line?: number;
  text: string;

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

  setComments(comments: LineCommentLike[]): void;

  openCommentInput(line: number): void;

  dispose(): void;
}

interface ViewZoneEntry {
  id: string;
  line: number;
  domNode: HTMLDivElement;

  stopMeasuring: () => void;
}

/**
 * Left indent of a widget card, in px — sets it in from the code it hangs off.
 *
 * Applied as `padding-left` and never as `margin-left`: the node is sized to
 * the editor's content width, so a left margin pushes its right edge that far
 * past the viewport, where the overflow — the Add/Save button among it — is
 * clipped away.
 */
const CARD_INSET_LEFT = 56;

const CARD_INSET_Y = 8;

/**
 * The node holding one card — the input panel or a saved comment.
 *
 * `border-box` so the insets stay inside the node's width (`pinZoneNode` sets
 * it to the editor's content width) instead of overflowing it.
 *
 * `z-index` because `.view-lines` is appended AFTER `.view-zones` in the same
 * lines container (`view.js`) and spans the whole content area — including the
 * rows a zone occupies — with no z-index of its own. So it wins the hit test
 * over every zone: without this, a click on the panel's textarea or on its
 * Cancel/Add button landed on the editor instead, which left the panel looking
 * dead and moved focus into Monaco's own hidden textarea (from where a
 * following Escape closed the whole diff dialog rather than the panel).
 * Monaco sets `position: absolute` on this node itself, so the z-index applies.
 */
function createZoneNode(): HTMLDivElement {
  const node = document.createElement("div");
  node.style.cssText = `box-sizing: border-box; z-index: 10; padding: ${CARD_INSET_Y}px 12px ${CARD_INSET_Y}px ${CARD_INSET_LEFT}px;`;

  // click at all. Stop the press at the panel. Never `preventDefault()`: the

  node.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  return node;
}

export function createCommentWidgetManager(
  editorOrDiff: monaco.editor.IStandaloneCodeEditor | monaco.editor.IDiffEditor,
  options: {
    filePath: string;
    onAddComment: (line: number, text: string) => void;
    onEditComment: (commentId: string, text: string) => void;
    onDeleteComment: (commentId: string) => void;
    side?: "modified";

    readOnly?: boolean;

    onInputOpenChange?: (open: boolean) => void;
  },
): CommentWidgetManager {

  const editor: monaco.editor.ICodeEditor = options.side
    ? (editorOrDiff as monaco.editor.IDiffEditor).getModifiedEditor()
    : (editorOrDiff as monaco.editor.IStandaloneCodeEditor);

  const commentZones: ViewZoneEntry[] = [];
  let inputZone: { id: string; domNode: HTMLDivElement; stopMeasuring: () => void } | null = null;
  let decorationCollection: monaco.editor.IEditorDecorationsCollection | null = null;

  let hoverCollection: monaco.editor.IEditorDecorationsCollection | null = null;

  let pointerLine: number | null = null;

  let renderedHoverLine: number | null = null;

  let commentedLines = new Set<number>();

  const editingIds = new Set<string>();
  let lastOpenState = false;

  function syncOpenState(): void {
    const open = inputZone !== null || editingIds.size > 0;
    if (open === lastOpenState) return;
    lastOpenState = open;
    options.onInputOpenChange?.(open);
  }

  function pinZoneNode(domNode: HTMLDivElement): void {
    domNode.style.width = `${editor.getLayoutInfo().contentWidth}px`;
    const scrollLeft = editor.getScrollLeft();
    domNode.style.transform = scrollLeft > 0 ? `translateX(${scrollLeft}px)` : "";
  }

  function pinAllZoneNodes(): void {
    for (const zone of commentZones) pinZoneNode(zone.domNode);
    if (inputZone) pinZoneNode(inputZone.domNode);
  }

  function addMeasuredZone(
    afterLineNumber: number,
    domNode: HTMLDivElement,
    estimateInPx: number,
  ): { id: string; stopMeasuring: () => void } {
    const zone: monaco.editor.IViewZone = {
      afterLineNumber,
      heightInPx: estimateInPx,
      domNode,

      suppressMouseDown: false,
    };
    let id = "";
    editor.changeViewZones((accessor) => {
      id = accessor.addZone(zone);
    });
    pinZoneNode(domNode);

    const card = domNode.firstElementChild as HTMLElement | null;
    const remeasure = (): void => {

      const measured = card?.offsetHeight ?? 0;
      if (measured === 0) return;
      const next = measured + CARD_INSET_Y * 2;
      if (next === zone.heightInPx) return;
      zone.heightInPx = next;
      editor.changeViewZones((accessor) => {
        accessor.layoutZone(id);
      });
    };
    remeasure();

    if (!card || typeof ResizeObserver === "undefined") {
      return { id, stopMeasuring: () => {} };
    }
    const observer = new ResizeObserver(remeasure);
    observer.observe(card);
    return { id, stopMeasuring: () => { observer.disconnect(); } };
  }

  function clearAllZones(): void {
    editor.changeViewZones((accessor) => {
      for (const zone of commentZones) {
        zone.stopMeasuring();
        accessor.removeZone(zone.id);
      }
      if (inputZone) {
        inputZone.stopMeasuring();
        accessor.removeZone(inputZone.id);
        inputZone = null;
      }
    });
    commentZones.length = 0;

    editingIds.clear();
    syncOpenState();
  }

  function clearDecorations(): void {
    if (decorationCollection) {
      decorationCollection.clear();
      decorationCollection = null;
    }
  }

  /**
   * Draw the `+` on `pointerLine`, or nothing. A line that already carries a
   * comment keeps its own glyph instead — two markers cannot both be legible
   * in a 16px strip. Derived rather than set directly so that `setComments()`
   * can re-run it: a line that gains a comment while hovered must drop its
   * `+`, and one that loses its last comment must get it back, neither of
   * which involves a mouse move.
   */
  function renderHoverMarker(): void {
    const next =
      pointerLine !== null && !commentedLines.has(pointerLine) ? pointerLine : null;
    if (next === renderedHoverLine) return;
    renderedHoverLine = next;

    if (next === null) {
      hoverCollection?.clear();
      return;
    }

    const decoration: monaco.editor.IModelDeltaDecoration = {
      range: {
        startLineNumber: next,
        startColumn: 1,
        endLineNumber: next,
        endColumn: 1,
      },
      options: {
        glyphMarginClassName: "monaco-comment-add-glyph",
        glyphMarginHoverMessage: { value: ADD_COMMENT_TOOLTIP },
        stickiness: 1,                               
      },
    };
    if (hoverCollection) {
      hoverCollection.set([decoration]);
    } else {
      hoverCollection = editor.createDecorationsCollection([decoration]);
    }
  }

  function setPointerLine(line: number | null): void {
    pointerLine = line;
    renderHoverMarker();
  }

  function removeInputZone(): void {
    if (!inputZone) return;
    editor.changeViewZones((accessor) => {
      if (inputZone) {
        inputZone.stopMeasuring();
        accessor.removeZone(inputZone.id);
        inputZone = null;
      }
    });
    syncOpenState();
  }

  function createCommentCard(
    comment: LineCommentLike,
    afterLineNumber: number,
  ): void {
    const isGitHub = comment.source === "github";
    const domNode = createZoneNode();
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

      editingIds.add(comment.id);
      syncOpenState();
      card.innerHTML = "";
      const textarea = document.createElement("textarea");
      textarea.value = comment.text;

      textarea.style.cssText = "display: block; box-sizing: border-box; width: 100%; background: transparent; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 6px; font-size: 12px; resize: none; min-height: 50px; outline: none; font-family: inherit;";

      const editButtons = document.createElement("div");
      editButtons.style.cssText = "display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px;";

      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = "Cancel";
      cancelBtn.style.cssText = "font-size: 11px; color: #94a3b8; cursor: pointer; background: none; border: none; padding: 4px 8px;";
      cancelBtn.addEventListener("click", () => {

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

    if (!isGitHub && !options.readOnly) {
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

    const { id, stopMeasuring } = addMeasuredZone(
      afterLineNumber,
      domNode,

      Math.min(220, 68 + replies.length * 42),
    );
    commentZones.push({ id, line: afterLineNumber, domNode, stopMeasuring });
  }

  function createInputZone(line: number): void {
    removeInputZone();

    const domNode = createZoneNode();

    const wrapper = document.createElement("div");

    // against syntax highlighting. Slate rather than a theme token because

    wrapper.style.cssText = `
      box-sizing: border-box;
      border: 1px solid #475569;
      background: #1e293b;
      border-radius: 6px;
      padding: 8px 12px;
    `;

    const textarea = document.createElement("textarea");
    textarea.placeholder = "Add a comment... (Cmd+Enter to submit, Escape to cancel)";
    textarea.style.cssText = "display: block; box-sizing: border-box; width: 100%; background: transparent; color: #e2e8f0; border: none; outline: none; font-size: 12px; resize: none; min-height: 50px; overflow: hidden; font-family: inherit;";

    const autoGrow = (): void => {
      textarea.style.height = "auto";
      if (textarea.scrollHeight > 0) textarea.style.height = `${textarea.scrollHeight}px`;
    };
    textarea.addEventListener("input", autoGrow);

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

    const { id, stopMeasuring } = addMeasuredZone(
      line,
      domNode,

      50 + 47 + CARD_INSET_Y * 2,
    );
    inputZone = { id, domNode, stopMeasuring };
    syncOpenState();

    setTimeout(() => textarea.focus(), 50);
  }

  // Monaco MouseTargetType.GUTTER_GLYPH_MARGIN — literal because the monaco

  const GLYPH_MARGIN_TYPE = 2 as monaco.editor.MouseTargetType;
  const glyphDisposable = editor.onMouseDown((e) => {
    if (options.readOnly) return;
    if (
      e.target.type === GLYPH_MARGIN_TYPE &&
      e.target.position &&
      !isPastEndOfFile(e.target)
    ) {
      createInputZone(e.target.position.lineNumber);
    }
  });

  // `readOnly` suppresses the click, so it must suppress the `+` too.
  const hoverDisposables: monaco.IDisposable[] = [];
  if (!options.readOnly) {
    hoverDisposables.push(
      editor.onMouseMove((e) => {
        const position = e.target.position;
        setPointerLine(
          position && LINE_HOVER_TYPES.has(e.target.type) && !isPastEndOfFile(e.target)
            ? position.lineNumber
            : null,
        );
      }),
      editor.onMouseLeave(() => { setPointerLine(null); }),

      editor.onDidScrollChange(() => { setPointerLine(null); }),
    );
  }

  const layoutDisposables: monaco.IDisposable[] = [
    editor.onDidScrollChange(pinAllZoneNodes),
    editor.onDidLayoutChange(pinAllZoneNodes),
  ];

  editor.updateOptions({ glyphMargin: true });

  let currentComments: LineCommentLike[] = [];

  const manager: CommentWidgetManager = {
    setComments(comments: LineCommentLike[]) {
      currentComments = comments;
      clearAllZones();
      clearDecorations();

      const lineComments = comments.filter(
        (c): c is LineCommentLike & { kind: "line"; line: number } =>
          c.kind === "line" &&
          typeof c.line === "number" &&
          (c.filePath === undefined || c.filePath === options.filePath),
      );
      const newDecorations: monaco.editor.IModelDeltaDecoration[] = [];

      for (const comment of lineComments) {
        createCommentCard(comment, comment.line);

        newDecorations.push({
          range: {
            startLineNumber: comment.line,
            startColumn: 1,
            endLineNumber: comment.line,
            endColumn: 1,
          },
          options: {

            // marker must not offer a pointer cursor it cannot honour.
            glyphMarginClassName: options.readOnly
              ? "monaco-comment-glyph monaco-comment-glyph--static"
              : "monaco-comment-glyph",
            glyphMarginHoverMessage: { value: HAS_COMMENT_TOOLTIP },
            stickiness: 1,                               
          },
        });
      }

      commentedLines = new Set(lineComments.map((c) => c.line));
      renderHoverMarker();

      if (newDecorations.length > 0) {
        decorationCollection = editor.createDecorationsCollection(newDecorations);
      }
    },

    openCommentInput(line: number) {
      if (options.readOnly) return;
      createInputZone(line);
    },

    dispose() {
      clearAllZones();
      clearDecorations();
      setPointerLine(null);
      hoverCollection = null;
      glyphDisposable.dispose();
      for (const disposable of hoverDisposables) disposable.dispose();
      for (const disposable of layoutDisposables) disposable.dispose();

      // can never be left with Send disabled by a torn-down editor.
      editingIds.clear();
      inputZone = null;
      syncOpenState();
    },
  };

  return manager;
}
