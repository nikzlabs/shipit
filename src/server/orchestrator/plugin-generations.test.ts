/**
 * docs/262 — generation staging and activation.
 *
 * Every test drives real git: a bare cache is built in a temp dir, so the
 * clone/checkout/pin paths are exercised rather than mocked. Only the fetch is
 * injected (`ensureCache`), because there is no network here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import {
  activateGeneration,
  activationQueueSize,
  activeLinkPath,
  readActiveGeneration,
} from "./plugin-generations.js";
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";

let tmp: string;
let originDir: string;
let bareCacheDir: string;
let stateDir: string;

const ensureCache = async (): Promise<void> => undefined;

function repo(over: Partial<DeclaredPluginRepo> = {}): DeclaredPluginRepo {
  return { name: "tools", source: { kind: "github", owner: "acme", repo: "tools" }, ...over };
}

/** The identity `repo()` points at — what a generation of it records. */
const TOOLS_SOURCE = "acme/tools";

function deps(selectedExports: string[] = []) {
  return {
    stateDir,
    bareCacheDir,
    repoUrl: "https://github.com/acme/tools.git",
    consumerKey: "https://github.com/acme/app.git",
    pinStorePath: path.join(tmp, "plugin-pins.json"),
    selectedExports,
    ensureCache,
  };
}

/** Commit `files` on the origin and return the new SHA. */
async function commitFiles(files: Record<string, string>, message: string): Promise<string> {
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(originDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  const git = simpleGit(originDir);
  await git.add(".");
  await git.commit(message);
  await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force"]);
  return (await simpleGit(originDir).revparse(["HEAD"])).trim();
}

/** A manifest exporting the named plugins. */
function manifest(names: string[] = ["probe"]): string {
  const entries = names
    .map((n) => `    ${n}:\n      cli:\n        ${n}: bin/${n}.mjs\n`)
    .join("");
  return `exports:\n  plugins:\n${entries}`;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-gen-"));
  originDir = path.join(tmp, "origin");
  bareCacheDir = path.join(tmp, "cache");
  stateDir = path.join(tmp, "state");
  fs.mkdirSync(originDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const git = simpleGit(originDir);
  await git.init(["--initial-branch=main"]);
  await git.addConfig("user.email", "test@example.com");
  await git.addConfig("user.name", "Test");
  fs.writeFileSync(path.join(originDir, "shipit.yaml"), manifest());
  await git.add(".");
  await git.commit("initial");
  await simpleGit().raw(["clone", "--bare", originDir, bareCacheDir]);
  await simpleGit(bareCacheDir).raw(["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("activateGeneration — staging and publish", () => {
  it("activates the branch tip and records the exact commit", async () => {
    const head = (await simpleGit(originDir).revparse(["HEAD"])).trim();
    const outcome = await activateGeneration(repo({ branch: "main" }), deps());

    expect(outcome.status).toBe("activated");
    const record = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE);
    expect(record?.commit).toBe(head);
    expect(record?.ref).toBe("branch main");
    expect(record?.exports).toEqual(["probe"]);
    // The checkout is real and reachable through the symlink.
    const live = fs.realpathSync(activeLinkPath(stateDir, "tools"));
    expect(fs.existsSync(path.join(live, "shipit.yaml"))).toBe(true);
  });

  it("a second activation at the same commit is a no-op", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const outcome = await activateGeneration(repo({ branch: "main" }), deps());
    expect(outcome.status).toBe("unchanged");
  });

  it("advances to a new commit and prunes the old generation", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    const second = await commitFiles({ "new.txt": "x" }, "second");
    const outcome = await activateGeneration(repo({ branch: "main" }), deps());

    expect(outcome.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(second);
    const generations = fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations"));
    expect(generations).not.toContain(first);
    expect(generations).toContain(second);
  });

  it("checks out the exact declared commit, not the tip", async () => {
    const first = (await simpleGit(originDir).revparse(["HEAD"])).trim();
    await commitFiles({ "later.txt": "later" }, "later");

    await activateGeneration(repo({ pin: first }), deps());

    const live = fs.realpathSync(activeLinkPath(stateDir, "tools"));
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(first);
    expect(fs.existsSync(path.join(live, "later.txt"))).toBe(false);
  });
});

describe("pin durability (req 8)", () => {
  it("stays on the first resolution even after the tag moves", async () => {
    const firstSha = (await simpleGit(originDir).revparse(["HEAD"])).trim();
    await simpleGit(originDir).raw(["tag", "v1"]);
    await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force", "--tags"]);

    await activateGeneration(repo({ pin: "v1" }), deps());
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(firstSha);

    // The tag moves to a newer commit — the plugin must not move with it.
    await commitFiles({ "moved.txt": "x" }, "moved");
    await simpleGit(originDir).raw(["tag", "-f", "v1"]);
    await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force", "--tags"]);

    const outcome = await activateGeneration(repo({ pin: "v1" }), deps());
    expect(outcome.status).toBe("unchanged");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(firstSha);
  });

  it("re-resolves when the declaration itself changes", async () => {
    await simpleGit(originDir).raw(["tag", "v1"]);
    const second = await commitFiles({ "two.txt": "x" }, "second");
    await simpleGit(originDir).raw(["tag", "v2"]);
    await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force", "--tags"]);

    await activateGeneration(repo({ pin: "v1" }), deps());
    await activateGeneration(repo({ pin: "v2" }), deps());
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(second);
  });
});

describe("phase-2 selector validation (plan §1a)", () => {
  it("a selected export missing from the manifest invalidates the whole generation", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["ghost"]));

    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toContain("`ghost`");
    // The names travel with the failure so the card states the fact once.
    expect((outcome as { missingSelectors?: string[] }).missingSelectors).toEqual(["ghost"]);
    // Nothing was published — degraded beats partial.
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
    const generations = fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations"));
    expect(generations).toEqual([]);
  });

  it("a selected export present in the manifest activates", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    expect(outcome.status).toBe("activated");
  });

  it("a new commit that drops a selected export keeps the prior generation live", async () => {
    await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    const good = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    // The plugin repo renames its export; the consumer still selects the old name.
    await commitFiles({ "shipit.yaml": manifest(["renamed"]) }, "rename export");
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));

    expect(outcome.status).toBe("failed");
    expect((outcome as { previous?: { commit: string } }).previous?.commit).toBe(good);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(good);
    // The live checkout is still complete.
    expect(fs.existsSync(path.join(fs.realpathSync(activeLinkPath(stateDir, "tools")), "shipit.yaml"))).toBe(true);
    // No staging leftovers.
    const generations = fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations"));
    expect(generations.filter((n) => n.includes(".staging-"))).toEqual([]);
  });
});

