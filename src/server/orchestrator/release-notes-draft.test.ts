import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDraftNotes, repoPublishesAuthoredNotes } from "./release-notes-draft.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "notes-draft-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeWorkflow(body: string): void {
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "workflows", "release.yml"), body);
}

describe("readDraftNotes", () => {
  it("returns the body verbatim, trailing newline and all", () => {
    fs.writeFileSync(path.join(dir, "RELEASE_NOTES.draft.md"), "## Highlights\n- a thing\n");
    return expect(readDraftNotes(dir)).resolves.toBe("## Highlights\n- a thing\n");
  });

  it("reads a whitespace-only draft as absent, matching CI's content test", () => {
    fs.writeFileSync(path.join(dir, "RELEASE_NOTES.draft.md"), "  \n\t\n");
    return expect(readDraftNotes(dir)).resolves.toBeNull();
  });

  it("reads a missing draft as absent rather than throwing", () => {
    return expect(readDraftNotes(dir)).resolves.toBeNull();
  });
});

describe("repoPublishesAuthoredNotes", () => {
  it("is true when the workflow reads the notes directory", async () => {
    writeWorkflow("jobs:\n  publish:\n    steps:\n      - run: gh release create --notes-file .release-notes/$TAG.md\n");
    expect(await repoPublishesAuthoredNotes(dir)).toBe(true);
  });

  it("is false for a workflow that generates its own notes", async () => {
    writeWorkflow("jobs:\n  publish:\n    steps:\n      - run: gh release create --generate-notes\n");
    expect(await repoPublishesAuthoredNotes(dir)).toBe(false);
  });

  it("is false for a repo with no release workflow at all (docs/309 req 9)", async () => {
    expect(await repoPublishesAuthoredNotes(dir)).toBe(false);
  });
});
