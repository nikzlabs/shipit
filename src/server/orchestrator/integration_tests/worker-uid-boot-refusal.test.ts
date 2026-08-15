/**
 * docs/263 — `buildApp` refuses a reserved egress UID before it initializes
 * anything.
 *
 * The unit tests in `session-worker-uid.test.ts` pin the parse-site refusal
 * itself. This one pins the two things only the composition root can prove:
 *
 *  1. the refusal is actually WIRED into `buildApp` (an exported assertion
 *     nobody calls is not a guard), and
 *  2. it runs BEFORE `initializeManagers`, which migrates the SQLite database,
 *     adopts environment credentials and writes the global gitconfig. A boot the
 *     orchestrator is about to refuse must not mutate durable state on its way
 *     out, and the absence of `<stateDir>/.shipit.db` is the cheapest observable
 *     proof that it did not.
 *
 * `buildApp` is called with no dependency stubs on purpose: if the assertion is
 * first, none are reached. A regression that moves the call later fails this
 * test by needing them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import { ReservedWorkerUidError, RESERVED_EGRESS_UIDS } from "../session-worker-uid.js";

describe("Integration: buildApp refuses a reserved worker UID (docs/263)", () => {
  const prevUid = process.env.SHIPIT_SESSION_WORKER_UID;
  const prevStateDir = process.env.SHIPIT_STATE_DIR;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wuid-boot-"));
    process.env.SHIPIT_STATE_DIR = tmpDir;
  });

  afterEach(() => {
    if (prevUid === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prevUid;
    if (prevStateDir === undefined) delete process.env.SHIPIT_STATE_DIR;
    else process.env.SHIPIT_STATE_DIR = prevStateDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const uid of RESERVED_EGRESS_UIDS) {
    it(`rejects the boot for uid ${uid} without initializing managers`, async () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(uid);

      await expect(buildApp({ workspaceDir: tmpDir, serveStatic: false })).rejects.toThrow(
        ReservedWorkerUidError,
      );

      // No database, no worker-UID marker: the refusal preceded every durable
      // write, so a corrected env can boot into untouched state.
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });
  }
});
