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
  generationId: A,
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

  it("tells two builds of one commit apart", () => {
    const commit = A;
    const rebuilt = ref({ generationId: `${commit}.deadbeef` });
    const held = holdGeneration(ref({ generationId: commit }));

    expect(generationHoldCount(rebuilt)).toBe(0);
    const claim = claimGenerationDeletion(rebuilt);
    expect(claim).not.toBeNull();

    claim!();
    held!();
  });

  it("refuses a hold while a deletion is under way, and allows one after", () => {
    const done = claimGenerationDeletion(ref());
    expect(done).not.toBeNull();
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
    stale!();
    expect(generationHoldCount(ref())).toBe(1);
    other!();
  });

  it("holds are per generation, not per repository", () => {
    const held = holdGeneration(ref({ generationId: A }));
    const claim = claimGenerationDeletion(ref({ generationId: B }));
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
    holdGenerationsForOwner(owner, [ref({ generationId: A })]);
    expect(generationHoldCount(ref({ generationId: A }))).toBe(1);

    holdGenerationsForOwner(owner, [ref({ generationId: B })]);
    expect(generationHoldCount(ref({ generationId: A }))).toBe(0);
    expect(generationHoldCount(ref({ generationId: B }))).toBe(1);
    const claim = claimGenerationDeletion(ref({ generationId: A }));
    expect(claim).not.toBeNull();
    claim!();
  });

  it("keeps a generation carried across rounds held exactly once", () => {
    holdGenerationsForOwner(owner, [ref()]);
    holdGenerationsForOwner(owner, [ref()]);
    expect(generationHoldCount(ref())).toBe(1);
    expect(claimGenerationDeletion(ref())).toBeNull();
  });

  it("an empty set is how a session with no plugin services lets go", () => {
    holdGenerationsForOwner(owner, [ref()]);
    holdGenerationsForOwner(owner, []);
    expect(generationHoldCount(ref())).toBe(0);
  });

  it("leaves out a generation that is being deleted, and reports what it got", () => {
    const done = claimGenerationDeletion(ref({ generationId: A }));
    const held = holdGenerationsForOwner(owner, [ref({ generationId: A }), ref({ generationId: B })]);
    expect(held.map((r) => r.generationId)).toEqual([B]);
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
    holdGenerationsForOwner(pluginServiceOwner("sess"), [ref({ generationId: B })]);
    holdGeneration(ref({ sessionId: "other" }));

    releaseSessionGenerationHolds("sess");

    expect(generationHoldCount(ref())).toBe(0);
    expect(generationHoldCount(ref({ generationId: B }))).toBe(0);
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

    const done = await begin({ repoName: "tools", generationId: A });
    expect(done).not.toBeNull();
    expect(volumes.has(VOLUME)).toBe(false);
    done!();
  });

  it("refuses when a container still holds the generation's volume", async () => {
    const { docker, volumes, held } = fakeDocker();
    volumes.add(VOLUME);
    held.add(VOLUME);
    const begin = createGenerationDeletionLease({ docker, sessionId: "sess" });

    expect(await begin({ repoName: "tools", generationId: A })).toBeNull();
    expect(volumes.has(VOLUME)).toBe(true);
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

    expect(await begin({ repoName: "tools", generationId: A })).toBeNull();
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
    expect(await begin({ repoName: "tools", generationId: A })).toBeNull();
    const retry = claimGenerationDeletion(ref());
    expect(retry).not.toBeNull();
    retry!();
  });
});
