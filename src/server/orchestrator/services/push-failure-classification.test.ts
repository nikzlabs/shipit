import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../../shared/git.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import {
  classifyPushFailure,
  isNonFastForwardError,
  isRewriteWindowPushFailure,
} from "./git.js";

/**
 * Regression for the 2026-08-18 incident (session b77e02fe,
 * `nicolasalt/reward-tag`): a push rejected with `GH008: unknown Git LFS
 * object` was reported to the user as *"branch has diverged from remote. Rebase
 * needed to update."* — advice that could not possibly fix it. There was no
 * divergence: `git ls-remote` showed the remote tip still at ShipIt's own last
 * successful push, and `git merge-base --is-ancestor <remote> HEAD` exited 0.
 *
 * The defect was one substring. `isNonFastForwardError` matched
 * `failed to push some refs`, which git prints as the SUMMARY of essentially
 * every push failure, so every failure read as a divergence.
 *
 * These pin the property that closes it: a class is assigned on a marker that
 * names the failure, never on the summary line.
 */
describe("classifyPushFailure", () => {
  /** Verbatim shape of the GH008 rejection, from the incident. */
  const GH008 = [
    "remote: error: GH008: Your push referenced at least 8 unknown Git LFS objects:",
    "remote: error:     3b1f0c…",
    "To https://github.com/nicolasalt/reward-tag.git",
    " ! [remote rejected] shipit/assetgen -> shipit/assetgen (pre-receive hook declined)",
    "error: failed to push some refs to 'https://github.com/nicolasalt/reward-tag.git'",
  ].join("\n");

  /** Verbatim shape of a real non-fast-forward rejection. */
  const NON_FAST_FORWARD = [
    "To https://github.com/o/r.git",
    " ! [rejected]        feature -> feature (fetch first)",
    "error: failed to push some refs to 'https://github.com/o/r.git'",
    "hint: Updates were rejected because the remote contains work that you do not have locally.",
  ].join("\n");

  it("does not call a GH008 LFS rejection a divergence", () => {
    // The incident, exactly: this used to be `true`, and the user was told to
    // rebase a branch that was a strict fast-forward of the remote.
    expect(isNonFastForwardError(new Error(GH008))).toBe(false);
    expect(classifyPushFailure(new Error(GH008))).toBe("lfs");
  });

  it("does not classify git's bare summary line at all", () => {
    // `error: failed to push some refs` accompanies every failure above and
    // names none of them. On its own it must stay uninterpreted.
    const err = new Error("error: failed to push some refs to 'https://github.com/o/r.git'");
    expect(classifyPushFailure(err)).toBe("unknown");
    expect(isNonFastForwardError(err)).toBe(false);
  });

  it("still recognises a real non-fast-forward rejection", () => {
    expect(classifyPushFailure(new Error(NON_FAST_FORWARD))).toBe("non-fast-forward");
    expect(isNonFastForwardError(new Error(NON_FAST_FORWARD))).toBe(true);
  });

  it("recognises the stale-lease rejection a force-push-with-lease produces", () => {
    const err = new Error(" ! [rejected]        feature -> feature (stale info)");
    expect(classifyPushFailure(err)).toBe("non-fast-forward");
  });

  it("classifies the mid-rebase detached-HEAD refusal as an invalid refspec", () => {
    // The 2026-08-17 incident (session 590c19aa): mid-rebase `getCurrentBranch()`
    // returns the literal "HEAD", so the push is refused before it reaches the
    // remote — and used to be reported as a divergence too.
    const err = new Error(
      "error: The destination you provided is not a full refname (i.e.,\n"
      + "starting with \"refs/\"). We tried to guess what you meant by:\n"
      + "error: failed to push some refs to 'https://github.com/o/r.git'",
    );
    expect(classifyPushFailure(err)).toBe("invalid-refspec");
    expect(isNonFastForwardError(err)).toBe(false);
  });

  it("separates a credential failure from a divergence", () => {
    for (const msg of [
      "fatal: Authentication failed for 'https://github.com/o/r.git/'",
      "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      "fatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403",
      "remote: Permission to o/r.git denied to someone.",
    ]) {
      expect(classifyPushFailure(new Error(msg)), msg).toBe("auth");
      expect(isNonFastForwardError(new Error(msg)), msg).toBe(false);
    }
  });

  it("does not read git's own progress counters as an HTTP status", () => {
    // A large push prints delta/object counts on its way to an ordinary
    // rejection, and `(403/403)` has word boundaries on both sides of the 403.
    // A bare `\b40[13]\b` in the auth pattern turned that into a credential
    // failure — and auth is checked BEFORE non-fast-forward, so the divergence
    // never got a look in.
    const err = new Error(
      "remote: Resolving deltas: 100% (403/403), done.\n"
      + "remote: Counting objects: 401, done.\n"
      + " ! [rejected]        feature -> feature (fetch first)\n"
      + "error: failed to push some refs",
    );
    expect(classifyPushFailure(err)).toBe("non-fast-forward");
  });

  it("separates a server-side hook rejection from a divergence", () => {
    const err = new Error(
      " ! [remote rejected] main -> main (protected branch hook declined)\n"
      + "error: failed to push some refs",
    );
    expect(classifyPushFailure(err)).toBe("remote-rejected");
    expect(isNonFastForwardError(err)).toBe(false);
  });

  it("separates a network failure from a divergence", () => {
    for (const msg of [
      "fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      "fatal: the remote end hung up unexpectedly\nsend-pack: unexpected disconnect",
      "error: RPC failed; curl 92 HTTP/2 stream 5 was not closed cleanly",
    ]) {
      expect(classifyPushFailure(new Error(msg)), msg).toBe("network");
    }
  });

  it("accepts a non-Error rejection without throwing", () => {
    expect(classifyPushFailure("nothing git ever says")).toBe("unknown");
    expect(classifyPushFailure(undefined)).toBe("unknown");
  });
});

