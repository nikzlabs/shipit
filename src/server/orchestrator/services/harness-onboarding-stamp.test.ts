/**
 * docs/257 req 9 — the historical "has this install ever been set up?" stamp.
 *
 * Req 9's condition is about the install's HISTORY, and every other signal in
 * the tree describes the present — disconnecting deletes the record, so
 * "completed and then removed everything" and "never configured" are otherwise
 * the same bytes. These tests pin the four cases where that distinction is
 * load-bearing, including the one that would look like a bug months later: a
 * stamp that never reached disk must not be reported as completed.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { resolveHarnessOnboarding, buildAgentListPayload } from "./settings.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-onboarding-stamp-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function registry(hasRunnableModels: boolean): AgentRegistry {
  return {
    list: () => [{
      id: "claude",
      name: "Claude Code",
      installed: true,
      hasRunnableModels,
      capabilities: {
        models: ["sonnet"],
        supportsReview: true,
        supportsSteering: true,
        supportsCompaction: true,
        supportedPermissionModes: ["auto"],
        skillInvocationPrefix: "/",
      },
    }],
  } as unknown as AgentRegistry;
}

describe("resolveHarnessOnboarding (docs/257 req 9)", () => {
  it("stamps a runnable install, and the stamp survives a restart", () => {
    const dir = tmpDir();
    const store = new CredentialStore(dir);
    expect(store.getHarnessOnboardingCompletedAt()).toBeUndefined();

    const first = resolveHarnessOnboarding(registry(true), store);
    expect(first.canRunTurns).toBe(true);
    expect(first.harnessOnboardingCompletedAt).toEqual(expect.any(String));

    // A fresh store over the same directory is exactly what a restart is.
    const reloaded = new CredentialStore(dir);
    expect(reloaded.getHarnessOnboardingCompletedAt()).toBe(first.harnessOnboardingCompletedAt);
  });

  it("does not stamp an install that cannot run anything", () => {
    // The migration case req 9 accepts knowingly: an install upgraded with no
    // credentials is treated as never-configured and does see the panel.
    const store = new CredentialStore(tmpDir());
    const result = resolveHarnessOnboarding(registry(false), store);
    expect(result.canRunTurns).toBe(false);
    expect(result.harnessOnboardingCompletedAt).toBeUndefined();
    expect(store.getHarnessOnboardingCompletedAt()).toBeUndefined();
  });

  it("keeps reporting completed after every credential is removed", () => {
    // The whole reason the field exists: a user who set ShipIt up and later
    // removed every credential is not a new user and must not meet the panel
    // again.
    const store = new CredentialStore(tmpDir());
    const stamped = resolveHarnessOnboarding(registry(true), store).harnessOnboardingCompletedAt;
    expect(stamped).toEqual(expect.any(String));

    const afterRemoval = resolveHarnessOnboarding(registry(false), store);
    expect(afterRemoval.canRunTurns).toBe(false);
    expect(afterRemoval.harnessOnboardingCompletedAt).toBe(stamped);
  });

  it("never re-stamps, so the recorded moment is the FIRST one", () => {
    const store = new CredentialStore(tmpDir());
    const first = resolveHarnessOnboarding(registry(true), store).harnessOnboardingCompletedAt;
    const second = resolveHarnessOnboarding(registry(true), store).harnessOnboardingCompletedAt;
    expect(second).toBe(first);
  });

  it("reports NOT completed when the write fails, and does not keep it in memory", () => {
    // `save()` swallows write failures and returns normally. If the stamp took
    // that path, this call would report "completed" from memory, hold that for
    // the rest of the process, and lose it at the next restart — returning the
    // panel to a user who finished onboarding, which req 9 says never happens.
    const store = new CredentialStore(tmpDir());
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = resolveHarnessOnboarding(registry(true), store);
    expect(write).toHaveBeenCalled();
    expect(result.canRunTurns).toBe(true);
    expect(result.harnessOnboardingCompletedAt).toBeUndefined();
    // The in-memory value is reverted too — otherwise the NEXT read in the same
    // process would report a completion that is not on disk.
    expect(store.getHarnessOnboardingCompletedAt()).toBeUndefined();

    // And once the disk comes back, the ask is simply repeated and succeeds.
    write.mockRestore();
    expect(resolveHarnessOnboarding(registry(true), store).harnessOnboardingCompletedAt)
      .toEqual(expect.any(String));
  });

  it("tolerates an install with no credential store at all", () => {
    const result = resolveHarnessOnboarding(registry(true), undefined);
    expect(result.canRunTurns).toBe(true);
    expect(result.harnessOnboardingCompletedAt).toBeUndefined();
  });
});

describe("buildAgentListPayload carries the stamp (docs/257 req 9)", () => {
  it("emits the stamp alongside the agent list and the runnable signal", () => {
    const store = new CredentialStore(tmpDir());
    const payload = buildAgentListPayload(registry(true), store, undefined);
    expect(payload.canRunTurns).toBe(true);
    expect(payload.harnessOnboardingCompletedAt).toEqual(expect.any(String));
    expect(payload.agents).toHaveLength(1);
  });

  it("omits the stamp while nothing has ever been configured", () => {
    // Absent means "no news" on the wire, which is safe precisely because the
    // stamp is never cleared: a client can only ever be told it exists.
    const store = new CredentialStore(tmpDir());
    const payload = buildAgentListPayload(registry(false), store, undefined);
    expect(payload.harnessOnboardingCompletedAt).toBeUndefined();
  });

  it("keeps emitting the stamp from the sign-OUT broadcast", () => {
    // The site that matters most: signing out of the last provider is a
    // producer of this event, and it must not report the install as
    // never-configured just because it can no longer run anything.
    const store = new CredentialStore(tmpDir());
    const stamped = buildAgentListPayload(registry(true), store, undefined).harnessOnboardingCompletedAt;
    expect(buildAgentListPayload(registry(false), store, undefined).harnessOnboardingCompletedAt).toBe(stamped);
  });
});
