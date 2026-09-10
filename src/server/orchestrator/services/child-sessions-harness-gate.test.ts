import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionInfo } from "../../shared/types.js";
import type { ServiceError } from "./types.js";

const parent = {
  id: "parent-1",
  workspaceDir: "/workspace/parent-1",
  remoteUrl: "https://github.com/example/repo.git",
} as SessionInfo;

const managerFor = (session: SessionInfo) => ({
  get: (id: string) => (id === session.id ? session : undefined),
  findChildren: () => [],
  countDetachedSpawnedInTurn: () => 0,
}) as never;

async function spawnWith(
  installed: string[],
  agent?: string,
  model?: string,
  parentOverride?: Partial<SessionInfo>,
) {
  vi.resetModules();
  vi.doMock("../../shared/installed-harnesses.js", () => ({
    isHarnessInstalled: (id: string) => installed.includes(id),
    readInstalledHarnesses: () => installed,
  }));
  const { spawnChildSession } = await import("./child-sessions.js");
  return spawnChildSession(
    managerFor({ ...parent, ...parentOverride } as SessionInfo),
    {} as never,
    {} as never,
    parent.id,
    { prompt: "do the thing", title: "t", ...(agent ? { agent } : {}), ...(model ? { model } : {}) } as never,
    "codex",
    undefined,
    undefined,
    undefined,
    {} as never,
  );
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock("../../shared/installed-harnesses.js");
  vi.resetModules();
});

describe("spawnChildSession — harness install gate", () => {
  it("rejects an explicit --agent for a harness this deployment lacks", async () => {
    // resetModules creates a separate ServiceError class, so avoid instanceof.
    const err = await spawnWith(["codex"], "claude").catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/'claude' is not installed in this deployment/);
  });

  it("rejects a --model that derives to a harness this deployment lacks", async () => {
    const err = await spawnWith(["codex"], undefined, "claude-sonnet-5").catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/'claude' is not installed in this deployment/);
  });

  it("rejects a --model the PARENT's own harness offers, when that harness is absent", async () => {
    const err = await spawnWith(["codex"], undefined, "claude-sonnet-5", { agentId: "claude" })
      .catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/'claude' is not installed in this deployment/);
  });

  it("does not reject an installed harness — it gets past the gate to the real work", async () => {
    // Incomplete dependencies cause a later failure after the install gate passes.
    const err = await spawnWith(["claude", "codex"], "claude").catch((e: unknown) => e);
    expect((err as Error | undefined)?.message ?? "").not.toMatch(/not installed in this deployment/);
  });
});
