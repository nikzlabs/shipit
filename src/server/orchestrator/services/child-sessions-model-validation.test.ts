/**
 * planning#359 — `shipit session create --model <x>` must refuse an id the
 * service catalogue does not carry for the child's harness.
 *
 * The reported failure: `--agent claude --model deepseek-v4` (the unsuffixed
 * near-miss of `deepseek-v4-flash` / `deepseek-v4-pro`) was accepted, a child
 * was created and shown running "deepseek-v4", and the Claude CLI then died
 * before doing any work — a bare id resolves to no `(service, mode)`, so the
 * turn was spawned against Anthropic asking for a DeepSeek model.
 *
 * This is the *naming* half of that issue and is deliberately separate from the
 * reachability half (`egress-allowlist.test.ts` / `egress-firewall.test.ts`),
 * which is why a **valid** DeepSeek id then failed too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionInfo } from "../../shared/types.js";
import type { ServiceError } from "./types.js";

const parent = {
  id: "parent-1",
  workspaceDir: "/workspace/parent-1",
  remoteUrl: "https://github.com/example/repo.git",
} as SessionInfo;

const sessionManager = {
  get: (id: string) => (id === parent.id ? parent : undefined),
  findChildren: () => [],
  countDetachedSpawnedInTurn: () => 0,
} as never;

/**
 * Both harnesses installed, so the install gate (docs/252 phase 9) can never be
 * what stops a spawn here — this file is only about the model id.
 */
async function spawnWith(agent: string | undefined, model: string | undefined) {
  vi.resetModules();
  vi.doMock("../../shared/installed-harnesses.js", () => ({
    isHarnessInstalled: () => true,
    readInstalledHarnesses: () => ["claude", "codex"],
  }));
  const { spawnChildSession } = await import("./child-sessions.js");
  return spawnChildSession(
    sessionManager,
    {} as never,
    {} as never,
    parent.id,
    { prompt: "do the thing", title: "t", ...(agent ? { agent } : {}), ...(model ? { model } : {}) } as never,
    "claude",
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

describe("spawnChildSession — model id validation", () => {
  it("rejects the unsuffixed 'deepseek-v4' and names the ids that do exist", async () => {
    // Asserted by shape, not `instanceof`: `vi.resetModules()` hands the module
    // under test its own copy of `./types.js`.
    const err = await spawnWith("claude", "deepseek-v4").catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    const message = (err as ServiceError).message;
    expect(message).toMatch(/Unknown model 'deepseek-v4' for agent 'claude'/);
    // The whole point of failing here rather than at the CLI: the caller is told
    // what to pass instead.
    expect(message).toContain("deepseek-v4-flash");
    expect(message).toContain("deepseek-v4-pro");
  });

  it("rejects an unlisted id even when it looks like a versioned first-party slug", async () => {
    // The passthrough this replaces existed for exactly this shape. It is gone:
    // no other model-admission surface accepts one, and a session cannot hold it
    // coherently (no service, no mode, no attribution, no failover).
    const err = await spawnWith("claude", "claude-opus-5-20260101").catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/Unknown model 'claude-opus-5-20260101'/);
  });

  it("validates against the harness the child will run on, not the parent's", async () => {
    // `--model gpt-5.5` alone derives the child onto Codex, so a Codex model is
    // valid from a Claude parent — the derivation has to happen first.
    const err = await spawnWith(undefined, "gpt-5.5").catch((e: unknown) => e);
    expect((err as Error | undefined)?.message ?? "").not.toMatch(/Unknown model/);
  });

  it("accepts a model the catalogue does carry for the harness", async () => {
    // The stub deps make the spawn fail further in; what matters is that model
    // validation is not what stopped it. Credentials are a separate gate —
    // this check is about the catalogue, not about eligibility.
    const err = await spawnWith("claude", "deepseek-v4-pro").catch((e: unknown) => e);
    expect((err as Error | undefined)?.message ?? "").not.toMatch(/Unknown model/);
  });

  it("still reports a cross-backend mismatch as a mismatch, not as an unknown id", async () => {
    const err = await spawnWith("claude", "gpt-5.5").catch((e: unknown) => e);
    expect((err as ServiceError).statusCode).toBe(400);
    expect((err as ServiceError).message).toMatch(/belongs to agent 'codex', not 'claude'/);
  });
});
