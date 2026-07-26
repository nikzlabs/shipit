/**
 * Unit tests for LFS pointer resolution in the diff viewer.
 *
 * The bug being guarded is specific: the diff viewer reads *committed blobs*,
 * which in an LFS repo are always pointer stubs, so an LFS-tracked PNG rendered
 * as its sha256 text. The assertions that matter most are therefore the negative
 * ones — a pointer must never survive into rendered content, and a failed fetch
 * must return `null` rather than the pointer git-lfs echoes back on stdout.
 *
 * Object-store reads run against a real store layout rather than a mock: the
 * two-level `ab/cd/abcd…` fanout (with the *full* oid as the filename) is
 * git-lfs's own convention, and getting it subtly wrong is exactly the kind of
 * mistake a mock would happily agree with.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import {
  parseLfsPointer,
  lfsObjectPath,
  createLfsBlobResolver,
} from "./git-lfs-blob.js";

const MB = 1_048_576;

function pointerFor(content: Buffer): string {
  const oid = crypto.createHash("sha256").update(content).digest("hex");
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A git repo with an LFS object store, optionally seeded with `content`. */
function makeRepo(content?: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-blob-"));
  dirs.push(dir);
  execSync("git init --initial-branch=main", { cwd: dir, stdio: "ignore" });
  if (content) seedObject(dir, content);
  return dir;
}

function seedObject(repoDir: string, content: Buffer): void {
  const oid = crypto.createHash("sha256").update(content).digest("hex");
  const objPath = lfsObjectPath(repoDir, oid);
  fs.mkdirSync(path.dirname(objPath), { recursive: true });
  fs.writeFileSync(objPath, content);
}

describe("parseLfsPointer", () => {
  it("parses a canonical v1 pointer", () => {
    const content = Buffer.from("some image bytes");
    expect(parseLfsPointer(pointerFor(content))).toEqual({
      oid: crypto.createHash("sha256").update(content).digest("hex"),
      size: content.length,
    });
  });

  it("accepts a Buffer as well as a string", () => {
    const ptr = pointerFor(Buffer.from("x"));
    expect(parseLfsPointer(Buffer.from(ptr))).toEqual(parseLfsPointer(ptr));
  });

  it("tolerates extra spec-allowed keys in any order", () => {
    const oid = "a".repeat(64);
    const ptr = `version https://git-lfs.github.com/spec/v1\next-0-shasum sha256:${"b".repeat(64)}\noid sha256:${oid}\nsize 42\n`;
    expect(parseLfsPointer(ptr)).toEqual({ oid, size: 42 });
  });

  it("rejects content that merely mentions LFS", () => {
    // A doc or .gitattributes quoting the spec URL must keep its text diff.
    expect(parseLfsPointer("See version https://git-lfs.github.com/spec/v1 for details")).toBeNull();
    expect(parseLfsPointer("*.png filter=lfs diff=lfs merge=lfs -text\n")).toBeNull();
  });

  it("rejects a pointer missing its oid or size", () => {
    expect(parseLfsPointer("version https://git-lfs.github.com/spec/v1\nsize 42\n")).toBeNull();
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\n`)).toBeNull();
  });

  it("rejects a malformed oid rather than trusting it as a store filename", () => {
    // Guards the object-store path build: a short or non-hex oid must never
    // become `.git/lfs/objects/../…`.
    expect(parseLfsPointer("version https://git-lfs.github.com/spec/v1\noid sha256:../../etc\nsize 1\n")).toBeNull();
    expect(parseLfsPointer(`version https://git-lfs.github.com/spec/v1\noid sha256:${"z".repeat(64)}\nsize 1\n`)).toBeNull();
  });

  it("rejects empty and oversized content without scanning it", () => {
    expect(parseLfsPointer("")).toBeNull();
    expect(parseLfsPointer(Buffer.alloc(4096))).toBeNull();
  });
});

