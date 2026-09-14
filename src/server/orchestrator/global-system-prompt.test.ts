import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  globalSystemPromptForTurn,
  globalSystemPromptPath,
  readGlobalSystemPrompt,
  writeGlobalSystemPrompt,
} from "./global-system-prompt.js";

describe("global system prompt (app-scope)", () => {
  let tmpDir = "";
  /** Files made unreadable by a test, restored so the temp tree can be removed. */
  const opened: string[] = [];

  function setup(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "global-prompt-"));
    return tmpDir;
  }

  afterEach(() => {
    for (const file of opened.splice(0)) {
      try { fs.chmodSync(file, 0o644); } catch { /* already gone */ }
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves directly under the app workspace root, not under sessions/", () => {
    const appRoot = setup();
    expect(globalSystemPromptPath(appRoot)).toBe(
      path.join(appRoot, ".shipit", "system-prompt.md"),
    );
    expect(globalSystemPromptPath(appRoot)).not.toContain(`${path.sep}sessions${path.sep}`);
  });

  it("round-trips a prompt, creating .shipit/ and trimming to a single trailing newline", async () => {
    const appRoot = setup();
    expect(fs.existsSync(path.join(appRoot, ".shipit"))).toBe(false);

    await writeGlobalSystemPrompt(appRoot, "  Always use TypeScript.  \n\n");

    expect(fs.readFileSync(globalSystemPromptPath(appRoot), "utf-8")).toBe("Always use TypeScript.\n");
    expect(await readGlobalSystemPrompt(appRoot)).toEqual({ ok: true, content: "Always use TypeScript." });
  });

  it("returns undefined when no prompt is configured", async () => {
    const appRoot = setup();
    expect(await readGlobalSystemPrompt(appRoot)).toEqual({ ok: true, content: undefined });
  });

  it("keeps the ops block in its own file, so neither scope reads the other's text", async () => {
    const appRoot = setup();
    expect(globalSystemPromptPath(appRoot, "ops")).toBe(
      path.join(appRoot, ".shipit", "system-prompt-ops.md"),
    );

    await writeGlobalSystemPrompt(appRoot, "Standard only.");
    await writeGlobalSystemPrompt(appRoot, "Ops only.", "ops");

    expect(await readGlobalSystemPrompt(appRoot)).toEqual({ ok: true, content: "Standard only." });
    expect(await readGlobalSystemPrompt(appRoot, "ops")).toEqual({ ok: true, content: "Ops only." });
  });

  it("reports an empty ops block as no prompt, never as the standard one", async () => {
    const appRoot = setup();
    await writeGlobalSystemPrompt(appRoot, "Standard only.");

    expect(await readGlobalSystemPrompt(appRoot, "ops")).toEqual({ ok: true, content: undefined });
  });

  it("treats a blank write as 'delete the file', and a blank file as no prompt", async () => {
    const appRoot = setup();
    await writeGlobalSystemPrompt(appRoot, "Something");
    expect(fs.existsSync(globalSystemPromptPath(appRoot))).toBe(true);

    await writeGlobalSystemPrompt(appRoot, "   \n  ");
    expect(fs.existsSync(globalSystemPromptPath(appRoot))).toBe(false);
    // Clearing what is already clear is applied, not a failure: the file is
    // missing, which is the state the caller asked for.
    await expect(writeGlobalSystemPrompt(appRoot, "")).resolves.toEqual({ status: "applied" });

    fs.mkdirSync(path.dirname(globalSystemPromptPath(appRoot)), { recursive: true });
    fs.writeFileSync(globalSystemPromptPath(appRoot), "\n \n");
    expect(await readGlobalSystemPrompt(appRoot)).toEqual({ ok: true, content: undefined });
  });

  it("says it could not read an existing file, never that there are no instructions", async () => {
    // docs/299-agent-settings-access req 1. The agent states what it reads to the
    // user as fact, so "empty instructions" for a file it could not open is a
    // made-up default reported as the truth.
    const appRoot = setup();
    await writeGlobalSystemPrompt(appRoot, "Always use TypeScript.");
    fs.chmodSync(globalSystemPromptPath(appRoot), 0o000);
    opened.push(globalSystemPromptPath(appRoot));

    const read = await readGlobalSystemPrompt(appRoot);
    expect(read.ok).toBe(false);
    expect((read as { error: NodeJS.ErrnoException }).error.code).toBe("EACCES");
  });

  it("carries no instructions with a turn when the file cannot be read, rather than failing it", async () => {
    const appRoot = setup();
    await writeGlobalSystemPrompt(appRoot, "Always use TypeScript.");
    fs.chmodSync(globalSystemPromptPath(appRoot), 0o000);
    opened.push(globalSystemPromptPath(appRoot));

    await expect(globalSystemPromptForTurn(appRoot)).resolves.toBeUndefined();
  });
});
