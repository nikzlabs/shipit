/**
 * docs/241 — admission for the always-on preview reservation.
 *
 * The cap is small (default 1 per deployment) and the release toggle only
 * exists on a non-archived sidebar row, so anything counted but unreachable
 * takes the deployment's only slot for good. These tests pin the reachability
 * half of that: what the cap counts, and what it must ignore.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { buildReservationFullMessage, listActiveReservations, setKeepPreviewRunning } from "./session.js";
import { SessionManager } from "../sessions.js";
import type { DatabaseManager } from "../../shared/database.js";
import type { SessionInfo } from "../../shared/types.js";
import { createTestDatabaseManager } from "../integration_tests/test-helpers.js";

let dbManager: DatabaseManager;
let sessionManager: SessionManager;
let activate: Mock<(session: SessionInfo) => void>;

function makeSession(id: string): string {
  sessionManager.track(id, id, `/workspace/${id}`);
  return id;
}

beforeEach(() => {
  dbManager = createTestDatabaseManager();
  sessionManager = new SessionManager(dbManager);
  activate = vi.fn();
});

afterEach(() => {
  dbManager.close();
});

describe("docs/241 reservation admission", () => {
  it("admits up to the cap and refuses beyond it", () => {
    makeSession("a");
    makeSession("b");

    setKeepPreviewRunning(sessionManager, "a", true, activate, 1);
    expect(sessionManager.get("a")?.keepPreviewRunning).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);

    expect(() => setKeepPreviewRunning(sessionManager, "b", true, activate, 1)).toThrow(
      /reserved by "a"/,
    );
    expect(sessionManager.get("b")?.keepPreviewRunning).toBeUndefined();
  });

  describe("refusal message", () => {
    const info = (id: string, title: string) => ({ id, title } as SessionInfo);

    it("names the single holder and the slot count", () => {
      expect(buildReservationFullMessage([info("a", "Landing page prototype")], 1)).toBe(
        'Always-on preview is reserved by "Landing page prototype". Turn it off there to free the only slot (1 of 1 in use).',
      );
    });

    it("names every holder when the operator raised the cap", () => {
      const message = buildReservationFullMessage([info("a", "One"), info("b", "Two")], 2);
      expect(message).toContain('"One", "Two"');
      expect(message).toContain("2 of 2 in use");
    });

    it("explains a cap of zero instead of naming nobody", () => {
      expect(buildReservationFullMessage([], 0)).toContain("MAX_KEEP_PREVIEW_RUNNING");
    });

    it("explains a cap lowered to zero under an existing reservation", () => {
      // Lowering the cap does not revoke reservations already granted, so the
      // holder-shaped sentence would promise a slot that turning it off never
      // frees — and report "1 of 0 in use".
      const message = buildReservationFullMessage([info("a", "Held")], 0);
      expect(message).toContain("capacity 0");
      expect(message).not.toContain("of 0 in use");
      expect(message).not.toContain("Held");
    });
  });

  it("does not count an archived session's stale reservation", () => {
    // Rows archived before `SessionManager.archive` learned to clear the flag
    // still exist in deployed databases. Such a row is unreachable — it is not
    // in the sidebar, so its toggle is never rendered — and counting it made
    // the last slot impossible to reclaim.
    const stale = makeSession("stale");
    sessionManager.setKeepPreviewRunning(stale, true);
    sessionManager.archive(stale);
    // Simulate the pre-fix row: archived, flag still set.
    sessionManager.setKeepPreviewRunning(stale, true);
    expect(sessionManager.get(stale)?.keepPreviewRunning).toBe(true);

    expect(listActiveReservations(sessionManager)).toEqual([]);

    const fresh = makeSession("fresh");
    expect(() => setKeepPreviewRunning(sessionManager, fresh, true, activate, 1)).not.toThrow();
    expect(sessionManager.get(fresh)?.keepPreviewRunning).toBe(true);
  });

  it("frees the slot for the next session once the holder is archived", () => {
    const holder = makeSession("holder");
    setKeepPreviewRunning(sessionManager, holder, true, activate, 1);
    sessionManager.archive(holder);

    const next = makeSession("next");
    expect(() => setKeepPreviewRunning(sessionManager, next, true, activate, 1)).not.toThrow();
    expect(listActiveReservations(sessionManager).map((s) => s.id)).toEqual([next]);
  });

  it("lets the holder re-toggle itself without tripping its own cap", () => {
    const holder = makeSession("holder");
    setKeepPreviewRunning(sessionManager, holder, true, activate, 1);
    // Re-enabling an already-reserved session is a no-op, not a second claim.
    expect(() => setKeepPreviewRunning(sessionManager, holder, true, activate, 1)).not.toThrow();

    setKeepPreviewRunning(sessionManager, holder, false, activate, 1);
    expect(listActiveReservations(sessionManager)).toEqual([]);
  });

  it("refuses to reserve an archived session", () => {
    const archived = makeSession("archived");
    sessionManager.archive(archived);
    expect(() => setKeepPreviewRunning(sessionManager, archived, true, activate, 1)).toThrow(
      /Only active sessions/,
    );
  });
});
