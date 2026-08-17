/**
 * docs/262 — generation staging and activation.
 *
 * Every test drives real git: a bare cache is built in a temp dir, so the
 * clone/checkout/pin paths are exercised rather than mocked. Only the fetch is
 * injected (`ensureCache`), because there is no network here.
 */

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

/**
 * docs/266-orchestrator-git-trust-boundary E2 / planning#410 — the ownership handback `checkoutCommit` performs
 * between the root clone and the dropped git that follows it.
 *
 * Spied rather than exercised because the state it protects cannot be produced
 * here: the real helper is inert unless the process is root AND the session
 * identity roots are configured, which is neither this suite nor the dogfood
 * instance — which is exactly why the missing call survived review. The spy
 * records what the tree looked like at the moment it was called, so the test
 * pins the POSITION and not merely the presence.
 */
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

describe("staged checkout ownership (docs/266-orchestrator-git-trust-boundary E2, planning#410)", () => {
  /**
   * The clone runs as root (a bare `safeSimpleGit()` has no tree to stat), and
   * every git call after it resolves the staging dir — which lives under
   * `<sessionDir>/state/` — to the SESSION's uid and drops to it. So the tree
   * has to change hands in between, or the dropped git meets a `root:root`
   * repository: `.git/config.lock` EACCESes today, and once
   * `SHIPIT_GIT_STRICT_OWNERSHIP` is armed git refuses the repository outright
   * with `detected dubious ownership`.
   *
   * Asserting the position and not just the call is the point. The handback is
   * useless after `checkout --detach`, and a later reader moving it there would
   * leave a green suite.
   */
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
    // After the clone: `.git` exists.
    expect(treeWhenCalled[0].hasGitDir).toBe(true);
    // Before `checkout --detach`: the `--no-checkout` clone has no worktree yet.
    expect(treeWhenCalled[0].worktreeEntries).toEqual([]);
    // The staging tree, never the shared bare cache — chowning that would hand
    // one session ownership of every other generation's objects.
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

    // req 13 says report WHY, and this reason goes straight onto the Plugins
    // card and into the `shipit plugin refresh` row. Relaying `git rev-parse`
    // put three lines of argument-syntax advice there instead — measured in the
    // dogfood — which reads as a ShipIt malfunction, not a missing branch.
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toBe("`nope` is not a branch, tag or commit in `acme/tools`.");
  });

  // The other half of the same rule: an error that is NOT "no such revision"
  // keeps git's own text AND must not be diagnosed as a missing ref — a broken
  // object store reported as a bad branch sends the reader to fix a declaration
  // that is correct (review finding).
  it("does not diagnose an unexpected git failure as a missing ref", async () => {
    const outcome = await activateGeneration(repo({ branch: "main" }), {
      ...deps(),
      // A bare-cache path that exists and is not a repository: `rev-parse`
      // fails for a reason that is not a missing ref.
      bareCacheDir: stateDir,
    });
    expect(outcome.status).toBe("failed");
    const reason = (outcome as { reason: string }).reason;
    expect(reason).toContain("could not resolve `main` in `acme/tools`");
    expect(reason).not.toContain("is not a branch, tag or commit");
    // git's own diagnostic survives, which is the whole point of not tidying.
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
 * docs/262 plan §1a phase 3 — the pre-publish gate. Phase-3 validation used to
 * run when services were RESOLVED, which is after this module has published and
 * pruned: a commit whose declared surfaces could not be used still became live,
 * taking the files, the CLIs and the skills with it while its services stayed
 * behind. These prove the gate is a *publish* decision, not a report.
 *
 * The gate's own verdicts are `services/plugin-preflight.test.ts`; here it is a
 * stub, because what this module owes is the ordering and the failure shape.
 */
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
    // The collector's own message reaches the card, not a generic one (req 13).
    expect((outcome as { reason: string }).reason).toContain("declares `build:`");
    expect((outcome as { previous?: { commit: string } }).previous?.commit).toBe(before?.commit);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(before?.commit);
    // The rejected commit was never renamed into a generation directory anything
    // can name, and its staging tree is cleaned up (best-effort, so this asserts
    // the path where the `rm` succeeds — a residue is inert and swept by the
    // next publish's prune either way).
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
        // The candidate is not live at the moment it is judged — that is the point.
        expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
        // And its files are readable, so the gate can parse a fragment out of them.
        expect(fs.existsSync(path.join(staged.stagingDir, "shipit.yaml"))).toBe(true);
        return { ok: true };
      },
    });

    expect(seen!.repoName).toBe("tools");
    expect(seen!.stagingDir).toContain(".staging-");
    // The source travels with the candidate: a name is not identity, and the
    // gate re-reads a declaration that may have been re-pointed meanwhile.
    expect(seen!.source).toBe(TOOLS_SOURCE);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(seen!.commit);
  });

  /**
   * The gate answers a question about the whole SESSION's name domain, so its
   * verdict is worth only as much as its adjacency to the swap. Activation is
   * serialized per repository and repositories run concurrently
   * (`plugin-activation.ts` maps them through `Promise.all`), so without a
   * session-wide publish window two first-time candidates exporting one service
   * name would each be judged against a world in which the other had not
   * published — both pass, both publish, and the loser ends up live for files,
   * CLIs and skills but not services. That is the very partial version this gate
   * exists to prevent, reached by a different route.
   *
   * The invariant asserted is the one the window guarantees and nothing else
   * does: **whichever candidate entered the window first has already swapped its
   * `active` link by the time the next one is judged.** It holds always under the
   * lock and essentially never without it, so the test cannot fail flakily in the
   * passing direction.
   */
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

  // Nothing is being published, so there is nothing to gate: the version that is
  // already live keeps running whatever the gate would say about it, and its
  // services report themselves through the service round as they do today.
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
    // Reads as written in the one-plugin case, which is the only one the
    // dogfood ever showed and the one it showed WRONG ("`probe` declare an
    // install command … the plugin is active"). A card is the whole report a
    // user gets about a partial version (req 13).
    //
    // It lives in the generation record and NOWHERE ELSE. It was also returned
    // as the attempt `warning`, and `buildRepoView` unshifts both channels into
    // one `issues` list — so the dogfood card showed the same sentence twice.
    // The record is the durable of the two: a session that reopens without
    // activating anything has no attempt at all, and must still be told.
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

  /**
   * A record written before `source` existed carries none — and that generation
   * is this repository's own, built by a ShipIt that did not record where it
   * came from. Treating "unknown provenance" as "foreign" would retire it, and
   * the retirement runs BEFORE the fetch while `previous` is read after: so the
   * first activation round after this ships would drop every plugin in every
   * live session, and any one of those fetches that then failed — a private
   * plugin repository the host's App is not installed on — would report
   * `failed` with no previous generation at all. Degrading is req 15; going
   * dark is not.
   */
  it("keeps a legacy generation ON DISK when the fetch for its own repository fails", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;

    // Rewrite the live record as a pre-source one, in place.
    const recordPath = path.join(stateDir, "plugins", "tools", "active", ".shipit-generation.json");
    const { source: _dropped, ...legacy } = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    fs.writeFileSync(recordPath, JSON.stringify(legacy));

    const outcome = await activateGeneration(repo({ pin: "v-does-not-exist" }), deps());

    expect(outcome.status).toBe("failed");
    // Kept on disk — NOT the same as served. Every reader here still refuses a
    // record whose source it cannot match, so the card says "no active
    // version"; what survives is the tree the next successful publish replaces,
    // and the container's link to it. Asserting the weaker thing on purpose.
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "active"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "generations", live.commit))).toBe(true);
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).toBeNull();
  });
});

