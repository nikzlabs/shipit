import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createCommentWidgetManager,
  ADD_COMMENT_TOOLTIP,
  HAS_COMMENT_TOOLTIP,
} from "./MonacoCommentWidgets.js";
import type { LineComment } from "../../server/shared/types.js";

/** The mouse events the widget's Monaco listeners read, as far as tests care. */
interface FakeMouseEvent {
  target: {
    type: number;
    position?: { lineNumber: number } | null;
    detail?: { isAfterLines: boolean };
  };
}

/** Shape of the decorations the widget hands to Monaco, as far as tests care. */
interface FakeDecoration {
  range: { startLineNumber: number };
  options: {
    glyphMarginClassName?: string;
    glyphMarginHoverMessage?: { value: string };
  };
}

/**
 * Minimal stub of the bits of monaco.editor.ICodeEditor that
 * MonacoCommentWidgets actually touches. Captures changeViewZones calls
 * and lets us drive onMouseDown/decorations to assert behavior.
 */
function makeFakeEditor() {
  const zones = new Map<string, { afterLineNumber: number; domNode: HTMLElement; heightInPx: number }>();
  let nextId = 0;
  const mouseDownHandlers: ((e: FakeMouseEvent) => void)[] = [];
  const mouseMoveHandlers: ((e: FakeMouseEvent) => void)[] = [];
  const mouseLeaveHandlers: (() => void)[] = [];
  const scrollHandlers: (() => void)[] = [];

  /**
   * Mirrors Monaco: `dispose()` unregisters the handler. Without this the
   * tests could not tell a torn-down listener from a live one, so dropping
   * disposal in production would still pass.
   */
  function subscribe<T>(list: T[], handler: T) {
    list.push(handler);
    return {
      dispose: vi.fn(() => {
        const i = list.indexOf(handler);
        if (i !== -1) list.splice(i, 1);
      }),
    };
  }
  const decorationCollections: { clear: ReturnType<typeof vi.fn> }[] = [];
  /** Every decoration currently live, across all collections. */
  const liveDecorations = new Map<number, FakeDecoration[]>();
  let nextCollectionId = 0;
  const updateOptions = vi.fn();

  const accessor = {
    addZone(zone: { afterLineNumber: number; domNode: HTMLElement; heightInPx: number }): string {
      const id = `zone-${++nextId}`;
      zones.set(id, zone);
      return id;
    },
    removeZone(id: string): void {
      zones.delete(id);
    },
  };

  const editor = {
    changeViewZones(cb: (a: typeof accessor) => void) {
      cb(accessor);
    },
    onMouseDown: (handler: (e: FakeMouseEvent) => void) => subscribe(mouseDownHandlers, handler),
    onMouseMove: (handler: (e: FakeMouseEvent) => void) => subscribe(mouseMoveHandlers, handler),
    onMouseLeave: (handler: () => void) => subscribe(mouseLeaveHandlers, handler),
    onDidScrollChange: (handler: () => void) => subscribe(scrollHandlers, handler),
    updateOptions,
    createDecorationsCollection: vi.fn((decs: FakeDecoration[]) => {
      const id = ++nextCollectionId;
      liveDecorations.set(id, decs);
      const coll = {
        clear: vi.fn(() => { liveDecorations.set(id, []); }),
        set: vi.fn((next: FakeDecoration[]) => { liveDecorations.set(id, next); }),
      };
      decorationCollections.push(coll);
      return coll;
    }),
  };

  /**
   * Decorations across all collections carrying the given glyph class.
   * Monaco takes a space-separated class list, so match a member of it.
   */
  const decorationsWithClass = (className: string): FakeDecoration[] =>
    [...liveDecorations.values()]
      .flat()
      .filter((d) => d.options.glyphMarginClassName?.split(" ").includes(className));

  return {
    editor,
    zones,
    fireMouseDown: (lineNumber: number, type = 2, isAfterLines = false) => {
      for (const h of [...mouseDownHandlers]) {
        h({
          target: {
            type,
            position: lineNumber > 0 ? { lineNumber } : null,
            detail: { isAfterLines },
          },
        });
      }
    },
    fireMouseMove: (lineNumber: number | null, type = 6, isAfterLines = false) => {
      for (const h of [...mouseMoveHandlers]) {
        h({
          target: {
            type,
            position: lineNumber === null ? null : { lineNumber },
            detail: { isAfterLines },
          },
        });
      }
    },
    fireMouseLeave: () => {
      for (const h of [...mouseLeaveHandlers]) h();
    },
    fireScroll: () => {
      for (const h of [...scrollHandlers]) h();
    },
    hasMouseMoveHandler: () => mouseMoveHandlers.length > 0,
    decorationsWithClass,
    /** Lines currently showing the hover `+`. */
    addGlyphLines: () =>
      decorationsWithClass("monaco-comment-add-glyph").map((d) => d.range.startLineNumber),
    getDecorationCount: () => [...liveDecorations.values()].flat().length,
    decorationCollections,
    updateOptions,
  };
}

