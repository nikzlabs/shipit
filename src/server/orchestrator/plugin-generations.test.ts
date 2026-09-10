import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import simpleGit from "simple-git";
import {
  activateGeneration,
  activationQueueSize,
  activeLinkPath,
  readActiveGeneration,
  resolveLiveGenerations,
  retireSelfDeclaredGeneration,
  type BeginGenerationDeletion,
  type StagedGeneration,
} from "./plugin-generations.js";
import type { DeclaredPluginRepo } from "../shared/plugin-repos.js";
import type * as SessionWorkerUidModule from "./session-worker-uid.js";

// The real handback needs root and configured session identities; spy on its timing here.
const handBackSpy = vi.hoisted(() => vi.fn());
vi.mock("./session-worker-uid.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionWorkerUidModule>()),
  handWorkspaceBackToWorker: handBackSpy,
}));

let tmp: string;
let originDir: string;
let bareCacheDir: string;
let stateDir: string;

const ensureCache = async (): Promise<void> => undefined;

function repo(over: Partial<DeclaredPluginRepo> = {}): DeclaredPluginRepo {
  return { name: "tools", source: { kind: "github", owner: "acme", repo: "tools" }, ...over };
}

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

describe("staged checkout ownership (docs/266-orchestrator-git-trust-boundary E2, planning#410)", () => {
  it("hands the staged checkout over between the root clone and the dropped git", async () => {
    const treeWhenCalled: { dir: string; hasGitDir: boolean; worktreeEntries: string[] }[] = [];
    handBackSpy.mockImplementation((dir: string) => {
      treeWhenCalled.push({
        dir,
        hasGitDir: fs.existsSync(path.join(dir, ".git")),
        worktreeEntries: fs.readdirSync(dir).filter((e) => e !== ".git"),
      });
    });

    const outcome = await activateGeneration(repo({ branch: "main" }), deps());
    expect(outcome.status).toBe("activated");

    expect(treeWhenCalled).toHaveLength(1);
    expect(treeWhenCalled[0].hasGitDir).toBe(true);
    expect(treeWhenCalled[0].worktreeEntries).toEqual([]);
    expect(treeWhenCalled[0].dir).not.toBe(bareCacheDir);
    expect(treeWhenCalled[0].dir.startsWith(stateDir)).toBe(true);
  });
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
    expect((outcome as { missingSelectors?: string[] }).missingSelectors).toEqual(["ghost"]);
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

    await commitFiles({ "shipit.yaml": manifest(["renamed"]) }, "rename export");
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));

    expect(outcome.status).toBe("failed");
    expect((outcome as { previous?: { commit: string } }).previous?.commit).toBe(good);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(good);
    expect(fs.existsSync(path.join(fs.realpathSync(activeLinkPath(stateDir, "tools")), "shipit.yaml"))).toBe(true);
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

    const reason = (outcome as { reason: string }).reason;
    expect(reason).toBe("`nope` is not a branch, tag or commit in `acme/tools`.");
  });

  it("does not diagnose an unexpected git failure as a missing ref", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(),
      bareCacheDir: stateDir,
    });
    expect(outcome.status).toBe("failed");
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain("could not resolve `main` in `acme/tools`");
    expect(reason).not.toContain("is not a branch, tag or commit");
    expect(reason).toMatch(/not a git repository/i);
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
    expect([a.status, b.status]).toEqual(["activated", "unchanged"]);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).not.toBeNull();
  });

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
    expect(branched.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(second);
  });
});

describe("cancellation and queue hygiene", () => {
  it("a cancelled activation publishes nothing", async () => {
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
    await new Promise((r) => setTimeout(r, 10));
    expect(activationQueueSize()).toBe(0);
  });
});

