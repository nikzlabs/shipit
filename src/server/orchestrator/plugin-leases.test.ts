/**
 * docs/262 req 15 — the consumer lease over a live plugin generation.
 *
 * The lease exists so a refresh cannot delete a checkout out from under a
 * container that has it mounted, and everything worth asserting here is about
 * the two ways that can go wrong: a deletion starting while a consumer holds the
 * tree, and a hold being taken while a deletion is already under way. Both are
 * decided synchronously on purpose, so the tests are ordering tests.
 */

import { describe, it, expect, afterEach } from "vitest";
import type Docker from "dockerode";
import {
  claimGenerationDeletion,
  createGenerationDeletionLease,
  generationHoldCount,
  holdGeneration,
  holdGenerationsForOwner,
  pluginServiceOwner,
  releaseSessionGenerationHolds,
  type GenerationRef,
} from "./plugin-leases.js";
import { pluginOverlayVolumeName } from "./plugin-overlay.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

const ref = (over: Partial<GenerationRef> = {}): GenerationRef => ({
  sessionId: "sess",
  repoName: "tools",
  commit: A,
  ...over,
});

afterEach(() => {
  releaseSessionGenerationHolds("sess");
  releaseSessionGenerationHolds("other");
});

describe("holdGeneration / claimGenerationDeletion", () => {
  it("refuses a deletion claim while a consumer holds the generation", () => {
    const release = holdGeneration(ref());
    expect(release).not.toBeNull();
    expect(claimGenerationDeletion(ref())).toBeNull();

    release!();
    const claim = claimGenerationDeletion(ref());
    expect(claim).not.toBeNull();
    claim!();
  });

  it("refuses a hold while a deletion is under way, and allows one after", () => {
    const done = claimGenerationDeletion(ref());
    expect(done).not.toBeNull();
    // This is the invocation path's "the version it resolved was replaced
    // mid-call": the tree is being removed, so it must not be mounted.
    expect(holdGeneration(ref())).toBeNull();

    done!();
    expect(holdGeneration(ref())).not.toBeNull();
  });

  it("counts concurrent holds, so one consumer letting go does not free the tree", () => {
    const first = holdGeneration(ref());
    const second = holdGeneration(ref());
    expect(generationHoldCount(ref())).toBe(2);

    first!();
    expect(claimGenerationDeletion(ref())).toBeNull();
    second!();
    const claim = claimGenerationDeletion(ref());
    expect(claim).not.toBeNull();
    claim!();
  });

  it("releases at most once, so a double release cannot free somebody else's hold", () => {
    const stale = holdGeneration(ref());
    stale!();
    const other = holdGeneration(ref());
    // The first consumer's `finally` running twice must not drop the second's.
    stale!();
    expect(generationHoldCount(ref())).toBe(1);
    other!();
  });

  it("holds are per generation, not per repository", () => {
    const held = holdGeneration(ref({ commit: A }));
    const claim = claimGenerationDeletion(ref({ commit: B }));
    expect(claim).not.toBeNull();
    claim!();
    held!();
  });

  it("a second pruner cannot claim what the first is already deleting", () => {
    const done = claimGenerationDeletion(ref());
    expect(claimGenerationDeletion(ref())).toBeNull();
    done!();
  });
});

describe("holdGenerationsForOwner", () => {
  const owner = pluginServiceOwner("sess");

  it("replaces the previous set, releasing what is no longer named", () => {
    holdGenerationsForOwner(owner, [ref({ commit: A })]);
    expect(generationHoldCount(ref({ commit: A }))).toBe(1);

    // A refresh: the service surface now runs B, so A must become prunable.
    holdGenerationsForOwner(owner, [ref({ commit: B })]);
    expect(generationHoldCount(ref({ commit: A }))).toBe(0);
    expect(generationHoldCount(ref({ commit: B }))).toBe(1);
    const claim = claimGenerationDeletion(ref({ commit: A }));
    expect(claim).not.toBeNull();
    claim!();
  });

  it("keeps a generation carried across rounds held exactly once", () => {
    holdGenerationsForOwner(owner, [ref()]);
    holdGenerationsForOwner(owner, [ref()]);
    expect(generationHoldCount(ref())).toBe(1);
    // Never dropped to zero in between: a pruner running between the rounds
    // still finds it held.
    expect(claimGenerationDeletion(ref())).toBeNull();
  });

  it("an empty set is how a session with no plugin services lets go", () => {
    holdGenerationsForOwner(owner, [ref()]);
    holdGenerationsForOwner(owner, []);
    expect(generationHoldCount(ref())).toBe(0);
  });

  it("leaves out a generation that is being deleted, and reports what it got", () => {
    const done = claimGenerationDeletion(ref({ commit: A }));
    const held = holdGenerationsForOwner(owner, [ref({ commit: A }), ref({ commit: B })]);
    expect(held.map((r) => r.commit)).toEqual([B]);
    done!();
  });

  it("does not disturb another session's holds", () => {
    holdGenerationsForOwner(owner, [ref()]);
    holdGenerationsForOwner(pluginServiceOwner("other"), [ref({ sessionId: "other" })]);
    expect(generationHoldCount(ref())).toBe(1);
    expect(generationHoldCount(ref({ sessionId: "other" }))).toBe(1);
  });
});

