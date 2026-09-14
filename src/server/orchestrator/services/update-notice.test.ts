import { describe, it, expect, vi } from "vitest";
import type { UpdateNotice, UpdateNoticeRecord } from "../../shared/types.js";
import type { UpdateStatus } from "./updates.js";
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_RETRY_MS,
  checkUpdatesAndRecord,
  currentUpdateNotice,
  dismissUpdateNotice,
  isCheckDue,
  runUpdateCheckIfDue,
  versionAnchor,
  type UpdateNoticeStore,
} from "./update-notice.js";

const ANCHOR = "aaaaaaa";

/** Mirrors `CredentialStore`'s anchor rule: a record from another build is dropped. */
function fakeStore(initial?: UpdateNoticeRecord): UpdateNoticeStore & { record: UpdateNoticeRecord | undefined } {
  return {
    record: initial,
    getUpdateNotice(anchor: string) {
      if (!this.record) return null;
      if (this.record.anchor !== anchor) {
        this.record = undefined;
        return null;
      }
      return this.record;
    },
    setUpdateNotice(record: UpdateNoticeRecord) {
      this.record = record;
    },
  };
}

function status(overrides: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    available: true,
    currentCommit: "aaaaaaa",
    latestCommit: "bbbbbbb",
    behindBy: 4,
    commitMessages: ["bbbbbbb new thing"],
    channel: "stable",
    currentVersion: "v1.4.0",
    latestVersion: "v1.5.0",
    isDowngrade: false,
    updateMode: "managed",
    ...overrides,
  };
}

function depsFor(store: UpdateNoticeStore, updates: () => Promise<UpdateStatus>, nowMs = Date.parse("2026-09-14T09:00:00Z")) {
  const broadcasts: UpdateNotice[] = [];
  return {
    deps: {
      store,
      anchor: ANCHOR,
      broadcast: (n: UpdateNotice) => { broadcasts.push(n); },
      checkUpdates: updates,
      now: () => nowMs,
    },
    broadcasts,
  };
}

describe("versionAnchor", () => {
  it("prefers the running image's commit over the version label", () => {
    expect(versionAnchor({ channel: "stable", version: "v1.4.0", commit: "abc123" })).toBe("abc123");
  });

  it("falls back to the version label when no commit is known", () => {
    expect(versionAnchor({ channel: "edge", version: "main @ abc1234" })).toBe("main @ abc1234");
  });
});

describe("isCheckDue", () => {
  const now = Date.parse("2026-09-14T09:00:00Z");

  it("is due when nothing has ever been checked", () => {
    expect(isCheckDue(null, now)).toBe(true);
  });

  it("is not due within the day after a successful check", () => {
    const at = new Date(now - UPDATE_CHECK_INTERVAL_MS + 60_000).toISOString();
    expect(isCheckDue({ anchor: ANCHOR, lastCheckedAt: at, lastAttemptAt: at }, now)).toBe(false);
  });

  it("is due a day after the last successful check", () => {
    const at = new Date(now - UPDATE_CHECK_INTERVAL_MS - 1).toISOString();
    expect(isCheckDue({ anchor: ANCHOR, lastCheckedAt: at, lastAttemptAt: at }, now)).toBe(true);
  });

  it("holds a failed check off for an hour rather than retrying every tick", () => {
    const failedAt = new Date(now - UPDATE_CHECK_RETRY_MS + 60_000).toISOString();
    expect(isCheckDue({ anchor: ANCHOR, lastAttemptAt: failedAt }, now)).toBe(false);
    const older = new Date(now - UPDATE_CHECK_RETRY_MS - 1).toISOString();
    expect(isCheckDue({ anchor: ANCHOR, lastAttemptAt: older }, now)).toBe(true);
  });

  it("treats a timestamp from the future as no timestamp at all", () => {
    const ahead = new Date(now + UPDATE_CHECK_INTERVAL_MS).toISOString();
    expect(isCheckDue({ anchor: ANCHOR, lastCheckedAt: ahead, lastAttemptAt: ahead }, now)).toBe(true);
  });
});