describe("pruning what a generation leaves behind", () => {
  it("drops a superseded generation's writable layer with it", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    const work = path.join(stateDir, "plugins", "tools", "work");
    fs.mkdirSync(path.join(work, first, "upper"), { recursive: true });

    await commitFiles({ "second.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), deps());
    const second = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    expect(second).not.toBe(first);
    expect(fs.existsSync(path.join(work, first))).toBe(false);
  });

  it("sweeps an abandoned staging tree", async () => {
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
    expect(record?.manifestWarnings.join(" ")).toContain("surprise");
  });
});

describe("the phase-3 gate runs before publish (reqs 13, 15)", () => {
  it("a refused candidate publishes nothing and leaves the prior generation live", async () => {
    await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    const before = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE);
    expect(before?.commit).toBeTruthy();

    await commitFiles({ "second.txt": "x" }, "second");
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      validateStaged: () => ({ ok: false, reason: "its compose service `web` declares `build:`." }),
    });

    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toContain("declares `build:`");
    expect((outcome as { previous?: { commit: string } }).previous?.commit).toBe(before?.commit);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(before?.commit);
    expect(fs.readdirSync(path.join(stateDir, "plugins", "tools", "generations")))
      .toEqual([before!.commit]);
  });

  it("a refused FIRST candidate leaves nothing active at all", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      validateStaged: () => ({ ok: false, reason: "its compose fragment could not be read." }),
    });

    expect(outcome.status).toBe("failed");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
    expect(fs.existsSync(activeLinkPath(stateDir, "tools"))).toBe(false);
  });

  it("judges the STAGING tree, and the declaration it was staged for", async () => {
    let seen: StagedGeneration | null = null;
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      validateStaged: (staged) => {
        seen = { ...staged };
        expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
        expect(fs.existsSync(path.join(staged.stagingDir, "shipit.yaml"))).toBe(true);
        return { ok: true };
      },
    });

    expect(seen!.repoName).toBe("tools");
    expect(seen!.stagingDir).toContain(".staging-");
    expect(seen!.source).toBe(TOOLS_SOURCE);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(seen!.commit);
  });

  it("judges one candidate at a time across the session, not one per repository", async () => {
    const entered: string[] = [];
    let sawUnpublishedPredecessor = false;
    const gate = (staged: StagedGeneration): { ok: true } => {
      for (const earlier of entered) {
        if (!fs.existsSync(activeLinkPath(stateDir, earlier))) sawUnpublishedPredecessor = true;
      }
      entered.push(staged.repoName);
      return { ok: true };
    };

    const other = repo({
      name: "other",
      source: { kind: "github", owner: "acme", repo: "other" },
      branch: "main",
    });
    await Promise.all([
      activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), validateStaged: gate }),
      activateGeneration(other, { ...deps(["probe"]), validateStaged: gate }),
    ]);

    expect(entered).toHaveLength(2);
    expect(sawUnpublishedPredecessor).toBe(false);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).not.toBeNull();
    expect(readActiveGeneration(stateDir, "other", "acme/other")).not.toBeNull();
  });

  it("is not consulted when the declared commit is already live", async () => {
    await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    let asked = false;
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      validateStaged: () => {
        asked = true;
        return { ok: false, reason: "nope" };
      },
    });

    expect(outcome.status).toBe("unchanged");
    expect(asked).toBe(false);
  });
});

