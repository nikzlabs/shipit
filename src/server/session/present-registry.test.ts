/**
 * Unit tests for PresentRegistry (docs/093).
 */
import { describe, it, expect } from "vitest";
import { PresentRegistry } from "./present-registry.js";

function meta(presentId: string, over: Partial<Parameters<PresentRegistry["put"]>[1]> = {}) {
  return {
    resolvedPath: `/tmp/${presentId}.html`,
    filePath: `${presentId}.html`,
    mimeType: "text/html",
    createdAt: "2026-06-03T00:00:00.000Z",
    ...over,
  };
}

describe("PresentRegistry", () => {
  it("stores and retrieves metadata (no bytes)", () => {
    const reg = new PresentRegistry();
    const { meta: stored, evicted } = reg.put("a", meta("a", { title: "Hi" }));
    expect(evicted).toEqual([]);
    expect(stored.resolvedPath).toBe("/tmp/a.html");
    expect(stored.title).toBe("Hi");
    expect(reg.get("a")?.filePath).toBe("a.html");
    expect(reg.size).toBe(1);
  });

  it("never evicts on count — many entries coexist (no caps)", () => {
    const reg = new PresentRegistry();
    for (let i = 0; i < 100; i++) {
      const { evicted } = reg.put(`e${i}`, meta(`e${i}`));
      expect(evicted).toEqual([]);
    }
    expect(reg.size).toBe(100);
  });

  it("revises in-place when replaceId matches, evicting the superseded id", () => {
    const reg = new PresentRegistry();
    reg.put("a", meta("a", { title: "first" }));
    const { meta: stored, evicted } = reg.put("b", meta("b", { title: "second", replaceId: "a" }));
    expect(evicted).toEqual(["a"]);
    expect(stored.title).toBe("second");
    expect(reg.get("a")).toBeUndefined();
    expect(reg.get("b")?.title).toBe("second");
    expect(reg.size).toBe(1);
  });

  it("revision with the same id does not evict", () => {
    const reg = new PresentRegistry();
    reg.put("a", meta("a"));
    const { evicted } = reg.put("a", meta("a", { title: "v2", replaceId: "a" }));
    expect(evicted).toEqual([]);
    expect(reg.get("a")?.title).toBe("v2");
  });

  it("appends when replaceId does not match any entry", () => {
    const reg = new PresentRegistry();
    reg.put("a", meta("a"));
    const { evicted } = reg.put("b", meta("b", { replaceId: "missing" }));
    expect(evicted).toEqual([]);
    expect(reg.size).toBe(2);
  });

  it("delete removes a single entry", () => {
    const reg = new PresentRegistry();
    reg.put("a", meta("a"));
    expect(reg.delete("a")).toBe(true);
    expect(reg.get("a")).toBeUndefined();
    expect(reg.delete("a")).toBe(false);
  });

  it("clear wipes all entries", () => {
    const reg = new PresentRegistry();
    reg.put("a", meta("a"));
    reg.put("b", meta("b"));
    reg.clear();
    expect(reg.size).toBe(0);
  });
});
