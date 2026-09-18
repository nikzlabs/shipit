import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { declarationPinKey, resolveDurablePin } from "./plugin-pins.js";
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";

let tmp: string;
let storePath: string;

const repo: DeclaredPluginRepo = {
  name: "tools",
  source: { kind: "github", owner: "acme", repo: "tools" },
  pin: "v1",
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-pins-"));
  storePath = path.join(tmp, "plugin-pins.json");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("resolveDurablePin", () => {
  it("records the first resolution and reuses it", async () => {
    const resolve = vi.fn(async () => SHA_A);
    expect(await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve })).toEqual({ commit: SHA_A });

    const again = await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve });
    expect(again).toEqual({ commit: SHA_A });
  });

  it("a moved tag does not move the plugin, and says so", async () => {
    await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve: async () => SHA_A });

    const moved = await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve: async () => SHA_B });
    expect(moved.commit).toBe(SHA_A);
    expect(moved.warning).toContain("pinned to");
  });

  it("honors the record when the tag can no longer be resolved at all", async () => {
    await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve: async () => SHA_A });

    const gone = await resolveDurablePin({
      storePath,
      consumerKey: "proj",
      repo,
      resolve: async () => {
        throw new Error("unknown revision");
      },
    });
    expect(gone.commit).toBe(SHA_A);
  });

  it("is scoped to the consuming project, so every session of it agrees", async () => {
    await resolveDurablePin({ storePath, consumerKey: "proj-a", repo, resolve: async () => SHA_A });
    const sameProject = await resolveDurablePin({ storePath, consumerKey: "proj-a", repo, resolve: async () => SHA_B });
    expect(sameProject.commit).toBe(SHA_A);

    const otherProject = await resolveDurablePin({ storePath, consumerKey: "proj-b", repo, resolve: async () => SHA_B });
    expect(otherProject.commit).toBe(SHA_B);
  });

  it("re-resolves when the declaration changes", async () => {
    await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve: async () => SHA_A });
    const edited = await resolveDurablePin({
      storePath,
      consumerKey: "proj",
      repo: { ...repo, pin: "v2" },
      resolve: async () => SHA_B,
    });
    expect(edited.commit).toBe(SHA_B);
  });

  it("survives a corrupt store rather than failing to activate", async () => {
    fs.writeFileSync(storePath, "{ not json");
    expect(await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve: async () => SHA_A })).toEqual({
      commit: SHA_A,
    });
  });

  it("writes atomically — no temp file survives a completed write", async () => {
    await resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve: async () => SHA_A });
    expect(fs.readdirSync(tmp).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(storePath, "utf-8")).pins).toHaveProperty(
      declarationPinKey("proj", repo),
      SHA_A,
    );
  });
});

describe("concurrent writers", () => {
  it("concurrent first-resolutions all survive", async () => {
    const repos: DeclaredPluginRepo[] = Array.from({ length: 8 }, (_, i) => ({
      name: `tools-${i}`,
      source: { kind: "github", owner: "acme", repo: `tools-${i}` },
      pin: "v1",
    }));

    await Promise.all(
      repos.map((r, i) =>
        resolveDurablePin({
          storePath,
          consumerKey: "proj",
          repo: r,
          resolve: async () => {
            // Allow concurrent callers to read before this resolution completes.
            await new Promise((res) => setTimeout(res, 1));
            return String(i).repeat(40);
          },
        }),
      ),
    );

    const pins = JSON.parse(fs.readFileSync(storePath, "utf-8")).pins;
    expect(Object.keys(pins)).toHaveLength(repos.length);
  });

  it("two concurrent callers for ONE declaration agree on a single commit", async () => {
    let calls = 0;
    const resolve = async (): Promise<string> => {
      await new Promise((res) => setTimeout(res, 1));
      calls += 1;
      return String(calls).repeat(40);
    };

    const [a, b] = await Promise.all([
      resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve }),
      resolveDurablePin({ storePath, consumerKey: "proj", repo, resolve }),
    ]);
    expect(a.commit).toBe(b.commit);
  });
});