describe("install runs before publish (req 13, req 15)", () => {
  it("a failed install publishes nothing and leaves the prior generation live", async () => {
    await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    const before = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE);
    expect(before?.commit).toBeTruthy();

    await commitFiles({ "second.txt": "x" }, "second");
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: async () => ({ ok: false, reason: "npm ci exited 1" }),
    });

    expect(outcome.status).toBe("failed");
    expect((outcome as { reason: string }).reason).toContain("npm ci exited 1");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(before?.commit);
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
        expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
        return { ok: true };
      },
    });

    expect(seen!.stagingDir).toContain(".staging-");
    expect(seen!.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(seen!.exports).toEqual(["probe"]);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(seen!.commit);
  });

  it("does not start an install for a session that went away mid-fetch", async () => {
    let started = false;
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
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

  it("says so when a selected export declares an install nothing can run", async () => {
    await commitFiles(
      { "shipit.yaml": "exports:\n  plugins:\n    probe:\n      install: npm ci\n" },
      "with install",
    );
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));

    expect(outcome.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.manifestWarnings).toContain(
      "`probe` declares an install command, which this runtime cannot run — "
      + "the plugin is active but was not installed.",
    );
    expect((outcome as { warning?: string }).warning).toBeUndefined();
  });

  it("agrees with itself when two selected exports declare one", async () => {
    await commitFiles(
      {
        "shipit.yaml":
          "exports:\n  plugins:\n    probe:\n      install: npm ci\n    other:\n      install: npm ci\n",
      },
      "two installs",
    );
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe", "other"]));

    expect(outcome.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.manifestWarnings).toContain(
      "`probe`, `other` declare an install command, which this runtime cannot run — "
      + "the plugins are active but were not installed.",
    );
    expect((outcome as { warning?: string }).warning).toBeUndefined();
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

describe("a re-pointed declaration", () => {
  const OTHER = { kind: "github", owner: "acme", repo: "other" } as const;

  it("does not read the previous repository's generation as its own", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).not.toBeNull();

    expect(readActiveGeneration(stateDir, "tools", "acme/other")).toBeNull();
  });

  it("republishes under the new repository, and the old one stops being live", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const outcome = await activateGeneration(repo({ branch: "main", source: OTHER }), deps());

    expect(outcome.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", "acme/other")?.source).toBe("acme/other");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
  });

  it("leaves nothing live when the new repository fails to activate", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const outcome = await activateGeneration(repo({ pin: "v-does-not-exist", source: OTHER }), deps());

    expect(outcome.status).toBe("failed");
    expect((outcome as { previous?: unknown }).previous).toBeUndefined();
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "active"))).toBe(false);
  });

  it("keeps a legacy generation ON DISK when the fetch for its own repository fails", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;

    const recordPath = path.join(stateDir, "plugins", "tools", "active", ".shipit-generation.json");
    const { source: _dropped, ...legacy } = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    fs.writeFileSync(recordPath, JSON.stringify(legacy));

    const outcome = await activateGeneration(repo({ pin: "v-does-not-exist" }), deps());

    expect(outcome.status).toBe("failed");
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "active"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "generations", live.commit))).toBe(true);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
  });
});

describe("retiring what is left under a `repo: self` name (req 27)", () => {
  const stillSelf = () => true;

  it("retires the previous repository's generation, link and trees", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;

    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, stillSelf);

    expect(fs.existsSync(activeLinkPath(stateDir, "tools"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "generations", live.commit))).toBe(false);
  });

  it("retires a legacy record with no recorded source, unlike the tracked path", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const recordPath = path.join(activeLinkPath(stateDir, "tools"), ".shipit-generation.json");
    const { source: _dropped, ...legacy } = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    fs.writeFileSync(recordPath, JSON.stringify(legacy));

    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, stillSelf);

    expect(fs.existsSync(activeLinkPath(stateDir, "tools"))).toBe(false);
  });

  it("does nothing when the name is no longer self by the time it runs", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, () => false);

    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).not.toBeNull();
  });

  it("runs on the per-repository queue and releases it", async () => {
    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, stillSelf);
    expect(activationQueueSize()).toBe(0);
  });
});

describe("resolveLiveGenerations", () => {
  it("resolves each repository's `active` exactly ONCE, however many readers ask", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const spy = vi.spyOn(fs, "realpathSync");
    const live = resolveLiveGenerations(stateDir, [repo({ branch: "main" })]);
    expect(spy.mock.calls.length).toBe(0);

    for (let i = 0; i < 5; i++) live(repo({ branch: "main" }));
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });

  it("never touches a declared repository nobody asks about", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const other = repo({ name: "other-tools", branch: "main" });

    const spy = vi.spyOn(fs, "realpathSync");
    resolveLiveGenerations(stateDir, [repo({ branch: "main" }), other])(repo({ branch: "main" }));

    const touchedOther = spy.mock.calls.filter(([p]) => String(p).includes("other-tools"));
    expect(touchedOther).toEqual([]);
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });

  it("hands back the directory WITH the record that proves whose it is", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const verified = resolveLiveGenerations(stateDir, [repo({ branch: "main" })])(repo({ branch: "main" }))!;
    expect(verified.record.source).toBe(TOOLS_SOURCE);
    expect(verified.record.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(verified.dir).toContain(path.join("generations", verified.record.commit));
    expect(fs.lstatSync(verified.dir).isSymbolicLink()).toBe(false);
  });

  it("answers null for a `repo: self` declaration and for a foreign generation", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const selfRepo: DeclaredPluginRepo = { name: "dev", source: { kind: "self" } };
    expect(resolveLiveGenerations(stateDir, [selfRepo])(selfRepo)).toBeNull();

    const rePointed = repo({ branch: "main", source: { kind: "github", owner: "acme", repo: "other" } });
    expect(resolveLiveGenerations(stateDir, [rePointed])(rePointed)).toBeNull();
  });

  it("answers null for a repository it was not asked to resolve", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const undeclared = repo({ name: "other-tools", branch: "main" });
    expect(resolveLiveGenerations(stateDir, [])(undeclared)).toBeNull();
  });
});

