import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync } from "node:child_process";

/**
 * Drives the REAL host-side self-updater (deployment/vps/update.sh) end to end
 * against a throwaway git checkout + a real bare "origin", rather than asserting
 * an isolated `git reset`. The script must NOT use `git pull`: when a release
 * cut rewrites/force-pushes `stable` (so the new release tag is on a commit that
 * is NOT a fast-forward descendant of the running checkout), `git pull` would
 * abort with "branches have diverged". The updater resolves the latest final tag
 * reachable from origin/stable and `git reset --hard`s to its commit, which
 * advances across a divergence transparently — that is the property under test.
 *
 * Only the Docker build (deploy.sh) is stubbed, via SHIPIT_DEPLOY_SCRIPT — every
 * other step (channel resolution, fetch, tag selection, reset, rollback trap,
 * failure breadcrumb) is the production code path.
 */
const UPDATE_SCRIPT = fileURLToPath(
  new URL("../../../../deployment/vps/update.sh", import.meta.url),
);

describe("deployment/vps/update.sh (host self-updater)", () => {
  let root: string;
  let bareDir: string;
  let seedDir: string;
  let shipitDir: string;
  let deployStub: string;
  let deployMarker: string;

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, {
      cwd,
      shell: "/bin/bash",
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();

  const head = (dir: string): string => run("git rev-parse HEAD", dir).trim();

  /** Run the real update.sh with SHIPIT_DIR pointed at our temp checkout. */
  const runUpdate = (
    channel: string,
    { deployExit = 0 }: { deployExit?: number } = {},
  ): { code: number; stdout: string } => {
    fs.writeFileSync(path.join(shipitDir, ".release-channel"), channel);
    // Stub deploy.sh: records that it ran, then exits with the requested code so
    // we can exercise both the success path and the rollback/failure trap.
    fs.writeFileSync(
      deployStub,
      `#!/bin/bash\necho ran > "${deployMarker}"\nexit ${deployExit}\n`,
    );
    fs.chmodSync(deployStub, 0o755);
    try {
      const stdout = execFileSync("bash", [UPDATE_SCRIPT], {
        env: {
          ...process.env,
          SHIPIT_DIR: shipitDir,
          SHIPIT_DEPLOY_SCRIPT: deployStub,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }).toString();
      return { code: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer };
      return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "" };
    }
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-update-"));
    bareDir = path.join(root, "origin.git");
    seedDir = path.join(root, "seed");
    shipitDir = path.join(root, "shipit");
    deployStub = path.join(root, "deploy-stub.sh");
    deployMarker = path.join(root, "deploy-ran");
    fs.mkdirSync(bareDir);
    fs.mkdirSync(seedDir);
    fs.mkdirSync(shipitDir);

    run("git init --bare -b main", bareDir);
    run(`git clone ${bareDir} .`, seedDir);
    run("git config user.email test@test.com && git config user.name Test", seedDir);

    // main @ C0 (this is also where the "running" checkout will sit).
    fs.writeFileSync(path.join(seedDir, "v.txt"), "0\n");
    run("git add -A && git commit -m c0", seedDir);
    run("git push origin main", seedDir);

    // The deployment checkout: a clone parked at C0, like a running install.
    run(`git clone ${bareDir} .`, shipitDir);
    run("git config user.email test@test.com && git config user.name Test", shipitDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("advances stable across a DIVERGED (force-pushed) branch where git pull would abort", () => {
    // Cut a first release on a stable branch: v1.0.0 @ C1.
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "1\n");
    run("git add -A && git commit -m c1", seedDir);
    run("git tag v1.0.0 && git push origin stable --tags", seedDir);

    // Park the DEPLOYMENT checkout on the v1.0.0 release (C1) — this is the
    // running install we're about to update from.
    run("git fetch origin --tags", shipitDir);
    run("git reset --hard v1.0.0", shipitDir);
    const oldRelease = head(shipitDir);

    // Now REWRITE stable's history (a release cut that rebases/amends) so the
    // NEW release commit is NOT a descendant of C1 — a genuine divergence from
    // what's deployed — and cut v1.1.0 on it, then force-push.
    run("git reset --hard HEAD~1", seedDir); // back to C0
    fs.writeFileSync(path.join(seedDir, "v.txt"), "1.1-rewritten\n");
    run("git add -A && git commit -m c1-prime", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "2\n");
    run("git add -A && git commit -m c2", seedDir);
    run("git tag v1.1.0 && git push origin stable --force --tags", seedDir);
    const target = head(seedDir);

    // Sanity: the new release does NOT descend from the deployed commit, so a
    // `git pull --ff-only origin stable` from here would abort. The updater,
    // resolving the tag + `git reset --hard`, must advance anyway.
    expect(
      run(`git merge-base --is-ancestor ${oldRelease} ${target}; echo $?`, seedDir).trim(),
    ).toBe("1"); // non-zero => oldRelease is NOT an ancestor of target

    const { code } = runUpdate("stable");

    expect(code).toBe(0);
    expect(head(shipitDir)).toBe(target); // reset --hard landed on v1.1.0's commit
    expect(fs.existsSync(deployMarker)).toBe(true); // build was invoked
    expect(fs.existsSync(path.join(shipitDir, ".update-failed"))).toBe(false);
  });

  it("picks the highest FINAL tag reachable from origin/stable, ignoring rc tags", () => {
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "final\n");
    run("git add -A && git commit -m rel", seedDir);
    const relCommit = head(seedDir);
    // Order matters: an rc tag and a lower final tag must both lose to v2.0.0.
    run("git tag v2.0.0-rc.1 && git tag v1.9.0 && git tag v2.0.0", seedDir);
    run("git push origin stable --tags", seedDir);

    const { code } = runUpdate("stable");

    expect(code).toBe(0);
    expect(head(shipitDir)).toBe(relCommit);
  });

  it("fails closed on stable when no final tag is reachable (no build, no move)", () => {
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "unreleased\n");
    run("git add -A && git commit -m wip", seedDir);
    run("git tag v3.0.0-rc.1 && git push origin stable --tags", seedDir); // rc only
    const before = head(shipitDir);

    const { code } = runUpdate("stable");

    expect(code).not.toBe(0);
    expect(head(shipitDir)).toBe(before); // never reset to the branch tip
    expect(fs.existsSync(deployMarker)).toBe(false); // build never ran
  });

  it("edge channel advances to the origin/main tip", () => {
    fs.writeFileSync(path.join(seedDir, "v.txt"), "edge\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-edge", seedDir);
    run("git push origin main", seedDir);
    const target = head(seedDir);

    const { code } = runUpdate("edge");

    expect(code).toBe(0);
    expect(head(shipitDir)).toBe(target);
  });

  it("rolls the checkout back to the running commit and writes a breadcrumb when the build fails", () => {
    const prior = head(shipitDir); // running image's commit (C0)
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "1\n");
    run("git add -A && git commit -m c1", seedDir);
    run("git tag v1.0.0 && git push origin stable --tags", seedDir);
    const target = head(seedDir);
    expect(target).not.toBe(prior);

    const { code } = runUpdate("stable", { deployExit: 1 });

    expect(code).not.toBe(0);
    // The whole invariant: a failed build must NOT leave the checkout ahead of
    // the still-running image.
    expect(head(shipitDir)).toBe(prior);
    const failPath = path.join(shipitDir, ".update-failed");
    expect(fs.existsSync(failPath)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(failPath, "utf8")) as {
      runningSha: string;
      attemptedSha: string;
    };
    expect(marker.runningSha).toBe(prior);
    expect(marker.attemptedSha).toBe(target);
  });

  it("clears a stale failure breadcrumb on a subsequent successful update", () => {
    fs.writeFileSync(path.join(shipitDir, ".update-failed"), "{}");
    fs.writeFileSync(path.join(seedDir, "v.txt"), "edge2\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-edge2", seedDir);
    run("git push origin main", seedDir);

    const { code } = runUpdate("edge");

    expect(code).toBe(0);
    expect(fs.existsSync(path.join(shipitDir, ".update-failed"))).toBe(false);
  });
});
