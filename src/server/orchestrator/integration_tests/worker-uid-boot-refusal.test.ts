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

      expect(fs.readdirSync(tmpDir)).toEqual([]);
    });
  }
});
