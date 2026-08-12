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
  type ActivationOutcome,
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

function deps() {
  return { stateDir, bareCacheDir, repoUrl: "https://github.com/acme/tools.git", ensureCache };
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

/** A manifest exporting one plugin, optionally with an install command. */
function manifest(opts: { install?: string; inputs?: string[] } = {}): string {
  const install = opts.install ? `      install: ${opts.install}\n` : "";
  const inputs = opts.inputs ? `      install-inputs: [${opts.inputs.join(", ")}]\n` : "";
  return `exports:\n  plugins:\n    probe:\n      cli:\n        probe: bin/probe.mjs\n${install}${inputs}`;
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

describe("install (req 7)", () => {
  it("runs the manifest's install with the generation's commit in the env", async () => {
    await commitFiles(
      {
        "shipit.yaml": manifest({ install: "node -e \"require('fs').writeFileSync('stamp.txt', process.env.SHIPIT_PLUGIN_COMMIT)\"" }),
      },
      "add install",
    );
    const head = (await simpleGit(originDir).revparse(["HEAD"])).trim();

    const outcome = await activateGeneration(repo({ branch: "main" }), deps());
    expect(outcome.status).toBe("activated");

    const live = fs.realpathSync(activeLinkPath(stateDir, "tools"));
    // Install output lands in the generation directory — never in the bare
    // cache, never in the consuming project.
    expect(fs.readFileSync(path.join(live, "stamp.txt"), "utf-8")).toBe(head);
    expect(fs.existsSync(path.join(originDir, "stamp.txt"))).toBe(false);
    expect(readActiveGeneration(stateDir, "tools")?.installStamp).toBeTruthy();
  });

  it("a failing install leaves the previous generation active and whole", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const good = readActiveGeneration(stateDir, "tools")!.commit;

    await commitFiles({ "shipit.yaml": manifest({ install: "exit 3" }) }, "broken install");
    const outcome = (await activateGeneration(repo({ branch: "main" }), deps())) as Extract<
      ActivationOutcome,
      { status: "failed" }
    >;

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toContain("exit 3");
    expect(outcome.previous?.commit).toBe(good);
    // Still live, still complete.
    expect(readActiveGeneration(stateDir, "tools")?.commit).toBe(good);
    expect(fs.existsSync(path.join(fs.realpathSync(activeLinkPath(stateDir, "tools")), "shipit.yaml"))).toBe(true);
    // No staging leftovers.
    const generations = fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations"));
    expect(generations.filter((n) => n.includes(".staging-"))).toEqual([]);
  });

  it("re-runs install when a declared install-input changes under the same commit", async () => {
    const install = "node -e \"require('fs').appendFileSync('runs.txt', 'x')\"";
    await commitFiles(
      { "shipit.yaml": manifest({ install, inputs: ["deps.lock"] }), "deps.lock": "v1" },
      "with inputs",
    );
    await activateGeneration(repo({ branch: "main" }), deps());
    const live = fs.realpathSync(activeLinkPath(stateDir, "tools"));
    expect(fs.readFileSync(path.join(live, "runs.txt"), "utf-8")).toBe("x");

    // Same commit, unchanged inputs — no re-run.
    await activateGeneration(repo({ branch: "main" }), deps());
    expect(fs.readFileSync(path.join(live, "runs.txt"), "utf-8")).toBe("x");

    // The input's CONTENT changes in the live checkout: install is stale.
    fs.writeFileSync(path.join(live, "deps.lock"), "v2");
    await activateGeneration(repo({ branch: "main" }), deps());
    expect(fs.readFileSync(path.join(live, "runs.txt"), "utf-8")).toBe("xx");
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

  it("concurrent activations of one repo share a single staging run", async () => {
    const [a, b] = await Promise.all([
      activateGeneration(repo({ branch: "main" }), deps()),
      activateGeneration(repo({ branch: "main" }), deps()),
    ]);
    // The second call joins the first rather than staging a second checkout.
    expect(a).toEqual(b);
    expect(readActiveGeneration(stateDir, "tools")).not.toBeNull();
  });
});
