/**
 * Unit tests for PresentBuffer (docs/093).
 */
import { describe, it, expect } from "vitest";
import { PresentBuffer, PresentBufferError } from "./present-buffer.js";

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

  it("rejects entries larger than the per-entry cap", () => {
    const buf = new PresentBuffer({ maxBytesPerEntry: 10 });
    expect(() =>
      buf.put("a", { content: "this string is longer than ten bytes", mimeType: "text/plain" }),
    ).toThrow(PresentBufferError);
    expect(buf.size).toBe(0);
  });

  it("LRU-evicts oldest when entry count exceeds the cap", () => {
    const buf = new PresentBuffer({ maxEntries: 2 });
    buf.put("a", { content: "1", mimeType: "text/plain" });
    buf.put("b", { content: "2", mimeType: "text/plain" });
    const { evicted } = buf.put("c", { content: "3", mimeType: "text/plain" });
    expect(evicted).toEqual(["a"]);
    expect(buf.get("a")).toBeUndefined();
    expect(buf.get("b")).toBeDefined();
    expect(buf.get("c")).toBeDefined();
  });

  it("LRU-evicts when total bytes exceed the byte ceiling", () => {
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
