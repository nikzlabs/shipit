import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertWorkerUidConsistency,
  WORKER_UID_MARKER_FILE,
} from "./worker-uid-guard.js";

describe("worker-uid-guard (docs/150 Rollout)", () => {
  let stateDir: string;
  const markerOf = () => path.join(stateDir, WORKER_UID_MARKER_FILE);
  const readMarker = () => fs.readFileSync(markerOf(), "utf-8").trim();
  const seedMarker = (v: string) => fs.writeFileSync(markerOf(), v);

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wuidguard-"));
  });
  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("first boot (no marker) persists the current uid and does not throw", () => {
    expect(() =>
      assertWorkerUidConsistency({ stateDir, currentUid: 1000, hasPersistedSessions: false }),
    ).not.toThrow();
    expect(readMarker()).toBe("1000");
  });

  it("enabling on a fresh deploy (unset -> 1000) is fine", () => {
    seedMarker("0");
    expect(() =>
      assertWorkerUidConsistency({ stateDir, currentUid: 1000, hasPersistedSessions: true }),
    ).not.toThrow();
    expect(readMarker()).toBe("1000");
  });

  it("steady state (1000 -> 1000) is fine", () => {
    seedMarker("1000");
    expect(() =>
      assertWorkerUidConsistency({ stateDir, currentUid: 1000, hasPersistedSessions: true }),
    ).not.toThrow();
    expect(readMarker()).toBe("1000");
  });

  it("FAILS FAST on a rollback (1000 -> unset) with sessions present", () => {
    seedMarker("1000");
    expect(() =>
      assertWorkerUidConsistency({ stateDir, currentUid: null, hasPersistedSessions: true }),
    ).toThrow(/config rollback/i);
    // Marker is NOT overwritten on a fatal — a re-set on the next boot recovers.
    expect(readMarker()).toBe("1000");
  });

  it("does NOT fail the rollback when there are no persisted sessions", () => {
    seedMarker("1000");
    expect(() =>
      assertWorkerUidConsistency({ stateDir, currentUid: null, hasPersistedSessions: false }),
    ).not.toThrow();
    expect(readMarker()).toBe("0");
  });

  it("allows a deliberate downgrade via the opt-out", () => {
    seedMarker("1000");
    expect(() =>
      assertWorkerUidConsistency({
        stateDir,
        currentUid: null,
        hasPersistedSessions: true,
        allowDowngrade: true,
      }),
    ).not.toThrow();
    expect(readMarker()).toBe("0");
  });

  it("reads the opt-out from SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE", () => {
    const prev = process.env.SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE;
    seedMarker("1000");
    process.env.SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE = "1";
    try {
      expect(() =>
        assertWorkerUidConsistency({ stateDir, currentUid: null, hasPersistedSessions: true }),
      ).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE;
      else process.env.SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE = prev;
    }
  });
});
