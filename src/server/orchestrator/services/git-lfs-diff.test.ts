/**
 * End-to-end: `getTurnDiff` over a Git LFS repo must yield renderable images,
 * not checksums.
 *
 * This is the test that would have caught the original bug. The diff service
 * reads blobs at two commits, and an LFS repo's committed blob is *always* a
 * ~130-byte pointer stub — `git lfs pull` materializes the working tree, which
 * the diff viewer never reads. Worse, the conventional `.gitattributes` line
 * (`filter=lfs diff=lfs merge=lfs -text`) does NOT make git call the blob
 * binary: it sniffs ASCII and reports an ordinary +2/-2 **text** diff. So these
 * fixtures deliberately commit real pointer stubs through a real git, and assert
 * on the text path, not the binary one.
 *
 * No LFS server is involved: objects are seeded straight into
 * `.git/lfs/objects`, which is exactly the state provisioning leaves a session
 * clone in (docs/231 pull + docs/232 hardlinks from the shared cache).
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { lfsObjectPath } from "../git-lfs-blob.js";
import { getTurnDiff } from "./git.js";

const LFS_ATTRS = "*.png filter=lfs diff=lfs merge=lfs -text\n*.svg filter=lfs diff=lfs merge=lfs\n";

/** A PNG header plus filler — enough that a corrupted decode would be obvious. */
function fakePng(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(marker.repeat(8))]);
}

function pointerFor(content: Buffer): string {
  const oid = crypto.createHash("sha256").update(content).digest("hex");
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string): void {
  execSync(`git ${args}`, { cwd, stdio: "pipe" });
}

function makeLfsRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-diff-"));
  dirs.push(dir);
  git(dir, "init -b main");
  git(dir, 'config user.email "t@example.com"');
  git(dir, 'config user.name "Test"');
  fs.writeFileSync(path.join(dir, ".gitattributes"), LFS_ATTRS);
  git(dir, "add -A");
  git(dir, 'commit -m attrs --no-gpg-sign');
  return dir;
}

/** Commit `content` at `relPath` as a pointer stub, with the object seeded locally. */
function commitLfsFile(dir: string, relPath: string, content: Buffer, message: string): void {
  fs.writeFileSync(path.join(dir, relPath), pointerFor(content));
  const oid = crypto.createHash("sha256").update(content).digest("hex");
  const objPath = lfsObjectPath(dir, oid);
  fs.mkdirSync(path.dirname(objPath), { recursive: true });
  fs.writeFileSync(objPath, content);
  git(dir, "add -A");
  git(dir, `commit -m ${message} --no-gpg-sign`);
}

function headAndParent(dir: string): { from: string; to: string } {
  const to = execSync("git rev-parse HEAD", { cwd: dir }).toString().trim();
  const from = execSync("git rev-parse HEAD~1", { cwd: dir }).toString().trim();
  return { from, to };
}

describe("getTurnDiff over Git LFS files", () => {
  it("renders both versions of a modified LFS image as data URIs", async () => {
    const dir = makeLfsRepo();
    const before = fakePng("BEFORE__");
    const after = fakePng("AFTER___");
    commitLfsFile(dir, "logo.png", before, "add-logo");
    commitLfsFile(dir, "logo.png", after, "change-logo");

    const { from, to } = headAndParent(dir);
    const diff = await getTurnDiff(new GitManager(dir), from, to);
    const file = diff.files.find((f) => f.path === "logo.png");

    expect(file).toBeDefined();
    expect(file!.image).toBe(true);
    expect(file!.lfs).toBe(true);
    expect(file!.oldContent).toBe(`data:image/png;base64,${before.toString("base64")}`);
    expect(file!.newContent).toBe(`data:image/png;base64,${after.toString("base64")}`);
  });

  it("never leaks the pointer stub into the rendered content", async () => {
    // The regression in one assertion: what the user saw was the sha256.
    const dir = makeLfsRepo();
    const content = fakePng("ONLY____");
    commitLfsFile(dir, "logo.png", content, "add-logo");
    const oid = crypto.createHash("sha256").update(content).digest("hex");

    const { from, to } = headAndParent(dir);
    const diff = await getTurnDiff(new GitManager(dir), from, to);
    const file = diff.files.find((f) => f.path === "logo.png")!;

    expect(file.newContent).not.toContain(oid);
    expect(file.newContent).not.toContain("git-lfs.github.com");
  });

  it("leaves the before pane empty for an added LFS image", async () => {
    const dir = makeLfsRepo();
    const content = fakePng("ADDED___");
    commitLfsFile(dir, "new.png", content, "add-image");

    const { from, to } = headAndParent(dir);
    const diff = await getTurnDiff(new GitManager(dir), from, to);
    const file = diff.files.find((f) => f.path === "new.png")!;

    expect(file.status).toBe("added");
    expect(file.oldContent).toBe("");
    expect(file.newContent.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("renders image panes even when the objects can't be resolved", async () => {
    // An old version whose object was never fetched locally and whose remote is
    // unreachable: the pane must be empty (the client labels it "(Git LFS
    // content unavailable)") rather than falling back to a pointer text diff.
    const dir = makeLfsRepo();
    const before = fakePng("GONE____");
    const after = fakePng("ALSOGONE");
    commitLfsFile(dir, "logo.png", before, "add-logo");
    commitLfsFile(dir, "logo.png", after, "change-logo");
    fs.rmSync(path.join(dir, ".git", "lfs"), { recursive: true, force: true });

    const { from, to } = headAndParent(dir);
    const diff = await getTurnDiff(new GitManager(dir), from, to);
    const file = diff.files.find((f) => f.path === "logo.png")!;

    expect(file.image).toBe(true);
    expect(file.lfs).toBe(true);
    expect(file.oldContent).toBe("");
    expect(file.newContent).toBe("");
  }, 60_000);

  it("resolves an LFS-tracked SVG to its source text", async () => {
    const dir = makeLfsRepo();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>');
    commitLfsFile(dir, "icon.svg", svg, "add-icon");

    const { from, to } = headAndParent(dir);
    const diff = await getTurnDiff(new GitManager(dir), from, to);
    const file = diff.files.find((f) => f.path === "icon.svg")!;

    // SVG stays text (Monaco diff + render toggle) — it just gets real source.
    expect(file.image).toBe(false);
    expect(file.lfs).toBe(true);
    expect(file.newContent).toBe(svg.toString("utf-8"));
  });

  it("leaves ordinary text files completely alone", async () => {
    const dir = makeLfsRepo();
    fs.writeFileSync(path.join(dir, "notes.md"), "hello\n");
    git(dir, "add -A");
    git(dir, "commit -m notes --no-gpg-sign");

    const { from, to } = headAndParent(dir);
    const diff = await getTurnDiff(new GitManager(dir), from, to);
    const file = diff.files.find((f) => f.path === "notes.md")!;

    expect(file.image).toBe(false);
    expect(file.lfs).toBeUndefined();
    expect(file.newContent).toBe("hello\n");
  });
});
