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

    const reloaded = new CredentialStore(dir);
    expect(reloaded.getHarnessOnboardingCompletedAt()).toBe(first.harnessOnboardingCompletedAt);
  });

  it("does not stamp an install that cannot run anything", () => {
    const store = new CredentialStore(tmpDir());
    const result = resolveHarnessOnboarding(registry(false), store);
    expect(result.canRunTurns).toBe(false);
    expect(result.harnessOnboardingCompletedAt).toBeUndefined();
    expect(store.getHarnessOnboardingCompletedAt()).toBeUndefined();
  });

  it("keeps reporting completed after every credential is removed", () => {
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
    const store = new CredentialStore(tmpDir());
    const write = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = resolveHarnessOnboarding(registry(true), store);
    expect(write).toHaveBeenCalled();
    expect(result.canRunTurns).toBe(true);
    expect(result.harnessOnboardingCompletedAt).toBeUndefined();
    expect(store.getHarnessOnboardingCompletedAt()).toBeUndefined();

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
    const store = new CredentialStore(tmpDir());
    const payload = buildAgentListPayload(registry(false), store, undefined);
    expect(payload.harnessOnboardingCompletedAt).toBeUndefined();
  });

  it("keeps emitting the stamp from the sign-OUT broadcast", () => {
    const store = new CredentialStore(tmpDir());
    const stamped = buildAgentListPayload(registry(true), store, undefined).harnessOnboardingCompletedAt;
    expect(buildAgentListPayload(registry(false), store, undefined).harnessOnboardingCompletedAt).toBe(stamped);
  });
});
