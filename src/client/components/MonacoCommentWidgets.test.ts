import { describe, it, expect, beforeEach, vi } from "vitest";
import { createCommentWidgetManager } from "./MonacoCommentWidgets.js";
import type { LineComment } from "../../server/shared/types.js";

/**
 * Minimal stub of the bits of monaco.editor.ICodeEditor that
 * MonacoCommentWidgets actually touches. Captures changeViewZones calls
 * and lets us drive onMouseDown/decorations to assert behavior.
 */
function makeFakeEditor() {
  const zones = new Map<string, { afterLineNumber: number; domNode: HTMLElement; heightInPx: number }>();
  let nextId = 0;
  const mouseDownHandlers: ((e: { target: { type: number; position?: { lineNumber: number } | null } }) => void)[] = [];
  let decorationCount = 0;
  const decorationCollections: { clear: ReturnType<typeof vi.fn> }[] = [];
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
    onMouseDown(handler: (e: { target: { type: number; position?: { lineNumber: number } | null } }) => void) {
      mouseDownHandlers.push(handler);
      return { dispose: vi.fn() };
    },
    updateOptions,
    createDecorationsCollection: vi.fn((decs: unknown[]) => {
      decorationCount = decs.length;
      const coll = { clear: vi.fn(() => { decorationCount = 0; }) };
      decorationCollections.push(coll);
      return coll;
    }),
  };

  return {
    editor,
    zones,
    fireMouseDown: (lineNumber: number, type = 2) => {
      for (const h of mouseDownHandlers) {
        h({ target: { type, position: lineNumber > 0 ? { lineNumber } : null } });
      }
    },
    getDecorationCount: () => decorationCount,
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
});