describe("releaseSessionGenerationHolds", () => {
  it("drops every hold a disposed session had, of both kinds", () => {
    holdGeneration(ref());
    holdGenerationsForOwner(pluginServiceOwner("sess"), [ref({ commit: B })]);
    holdGeneration(ref({ sessionId: "other" }));

    releaseSessionGenerationHolds("sess");

    expect(generationHoldCount(ref())).toBe(0);
    expect(generationHoldCount(ref({ commit: B }))).toBe(0);
    expect(generationHoldCount(ref({ sessionId: "other" }))).toBe(1);
  });

  it("a CLI call whose `finally` runs after disposal cannot free a newer hold", () => {
    const inFlight = holdGeneration(ref());
    releaseSessionGenerationHolds("sess");
    const fresh = holdGeneration(ref());
    inFlight!();
    expect(generationHoldCount(ref())).toBe(1);
    fresh!();
  });
});

/** A daemon that answers only what the lease asks: does this volume still exist. */
function fakeDocker(opts: { held?: Set<string> } = {}) {
  const volumes = new Set<string>();
  const held = opts.held ?? new Set<string>();
  const notFound = (): never => {
    throw Object.assign(new Error("no such volume"), { statusCode: 404 });
  };
  const docker = {
    getVolume: (name: string) => ({
      inspect: async () => {
        if (!volumes.has(name)) notFound();
        return { Mountpoint: `/var/lib/docker/volumes/${name}/_data` };
      },
      remove: async () => {
        if (held.has(name)) {
          throw Object.assign(new Error("volume is in use"), { statusCode: 409 });
        }
        volumes.delete(name);
      },
    }),
  };
  return { docker: docker as unknown as Docker, volumes, held };
}

describe("createGenerationDeletionLease", () => {
  const VOLUME = pluginOverlayVolumeName("sess", "tools", A);

  it("grants the lease and removes the generation's volume", async () => {
    const { docker, volumes } = fakeDocker();
    volumes.add(VOLUME);
    const begin = createGenerationDeletionLease({ docker, sessionId: "sess" });

    const done = await begin({ repoName: "tools", commit: A });
    expect(done).not.toBeNull();
    // Removing the volume is PART of taking the lease: the directories it
    // describes are about to go, so a volume left behind would be a mount
    // description of nothing — and nothing else in a running session removes it.
    expect(volumes.has(VOLUME)).toBe(false);
    done!();
  });

  it("refuses when a container still holds the generation's volume", async () => {
    const { docker, volumes, held } = fakeDocker();
    volumes.add(VOLUME);
    held.add(VOLUME); // a plugin service is still attached to the superseded tree
    const begin = createGenerationDeletionLease({ docker, sessionId: "sess" });

    expect(await begin({ repoName: "tools", commit: A })).toBeNull();
    expect(volumes.has(VOLUME)).toBe(true);
    // The refusal released its own claim, so the next publish's prune retries
    // rather than finding the generation permanently unclaimable.
    const retry = claimGenerationDeletion(ref());
    expect(retry).not.toBeNull();
    retry!();
  });

  it("refuses while a consumer holds the generation, without asking the daemon", async () => {
    let asked = false;
    const docker = {
      getVolume: () => {
        asked = true;
        return { inspect: async () => ({ Mountpoint: "/m" }), remove: async () => undefined };
      },
    } as unknown as Docker;
    const release = holdGeneration(ref());
    const begin = createGenerationDeletionLease({ docker, sessionId: "sess" });

    expect(await begin({ repoName: "tools", commit: A })).toBeNull();
    // The in-process half is checked first and is decisive on its own: a CLI
    // that has resolved the generation but not yet created its container holds
    // no volume the daemon could report.
    expect(asked).toBe(false);
    release!();
  });

  it("treats a daemon that cannot answer as still held", async () => {
    const docker = {
      getVolume: () => ({
        inspect: async () => {
          throw new Error("daemon unreachable");
        },
        remove: async () => {
          throw new Error("daemon unreachable");
        },
      }),
    } as unknown as Docker;
    const begin = createGenerationDeletionLease({ docker, sessionId: "sess" });
    expect(await begin({ repoName: "tools", commit: A })).toBeNull();
    // Fail-closed, but not wedged: the claim is released on the way out.
    const retry = claimGenerationDeletion(ref());
    expect(retry).not.toBeNull();
    retry!();
  });
});
