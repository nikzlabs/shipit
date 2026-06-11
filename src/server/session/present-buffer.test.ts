/**
 * Unit tests for PresentBuffer (docs/093).
 */
import { describe, it, expect } from "vitest";
import { PresentBuffer } from "./present-buffer.js";

describe("PresentBuffer", () => {
  it("stores and retrieves entries", () => {
    const buf = new PresentBuffer();
    const { entry, evicted } = buf.put("a", { content: "<p>hi</p>", mimeType: "text/html", title: "Hi" });
    expect(evicted).toEqual([]);
    expect(entry.content).toBe("<p>hi</p>");
    expect(entry.title).toBe("Hi");
    expect(buf.get("a")?.content).toBe("<p>hi</p>");
    expect(buf.size).toBe(1);
  });

  it("never rejects an artifact, regardless of size (no per-entry cap)", () => {
    const buf = new PresentBuffer({ maxTotalBytes: 10 });
    const big = "x".repeat(1000); // far larger than the backstop
    const { entry, evicted } = buf.put("a", { content: big, mimeType: "text/plain" });
    expect(evicted).toEqual([]);
    expect(entry.content).toBe(big);
    // The newest entry is kept even when it alone exceeds the budget.
    expect(buf.get("a")?.content).toBe(big);
    expect(buf.size).toBe(1);
  });

  it("does not evict on entry count alone — only the memory backstop bounds it", () => {
    // A high byte ceiling means many small entries all coexist; there is no
    // 20-entry (or any) count cap anymore.
    const buf = new PresentBuffer({ maxTotalBytes: 1024 });
    for (let i = 0; i < 50; i++) {
      const { evicted } = buf.put(`e${i}`, { content: "x", mimeType: "text/plain" });
      expect(evicted).toEqual([]);
    }
    expect(buf.size).toBe(50);
  });

  it("LRU-evicts when total bytes exceed the memory backstop", () => {
    const buf = new PresentBuffer({ maxTotalBytes: 20 });
    buf.put("a", { content: "0123456789", mimeType: "text/plain" }); // 10 bytes
    buf.put("b", { content: "0123456789", mimeType: "text/plain" }); // 10 bytes — at ceiling
    const { evicted } = buf.put("c", { content: "01234", mimeType: "text/plain" }); // pushes over
    expect(evicted).toContain("a");
    expect(buf.get("a")).toBeUndefined();
  });

  it("replaces in-place when replaceId matches an existing entry", () => {
    const buf = new PresentBuffer();
    buf.put("a", { content: "v1", mimeType: "text/plain", title: "first" });
    const { entry, evicted } = buf.put("b", {
      content: "v2",
      mimeType: "text/plain",
      title: "second",
      replaceId: "a",
    });
    expect(evicted).toEqual(["a"]);
    expect(entry.content).toBe("v2");
    expect(buf.get("a")).toBeUndefined();
    expect(buf.get("b")?.title).toBe("second");
    expect(buf.size).toBe(1);
  });

  it("replace with same id does not generate an eviction", () => {
    const buf = new PresentBuffer();
    buf.put("a", { content: "v1", mimeType: "text/plain" });
    const { evicted } = buf.put("a", { content: "v2", mimeType: "text/plain", replaceId: "a" });
    expect(evicted).toEqual([]);
    expect(buf.get("a")?.content).toBe("v2");
  });

  it("delete removes the entry and updates byte accounting", () => {
    const buf = new PresentBuffer();
    buf.put("a", { content: "12345", mimeType: "text/plain" });
    expect(buf.bytes).toBe(5);
    expect(buf.delete("a")).toBe(true);
    expect(buf.bytes).toBe(0);
    expect(buf.get("a")).toBeUndefined();
    expect(buf.delete("a")).toBe(false);
  });

  it("clear wipes all entries", () => {
    const buf = new PresentBuffer();
    buf.put("a", { content: "1", mimeType: "text/plain" });
    buf.put("b", { content: "2", mimeType: "text/plain" });
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.bytes).toBe(0);
  });
});
