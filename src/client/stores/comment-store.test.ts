import { describe, it, expect, beforeEach } from "vitest";
import { useCommentStore } from "./comment-store.js";

const STORAGE_KEY = "shipit-file-comments";

function reset(): void {
  localStorage.clear();
  useCommentStore.setState({ commentsBySession: {} });
}

describe("comment-store", () => {
  beforeEach(reset);

  describe("addLineComment", () => {
    it("stores a comment with kind=line, filePath, and line", () => {
      useCommentStore.getState().addLineComment("s1", "src/a.ts", 10, "needs work");
      const comments = useCommentStore.getState().getAllComments("s1");
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        kind: "line",
        filePath: "src/a.ts",
        line: 10,
        text: "needs work",
      });
      expect(comments[0].id).toBeTruthy();
    });

    it("appends multiple line comments", () => {
      useCommentStore.getState().addLineComment("s1", "src/a.ts", 1, "one");
      useCommentStore.getState().addLineComment("s1", "src/a.ts", 5, "two");
      expect(useCommentStore.getState().getCommentCount("s1")).toBe(2);
    });
  });

  describe("addSectionComment", () => {
    it("stores a comment with kind=section, heading, and index", () => {
      useCommentStore.getState().addSectionComment("s1", "docs/x.md", "## Architecture", 2, "rethink this");
      const comments = useCommentStore.getState().getAllComments("s1");
      expect(comments).toHaveLength(1);
      expect(comments[0]).toMatchObject({
        kind: "section",
        filePath: "docs/x.md",
        sectionHeading: "## Architecture",
        sectionIndex: 2,
        text: "rethink this",
      });
    });
  });

  describe("editComment", () => {
    it("updates text by id, preserving other fields", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 3, "old");
      const id = useCommentStore.getState().getAllComments("s1")[0].id;
      useCommentStore.getState().editComment("s1", id, "new");
      const c = useCommentStore.getState().getAllComments("s1")[0];
      expect(c.text).toBe("new");
      expect(c.kind).toBe("line");
      expect(c.filePath).toBe("a.ts");
      expect((c as { line: number }).line).toBe(3);
    });

    it("does nothing when id is unknown", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "x");
      useCommentStore.getState().editComment("s1", "nonexistent", "y");
      expect(useCommentStore.getState().getAllComments("s1")[0].text).toBe("x");
    });
  });

  describe("deleteComment", () => {
    it("removes the matching comment, leaves others", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "a");
      useCommentStore.getState().addLineComment("s1", "a.ts", 2, "b");
      const ids = useCommentStore.getState().getAllComments("s1").map((c) => c.id);
      useCommentStore.getState().deleteComment("s1", ids[0]);
      const remaining = useCommentStore.getState().getAllComments("s1");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].text).toBe("b");
    });
  });

  describe("clearComments", () => {
    it("removes all comments for a session", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "x");
      useCommentStore.getState().addLineComment("s1", "b.ts", 1, "y");
      useCommentStore.getState().clearComments("s1");
      expect(useCommentStore.getState().getCommentCount("s1")).toBe(0);
    });

    it("does not touch other sessions", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "x");
      useCommentStore.getState().addLineComment("s2", "b.ts", 1, "y");
      useCommentStore.getState().clearComments("s1");
      expect(useCommentStore.getState().getCommentCount("s1")).toBe(0);
      expect(useCommentStore.getState().getCommentCount("s2")).toBe(1);
    });
  });

  describe("getCommentsForFile", () => {
    it("returns only comments matching the filePath", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "x");
      useCommentStore.getState().addLineComment("s1", "b.ts", 2, "y");
      useCommentStore.getState().addSectionComment("s1", "a.ts", "## H", 0, "z");
      const aComments = useCommentStore.getState().getCommentsForFile("s1", "a.ts");
      expect(aComments).toHaveLength(2);
      expect(aComments.every((c) => c.filePath === "a.ts")).toBe(true);
    });

    it("returns both line and section comments for the file", () => {
      useCommentStore.getState().addLineComment("s1", "a.md", 1, "line");
      useCommentStore.getState().addSectionComment("s1", "a.md", "## H", 0, "section");
      const kinds = useCommentStore.getState().getCommentsForFile("s1", "a.md").map((c) => c.kind).sort();
      expect(kinds).toEqual(["line", "section"]);
    });
  });

  describe("session isolation", () => {
    it("comments from one session do not leak into another", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "s1");
      useCommentStore.getState().addLineComment("s2", "a.ts", 1, "s2");
      expect(useCommentStore.getState().getAllComments("s1")[0].text).toBe("s1");
      expect(useCommentStore.getState().getAllComments("s2")[0].text).toBe("s2");
    });

    it("getAllComments returns [] for unknown session", () => {
      expect(useCommentStore.getState().getAllComments("missing")).toEqual([]);
    });
  });

  describe("localStorage persistence", () => {
    it("writes to localStorage on add", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "x");
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw!) as Record<string, { text: string }[]>;
      expect(parsed.s1).toHaveLength(1);
      expect(parsed.s1[0].text).toBe("x");
    });

    it("writes to localStorage on delete", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "x");
      const id = useCommentStore.getState().getAllComments("s1")[0].id;
      useCommentStore.getState().deleteComment("s1", id);
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown[]>;
      expect(parsed.s1).toEqual([]);
    });

    it("removes the session entry on clearComments", () => {
      useCommentStore.getState().addLineComment("s1", "a.ts", 1, "x");
      useCommentStore.getState().clearComments("s1");
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY)!) as Record<string, unknown[]>;
      expect(parsed.s1).toBeUndefined();
    });
  });
});