describe("failure semantics (reqs 13, 15)", () => {
  it("an unfetchable repository fails without throwing and keeps nothing half-made", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(),
      ensureCache: async () => {
        throw new Error("authorization failed");
      },
    });
    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toContain("authorization failed");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
  });

  it("an unknown branch fails without disturbing the live generation", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const good = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    const outcome = await activateGeneration(repo({ branch: "nope" }), deps());
    expect(outcome.status).toBe("failed");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(good);
  });

  it("`repo: self` has no generations", async () => {
    const outcome = await activateGeneration({ name: "dev", source: { kind: "self" } }, deps());
    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toContain("live working tree");
  });

  it("concurrent activations of one repo run in order, not in parallel", async () => {
    const [a, b] = await Promise.all([
      activateGeneration(repo({ branch: "main" }), deps()),
      activateGeneration(repo({ branch: "main" }), deps()),
    ]);
    // Serialized: the first stages and publishes, the second sees it live.
    expect([a.status, b.status]).toEqual(["activated", "unchanged"]);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).not.toBeNull();
  });

  // The regression this guards: joining an in-flight promise handed the second
  // caller the FIRST declaration's outcome, so a shipit.yaml edit landing
  // mid-activation was silently ignored (review finding 5).
  it("a declaration edit during activation is not lost", async () => {
    const first = (await simpleGit(originDir).revparse(["HEAD"])).trim();
    const second = await commitFiles({ "next.txt": "x" }, "second");
    await simpleGit(originDir).raw(["branch", "next"]);
    await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force"]);

    const [pinned, branched] = await Promise.all([
      activateGeneration(repo({ pin: first }), deps()),
      activateGeneration(repo({ branch: "next" }), deps()),
    ]);

    expect(pinned.status).toBe("activated");
    // The second declaration ran against ITS OWN declaration and won.
    expect(branched.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(second);
  });
});

