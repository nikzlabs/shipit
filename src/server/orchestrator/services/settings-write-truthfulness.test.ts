import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { globalSystemPromptPath, writeGlobalSystemPrompt } from "../global-system-prompt.js";

/**
 * "Saved" has to mean saved (docs/299-agent-settings-access, plan.md). Two of
 * the three shipped writers that could not say whether they worked; the git
 * identity is the third and is in `git-identity-outcome.test.ts`, which needs a
 * module mock this file must not impose on the other two.
 */

const dirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("CredentialStore: a failed disk write is reported and rolled back", () => {
  it("keeps the change when the write lands", () => {
    const store = new CredentialStore(tmpDir("shipit-truth-ok-"));
    const { outcome } = store.transact(() => {
      store.setDeclaredSetting("advanced.enableSubAgents", false);
    });

    expect(outcome).toEqual({ status: "applied" });
    expect(store.getDeclaredSetting("advanced.enableSubAgents")).toBe(false);
  });

  it("reports `failed` and restores the previous value, so memory matches disk", () => {
    const dir = tmpDir("shipit-truth-fail-");
    const store = new CredentialStore(dir);
    // A value that IS durable first, so the rollback has somewhere to roll back
    // to: a test starting from the default would pass with the restore removed.
    store.setDeclaredSetting("advanced.memoryBudgetMb", 4096);
    expect(store.getDeclaredSetting("advanced.memoryBudgetMb")).toBe(4096);

    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { outcome } = store.transact(() => {
      store.setDeclaredSetting("advanced.memoryBudgetMb", 8192);
    });
    vi.restoreAllMocks();

    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toMatch(/rolled back/i);
    // The point of the rollback: what the caller reads back and what the next
    // restart reads are the same value.
    expect(store.getDeclaredSetting("advanced.memoryBudgetMb")).toBe(4096);
    expect(new CredentialStore(dir).getDeclaredSetting("advanced.memoryBudgetMb")).toBe(4096);
  });

  it("reports `partial` when an earlier write in the group landed and a later one did not", () => {
    const dir = tmpDir("shipit-truth-partial-");
    const store = new CredentialStore(dir);
    vi.spyOn(console, "error").mockImplementation(() => {});

    let writes = 0;
    const realWriteFileSync = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((...args: unknown[]) => {
      writes += 1;
      if (writes === 2) throw new Error("ENOSPC: no space left on device");
      return (realWriteFileSync as (...a: unknown[]) => unknown)(...args);
    }) as typeof fs.writeFileSync);

    const { outcome } = store.transact(() => {
      store.setDeclaredSetting("advanced.enableSubAgents", false);
      store.setDeclaredSetting("advanced.memoryBudgetMb", 8192);
    });
    spy.mockRestore();

    expect(outcome.status).toBe("partial");
    expect(store.getDeclaredSetting("advanced.enableSubAgents")).toBe(false);
    expect(store.getDeclaredSetting("advanced.memoryBudgetMb")).toBeNull();
    expect(new CredentialStore(dir).getDeclaredSetting("advanced.enableSubAgents")).toBe(false);
  });

  it("reports `failed` only when the file on disk is really unchanged", () => {
    const dir = tmpDir("shipit-truth-atomic-");
    const store = new CredentialStore(dir);
    store.setDeclaredSetting("advanced.memoryBudgetMb", 4096);
    vi.spyOn(console, "error").mockImplementation(() => {});

    // The bytes are written and the step AFTER them fails. Writing in place made
    // this report `failed` with the new value already on disk — a claim of
    // "nothing was saved" that the next restart contradicts.
    const spy = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("EXDEV: cross-device link not permitted");
    });
    const { outcome } = store.transact(() => {
      store.setDeclaredSetting("advanced.memoryBudgetMb", 8192);
    });
    spy.mockRestore();

    expect(outcome.status).toBe("failed");
    expect(new CredentialStore(dir).getDeclaredSetting("advanced.memoryBudgetMb")).toBe(4096);
  });

  it("refuses an async mutation instead of reporting a group that has not run", async () => {
    const store = new CredentialStore(tmpDir("shipit-truth-async-"));
    // The report closes when `mutate` returns, so an awaited body would answer
    // `applied` before its own writes ran.
    expect(() => store.transact(async () => Promise.resolve())).toThrow(/synchronous/i);
  });

  it("does not stamp onboarding completion that would vanish at restart", () => {
    const dir = tmpDir("shipit-truth-stamp-");
    const store = new CredentialStore(dir);
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("EROFS: read-only file system");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(store.stampHarnessOnboardingCompleted(new Date().toISOString())).toBeUndefined();
    vi.restoreAllMocks();
    expect(store.getHarnessOnboardingCompletedAt()).toBeUndefined();
  });
});

describe("writeGlobalSystemPrompt: clearing can fail, and says so", () => {
  it("reports `applied` when the file is written and when it is removed", async () => {
    const dir = tmpDir("shipit-truth-prompt-");
    expect(await writeGlobalSystemPrompt(dir, "Be brief.")).toEqual({ status: "applied" });
    expect(fs.existsSync(globalSystemPromptPath(dir))).toBe(true);
    expect(await writeGlobalSystemPrompt(dir, "")).toEqual({ status: "applied" });
    expect(fs.existsSync(globalSystemPromptPath(dir))).toBe(false);
  });

  it("reports a refused write instead of throwing, so a multi-setting save keeps its other outcomes", async () => {
    const dir = tmpDir("shipit-truth-prompt-write-");
    await writeGlobalSystemPrompt(dir, "Be brief.");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fs.promises, "rename").mockRejectedValue(new Error("EROFS: read-only file system"));

    const outcome = await writeGlobalSystemPrompt(dir, "Cite every file.");

    expect(outcome.status).toBe("failed");
    vi.restoreAllMocks();
    // Staged and renamed, so the refused write left the previous content whole
    // rather than truncating it — which is what lets `failed` be claimed.
    expect(fs.readFileSync(globalSystemPromptPath(dir), "utf-8")).toContain("Be brief.");
  });

  it("reports `failed` when the unlink is refused, because the old instructions are still live", async () => {
    const dir = tmpDir("shipit-truth-prompt-fail-");
    await writeGlobalSystemPrompt(dir, "Be brief.");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Not ENOENT: a missing file is already cleared, and answering `failed` for
    // that would make every repeat clear look like a failure.
    vi.spyOn(fs.promises, "unlink").mockRejectedValue(
      Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
    );

    const outcome = await writeGlobalSystemPrompt(dir, "");

    expect(outcome.status).toBe("failed");
    expect(outcome.detail).toMatch(/still in place/i);
  });
});