/**
 * docs/262 req 27 — the retirement no activation performs for itself. A
 * `repo: self` declaration stages nothing, so `activateOnce`'s pre-fetch
 * retirement never runs for it and whatever an earlier tracked declaration
 * published under that name would stay live for the session's life.
 */
describe("retiring what is left under a `repo: self` name (req 27)", () => {
  const stillSelf = () => true;

  it("retires the previous repository's generation, link and trees", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;

    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, stillSelf);

    expect(fs.existsSync(activeLinkPath(stateDir, "tools"))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "plugins", "tools", "generations", live.commit))).toBe(false);
  });

  /**
   * The opposite answer from the tracked path, and deliberately so. There,
   * "unknown provenance" might be this repository's own generation, so it is
   * kept. Under a self declaration it cannot be: `activateGeneration` refuses to
   * publish for one at all, so nothing ShipIt wrote can be here — and keeping it
   * only leaves another repository's files readable through the store mount.
   */
  it("retires a legacy record with no recorded source, unlike the tracked path", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const recordPath = path.join(activeLinkPath(stateDir, "tools"), ".shipit-generation.json");
    const { source: _dropped, ...legacy } = JSON.parse(fs.readFileSync(recordPath, "utf-8"));
    fs.writeFileSync(recordPath, JSON.stringify(legacy));

    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, stillSelf);

    expect(fs.existsSync(activeLinkPath(stateDir, "tools"))).toBe(false);
  });

  /**
   * Rounds overlap and a new round does not cancel the one before it, so a round
   * that read the declaration while it said `self` can reach this point long
   * after the name was re-pointed at a real repository — and the queue only
   * decides WHEN it runs, not whether it still should. The declaration at the
   * moment the work runs is the only version worth acting on.
   */
  it("does nothing when the name is no longer self by the time it runs", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, () => false);

    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)).not.toBeNull();
  });

  // It takes the per-repository queue, the same key activation serializes on,
  // so it can never interleave with a publish for the same name.
  it("runs on the per-repository queue and releases it", async () => {
    await retireSelfDeclaredGeneration(stateDir, "tools", undefined, stillSelf);
    expect(activationQueueSize()).toBe(0);
  });
});