describe("checkUpdatesAndRecord", () => {
  it("records the check, broadcasts, and returns the full status", async () => {
    const store = fakeStore();
    const { deps, broadcasts } = depsFor(store, () => Promise.resolve(status()));

    const result = await checkUpdatesAndRecord(deps);

    expect(result.behindBy).toBe(4);
    expect(broadcasts).toEqual([
      { available: true, latestVersion: "v1.5.0", currentVersion: "v1.4.0", dismissed: false },
    ]);
    expect(store.record?.lastCheckedAt).toBe("2026-09-14T09:00:00.000Z");
    expect(isCheckDue(store.record ?? null, Date.parse("2026-09-14T09:00:00Z"))).toBe(false);
  });

  it("does not advertise a downgrade as an available update", async () => {
    const store = fakeStore();
    const { deps, broadcasts } = depsFor(
      store,
      () => Promise.resolve(status({ available: true, isDowngrade: true, behindBy: 0 })),
    );

    await checkUpdatesAndRecord(deps);

    expect(broadcasts[0]?.available).toBe(false);
  });

  it("keeps a standing dismissal when a later version turns up", async () => {
    const store = fakeStore({ anchor: ANCHOR, dismissed: true });
    const { deps, broadcasts } = depsFor(store, () => Promise.resolve(status({ latestVersion: "v1.6.0" })));

    await checkUpdatesAndRecord(deps);

    expect(broadcasts[0]).toEqual({
      available: true, latestVersion: "v1.6.0", currentVersion: "v1.4.0", dismissed: true,
    });
  });

  it("records the attempt and rethrows when the check fails", async () => {
    const store = fakeStore();
    const { deps, broadcasts } = depsFor(store, () => Promise.reject(new Error("offline")));

    await expect(checkUpdatesAndRecord(deps)).rejects.toThrow("offline");
    expect(broadcasts).toEqual([]);
    expect(store.record?.lastAttemptAt).toBe("2026-09-14T09:00:00.000Z");
    expect(store.record?.lastCheckedAt).toBeUndefined();
  });
});

describe("runUpdateCheckIfDue", () => {
  it("skips the check when one already ran today", async () => {
    const now = Date.parse("2026-09-14T09:00:00Z");
    const at = new Date(now - 60_000).toISOString();
    const store = fakeStore({ anchor: ANCHOR, lastCheckedAt: at, lastAttemptAt: at });
    const check = vi.fn(() => Promise.resolve(status()));
    const { deps } = depsFor(store, check, now);

    await runUpdateCheckIfDue(deps);

    expect(check).not.toHaveBeenCalled();
  });

  it("swallows a failing background check", async () => {
    const store = fakeStore();
    const { deps } = depsFor(store, () => Promise.reject(new Error("no host repo")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runUpdateCheckIfDue(deps)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("dismissUpdateNotice", () => {
  it("silences the notice for the install and broadcasts the new state", () => {
    const store = fakeStore({
      anchor: ANCHOR,
      result: { available: true, latestVersion: "v1.5.0", currentVersion: "v1.4.0" },
    });
    const { deps, broadcasts } = depsFor(store, () => Promise.resolve(status()));

    const notice = dismissUpdateNotice(deps);

    expect(notice?.dismissed).toBe(true);
    expect(broadcasts[0]?.dismissed).toBe(true);
    expect(currentUpdateNotice(store, ANCHOR)?.dismissed).toBe(true);
  });

  it("ends once the install is running different code", () => {
    const store = fakeStore({
      anchor: ANCHOR,
      dismissed: true,
      result: { available: true, latestVersion: "v1.5.0", currentVersion: "v1.4.0" },
    });

    expect(currentUpdateNotice(store, "ccccccc")).toBeNull();
    expect(store.record).toBeUndefined();
  });

  it("drops the previous result too, so an applied update is not still advertised", async () => {
    const store = fakeStore({
      anchor: ANCHOR,
      lastCheckedAt: "2026-09-14T08:00:00Z",
      result: { available: true, latestVersion: "v1.5.0", currentVersion: "v1.4.0" },
    });
    const updatedAnchor = "bbbbbbb";
    const { deps, broadcasts } = depsFor(store, () => Promise.resolve(status({
      available: false, isDowngrade: false, behindBy: 0, currentVersion: "v1.5.0", latestVersion: "v1.5.0",
    })));
    const afterUpdate = { ...deps, anchor: updatedAnchor };

    expect(currentUpdateNotice(store, updatedAnchor)).toBeNull();
    // The day's check does not carry over either — the new build gets its own.
    expect(isCheckDue(store.getUpdateNotice(updatedAnchor), Date.parse("2026-09-14T09:00:00Z"))).toBe(true);

    await runUpdateCheckIfDue(afterUpdate);
    expect(broadcasts[0]).toEqual({
      available: false, latestVersion: "v1.5.0", currentVersion: "v1.5.0", dismissed: false,
    });
  });
});