describe("cancellation and queue hygiene", () => {
  it("a cancelled activation publishes nothing", async () => {
    // The session is archived mid-flight: its state dir may already be gone,
    // and a staging mkdir would silently re-create it.
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(),
      isCancelled: () => true,
    });
    expect(outcome.status).toBe("failed");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "generations"))).toBe(false);
  });

  it("releases its queue entry so session churn cannot grow the map", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    // Drain the microtask/cleanup tail.
    await new Promise((r) => setTimeout(r, 10));
    expect(activationQueueSize()).toBe(0);
  });
});

describe("pruning what a generation leaves behind", () => {
  it("drops a superseded generation's writable layer with it", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    // The layer an install would have written into.
    const work = path.join(stateDir, "plugins", "tools", "work");
    fs.mkdirSync(path.join(work, first, "upper"), { recursive: true });

    await commitFiles({ "second.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), deps());
    const second = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    expect(second).not.toBe(first);
    // Kept forever otherwise: install output for every commit this repo ever had.
    expect(fs.existsSync(path.join(work, first))).toBe(false);
  });

  it("sweeps an abandoned staging tree", async () => {
    // A crashed stage leaves `<sha>.staging-<uuid>`; the next stage of that
    // same commit removes the FINAL dir, never this one, and its suffix is
    // random, so nothing ever names it again.
    await activateGeneration(repo({ branch: "main" }), deps());
    const generations = path.join(stateDir, "plugins", "tools", "generations");
    const abandoned = path.join(generations, `${"e".repeat(40)}.staging-deadbeef`);
    fs.mkdirSync(abandoned, { recursive: true });

    await commitFiles({ "third.txt": "x" }, "third");
    await activateGeneration(repo({ branch: "main" }), deps());

    expect(fs.existsSync(abandoned)).toBe(false);
    expect(fs.readdirSync(generations)).toEqual([readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit]);
  });
});

describe("manifest warnings (req 13)", () => {
  it("records a fetched manifest's warnings on the generation", async () => {
    await commitFiles(
      { "shipit.yaml": "exports:\n  plugins:\n    probe:\n      cli:\n        probe: bin/probe.mjs\n      surprise: 1\n" },
      "unknown key",
    );
    await activateGeneration(repo({ branch: "main" }), deps());

    const record = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE);
    expect(record?.exports).toEqual(["probe"]);
    // Recorded, not just logged — the tab shows it (degrade *visibly*).
    expect(record?.manifestWarnings.join(" ")).toContain("surprise");
  });
});

/**
 * The ordering the blocked first attempt inverted: it published, pruned the
 * prior generation, THEN installed fire-and-forget and dropped the result — so
 * a failed install left a broken commit reported as `active` with no fallback.
 */