/**
 * docs/262 resolve-once — one answer per repository for one operation, so every
 * reader on a request describes the same generation.
 */
describe("resolveLiveGenerations", () => {
  it("resolves each repository's `active` exactly ONCE, however many readers ask", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const spy = vi.spyOn(fs, "realpathSync");
    const live = resolveLiveGenerations(stateDir, [repo({ branch: "main" })]);
    // Nothing yet: the answer is owed on the first ask, not on construction.
    expect(spy.mock.calls.length).toBe(0);

    // Five readers, as one snapshot request has: the commit, two manifests, a
    // fragment and a credential list.
    for (let i = 0; i < 5; i++) live(repo({ branch: "main" }));
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });

  it("never touches a declared repository nobody asks about", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const other = repo({ name: "other-tools", branch: "main" });

    const spy = vi.spyOn(fs, "realpathSync");
    // Both declared, one asked for. The unasked one costs nothing: an
    // operation that pins its own target separately (`plugin-cli-run.ts`) must
    // not follow that target's `active` a second time just by building this.
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
    // The concrete generation directory, not the symlink — a later swap cannot
    // move what this operation already read.
    expect(verified.dir).toContain(path.join("generations", verified.record.commit));
    expect(fs.lstatSync(verified.dir).isSymbolicLink()).toBe(false);
  });

  it("answers null for a `repo: self` declaration and for a foreign generation", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());

    const selfRepo: DeclaredPluginRepo = { name: "dev", source: { kind: "self" } };
    expect(resolveLiveGenerations(stateDir, [selfRepo])(selfRepo)).toBeNull();

    // Same declared name, re-pointed at another repository: what is live is
    // someone else's, and every reader must see nothing rather than that.
    const rePointed = repo({ branch: "main", source: { kind: "github", owner: "acme", repo: "other" } });
    expect(resolveLiveGenerations(stateDir, [rePointed])(rePointed)).toBeNull();
  });

  it("answers null for a repository it was not asked to resolve", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const undeclared = repo({ name: "other-tools", branch: "main" });
    expect(resolveLiveGenerations(stateDir, [])(undeclared)).toBeNull();
  });
});

