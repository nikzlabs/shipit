/**
 * Unit tests for PresentRegistry (docs/093).
 */
import { describe, it, expect } from "vitest";
import { PresentRegistry, derivePresentId } from "./present-registry.js";

function meta(presentId: string, over: Partial<Parameters<PresentRegistry["put"]>[1]> = {}) {
  return {
    resolvedPath: `/tmp/${presentId}.html`,
    filePath: `${presentId}.html`,
    mimeType: "text/html",
    createdAt: "2026-06-03T00:00:00.000Z",
    ...over,
  };
}

describe("derivePresentId", () => {
  it("is deterministic for the same (sessionId, path) and prefixed", () => {
    const a = derivePresentId("sess-1", "/tmp/x.html");
    const b = derivePresentId("sess-1", "/tmp/x.html");
    expect(a).toBe(b);
    expect(a.startsWith("pres_")).toBe(true);
  });

  it("differs by path", () => {
    expect(derivePresentId("sess-1", "/tmp/x.html")).not.toBe(
      derivePresentId("sess-1", "/tmp/y.html"),
    );
  });

  it("differs by session so two sessions presenting the same path don't collide", () => {
    expect(derivePresentId("sess-1", "/tmp/x.html")).not.toBe(
      derivePresentId("sess-2", "/tmp/x.html"),
    );
  });
});

describe("PresentRegistry", () => {
  it("stores and retrieves metadata (no bytes)", () => {
    const reg = new PresentRegistry();
    const stored = reg.put("a", meta("a", { title: "Hi" }));
    expect(stored.resolvedPath).toBe("/tmp/a.html");
    expect(stored.title).toBe("Hi");
    expect(reg.get("a")?.filePath).toBe("a.html");
    expect(reg.size).toBe(1);
  });

  it("never evicts on count — many entries coexist (no caps)", () => {
    const reg = new PresentRegistry();
    for (let i = 0; i < 100; i++) {
      reg.put(`e${i}`, meta(`e${i}`));
    }
    expect(reg.size).toBe(100);
  });

  it("re-presenting the same id updates in place, keeping a single entry", () => {
    const reg = new PresentRegistry();
    reg.put("a", meta("a", { title: "first" }));
    const stored = reg.put("a", meta("a", { title: "second" }));
    expect(stored.title).toBe("second");
    expect(reg.get("a")?.title).toBe("second");
    expect(reg.size).toBe(1);
  });

  it("distinct ids append as separate entries", () => {
    const reg = new PresentRegistry();
    reg.put("a", meta("a"));
    reg.put("b", meta("b"));
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
