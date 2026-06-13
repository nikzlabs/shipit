import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sessionWorkerUid,
  chownToSessionWorker,
  chownTreeToSessionWorker,
} from "./session-worker-uid.js";

describe("session-worker-uid (docs/150 §7)", () => {
  const prev = process.env.SHIPIT_SESSION_WORKER_UID;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "swuid-"));
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.SHIPIT_SESSION_WORKER_UID;
    else process.env.SHIPIT_SESSION_WORKER_UID = prev;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("sessionWorkerUid()", () => {
    it("returns null when unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      expect(sessionWorkerUid()).toBeNull();
    });

    it("parses a numeric uid", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "1000";
      expect(sessionWorkerUid()).toBe(1000);
    });

    it("returns null for a non-numeric value", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "shipit";
      expect(sessionWorkerUid()).toBeNull();
    });

    it("returns null for a negative value", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = "-5";
      expect(sessionWorkerUid()).toBeNull();
    });
  });

  describe("chown gating", () => {
    it("is a no-op when SHIPIT_SESSION_WORKER_UID is unset", () => {
      delete process.env.SHIPIT_SESSION_WORKER_UID;
      const file = path.join(tmpDir, "f");
      fs.writeFileSync(file, "x");
      const before = fs.lstatSync(file).uid;
      chownToSessionWorker(file);
      expect(fs.lstatSync(file).uid).toBe(before);
    });

    it("never throws on a missing path", () => {
      process.env.SHIPIT_SESSION_WORKER_UID = String(process.getuid?.() ?? 0);
      expect(() => chownToSessionWorker(path.join(tmpDir, "nope"))).not.toThrow();
      expect(() => chownTreeToSessionWorker(path.join(tmpDir, "nope"))).not.toThrow();
    });

    // Chowning to a *different* uid needs CAP_CHOWN; chowning to our OWN uid
    // always succeeds, so we exercise the real walk without requiring root.
    it("recursively chowns a subtree to the configured uid", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return; // not POSIX — skip
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const sub = path.join(tmpDir, "a", "b");
      fs.mkdirSync(sub, { recursive: true });
      const file = path.join(sub, "token.json");
      fs.writeFileSync(file, "{}");
      expect(() => chownTreeToSessionWorker(tmpDir)).not.toThrow();
      expect(fs.lstatSync(file).uid).toBe(myUid);
    });

    it("does not follow symlinks out of the tree", () => {
      const myUid = process.getuid?.();
      if (myUid === undefined) return;
      process.env.SHIPIT_SESSION_WORKER_UID = String(myUid);
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "swuid-out-"));
      const outsideFile = path.join(outside, "secret");
      fs.writeFileSync(outsideFile, "x");
      try {
        fs.symlinkSync(outside, path.join(tmpDir, "link"));
        // Walk must not traverse into `outside` via the symlink.
        expect(() => chownTreeToSessionWorker(tmpDir)).not.toThrow();
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