/**
 * The deferral budget exists for pushes that failed *because ShipIt was
 * mid-rewrite*. Widening it to every failure would delay a real credential or
 * LFS failure by the whole retry budget (~15 minutes) — which is the same
 * "swallowed in the logs" shape both incidents are about.
 */
describe("isRewriteWindowPushFailure", () => {
  it("covers exactly the two shapes an in-flight rewrite produces", () => {
    expect(isRewriteWindowPushFailure(new Error(" ! [rejected] f -> f (fetch first)"))).toBe(true);
    expect(isRewriteWindowPushFailure(new Error("not a full refname"))).toBe(true);
  });

  it("does not defer a failure the rewrite cannot explain", () => {
    expect(isRewriteWindowPushFailure(new Error("GH008: unknown Git LFS objects"))).toBe(false);
    expect(isRewriteWindowPushFailure(new Error("fatal: Authentication failed"))).toBe(false);
    expect(isRewriteWindowPushFailure(new Error("Could not resolve host: github.com"))).toBe(false);
  });
});

/**
 * The samples above are written down from git's documented output, which is a
 * claim, not a contract — and the shape that actually reaches this code is
 * simple-git's, not a terminal's. Real git prints
 * `! [rejected]        main -> main (fetch first)`; the porcelain output
 * simple-git receives prints
 * `!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)` instead. A
 * pattern anchored on the first form silently stops matching the second.
 *
 * So one case drives a genuine divergence through a real `GitManager.push` and
 * classifies whatever it actually throws.
 */
describe("classifyPushFailure against a real diverged push", () => {
  let root: string;
  let bareDir: string;
  let aheadDir: string;
  let behindDir: string;
  let origGitConfigGlobal: string | undefined;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-nff-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");

    bareDir = path.join(root, "bare.git");
    aheadDir = path.join(root, "ahead");
    behindDir = path.join(root, "behind");
    for (const d of [bareDir, aheadDir, behindDir]) fs.mkdirSync(d);

    run("git init --bare -b main", bareDir);
    run(`git clone ${bareDir} .`, aheadDir);
    fs.writeFileSync(path.join(aheadDir, "f"), "1\n");
    run("git add -A && git commit -m one", aheadDir);
    run("git push origin main", aheadDir);

    // The second clone snapshots the remote, then the first advances it — so
    // the second's own commit is a true non-fast-forward.
    run(`git clone ${bareDir} .`, behindDir);
    fs.writeFileSync(path.join(aheadDir, "f"), "2\n");
    run("git commit -am two", aheadDir);
    run("git push origin main", aheadDir);
    fs.writeFileSync(path.join(behindDir, "g"), "3\n");
    run("git add -A && git commit -m three", behindDir);
  });

  afterEach(() => {
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("classifies what GitManager.push actually throws", async () => {
    let thrown: unknown;
    try {
      await new GitManager(behindDir).push("origin", "main");
    } catch (err) {
      thrown = err;
    }
    expect(thrown, "the push should have been rejected").toBeDefined();
    // The message has to carry git's stderr at all — the whole classification
    // rests on that, and it is not something simple-git promises in its types.
    expect((thrown as Error).message).toContain("rejected");
    expect(classifyPushFailure(thrown)).toBe("non-fast-forward");
    expect(isNonFastForwardError(thrown)).toBe(true);
  });
});
