/**
 * Unit tests for the durable Present-tab store (docs/093).
 *
 * The store is the orchestrator-side persistence that lets the Present tab
 * survive a session-container restart: a fresh runner seeds its cache from
 * here, and `proxyPresentRaw` re-registers a persisted entry with the new
 * worker. These assert the record/replace/clear reducer and the round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { PresentStore, type PersistedPresentation } from "./present-store.js";

function makeEntry(overrides: Partial<PersistedPresentation> = {}): PersistedPresentation {
  return {
    presentId: "pres_1",
    sessionId: "s1",
    filePath: "/tmp/chart.html",
    resolvedPath: "/tmp/chart.html",
    mimeType: "text/html",
    title: "Chart",
    createdAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("PresentStore", () => {
  let dbManager: DatabaseManager;
  let store: PresentStore;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    store = new PresentStore(dbManager);
  });

  afterEach(() => {
    dbManager.close();
  });

  it("records a presentation and round-trips its full metadata", () => {
    store.record(makeEntry());
    const list = store.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(makeEntry());
  });

  it("omits title when not set (round-trips as undefined, not null)", () => {
    const { title: _omit, ...noTitle } = makeEntry();
    store.record(noTitle as PersistedPresentation);
    const got = store.get("pres_1");
    expect(got).toBeDefined();
    expect("title" in got!).toBe(false);
  });

  it("listForClient strips the container-internal resolvedPath", () => {
    store.record(makeEntry());
    const client = store.listForClient("s1");
    expect(client).toEqual([
      {
        presentId: "pres_1",
        mimeType: "text/html",
        filePath: "/tmp/chart.html",
        createdAt: "2026-06-15T00:00:00.000Z",
        title: "Chart",
      },
    ]);
    expect("resolvedPath" in client[0]).toBe(false);
  });

  it("scopes by session id", () => {
    store.record(makeEntry({ presentId: "a", sessionId: "s1" }));
    store.record(makeEntry({ presentId: "b", sessionId: "s2" }));
    expect(store.list("s1").map((p) => p.presentId)).toEqual(["a"]);
    expect(store.list("s2").map((p) => p.presentId)).toEqual(["b"]);
  });

  it("appends new entries in insertion order", () => {
    store.record(makeEntry({ presentId: "a" }));
    store.record(makeEntry({ presentId: "b" }));
    store.record(makeEntry({ presentId: "c" }));
    expect(store.list("s1").map((p) => p.presentId)).toEqual(["a", "b", "c"]);
  });

  it("replaceId replaces in place, preserving carousel slot", () => {
    store.record(makeEntry({ presentId: "a" }));
    store.record(makeEntry({ presentId: "b" }));
    store.record(makeEntry({ presentId: "c" }));
    // Revise the middle one (b → b2). It must keep slot 1, not jump to the end.
    store.record(makeEntry({ presentId: "b2", title: "B v2" }), "b");
    const ids = store.list("s1").map((p) => p.presentId);
    expect(ids).toEqual(["a", "b2", "c"]);
    expect(store.get("b2")?.title).toBe("B v2");
    expect(store.get("b")).toBeUndefined();
  });

  it("appends when replaceId does not match any row", () => {
    store.record(makeEntry({ presentId: "a" }));
    store.record(makeEntry({ presentId: "b" }), "missing");
    expect(store.list("s1").map((p) => p.presentId)).toEqual(["a", "b"]);
  });

  it("idempotent re-delivery of the same presentId updates in place", () => {
    store.record(makeEntry({ presentId: "a", title: "v1" }));
    store.record(makeEntry({ presentId: "a", title: "v2" }));
    const list = store.list("s1");
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("v2");
  });

  it("clear(sessionId, presentId) drops just that entry", () => {
    store.record(makeEntry({ presentId: "a" }));
    store.record(makeEntry({ presentId: "b" }));
    store.clear("s1", "a");
    expect(store.list("s1").map((p) => p.presentId)).toEqual(["b"]);
  });

  it("clear(sessionId) wipes the whole session", () => {
    store.record(makeEntry({ presentId: "a" }));
    store.record(makeEntry({ presentId: "b" }));
    store.clear("s1");
    expect(store.list("s1")).toEqual([]);
  });

  it("deleteSession drops every entry for a session", () => {
    store.record(makeEntry({ presentId: "a", sessionId: "s1" }));
    store.record(makeEntry({ presentId: "b", sessionId: "s2" }));
    store.deleteSession("s1");
    expect(store.list("s1")).toEqual([]);
    expect(store.list("s2").map((p) => p.presentId)).toEqual(["b"]);
  });

  it("survives a fresh store over the same database (restart simulation)", () => {
    store.record(makeEntry({ presentId: "a" }));
    // A new store instance over the SAME db = the orchestrator outliving a
    // session container; a freshly-created runner reads the persisted metadata.
    const reopened = new PresentStore(dbManager);
    expect(reopened.list("s1").map((p) => p.presentId)).toEqual(["a"]);
    expect(reopened.get("a")?.resolvedPath).toBe("/tmp/chart.html");
  });
});
