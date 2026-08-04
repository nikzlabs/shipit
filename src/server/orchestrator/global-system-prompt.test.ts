/**
 * SHI-290 — the GLOBAL system prompt lives under the ORCHESTRATOR's workspace
 * root, not a session clone. Four call sites used to compose that path by hand
 * with a variable called `workspaceDir`, which is also the name of a session's
 * clone everywhere else in the codebase; these tests pin the contract now that
 * one helper owns it.
 */

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  globalSystemPromptPath,
  readGlobalSystemPrompt,
  writeGlobalSystemPrompt,
} from "./global-system-prompt.js";

describe("global system prompt (app-scope)", () => {
  let tmpDir = "";

  function setup(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-prompt-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves directly under the app workspace root, not under sessions/", () => {
    const appRoot = setup();
    expect(globalSystemPromptPath(appRoot)).toBe(
      path.join(appRoot, ".shipit", "system-prompt.md"),
    );
    // The orchestrator root holds every session's dir at `sessions/<id>/workspace`.
    // The global prompt sits above all of them — no session id in the path.
    expect(globalSystemPromptPath(appRoot)).not.toContain(`${path.sep}sessions${path.sep}`);
  });

  it("round-trips a prompt, creating .shipit/ and trimming to a single trailing newline", async () => {
    const appRoot = setup();
    expect(fs.existsSync(path.join(appRoot, ".shipit"))).toBe(false);

    await writeGlobalSystemPrompt(appRoot, "  Always use TypeScript.  \n\n");

    expect(fs.readFileSync(globalSystemPromptPath(appRoot), "utf-8")).toBe("Always use TypeScript.\n");
    expect(await readGlobalSystemPrompt(appRoot)).toBe("Always use TypeScript.");
  });

  it("returns undefined when no prompt is configured", async () => {
    const appRoot = setup();
    expect(await readGlobalSystemPrompt(appRoot)).toBeUndefined();
  });

  it("treats a blank write as 'delete the file', and a blank file as no prompt", async () => {
    const appRoot = setup();
    await writeGlobalSystemPrompt(appRoot, "Something");
    expect(fs.existsSync(globalSystemPromptPath(appRoot))).toBe(true);

    await writeGlobalSystemPrompt(appRoot, "   \n  ");
    expect(fs.existsSync(globalSystemPromptPath(appRoot))).toBe(false);
    // Deleting an already-absent file is not an error.
    await expect(writeGlobalSystemPrompt(appRoot, "")).resolves.toBeUndefined();

    // A file that exists but holds only whitespace reads as "no prompt".
    fs.mkdirSync(path.dirname(globalSystemPromptPath(appRoot)), { recursive: true });
    fs.writeFileSync(globalSystemPromptPath(appRoot), "\n \n");
    expect(await readGlobalSystemPrompt(appRoot)).toBeUndefined();
  });
});