function lineComment(overrides?: Partial<LineComment>): LineComment {
  return {
    id: "c1",
    kind: "line",
    filePath: "src/a.ts",
    line: 5,
    text: "needs fixing",
    ...overrides,
  };
}

describe("MonacoCommentWidgets", () => {
  let fake: ReturnType<typeof makeFakeEditor>;

  beforeEach(() => {
    fake = makeFakeEditor();
  });

  it("enables glyph margin on creation", () => {
    createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    expect(fake.updateOptions).toHaveBeenCalledWith({ glyphMargin: true });
  });

  it("setComments() creates view zones for line comments at the right line", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );

    manager.setComments([lineComment({ line: 7 }), lineComment({ id: "c2", line: 12 })]);

    const lines = [...fake.zones.values()].map((z) => z.afterLineNumber).sort((a, b) => a - b);
    expect(lines).toEqual([7, 12]);
  });

  it("setComments() ignores comments for other files", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.setComments([
      lineComment({ filePath: "src/a.ts", line: 3 }),
      lineComment({ id: "c2", filePath: "src/b.ts", line: 3 }),
    ]);
    expect(fake.zones.size).toBe(1);
  });

  it("setComments() ignores section-kind comments", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "doc.md",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    // Selection-kind entries are filtered out by the widget regardless of
    // any extra fields. We pass a minimal selection shape that satisfies
    // the LineCommentLike supertype.
    manager.setComments([
      {
        id: "s1",
        kind: "selection",
        filePath: "doc.md",
        text: "x",
      },
    ]);
    expect(fake.zones.size).toBe(0);
  });

  it("setComments() adds glyph margin decorations for commented lines", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.setComments([lineComment({ line: 4 }), lineComment({ id: "c2", line: 9 })]);
    expect(fake.getDecorationCount()).toBe(2);
  });

  it("setComments() clears previous zones when called again", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.setComments([lineComment({ line: 4 })]);
    expect(fake.zones.size).toBe(1);
    manager.setComments([lineComment({ id: "c2", line: 8 }), lineComment({ id: "c3", line: 12 })]);
    const lines = [...fake.zones.values()].map((z) => z.afterLineNumber).sort((a, b) => a - b);
    expect(lines).toEqual([8, 12]);
  });

  it("clicking the glyph margin opens an input zone at that line", () => {
    createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );

    fake.fireMouseDown(15);
    const lines = [...fake.zones.values()].map((z) => z.afterLineNumber);
    expect(lines).toContain(15);
  });

  it("ignores a glyph margin click in the blank space past the end of the file", () => {
    createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    // Monaco still reports the last line here, so an unguarded click opens an
    // input on a line the pointer is nowhere near — and one the `+` refuses
    // to mark, which would make the affordance a lie.
    fake.fireMouseDown(8, 2, /* isAfterLines */ true);
    expect(fake.zones.size).toBe(0);
  });

  it("ignores mouse down events outside the glyph margin", () => {
    createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    fake.fireMouseDown(15, /* type=content */ 6);
    expect(fake.zones.size).toBe(0);
  });

  it("openCommentInput() inserts an input zone below the requested line", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.openCommentInput(20);
    const lines = [...fake.zones.values()].map((z) => z.afterLineNumber);
    expect(lines).toContain(20);
  });

  it("opening a second input replaces the first", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.openCommentInput(5);
    expect(fake.zones.size).toBe(1);
    manager.openCommentInput(10);
    expect(fake.zones.size).toBe(1);
    expect([...fake.zones.values()][0].afterLineNumber).toBe(10);
  });

  it("input zone calls onAddComment when Add is clicked with text", () => {
    const onAdd = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: onAdd,
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.openCommentInput(7);

    const zone = [...fake.zones.values()][0];
    const textarea = zone.domNode.querySelector("textarea")!;
    textarea.value = "looks wrong";
    const addBtn = [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Add")!;
    addBtn.click();

    expect(onAdd).toHaveBeenCalledWith(7, "looks wrong");
    // Input is removed after submit
    expect(fake.zones.size).toBe(0);
  });

  it("input zone trims whitespace and skips empty submissions", () => {
    const onAdd = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: onAdd,
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.openCommentInput(2);
    const zone = [...fake.zones.values()][0];
    const textarea = zone.domNode.querySelector("textarea")!;
    textarea.value = "   ";
    const addBtn = [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Add")!;
    addBtn.click();
    expect(onAdd).not.toHaveBeenCalled();
    // Empty input should not be removed (still showing for the user)
    expect(fake.zones.size).toBe(1);
  });

  it("input zone closes via Cancel without calling onAddComment", () => {
    const onAdd = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: onAdd,
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.openCommentInput(3);
    const zone = [...fake.zones.values()][0];
    const cancelBtn = [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    cancelBtn.click();
    expect(onAdd).not.toHaveBeenCalled();
    expect(fake.zones.size).toBe(0);
  });

  it("input zone supports Cmd+Enter to submit", () => {
    const onAdd = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: onAdd,
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.openCommentInput(11);
    const zone = [...fake.zones.values()][0];
    const textarea = zone.domNode.querySelector("textarea")!;
    textarea.value = "hi";
    const evt = new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true });
    textarea.dispatchEvent(evt);
    expect(onAdd).toHaveBeenCalledWith(11, "hi");
  });

  it("input zone supports Escape to cancel", () => {
    const onAdd = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: onAdd,
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.openCommentInput(11);
    const zone = [...fake.zones.values()][0];
    const textarea = zone.domNode.querySelector("textarea")!;
    const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    textarea.dispatchEvent(evt);
    expect(onAdd).not.toHaveBeenCalled();
    expect(fake.zones.size).toBe(0);
  });

  it("comment card delete button calls onDeleteComment with id", () => {
    const onDelete = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: onDelete,
      },
    );
    manager.setComments([lineComment({ id: "abc", line: 7 })]);
    const zone = [...fake.zones.values()][0];
    const delBtn = [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Del")!;
    delBtn.click();
    expect(onDelete).toHaveBeenCalledWith("abc");
  });

  it("renders GitHub-sourced review threads as read-only cards with author details", () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: onEdit,
        onDeleteComment: onDelete,
      },
    );

    manager.setComments([
      {
        id: "github:RT_1",
        kind: "line",
        source: "github",
        filePath: "src/a.ts",
        line: 9,
        text: "rename this",
        isResolved: true,
        replies: [
          {
            id: "RC_1",
            author: { login: "alice", avatarUrl: "" },
            body: "rename this",
            createdAt: "2026-05-20T10:00:00Z",
          },
        ],
      },
    ]);

    const zone = [...fake.zones.values()][0];
    expect(zone.domNode.textContent).toContain("GitHub");
    expect(zone.domNode.textContent).toContain("resolved");
    expect(zone.domNode.textContent).toContain("alice");
    expect(zone.domNode.textContent).toContain("rename this");
    expect([...zone.domNode.querySelectorAll("button")].some((b) => b.textContent === "Edit")).toBe(false);
    expect([...zone.domNode.querySelectorAll("button")].some((b) => b.textContent === "Del")).toBe(false);
    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("comment card edit flow calls onEditComment with new text", () => {
    const onEdit = vi.fn();
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: onEdit,
        onDeleteComment: vi.fn(),
      },
    );
    manager.setComments([lineComment({ id: "c1", line: 7, text: "old" })]);
    const zone = [...fake.zones.values()][0];
    const editBtn = [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Edit")!;
    editBtn.click();

    // After edit, the card replaces itself with a textarea and Save button
    const textarea = zone.domNode.querySelector("textarea")!;
    expect(textarea).toBeTruthy();
    expect(textarea.value).toBe("old");
    textarea.value = "new text";
    const saveBtn = [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
    saveBtn.click();
    expect(onEdit).toHaveBeenCalledWith("c1", "new text");
  });

  describe("onInputOpenChange (blocks Send while an editor is open)", () => {
    it("reports the add-comment input opening and closing", () => {
      const onInputOpenChange = vi.fn();
      const manager = createCommentWidgetManager(
        fake.editor as never,
        {
          filePath: "src/a.ts",
          onAddComment: vi.fn(),
          onEditComment: vi.fn(),
          onDeleteComment: vi.fn(),
          onInputOpenChange,
        },
      );
      manager.openCommentInput(3);
      expect(onInputOpenChange).toHaveBeenLastCalledWith(true);

      const zone = [...fake.zones.values()][0];
      const cancelBtn = [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
      cancelBtn.click();
      expect(onInputOpenChange).toHaveBeenLastCalledWith(false);
    });

    it("reports an in-card edit form opening, and closing on re-render", () => {
      const onInputOpenChange = vi.fn();
      const manager = createCommentWidgetManager(
        fake.editor as never,
        {
          filePath: "src/a.ts",
          onAddComment: vi.fn(),
          onEditComment: vi.fn(),
          onDeleteComment: vi.fn(),
          onInputOpenChange,
        },
      );
      manager.setComments([lineComment({ id: "c1", line: 7, text: "old" })]);
      const zone = [...fake.zones.values()][0];
      [...zone.domNode.querySelectorAll("button")].find((b) => b.textContent === "Edit")!.click();
      expect(onInputOpenChange).toHaveBeenLastCalledWith(true);

      // Cancelling re-renders the cards, which tears the edit form down.
      manager.setComments([lineComment({ id: "c1", line: 7, text: "old" })]);
      expect(onInputOpenChange).toHaveBeenLastCalledWith(false);
    });

    it("reports false on dispose so a torn-down editor can't strand Send", () => {
      const onInputOpenChange = vi.fn();
      const manager = createCommentWidgetManager(
        fake.editor as never,
        {
          filePath: "src/a.ts",
          onAddComment: vi.fn(),
          onEditComment: vi.fn(),
          onDeleteComment: vi.fn(),
          onInputOpenChange,
        },
      );
      manager.openCommentInput(3);
      expect(onInputOpenChange).toHaveBeenLastCalledWith(true);
      manager.dispose();
      expect(onInputOpenChange).toHaveBeenLastCalledWith(false);
    });
  });

  /**
   * The glyph-margin click is the only way to add a line comment, and before
   * this the margin drew nothing at all — so the hover `+` is the feature's
   * entire discoverability.
   */
  describe("hover affordance", () => {
    function makeManager(readOnly = false) {
      return createCommentWidgetManager(
        fake.editor as never,
        {
          filePath: "src/a.ts",
          onAddComment: vi.fn(),
          onEditComment: vi.fn(),
          onDeleteComment: vi.fn(),
          readOnly,
        },
      );
    }

    it("marks the hovered line with an add-comment glyph", () => {
      makeManager();
      expect(fake.addGlyphLines()).toEqual([]);
      fake.fireMouseMove(6);
      expect(fake.addGlyphLines()).toEqual([6]);
    });

    it("carries a tooltip saying what the click does", () => {
      makeManager();
      fake.fireMouseMove(6);
      const [decoration] = fake.decorationsWithClass("monaco-comment-add-glyph");
      expect(decoration.options.glyphMarginHoverMessage?.value).toBe(ADD_COMMENT_TOOLTIP);
    });

    it("moves the glyph to the newly hovered line", () => {
      makeManager();
      fake.fireMouseMove(6);
      fake.fireMouseMove(11);
      expect(fake.addGlyphLines()).toEqual([11]);
    });

    it("tracks the glyph margin, the line numbers and the code itself", () => {
      makeManager();
      // GUTTER_GLYPH_MARGIN, GUTTER_LINE_NUMBERS, GUTTER_LINE_DECORATIONS,
      // CONTENT_TEXT, CONTENT_EMPTY — the pointer is on the line in all five.
      for (const type of [2, 3, 4, 6, 7]) {
        fake.fireMouseMove(null);
        fake.fireMouseMove(3, type);
        expect(fake.addGlyphLines()).toEqual([3]);
      }
    });

    it("ignores hovers over a view zone, so a comment card marks nothing", () => {
      makeManager();
      // CONTENT_VIEW_ZONE — the pointer is over a comment card, not a line.
      fake.fireMouseMove(4, 8);
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("clears the glyph when the pointer leaves the editor", () => {
      makeManager();
      fake.fireMouseMove(6);
      fake.fireMouseLeave();
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("clears the glyph when the pointer moves off any line", () => {
      makeManager();
      fake.fireMouseMove(6);
      fake.fireMouseMove(null, /* OUTSIDE_EDITOR */ 13);
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("leaves a commented line showing its own glyph, not a `+`", () => {
      const manager = makeManager();
      manager.setComments([lineComment({ line: 5 })]);
      fake.fireMouseMove(5);
      expect(fake.addGlyphLines()).toEqual([]);
      expect(fake.decorationsWithClass("monaco-comment-glyph")).toHaveLength(1);
    });

    it("drops the `+` when the hovered line gains a comment", () => {
      const manager = makeManager();
      fake.fireMouseMove(5);
      expect(fake.addGlyphLines()).toEqual([5]);
      manager.setComments([lineComment({ line: 5 })]);
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("restores the `+` when the hovered line loses its last comment", () => {
      const manager = makeManager();
      manager.setComments([lineComment({ line: 5 })]);
      fake.fireMouseMove(5);
      expect(fake.addGlyphLines()).toEqual([]);
      manager.setComments([]);
      expect(fake.addGlyphLines()).toEqual([5]);
    });

    it("shows no `+` in readOnly mode, which also suppresses the click", () => {
      makeManager(true);
      // readOnly must not even subscribe — a marker with no working click
      // would be a lie.
      expect(fake.hasMouseMoveHandler()).toBe(false);
      fake.fireMouseMove(6);
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("still marks a commented line for the tooltip in readOnly mode", () => {
      const manager = makeManager(true);
      manager.setComments([lineComment({ line: 5 })]);
      const [decoration] = fake.decorationsWithClass("monaco-comment-glyph");
      expect(decoration.options.glyphMarginHoverMessage?.value).toBe(HAS_COMMENT_TOOLTIP);
      // ...but flagged static, so the CSS drops the pointer cursor — readOnly
      // suppresses the click the cursor would be advertising.
      expect(decoration.options.glyphMarginClassName)
        .toContain("monaco-comment-glyph--static");
    });

    it("leaves the comment glyph clickable when not readOnly", () => {
      const manager = makeManager();
      manager.setComments([lineComment({ line: 5 })]);
      const [decoration] = fake.decorationsWithClass("monaco-comment-glyph");
      expect(decoration.options.glyphMarginClassName)
        .not.toContain("monaco-comment-glyph--static");
    });

    // Monaco reports the last line's position for the blank space past the
    // end of a short file, so an unguarded handler marks a line the pointer
    // is hundreds of pixels away from.
    it("draws nothing in the blank space past the end of the file", () => {
      makeManager();
      fake.fireMouseMove(8, /* CONTENT_EMPTY */ 7, /* isAfterLines */ true);
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("clears an existing glyph when the pointer moves past the end", () => {
      makeManager();
      fake.fireMouseMove(3);
      fake.fireMouseMove(8, 7, true);
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("drops the glyph on scroll, which fires no mouse event", () => {
      makeManager();
      fake.fireMouseMove(6);
      fake.fireScroll();
      // Decorations are model-anchored, so a kept marker would ride line 6
      // away from the stationary pointer.
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("dispose() removes the hover glyph", () => {
      const manager = makeManager();
      fake.fireMouseMove(6);
      expect(fake.addGlyphLines()).toEqual([6]);
      manager.dispose();
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("dispose() unsubscribes, so a later mouse move draws nothing", () => {
      const manager = makeManager();
      manager.dispose();
      fake.fireMouseMove(6);
      fake.fireScroll();
      expect(fake.addGlyphLines()).toEqual([]);
      expect(fake.hasMouseMoveHandler()).toBe(false);
    });

    it("survives a second dispose()", () => {
      const manager = makeManager();
      fake.fireMouseMove(6);
      manager.dispose();
      expect(() => { manager.dispose(); }).not.toThrow();
      expect(fake.addGlyphLines()).toEqual([]);
    });

    it("a manager recreated on the same editor still draws the glyph", () => {
      makeManager().dispose();
      makeManager();
      fake.fireMouseMove(6);
      expect(fake.addGlyphLines()).toEqual([6]);
    });
  });

  it("dispose() removes all view zones and clears decorations", () => {
    const manager = createCommentWidgetManager(
      fake.editor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
      },
    );
    manager.setComments([lineComment({ line: 4 }), lineComment({ id: "c2", line: 9 })]);
    expect(fake.zones.size).toBe(2);
    expect(fake.getDecorationCount()).toBe(2);

    manager.dispose();
    expect(fake.zones.size).toBe(0);
    expect(fake.getDecorationCount()).toBe(0);
  });
});

describe("MonacoCommentWidgets — diff editor (modified side)", () => {
  it("uses getModifiedEditor() when side: 'modified' is set", () => {
    const fake = makeFakeEditor();
    const getModifiedEditor = vi.fn(() => fake.editor);
    const diffEditor = { getModifiedEditor };

    createCommentWidgetManager(
      diffEditor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
        side: "modified",
      },
    );

    expect(getModifiedEditor).toHaveBeenCalled();
    expect(fake.updateOptions).toHaveBeenCalledWith({ glyphMargin: true });
  });

  // DiffPanel gets the affordance from the same shared widget, so the hover
  // must land on the modified editor rather than the diff wrapper.
  it("shows the hover glyph on the modified editor", () => {
    const fake = makeFakeEditor();
    const diffEditor = { getModifiedEditor: vi.fn(() => fake.editor) };

    createCommentWidgetManager(
      diffEditor as never,
      {
        filePath: "src/a.ts",
        onAddComment: vi.fn(),
        onEditComment: vi.fn(),
        onDeleteComment: vi.fn(),
        side: "modified",
      },
    );

    fake.fireMouseMove(9);
    expect(fake.addGlyphLines()).toEqual([9]);
  });
});