describe("consumer lease over a superseded generation (req 15)", () => {
  function lease(held: string[] = []) {
    const refuse = new Set(held);
    const asked: string[] = [];
    const claimed = new Set<string>();
    const begin: BeginGenerationDeletion = async ({ generationId }) => {
      asked.push(generationId);
      if (refuse.has(generationId) || claimed.has(generationId)) return null;
      claimed.add(generationId);
      return () => claimed.delete(generationId);
    };
    return { begin, asked, claimed, refuse };
  }

  const generationsDir = (): string => path.join(stateDir, "plugins", "tools", "generations");
  const workDir = (commit: string): string => path.join(stateDir, "plugins", "tools", "work", commit);

  function seedWorkLayer(commit: string): void {
    fs.mkdirSync(path.join(workDir(commit), "upper"), { recursive: true });
  }

  it("leaves a held generation — checkout AND writable layer — exactly where it is", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(first);

    const held = lease([first]);
    const second = await commitFiles({ "new.txt": "x" }, "second");
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(),
      beginGenerationDeletion: held.begin,
    });

    expect(outcome.status).toBe("activated");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(second);
    expect(held.asked).toContain(first);
    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(true);
    expect(fs.existsSync(path.join(workDir(first), "upper"))).toBe(true);
    expect(fs.existsSync(path.join(generationsDir(), second))).toBe(true);
  });

  it("reclaims it on the next publish, once nothing holds it", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(first);

    const held = lease([first]);
    await commitFiles({ "new.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });
    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(true);

    held.refuse.delete(first);
    await commitFiles({ "third.txt": "x" }, "third");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });

    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(false);
    expect(fs.existsSync(workDir(first))).toBe(false);
    expect(held.claimed.size).toBe(0);
  });

  it("removes an abandoned staging tree without asking for a lease", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const stale = `${"c".repeat(40)}.staging-deadbeef`;
    fs.mkdirSync(path.join(generationsDir(), stale), { recursive: true });

    const held = lease();
    await commitFiles({ "new.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });

    expect(fs.existsSync(path.join(generationsDir(), stale))).toBe(false);
    expect(held.asked).not.toContain(stale);
  });

  it("re-publishes a commit whose previous copy is in use WITHOUT touching that copy", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(first);
    fs.writeFileSync(path.join(workDir(first), "upper", "installed.txt"), "from the running version");

    const held = lease([first]);
    await commitFiles({ "new.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });

    const installed: string[] = [];
    const outcome = await activateGeneration(repo({ pin: first }), {
      ...deps(),
      runInstall: async (job) => {
        installed.push(job.generationId);
        return { ok: true };
      },
      beginGenerationDeletion: held.begin,
    });

    expect(outcome.status).toBe("activated");
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    expect(live.commit).toBe(first);
    expect(live.id).toMatch(new RegExp(`^${first}\\.[0-9a-f]{8}$`));
    expect(installed).toEqual([live.id]);
    expect(fs.existsSync(path.join(workDir(first), "upper", "installed.txt"))).toBe(true);
    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(true);
    expect(fs.readdirSync(generationsDir()).filter((n) => n.includes(".staging-"))).toEqual([]);
  });

  it("re-stages and re-installs the commit already live when forced", async () => {
    const installed: string[] = [];
    const runInstall = async (job: { commit: string }): Promise<{ ok: true }> => {
      installed.push(job.commit);
      return { ok: true };
    };
    await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    expect(installed).toEqual([live]);

    const plain = await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    expect(plain.status).toBe("unchanged");
    expect(installed).toEqual([live]);

    const forced = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]), runInstall, force: true,
    });
    expect(forced.status).toBe("activated");
    expect(installed).toEqual([live, live]);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(live);
  });

  it("forces a re-install beside a version a consumer holds, clearing nothing", async () => {
    const held = lease();
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(live);
    fs.writeFileSync(path.join(workDir(live), "upper", "installed.txt"), "from the running version");

    const inUse = lease([live]);
    const installed: string[] = [];
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(),
      beginGenerationDeletion: inUse.begin,
      runInstall: async (job) => {
        installed.push(job.generationId);
        return { ok: true };
      },
      force: true,
    });

    expect(outcome.status).toBe("activated");
    const rebuilt = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    expect(rebuilt.commit).toBe(live);
    expect(rebuilt.id).not.toBe(live);
    expect(installed).toEqual([rebuilt.id]);
    expect(fs.existsSync(path.join(workDir(live), "upper", "installed.txt"))).toBe(true);
    expect(fs.readdirSync(generationsDir()).filter((n) => n.includes(".staging-"))).toEqual([]);
  });

  it("leaves the version live when a forced re-install fails", async () => {
    await activateGeneration(repo({ branch: "main" }), deps(["probe"]));
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: async () => ({ ok: false, reason: "install for `probe` exited 1" }),
      force: true,
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.reason).toContain("exited 1");
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(live);
    expect(fs.readdirSync(generationsDir()).filter((n) => n.includes(".staging-"))).toEqual([]);
  });

  it("releases the lease on the ordinary path, so a later prune is never wedged", async () => {
    const clean = lease();
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: clean.begin });
    await commitFiles({ "new.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: clean.begin });

    expect(clean.claimed.size).toBe(0);
  });

  it("retires a re-pointed declaration's link but not a tree somebody is running", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(first);

    const held = lease([first]);
    const rePointed = repo({ branch: "main", source: { kind: "github", owner: "acme", repo: "other" } });
    const outcome = await activateGeneration(rePointed, {
      ...deps(),
      repoUrl: "https://github.com/acme/other.git",
      ensureCache: async () => {
        throw new Error("no access");
      },
      beginGenerationDeletion: held.begin,
    });

    expect(outcome.status).toBe("failed");
    expect(fs.existsSync(activeLinkPath(stateDir, "tools"))).toBe(false);
    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(true);
    expect(fs.existsSync(path.join(workDir(first), "upper"))).toBe(true);
  });
});