/**
 * docs/262 req 15 — the consumer lease (`plugin-leases.ts`).
 *
 * The lease itself is exercised in its own file; what matters here is that the
 * PRUNE asks for it, honours a refusal, and never leaves half a generation
 * behind — a checkout without its writable layer is as broken a lowerdir as no
 * checkout at all. The hook is stubbed rather than driven through Docker,
 * because this file is deliberately offline and the fact under test is the
 * ordering, not the daemon's answer.
 */
describe("consumer lease over a superseded generation (req 15)", () => {
  /** A stub lease that refuses the generation ids in `held`. */
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

  /** Give a generation the writable layer an installed plugin would have. */
  function seedWorkLayer(commit: string): void {
    fs.mkdirSync(path.join(workDir(commit), "upper"), { recursive: true });
  }

  it("leaves a held generation — checkout AND writable layer — exactly where it is", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(first);

    // A companion CLI or a plugin service is running against `first` when the
    // refresh lands. Deleting it would pull the lowerdir out from under a live
    // overlay mount, which is silent corruption rather than an error.
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
    // A refused prune is not a failed activation: the new version is live and
    // the old tree is simply still there.
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

    // The consumer is done, so the round after it takes the tree away.
    held.refuse.delete(first);
    await commitFiles({ "third.txt": "x" }, "third");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });

    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(false);
    expect(fs.existsSync(workDir(first))).toBe(false);
    // Every lease it took was released, so a later prune is never wedged.
    expect(held.claimed.size).toBe(0);
  });

  it("removes an abandoned staging tree without asking for a lease", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const stale = `${"c".repeat(40)}.staging-deadbeef`;
    fs.mkdirSync(path.join(generationsDir(), stale), { recursive: true });

    const held = lease();
    await commitFiles({ "new.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });

    // Publish RENAMES a staging tree, it never mounts one, so no consumer can
    // ever have held it — and it carries no commit identity to lease against.
    expect(fs.existsSync(path.join(generationsDir(), stale))).toBe(false);
    expect(held.asked).not.toContain(stale);
  });

  /**
   * docs/273-plugin-generation-rebuild — this used to be "refuses to re-publish
   * a commit whose previous copy is still in use". It no longer refuses: the
   * build takes its own id. What must still hold is everything the refusal was
   * protecting — the held checkout and, above all, the writable layer `install`
   * CLEARS before it writes.
   */
  it("re-publishes a commit whose previous copy is in use WITHOUT touching that copy", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(first);
    fs.writeFileSync(path.join(workDir(first), "upper", "installed.txt"), "from the running version");

    const held = lease([first]);
    await commitFiles({ "new.txt": "x" }, "second");
    await activateGeneration(repo({ branch: "main" }), { ...deps(), beginGenerationDeletion: held.begin });

    // The project pins back to the version it was running (req 8's exact case),
    // whose checkout is still there and still mounted.
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
    // The install ran against the NEW build, so the running copy's layer is
    // exactly as its consumer left it.
    expect(installed).toEqual([live.id]);
    expect(fs.existsSync(path.join(workDir(first), "upper", "installed.txt"))).toBe(true);
    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(true);
    // …and nothing was left staged.
    expect(fs.readdirSync(generationsDir()).filter((n) => n.includes(".staging-"))).toEqual([]);
  });

  /**
   * docs/266-plugin-install-diagnosability reqs 5, 6 — the forced retry of a version that is already live.
   *
   * The short-circuit it skips was load-bearing: the comment on the deletion
   * claim used to say a live commit "never reaches this line". These tests are
   * the replacement guarantee — the claim itself, exercised on the one path
   * that now depends on it.
   *
   * **What they cannot fail on** (review finding). `lease()` is a Set-based
   * fake: the refusal test proves `activateOnce` aborts cleanly and touches
   * nothing when the hook says no, NOT that the real
   * `createGenerationDeletionLease` says no while a plugin container holds the
   * volume. That half lives in `plugin-leases.test.ts`, and nothing ties the
   * two together — a regression that stopped removing the overlay volume in the
   * real lease, or stopped passing the lease down the force path, would pass
   * here. They also cannot see the publish window itself: the rm-then-rename
   * ordering that a forced round made dangerous is asserted only by the
   * "leaves the version live when a forced re-install fails" case, which
   * exercises the failure BEFORE publish.
   */
  it("re-stages and re-installs the commit already live when forced", async () => {
    const installed: string[] = [];
    const runInstall = async (job: { commit: string }): Promise<{ ok: true }> => {
      installed.push(job.commit);
      return { ok: true };
    };
    await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    expect(installed).toEqual([live]);

    // Without force this is the terminal `unchanged` that left a consumer with
    // no recovery but the plugin author publishing a new commit.
    const plain = await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    expect(plain.status).toBe("unchanged");
    expect(installed).toEqual([live]);

    const forced = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]), runInstall, force: true,
    });
    expect(forced.status).toBe("activated");
    expect(installed).toEqual([live, live]);
    // A retry, not an upgrade: the same version is live afterwards.
    expect(readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)?.commit).toBe(live);
  });

  /**
   * docs/273-plugin-generation-rebuild / nikzlabs/shipit#2411 — this used to
   * assert the refusal, and the refusal was the deadlock: what holds the live
   * version is the plugin's own service, which is failing BECAUSE the install
   * is broken, so the documented recovery could never run. The safety it was
   * buying is bought instead by building elsewhere, which this now asserts.
   */
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
    // The layer the running container has mounted was never cleared — the
    // corruption docs/183 recorded is what the forked id avoids.
    expect(installed).toEqual([rebuilt.id]);
    expect(fs.existsSync(path.join(workDir(live), "upper", "installed.txt"))).toBe(true);
    expect(fs.readdirSync(generationsDir()).filter((n) => n.includes(".staging-"))).toEqual([]);
  });

  it("leaves the version live when a forced re-install fails", async () => {
    // Half of the cost force carries, asserted rather than assumed: the version
    // KEEPS SERVING and no staging tree is left behind. The other half — that
    // the writable layer was already cleared before the install wrote — belongs
    // to `prepareLayer` in the install runner and is not observable from here,
    // so this test cannot fail on it. It is what the docs tell a consumer to
    // weigh before forcing.
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

    // The publish takes a claim over the commit it is about to write and the
    // prune takes one per superseded generation; every one of them is released
    // in a `finally`, because a claim nobody drops blocks that generation for
    // the life of the process.
    expect(clean.claimed.size).toBe(0);
  });

  it("retires a re-pointed declaration's link but not a tree somebody is running", async () => {
    await activateGeneration(repo({ branch: "main" }), deps());
    const first = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;
    seedWorkLayer(first);

    // The same declared name now points at a repository that cannot be fetched.
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
    // The link is what the container follows, so retiring it is the half that
    // has to happen whatever a consumer is doing.
    expect(fs.existsSync(activeLinkPath(stateDir, "tools"))).toBe(false);
    // The tree behind it is addressable by nothing now, and stays until its
    // consumer is done rather than vanishing mid-run.
    expect(fs.existsSync(path.join(generationsDir(), first))).toBe(true);
    expect(fs.existsSync(path.join(workDir(first), "upper"))).toBe(true);
  });
});