describe("install runs before publish (req 13, req 15)", () => {
  it("a failed install publishes nothing and leaves the prior generation live", async () => {
    // A good generation first, with no install step.
    await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    const before = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE);
    expect(before?.commit).toBeTruthy();

    // Now a new commit whose install fails.
    await commitFiles({ "second.txt": "x" }, "second");
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: async () => ({ ok: false, reason: "npm ci exited 1" }),
    });

    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toContain("npm ci exited 1");
    // The live generation is untouched — same commit, still readable.
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(before?.commit);
    // And the staging tree is gone rather than left half-built.
    const generations = fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations"));
    expect(generations).toEqual([before!.commit]);
  });

  it("install sees the STAGING dir, not a published generation", async () => {
    let seen: { stagingDir: string; commit: string; exports: string[] } | null = null;
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: async (job) => {
        seen = {
          stagingDir: job.stagingDir,
          commit: job.commit,
          exports: job.exports.map((e) => e.name),
        };
        // Nothing is live yet at the moment install runs — that is the point.
        expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
        return { ok: true };
      },
    });

    expect(seen!.stagingDir).toContain(".staging-");
    expect(seen!.commit).toMatch(/^[0-9a-f]{40}$/);
    // Only the selected export is offered for install.
    expect(seen!.exports).toEqual(["probe"]);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(seen!.commit);
  });

  // The session is archived while the fetch/checkout runs. Without a check
  // here, activation went on to start minutes of third-party code — and its
  // layer preparation re-created the very state directory cleanup had removed.
  it("does not start an install for a session that went away mid-fetch", async () => {
    let started = false;
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      // Cancellation arrives after staging, before install.
      isCancelled: (() => {
        let calls = 0;
        return () => ++calls > 1;
      })(),
      runInstall: async () => {
        started = true;
        return { ok: true };
      },
    });

    expect(started).toBe(false);
    expect(outcome.status).toBe("failed");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
  });

  it("hands the install a way to notice its session went away", async () => {
    let saw: boolean | undefined;
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      isCancelled: () => false,
      runInstall: async (job) => {
        saw = typeof job.isCancelled === "function";
        return { ok: true };
      },
    });
    expect(saw).toBe(true);
  });

  // Local/dogfood mode has no Docker and therefore no install runner. It still
  // activates — that runtime has to be able to exercise a plugin at all — but
  // reporting the generation as plainly `active` would be a lie the probe
  // catches.
  it("says so when a selected export declares an install nothing can run", async () => {
    await commitFiles(
      { "shipit.yaml": "exports:\n  plugins:\n    probe:\n      install: npm ci\n" },
      "with install",
    );
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));

    expect(outcome.status).toBe("activated");
    expect((outcome as { warning?: string }).warning).toContain("was not installed");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.manifestWarnings.join(" ")).toContain("`probe`");
  });

  it("stays quiet when nothing selected declares an install", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    expect(outcome.status).toBe("activated");
    expect((outcome as { warning?: string }).warning).toBeUndefined();
  });

  it("offers nothing to install when the consumer selected nothing", async () => {
    let calledWith: string[] | null = null;
    await activateGeneration(repo({ branch: "main" }), {
      ...deps([]),
      runInstall: async (job) => {
        calledWith = job.exports.map((e) => e.name);
        return { ok: true };
      },
    });
    expect(calledWith).toEqual([]);
  });
});

/**
 * Every on-disk path is keyed by the declaration's NAME, but a name is not
 * identity — a consumer can re-point `tools` from one repository to another and
 * keep the name. Without the recorded source, the previous repository's
 * generation stayed live under the new declaration: the Plugins tab showed the
 * new repository at the old repository's commit, and `/plugins/tools` still
 * held the old repository's files (reported by the feedback-channel session,
 * confirmed here).
 */
describe("a re-pointed declaration", () => {
  const OTHER = { kind: "github", owner: "acme", repo: "other" } as const;

  it("does not read the previous repository's generation as its own", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).not.toBeNull();

    // Same name, different repository: what is live belongs to someone else.
    expect(readActiveGeneration(stateDir, "tools", "acme/other")).toBeNull();
  });

  it("republishes under the new repository, and the old one stops being live", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const outcome = await activateGeneration(repo({ branch: "main", source: OTHER }), deps());

    expect(outcome.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", "acme/other")?.source).toBe("acme/other");
    // Whatever is live now, it is not the previous repository's.
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
  });

  // The half that reading-as-absent cannot cover: while the symlink resolves,
  // the container's prepare pass keeps linking /plugins/<name> at whatever it
  // points to. req 15 keeps the prior generation live on failure — the prior
  // generation OF THIS PLUGIN. Another repository's files are not a degraded
  // version of it, so the declaration reads as unavailable instead.
  it("leaves nothing live when the new repository fails to activate", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const outcome = await activateGeneration(repo({ pin: "v-does-not-exist", source: OTHER }), deps());

    expect(outcome.status).toBe("failed");
    expect((outcome as { previous?: unknown }).previous).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "active"))).toBe(false);
  });
});
