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

describe("classifyPushFailure", () => {
  // GH008 sample from the 2026-08-18 incident.
  const GH008 = [
    "remote: error: GH008: Your push referenced at least 8 unknown Git LFS objects:",
    "remote: error:     3b1f0c…",
    "To https://github.com/nicolasalt/reward-tag.git",
    " ! [remote rejected] shipit/assetgen -> shipit/assetgen (pre-receive hook declined)",
    "error: failed to push some refs to 'https://github.com/nicolasalt/reward-tag.git'",
  ].join("\n");

  const NON_FAST_FORWARD = [
    "To https://github.com/o/r.git",
    " ! [rejected]        feature -> feature (fetch first)",
    "error: failed to push some refs to 'https://github.com/o/r.git'",
    "hint: Updates were rejected because the remote contains work that you do not have locally.",
  ].join("\n");

  it("does not call a GH008 LFS rejection a divergence", () => {
    expect(isNonFastForwardError(new Error(GH008))).toBe(false);
    expect(classifyPushFailure(new Error(GH008))).toBe("lfs");
  });

  it("does not classify git's bare summary line at all", () => {
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

// simple-git receives porcelain output, which differs from the terminal samples above.
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
    expect((thrown as Error).message).toContain("rejected");
    expect(classifyPushFailure(thrown)).toBe("non-fast-forward");
    expect(isNonFastForwardError(thrown)).toBe(true);
  });
});