/**
 * docs/273-plugin-generation-rebuild — a version that is LIVE can be built
 * again.
 *
 * Two defects met here (nikzlabs/shipit#2411): a generation published for a
 * selection that installed nothing could never be repaired, because every later
 * round saw the declared commit already live and returned `unchanged`; and the
 * one escape hatch that did re-stage a live version had to clear the live tree,
 * so the consumer lease refused it — permanently, since what held the version
 * was the plugin's own service.
 */
describe("rebuilding a live generation (docs/273-plugin-generation-rebuild)", () => {
  /** A manifest whose exports each declare an install command. */
  function installingManifest(names: string[] = ["probe"]): string {
    const entries = names
      .map((n) => `    ${n}:\n      install: npm ci\n      cli:\n        ${n}: bin/${n}.mjs\n`)
      .join("");
    return `exports:\n  plugins:\n${entries}`;
  }

  /** A stub lease that refuses every id in `held`, and records what it was asked. */
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

  /** Every install this round ran, as `<generationId>:<export names>`. */
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

    // The round that publishes resolves NO selection — which is what a `use:`
    // entry whose `from:` does not resolve yet produces, and what a repository
    // swapped mid-session walks through.
    const first = await activateGeneration(repo({ branch: "main" }), { ...deps([]), runInstall });
    expect(first.status).toBe("activated");
    // The hook is called, with nothing selected — so no install command runs
    // and the published generation is genuinely uninstalled.
    expect(installs).toEqual([`${readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.id}:`]);

    // The declaration now selects `probe` from the same, already-live commit.
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

    // A record written before the field existed cannot say what it installed,
    // and "cannot say" must not mean "rebuild every live plugin on upgrade".
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
    expect(installs).toHaveLength(1); // only the round that published it
  });

  it("does not rebuild in a runtime that cannot install, which would never converge", async () => {
    await activateGeneration(repo({ branch: "main" }), deps([]));
    const outcome = await activateGeneration(repo({ branch: "main" }), deps(["probe"]));

    // With no runner a rebuild would install nothing, record the same empty
    // coverage and rebuild again on the next round, for ever.
    expect(outcome.status).toBe("unchanged");
  });

  it("builds beside a version a consumer is holding instead of refusing", async () => {
    const installs: string[] = [];
    const runInstall = recordingInstall(installs);
    await activateGeneration(repo({ branch: "main" }), { ...deps(["probe"]), runInstall });
    const commit = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!.commit;

    // The plugin's own service is running against the live version — the exact
    // state that made `--force` unreachable, since the service is failing
    // BECAUSE the install is broken.
    const held = lease([commit]);
    const forced = await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]),
      runInstall,
      beginGenerationDeletion: held.begin,
      force: true,
    });

    expect(forced.status).toBe("activated");
    const live = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    // Same commit, a different build of it — published beside the one in use.
    expect(live.commit).toBe(commit);
    expect(live.id).toMatch(new RegExp(`^${commit}\\.[0-9a-f]{8}$`));
    expect(installs[1]).toBe(`${live.id}:probe`);
    // The held tree is untouched: its consumer keeps running until the service
    // round moves it onto the new build's volume.
    expect(fs.existsSync(path.join(generationsDir(), commit))).toBe(true);
    expect(fs.realpathSync(activeLinkPath(stateDir, "tools"))).toBe(path.join(generationsDir(), live.id!));
  });

  it("forks the id for a live version even when the lease would allow reuse", async () => {
    // A granted claim proves nobody has the tree MOUNTED. It does not make
    // clearing a live layer safe: an install that then fails would leave the
    // version live with its previous install output gone — req 4's "leaves the
    // plugin exactly as it found it", and what the reporter watched fail.
    const installs: string[] = [];
    const runInstall = recordingInstall(installs);
    const free = lease(); // refuses nothing
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]), runInstall, beginGenerationDeletion: free.begin,
    });
    const before = readActiveGeneration(stateDir, "tools", TOOLS_SOURCE)!;
    const askedWhileBuildingIt = [...free.asked];

    // Everything the lease was asked BEFORE the install ran — the only window in
    // which its answer could have licensed clearing the live layer.
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
    // The forced round never asked the lease about the live build: reuse is not
    // a question whose answer could make it right. (It is asked about the
    // superseded build later — that is the prune, after the swap.)
    expect(askedBeforeInstall).toEqual([]);
    // …and the install ran against the new build, not over the live layer.
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
    // req 4 — a recovery that cannot complete leaves the plugin as it found it.
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

    // A rebuild's `<sha>.<rev>` name is an identity a container can be mounted
    // on. Matching only a bare object name would have deleted it with no lease
    // taken at all — the corruption the lease exists to prevent.
    held.refuse.add(rebuilt);
    await commitFiles({ "third.txt": "x" }, "third");
    await activateGeneration(repo({ branch: "main" }), {
      ...deps(["probe"]), runInstall, beginGenerationDeletion: held.begin,
    });

    expect(held.asked).toContain(rebuilt);
    expect(fs.existsSync(path.join(generationsDir(), rebuilt))).toBe(true);
  });
});