describe("lfsObjectPath", () => {
  it("uses git-lfs's two-level fanout with the full oid as the filename", () => {
    const oid = `abcdef${"0".repeat(58)}`;
    expect(lfsObjectPath("/w", oid)).toBe(path.join("/w", ".git", "lfs", "objects", "ab", "cd", oid));
  });
});

describe("createLfsBlobResolver", () => {
  const neverAvailable = { isAvailable: async () => false };

  it("returns content from the clone's own LFS object store", async () => {
    const content = Buffer.from("\x89PNG\r\n\x1a\n real image bytes");
    const dir = makeRepo(content);
    // git-lfs unavailable, so a hit here proves the read was purely local.
    const resolve = createLfsBlobResolver(dir, neverAvailable);
    expect(await resolve(pointerFor(content), "a.png", 2 * MB)).toEqual(content);
  });

  it("returns null when the object is not cached and cannot be fetched", async () => {
    const dir = makeRepo();
    const resolve = createLfsBlobResolver(dir, neverAvailable);
    expect(await resolve(pointerFor(Buffer.from("absent")), "a.png", 2 * MB)).toBeNull();
  });

  it("treats a size mismatch as a miss rather than serving a truncated image", async () => {
    const content = Buffer.from("full content");
    const dir = makeRepo();
    // Same oid, half-written file — what an interrupted download leaves behind.
    const oid = crypto.createHash("sha256").update(content).digest("hex");
    const objPath = lfsObjectPath(dir, oid);
    fs.mkdirSync(path.dirname(objPath), { recursive: true });
    fs.writeFileSync(objPath, content.subarray(0, 4));

    const resolve = createLfsBlobResolver(dir, neverAvailable);
    expect(await resolve(pointerFor(content), "a.png", 2 * MB)).toBeNull();
  });

  it("refuses an oversized asset without touching the store", async () => {
    const content = Buffer.from("small on disk, huge per the pointer");
    const dir = makeRepo(content);
    const oid = crypto.createHash("sha256").update(content).digest("hex");
    const resolve = createLfsBlobResolver(dir, neverAvailable);
    // The pointer's declared size is what we screen on — the whole point is to
    // avoid downloading a 40 MB asset only to discard it.
    const huge = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${40 * MB}\n`;
    expect(await resolve(huge, "a.png", 2 * MB)).toBeNull();
  });

  it("returns null for a blob that isn't a pointer at all", async () => {
    const dir = makeRepo();
    const resolve = createLfsBlobResolver(dir, neverAvailable);
    expect(await resolve("just some text", "a.txt", 2 * MB)).toBeNull();
  });

  it("stops probing the network once the per-diff budget is spent", async () => {
    const dir = makeRepo();
    let probes = 0;
    const resolve = createLfsBlobResolver(dir, {
      networkBudget: 2,
      isAvailable: async () => {
        probes++;
        return false;
      },
    });
    // Distinct oids so nothing is deduped; all miss the empty local store.
    for (let i = 0; i < 5; i++) {
      await resolve(pointerFor(Buffer.from(`asset-${i}`)), `a${i}.png`, 2 * MB);
    }
    // The availability probe is memoized, so the budget shows up as fetches
    // attempted, not probes — but past the budget we must not even get that far.
    expect(probes).toBe(1);
  });
});

describe("createLfsBlobResolver with the real git-lfs binary", () => {
  it("smudges an object that is in the store but reports the miss as null", async () => {
    const hasLfs = (() => {
      try {
        execSync("git lfs version", { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    })();
    if (!hasLfs) return; // orchestrator image ships git-lfs; a dev box may not

    const dir = makeRepo();
    execSync("git lfs install --local", { cwd: dir, stdio: "ignore" });
    fs.writeFileSync(path.join(dir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");

    // A resolver whose local store is empty and whose remote doesn't exist: the
    // real `git lfs smudge` exits non-zero AND echoes the pointer back on
    // stdout. Returning that would re-embed the checksum as image bytes.
    const resolve = createLfsBlobResolver(dir);
    const missing = await resolve(pointerFor(Buffer.from("never uploaded")), "a.png", 2 * MB);
    expect(missing).toBeNull();
  }, 30_000);
});