describe("rebuilding a live generation (docs/273-plugin-generation-rebuild)", () => {
  function installingManifest(names: string[] = ["probe"]): string {
    const entries = names
      .map((n) => `    ${n}:\n      install: npm ci\n      cli:\n        ${n}: bin/${n}.mjs\n`)
      .join("");
    return `exports:\n  plugins:\n${entries}`;
  }

  function lease(held: string[] = []) {
    const refuse = new Set(held);
    const asked: string[] = [];
    const begin: BeginGenerationDeletion = async ({ generationId }) => {
      asked.push(generationId);
      return refuse.has(generationId) ? null : () => undefined;
    };
    return { begin, asked, refuse };
  }

  const generationsDir = (): string => path.join(stateDir, "plugins", "tools", "generations");

  function recordingInstall(installs: string[], ok = true) {
    return async (job: { generationId: string; exports: readonly { name: string }[] }) => {
      installs.push(`${job.generationId}:${job.exports.map((e) => e.name).join(",")}`);
      return ok ? { ok: true } : { ok: false, reason: "npm ci exited 1" };
    };
  }

  beforeEach(async () => {
    await commitFiles({ "shipit.yaml": installingManifest() }, "installing manifest");
  });

  it("installs an export the live generation was never installed for", async () => {
    const installs: string[] = [];
    const runInstall = recordingInstall(installs);

    const first = await activateGeneration(repo({ branch: "main" }), { ...deps([]), runInstall });
    expect(first.status).toBe("activated");
    expect(installs).toEqual([`${readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.id}:`]);

    const second = await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });

    expect(second.status).toBe("activated");
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    expect(installs[1]).toBe(`${live.id}:probe`);
    expect(live.installedFor).toEqual(["probe"]);
  });

  it("still does nothing when the live generation already covers the selection", async () => {
    const installs: string[] = [];
    const runInstall = recordingInstall(installs);

    await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    const again = await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });

    expect(again.status).toBe("unchanged");
    expect(installs).toHaveLength(1);
  });

  it("leaves a generation that predates `installedFor` alone", async () => {
    const installs: string[] = [];
    await activateGeneration(repo({ branch: "main" }), { ...deps([]), runInstall: recordingInstall(installs) });

    const live = fs.realpathSync(activeLinkPath(stateDir, "tools"));
    const file = path.join(live, ".shipit-generation.json");
    const legacy = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    delete legacy.installedFor;
    fs.writeFileSync(file, JSON.stringify(legacy));

    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: recordingInstall(installs),
    });

    expect(outcome.status).toBe("unchanged");
    expect(installs).toHaveLength(1);
  });

  it("does not rebuild in a runtime that cannot install, which would never converge", async () => {
    await activateGeneration(repo({ branch: "main" }), deps([]));
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));

    expect(outcome.status).toBe("unchanged");
  });

  it("builds beside a version a consumer is holding instead of refusing", async () => {
    const installs: string[] = [];
    const runInstall = recordingInstall(installs);
    await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    const commit = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    const held = lease([commit]);
    const forced = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall,
      beginGenerationDeletion: held.begin,
      force: true,
    });

    expect(forced.status).toBe("activated");
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    expect(live.commit).toBe(commit);
    expect(live.id).toMatch(new RegExp(`^${commit}\\.[0-9a-f]{8}$`));
    expect(installs[1]).toBe(`${live.id}:probe`);
    expect(fs.existsSync(path.join(generationsDir(), commit))).toBe(true);
    expect(fs.realpathSync(activeLinkPath(stateDir, "tools"))).toBe(path.join(generationsDir(), live.id!));
  });

  it("forks the id for a live version even when the lease would allow reuse", async () => {
    const installs: string[] = [];
    const runInstall = recordingInstall(installs);
    const free = lease();
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]), runInstall, beginGenerationDeletion: free.begin,
    });
    const before = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    const askedWhileBuildingIt = [...free.asked];

    let askedBeforeInstall: string[] = [];
    const forced = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: async (job) => {
        askedBeforeInstall = free.asked.slice(askedWhileBuildingIt.length);
        return recordingInstall(installs)(job);
      },
      beginGenerationDeletion: free.begin,
      force: true,
    });

    expect(forced.status).toBe("activated");
    const after = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    expect(after.commit).toBe(before.commit);
    expect(after.id).not.toBe(before.id);
    expect(askedBeforeInstall).toEqual([]);
    expect(installs[1]).toBe(`${after.id}:probe`);
  });

  it("changes nothing when the rebuild's own install fails", async () => {
    const installs: string[] = [];
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: recordingInstall(installs),
    });
    const before = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;

    const held = lease([before.commit]);
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall: recordingInstall(installs, false),
      beginGenerationDeletion: held.begin,
      force: true,
    });

    expect(outcome.status).toBe("failed");
    const after = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    expect(after.id).toBe(before.id);
    expect(after.installedFor).toEqual(["probe"]);
    expect(fs.readdirSync(generationsDir())).toEqual([before.id]);
  });

  it("prunes a superseded rebuild under the lease, never unconditionally", async () => {
    const installs: string[] = [];
    const runInstall = recordingInstall(installs);
    await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    const commit = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    const held = lease([commit]);
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]), runInstall, beginGenerationDeletion: held.begin, force: true,
    });
    const rebuilt = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.id!;

    held.refuse.add(rebuilt);
    await commitFiles({ "third.txt": "x" }, "third");
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]), runInstall, beginGenerationDeletion: held.begin,
    });

    expect(held.asked).toContain(rebuilt);
    expect(fs.existsSync(path.join(generationsDir(), rebuilt))).toBe(true);
  });
});
