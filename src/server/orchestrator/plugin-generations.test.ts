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
    const record = readActiveGeneration(stateDir, "tools");
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
    const first = readActiveGeneration(stateDir, "tools")!.commit;

    const second = await commitFiles({ "new.txt": "x" }, "second");
    const outcome = await activateGeneration(repo({ branch: "main" }), deps());

    expect(outcome.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(second);
    const generations = fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations"));
    expect(generations).not.toContain(first);
    expect(generations).toContain(second);
  });

  it("checks out the exact declared commit, not the tip", async () => {
    const first = (await simpleGit(originDir).revparse(["HEAD"])).trim();
    await commitFiles({ "later.txt": "later" }, "later");

    await activateGeneration(repo({ pin: first }), deps());

    const live = fs.realpathSync(activeLinkPath(stateDir, "tools"));
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(first);
    expect(fs.existsSync(path.join(live, "later.txt"))).toBe(false);
  });
});

describe("pin durability (req 8)", () => {
  it("stays on the first resolution even after the tag moves", async () => {
    const firstSha = (await simpleGit(originDir).revparse(["HEAD"])).trim();
    await simpleGit(originDir).raw(["tag", "v1"]);
    await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force", "--tags"]);

    await activateGeneration(repo({ pin: "v1" }), deps());
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(firstSha);

    // The tag moves to a newer commit — the plugin must not move with it.
    await commitFiles({ "moved.txt": "x" }, "moved");
    await simpleGit(originDir).raw(["tag", "-f", "v1"]);
    await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force", "--tags"]);

    const outcome = await activateGeneration(repo({ pin: "v1" }), deps());
    expect(outcome.status).toBe("unchanged");
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(firstSha);
  });

  it("re-resolves when the declaration itself changes", async () => {
    await simpleGit(originDir).raw(["tag", "v1"]);
    const second = await commitFiles({ "two.txt": "x" }, "second");
    await simpleGit(originDir).raw(["tag", "v2"]);
    await simpleGit(bareCacheDir).raw(["fetch", "--all", "--force", "--tags"]);

    await activateGeneration(repo({ pin: "v1" }), deps());
    await activateGeneration(repo({ pin: "v2" }), deps());
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(second);
  });
});

describe("phase-2 selector validation (plan §1a)", () => {
  it("a selected export missing from the manifest invalidates the whole generation", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["ghost"]));

    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toContain("`ghost`");
    // Nothing was published — degraded beats partial.
    expect(readActiveGeneration(stateDir, "tools")).toBeNull();
    const generations = fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations"));
    expect(generations).toEqual([]);
  });

  it("a selected export present in the manifest activates", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    expect(outcome.status).toBe("activated");
  });

  it("a new commit that drops a selected export keeps the prior generation live", async () => {
    await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    const good = readActiveGeneration(stateDir, "tools")!.commit;

    // The plugin repo renames its export; the consumer still selects the old name.
    await commitFiles({ "shipit.yaml": manifest(["renamed"]) }, "rename export");
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));

    expect(outcome.status).toBe("failed");
    expect((outcome as { previous?: { commit: string } }).previous?.commit).toBe(good);
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(good);
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
    expect(readActiveGeneration(stateDir, "tools")).toBeNull();
  });

  it("an unknown branch fails without disturbing the live generation", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const good = readActiveGeneration(stateDir, "tools")!.commit;

    const outcome = await activateGeneration(repo({ branch: "nope" }), deps());
    expect(outcome.status).toBe("failed");
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(good);
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
    expect(readActiveGeneration(stateDir, "tools")).not.toBeNull();
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
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(second);
  });
});
