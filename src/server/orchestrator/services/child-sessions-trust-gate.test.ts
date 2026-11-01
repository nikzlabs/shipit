import { describe, it, expect, vi } from "vitest";
import type { SessionInfo } from "../../shared/types.js";
import { spawnChildSession, SpawnRepositoryUntrustedError } from "./child-sessions.js";
import { ServiceError } from "./types.js";

const REPO_URL = "https://x:secret@github.com/acme/api.git";

const parent = {
  id: "parent-1",
  title: "Parent",
  workspaceDir: "/workspace/parent-1",
  remoteUrl: REPO_URL,
  agentId: "claude",
} as SessionInfo;

function harness(opts: {
  trusted: boolean;
  discard?: () => Promise<void>;
  onChildClaimed?: (sessionId: string) => void;
}) {
  const claim = vi.fn().mockResolvedValue({
    sessionId: "child-1",
    // Not a git checkout, so the first step after the claim fails.
    workspaceDir: "/nonexistent/child-1/workspace",
    fetchDurationMs: 0,
    claimPath: "slow-clone",
  });
  const getOrCreate = vi.fn();
  const isTrusted = vi.fn().mockReturnValue(opts.trusted);
  const discardChild = vi.fn(opts.discard ?? (async () => {}));
  const run = () =>
    spawnChildSession(
      {
        get: (id: string) => (id === parent.id ? parent : undefined),
        findChildren: () => [],
        countDetachedSpawnedInTurn: () => 0,
      } as never,
      { get: () => undefined, getOrCreate } as never,
      { claim },
      parent.id,
      { prompt: "do the thing", title: "Child", ...(opts.onChildClaimed ? { onChildClaimed: opts.onChildClaimed } : {}) },
      "claude",
      undefined,
      undefined,
      undefined,
      { repoStore: { isTrusted } } as never,
      discardChild,
    );
  return { run, claim, getOrCreate, isTrusted, discardChild };
}

describe("spawnChildSession — repository trust (docs/243)", () => {
  it("refuses an untrusted remote before the claim creates anything", async () => {
    const h = harness({ trusted: false });

    const err = await h.run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SpawnRepositoryUntrustedError);
    expect(err).toMatchObject({ statusCode: 403, code: "repository_untrusted" });
    expect(h.isTrusted).toHaveBeenCalledWith(REPO_URL);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.discardChild).not.toHaveBeenCalled();
  });

  it("names the repository without its credential, and the Trust action", async () => {
    const err = await harness({ trusted: false }).run().catch((e: unknown) => e) as Error;

    expect(err.message).toContain("acme/api");
    expect(err.message).toContain("Trust this repository");
    expect(err.message).not.toContain("secret");
  });
});

describe("spawnChildSession — a failure after the child exists", () => {
  it("removes the child and keeps the original error", async () => {
    const h = harness({ trusted: true });

    const err = await h.run().catch((e: unknown) => e);

    expect(h.claim).toHaveBeenCalledTimes(1);
    expect(h.discardChild).toHaveBeenCalledWith("child-1");
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).message).toMatch(/Failed to read claimed branch/);
    expect((err as ServiceError).message).not.toContain("child-1");
  });

  it("names the child's id when it could not be removed", async () => {
    const h = harness({
      trusted: true,
      discard: async () => {
        throw new Error("database is locked");
      },
    });

    const err = await h.run().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).statusCode).toBe(500);
    expect((err as ServiceError).message).toMatch(/Failed to read claimed branch/);
    expect((err as ServiceError).message).toMatch(/child-1 .* still\s+exists: .*database is locked/);
  });

  it("tells the caller the child's id as soon as the claim returns", async () => {
    const onChildClaimed = vi.fn();
    const h = harness({ trusted: true, onChildClaimed });

    await h.run().catch(() => {});

    expect(onChildClaimed).toHaveBeenCalledExactlyOnceWith("child-1");
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  it("removes the child when the caller cannot record its id", async () => {
    const h = harness({
      trusted: true,
      onChildClaimed: () => {
        throw new Error("could not record the child");
      },
    });

    const err = await h.run().catch((e: unknown) => e);

    expect(h.discardChild).toHaveBeenCalledWith("child-1");
    expect((err as Error).message).toBe("could not record the child");
  });
});
