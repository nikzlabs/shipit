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

/** Glyph-margin hover text. Says what the click does, since the `+` alone doesn't. */
export const ADD_COMMENT_TOOLTIP = "Click to add a comment on this line";

/** Glyph-margin hover text on a line that already carries a comment. */
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

/**
 * True when the pointer is in the blank space past the end of the file.
 *
 * Monaco still reports the last line's position there, so without this check
 * hovering empty space 300px below a short file marks its final line, and
 * clicking it opens a comment input on a line the pointer is nowhere near.
 * The flag rides on the margin and content-empty detail objects only, hence
 * the property probing rather than a cast.
 */
function isPastEndOfFile(target: monaco.editor.IMouseTarget): boolean {
  return (
    "detail" in target &&
    typeof target.detail === "object" &&
    target.detail !== null &&
    "isAfterLines" in target.detail &&
    target.detail.isAfterLines
  );
}

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
  /** Stops the height observer for this zone. */
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

/** Vertical padding around a widget card, in px. Counted into the zone height. */
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
  // The zone sits inside the editor, so Monaco's own mouse handler sees every
  // press on it and reacts as if the editor had been clicked: it takes focus
  // and reveals its cursor, which scrolls the panel out from under the
  // pointer before the button gets its mouseup — so the press produced no
  // click at all. Stop the press at the panel. Never `preventDefault()`: the
  // textarea still has to take focus from that same press.
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
    /**
     * docs/151 — when true, suppresses the glyph-margin click that opens an
     * add-comment input, and the edit/delete actions on existing comments.
     * Used by `FilePreviewModal` in agent-review snapshot mode.
     */
    readOnly?: boolean;
    /**
     * Fires when an unsaved comment editor opens or closes — the add-comment
     * input or an in-card edit form. Surfaces use it to disable their "Send
     * comments" button so a half-typed comment can't be dropped by an
     * accidental submit. Always fires `false` on `dispose()`.
     */
    onInputOpenChange?: (open: boolean) => void;
  },
): CommentWidgetManager {
  // Resolve the actual code editor instance
  const editor: monaco.editor.ICodeEditor = options.side
    ? (editorOrDiff as monaco.editor.IDiffEditor).getModifiedEditor()
    : (editorOrDiff as monaco.editor.IStandaloneCodeEditor);

  const commentZones: ViewZoneEntry[] = [];
  let inputZone: { id: string; domNode: HTMLDivElement; stopMeasuring: () => void } | null = null;
  let decorationCollection: monaco.editor.IEditorDecorationsCollection | null = null;
  /**
   * Separate from `decorationCollection` on purpose: the hover `+` changes on
   * every mouse move, while the saved-comment dots only change on
   * `setComments()`. Sharing one collection would make each mouse move
   * re-render every comment decoration.
   */
  let hoverCollection: monaco.editor.IEditorDecorationsCollection | null = null;
  /** Line the pointer is on, whether or not a `+` is drawn there. */
  let pointerLine: number | null = null;
  /** Line the `+` is currently drawn on — `null` when nothing is drawn. */
  let renderedHoverLine: number | null = null;
  /** Lines that already show a saved-comment glyph, so they skip the `+`. */
  let commentedLines = new Set<number>();
  /** Ids of comments whose in-card edit form is currently open. */
  const editingIds = new Set<string>();
  let lastOpenState = false;

  /** Emit the aggregate "an unsaved editor is open" state, on change only. */
  function syncOpenState(): void {
    const open = inputZone !== null || editingIds.size > 0;
    if (open === lastOpenState) return;
    lastOpenState = open;
    options.onInputOpenChange?.(open);
  }

  /**
   * Pin a zone node to the visible content area.
   *
   * Monaco gives a zone node `width: 100%` of the *scroll* width, and the
   * container it lives in is translated by the horizontal scroll offset. In a
   * non-wrapping editor (the file preview) that makes the card as wide as the
   * longest line in the file, which puts its right-aligned buttons far off
   * screen, and slides the card sideways as the code scrolls. Sizing to the
   * viewport and cancelling the scroll translation keeps the whole card in
   * view. Wrapping editors (the diff panel) scroll-width == content-width, so
   * this is a no-op there.
   */
  function pinZoneNode(domNode: HTMLDivElement): void {
    domNode.style.width = `${editor.getLayoutInfo().contentWidth}px`;
    const scrollLeft = editor.getScrollLeft();
    domNode.style.transform = scrollLeft > 0 ? `translateX(${scrollLeft}px)` : "";
  }

  function pinAllZoneNodes(): void {
    for (const zone of commentZones) pinZoneNode(zone.domNode);
    if (inputZone) pinZoneNode(inputZone.domNode);
  }

  /**
   * Add a view zone that keeps reserving exactly as much room as its card
   * needs.
   *
   * Monaco reserves `heightInPx` and nothing more, and it appends
   * `.view-zones` BEFORE `.view-lines` inside the lines container
   * (`view.js`) — so a card taller than its reservation is painted *under* the
   * lines that follow it. That is what a hardcoded height produced: the card
   * looked half-transparent (code showing through it), and its buttons sat in
   * the overlapped strip where the click landed on the editor instead. Text
   * length, wrapping and font all move the real height, so it is measured
   * from the DOM rather than guessed, and re-measured whenever the card
   * changes size (typing into the textarea, opening the in-card edit form).
   */
  function addMeasuredZone(
    afterLineNumber: number,
    domNode: HTMLDivElement,
    estimateInPx: number,
  ): { id: string; stopMeasuring: () => void } {
    const zone: monaco.editor.IViewZone = {
      afterLineNumber,
      heightInPx: estimateInPx,
      domNode,
      // `suppressMouseDown` stays OFF, and its name is why this needs saying:
      // it does not stop Monaco handling a press on the zone, it is the flag
      // that makes Monaco handle it — `mouseHandler.js` answers a true here by
      // focusing its own textarea, starting a cursor operation and calling
      // `preventDefault()` on the press. On a widget with its own textarea and
      // buttons that is exactly the wrong answer: it was what pulled focus out
      // of the panel and left the press producing no click.
      suppressMouseDown: false,
    };
    let id = "";
    editor.changeViewZones((accessor) => {
      id = accessor.addZone(zone);
    });
    pinZoneNode(domNode);

    const card = domNode.firstElementChild as HTMLElement | null;
    const remeasure = (): void => {
      // `offsetHeight` is 0 before layout (and always, under jsdom) — keep the
      // estimate rather than collapsing the zone to its padding.
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
    // Re-rendering the cards destroys any open edit form with them.
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
        stickiness: 1, // NeverGrowsWhenTypingAtEdges
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
      // Replace card with edit input
      editingIds.add(comment.id);
      syncOpenState();
      card.innerHTML = "";
      const textarea = document.createElement("textarea");
      textarea.value = comment.text;
      // `border-box`, or the 100% width plus padding and border overflows the
      // card and puts Save under the editor's right edge.
      textarea.style.cssText = "display: block; box-sizing: border-box; width: 100%; background: transparent; color: #e2e8f0; border: 1px solid #475569; border-radius: 4px; padding: 6px; font-size: 12px; resize: none; min-height: 50px; outline: none; font-family: inherit;";

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
      // Only what the zone shows until the first measurement lands.
      Math.min(220, 68 + replies.length * 42),
    );
    commentZones.push({ id, line: afterLineNumber, domNode, stopMeasuring });
  }

  function createInputZone(line: number): void {
    removeInputZone();

    const domNode = createZoneNode();

    const wrapper = document.createElement("div");
    // Opaque on purpose. The old `rgba(30, 41, 59, 0.8)` let the code behind
    // the panel read through it, which made a typed comment hard to read
    // against syntax highlighting. Slate rather than a theme token because
    // both surfaces pin Monaco to `vs-dark` whatever the app theme is, so the
    // panel has to sit against a dark editor, not against the app background.
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
    // Grow with the text instead of scrolling inside a fixed 50px box — the
    // zone now measures the panel, so the editor makes room for the growth.
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
      // Textarea (50) + its button row and the wrapper's own padding+border,
      // plus the zone insets. Only what the zone shows until the first
      // measurement lands.
      50 + 47 + CARD_INSET_Y * 2,
    );
    inputZone = { id, domNode, stopMeasuring };
    syncOpenState();

    // Focus the textarea after zone is rendered
    setTimeout(() => textarea.focus(), 50);
  }

  // Glyph margin click handler
  // Monaco MouseTargetType.GUTTER_GLYPH_MARGIN — literal because the monaco
  // import is type-only (the editor instance is passed in by the caller).
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

  // Hover affordance. Without it the glyph margin is an unmarked 16px strip
  // and the gesture is undiscoverable. Tracking the whole line (not just the
  // margin) means the marker appears before the pointer reaches the target.
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
      // Wheel scrolling fires no mouse event, and decorations are anchored to
      // the model — so the marker would ride its old line out from under a
      // stationary pointer. Drop it; the next mouse move re-derives it.
      editor.onDidScrollChange(() => { setPointerLine(null); }),
    );
  }

  // Keep every card sized to, and aligned with, the visible content area —
  // both move without a comment changing (sideways scrolling, a resized
  // panel, the modal's own layout settling).
  const layoutDisposables: monaco.IDisposable[] = [
    editor.onDidScrollChange(pinAllZoneNodes),
    editor.onDidLayoutChange(pinAllZoneNodes),
  ];

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
            // In readOnly mode the glyph-margin click is suppressed, so the
            // marker must not offer a pointer cursor it cannot honour.
            glyphMarginClassName: options.readOnly
              ? "monaco-comment-glyph monaco-comment-glyph--static"
              : "monaco-comment-glyph",
            glyphMarginHoverMessage: { value: HAS_COMMENT_TOOLTIP },
            stickiness: 1, // NeverGrowsWhenTypingAtEdges
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
      // clearAllZones() already emitted `false`; belt-and-braces so a surface
      // can never be left with Send disabled by a torn-down editor.
      editingIds.clear();
      inputZone = null;
      syncOpenState();
    },
  };

  return manager;
}
