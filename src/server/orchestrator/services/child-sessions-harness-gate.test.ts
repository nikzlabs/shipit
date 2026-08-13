/**
 * docs/252 phase 9 (req 14) — `shipit session create --agent <x>` must refuse a
 * harness this deployment did not install.
 *
 * The pre-existing validation asked the *catalogue* whether the harness exists,
 * which is a different question: on a Codex-only install `--agent claude` passed
 * it, provisioned a workspace and a container, and then died on its first turn
 * with a missing binary. The gate has to sit next to that one — before any disk
 * work — so the failure names the reason.
 */

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

/** Import the module fresh so the mocked install report is the one it reads. */
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
    // Asserted by shape, not `instanceof`: `vi.resetModules()` hands the module
    // under test its own copy of `./types.js`, so its ServiceError is a different
    // class object from the one this file would import.
    const err = await spawnWith(["codex"], "claude").catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/'claude' is not installed in this deployment/);
  });

  it("rejects a --model that derives to a harness this deployment lacks", async () => {
    // The agent is derived from the model when `--agent` is omitted, so the gate
    // has to run after that derivation or this path walks straight past it.
    const err = await spawnWith(["codex"], undefined, "claude-sonnet-5").catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/'claude' is not installed in this deployment/);
  });

  it("rejects a --model the PARENT's own harness offers, when that harness is absent", async () => {
    // planning#304 — the same 400 as the case above, reached without a switch. A
    // `--model` the parent's harness already offers implies no harness change, and
    // the resolution says so by naming the parent's harness rather than leaving the
    // override unset: the override is also the gate's subject, so an unset one
    // walks past it and creates a child on an absent CLI. The parent here is pinned
    // to Claude on a Codex-only deployment, so the model derives nothing new.
    const err = await spawnWith(["codex"], undefined, "claude-sonnet-5", { agentId: "claude" })
      .catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/'claude' is not installed in this deployment/);
  });

  it("does not reject an installed harness — it gets past the gate to the real work", async () => {
    // The stub deps make the spawn fail further in; what matters is that it is
    // NOT the install gate that stopped it.
    const err = await spawnWith(["claude", "codex"], "claude").catch((e: unknown) => e);
    expect((err as Error | undefined)?.message ?? "").not.toMatch(/not installed in this deployment/);
  });
});
