import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawn } from "node:child_process";

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
    {
      deployExit = 0,
      env = {},
    }: { deployExit?: number; env?: Record<string, string> } = {},
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
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      }).toString();
      return { code: 0, stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer };
      return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "" };
    }
  };

  /**
   * Put a `git` shim ahead of the real one on the script's PATH. It logs every
   * `fetch` invocation (so a run's round-trips can be counted) and can make a
   * fetch fail the way GitHub's intermittent 401 does, or STALL the way a dead
   * connection does; everything else execs the real git. The stall redirects its
   * own stdio so the killed attempt leaves nothing holding the run's pipes open.
   */
  const installGitShim = ({
    failFirstFetch = false,
    stallFetch,
    deafToTerm = false,
  }: {
    failFirstFetch?: boolean;
    stallFetch?: "first" | "always";
    deafToTerm?: boolean;
  } = {}) => {
    const shimDir = path.join(root, "bin");
    const fetchLog = path.join(root, "fetches");
    const failedOnce = path.join(root, "failed-once");
    const stalledOnce = path.join(root, "stalled-once");
    const realGit = execSync("command -v git", { shell: "/bin/bash" }).toString().trim();
    const failFirst = failFirstFetch
      ? `  if [ ! -f "${failedOnce}" ]; then
    touch "${failedOnce}"
    echo "fatal: Authentication failed" >&2
    exit 128
  fi
`
      : "";
    // Far longer than any timeout the tests set: if the bound does not fire, the
    // assertion on elapsed time is what fails, not a passing-by-luck race.
    // `deafToTerm` ignores SIGTERM, so only `timeout -k`'s SIGKILL ends it — the
    // wedged connection a plain `timeout` would wait on forever. It waits in
    // slices because `timeout` signals the whole process group: one long `sleep`
    // would die of the TERM the shim itself is ignoring.
    const stall = deafToTerm
      ? `  trap '' TERM
  for _i in $(seq 1 300); do sleep 0.1 </dev/null >/dev/null 2>&1; done
`
      : "  sleep 30 </dev/null >/dev/null 2>&1\n";
    const stallBlock =
      stallFetch === "always"
        ? stall
        : stallFetch === "first"
          ? `  if [ ! -f "${stalledOnce}" ]; then
    touch "${stalledOnce}"
  ${stall}  fi
`
          : "";
    fs.mkdirSync(shimDir);
    fs.writeFileSync(
      path.join(shimDir, "git"),
      `#!/bin/bash
if [ "$1" = fetch ]; then
  echo fetch >> "${fetchLog}"
${failFirst}${stallBlock}fi
exec ${realGit} "$@"
`,
    );
    fs.chmodSync(path.join(shimDir, "git"), 0o755);
    return {
      pathPrefix: `${shimDir}:${process.env.PATH ?? ""}`,
      fetchCount: (): number =>
        fs.existsSync(fetchLog)
          ? fs.readFileSync(fetchLog, "utf8").trim().split("\n").length
          : 0,
    };
  };

  /**
   * Start the real update.sh on the edge channel and kill its process GROUP once
   * the deploy stub is in flight — what systemd's TimeoutStartSec= does to a run
   * wedged in the build. `afterStart` is extra shell the stub runs before it
   * hangs, so a test can model the restart having already happened.
   */
  const killDuringDeploy = (beforeReady = ""): Promise<number | null> =>
    new Promise((resolve) => {
      // `beforeReady` runs FIRST and the polled marker last, so the kill can
      // never land between them — the test would otherwise pass or fail on
      // which of two writes won a race.
      fs.writeFileSync(
        deployStub,
        `#!/bin/bash\n${beforeReady}echo ran > "${deployMarker}"\nsleep 30\n`,
      );
      fs.chmodSync(deployStub, 0o755);
      fs.writeFileSync(path.join(shipitDir, ".release-channel"), "edge");
      const child = spawn("bash", [UPDATE_SCRIPT], {
        env: { ...process.env, SHIPIT_DIR: shipitDir, SHIPIT_DEPLOY_SCRIPT: deployStub },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true, // its own process group, like a unit's control group
      });
      const waitForBuild = setInterval(() => {
        if (!fs.existsSync(deployMarker)) return;
        clearInterval(waitForBuild);
        process.kill(-child.pid!, "SIGTERM");
      }, 50);
      // Also clears the timer when the script dies before the stub ever runs,
      // which would otherwise leave it polling for the rest of the suite.
      child.on("exit", (code) => {
        clearInterval(waitForBuild);
        resolve(code);
      });
    });

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

  it("fails closed when the origin keeps refusing", () => {
    const before = head(shipitDir);
    // An origin that can never answer stands in for GitHub refusing every
    // attempt: the retry must run out, not loop forever or update anyway.
    run(`git remote set-url origin ${path.join(root, "gone.git")}`, shipitDir);

    const { code, stdout } = runUpdate("edge", {
      env: { SHIPIT_FETCH_RETRY_DELAYS: "0 0" },
    });

    expect(code).toBe(128); // git's own exit code, not a swallowed one
    expect(stdout.match(/retrying in/g)).toHaveLength(2); // 2 delays => 3 attempts
    expect(head(shipitDir)).toBe(before); // HEAD moves only after a good fetch
    expect(fs.existsSync(deployMarker)).toBe(false);
    const marker = JSON.parse(
      fs.readFileSync(path.join(shipitDir, ".update-failed"), "utf8"),
    ) as { exitCode: number };
    expect(marker.exitCode).toBe(128);
  });

  it("recovers when a retry succeeds, with a single fetch per run", () => {
    fs.writeFileSync(path.join(seedDir, "v.txt"), "edge3\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-edge3", seedDir);
    run("git push origin main", seedDir);
    const target = head(seedDir);

    const shim = installGitShim({ failFirstFetch: true });

    const { code, stdout } = runUpdate("edge", {
      env: { SHIPIT_FETCH_RETRY_DELAYS: "0 0", PATH: shim.pathPrefix },
    });

    expect(code).toBe(0);
    expect(stdout.match(/retrying in/g)).toHaveLength(1); // recovered on attempt 2
    // Exactly two: one refused, one that worked. Pins the removal of the
    // redundant per-channel fetch — a second round-trip would make this 3.
    expect(shim.fetchCount()).toBe(2);
    expect(head(shipitDir)).toBe(target);
    expect(fs.existsSync(deployMarker)).toBe(true);
  });

  it("makes a single fetch on the stable channel too", () => {
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "1\n");
    run("git add -A && git commit -m c1", seedDir);
    run("git tag v1.0.0 && git push origin stable --tags", seedDir);
    const target = head(seedDir);
    const shim = installGitShim();

    const { code } = runUpdate("stable", { env: { PATH: shim.pathPrefix } });

    expect(code).toBe(0);
    // origin/stable and the tags both come from the ONE `--tags --prune` fetch.
    expect(shim.fetchCount()).toBe(1);
    expect(head(shipitDir)).toBe(target);
  });

  it("abandons a fetch that stalls and retries it", () => {
    fs.writeFileSync(path.join(seedDir, "v.txt"), "edge4\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-edge4", seedDir);
    run("git push origin main", seedDir);
    const target = head(seedDir);
    // A hung connection, not a refusal: git would wait forever on its own.
    const shim = installGitShim({ stallFetch: "first" });

    const startedAt = Date.now();
    const { code, stdout } = runUpdate("edge", {
      env: {
        SHIPIT_FETCH_TIMEOUT_SECONDS: "1",
        SHIPIT_FETCH_RETRY_DELAYS: "0 0",
        PATH: shim.pathPrefix,
      },
    });

    expect(code).toBe(0);
    // The stall is 30s: finishing at all means the bound fired and the retry ran.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(stdout.match(/retrying in/g)).toHaveLength(1);
    expect(head(shipitDir)).toBe(target);
    expect(fs.existsSync(deployMarker)).toBe(true);
  });

  it("kills a fetch that ignores the timeout's TERM", () => {
    fs.writeFileSync(path.join(seedDir, "v.txt"), "edge5\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-edge5", seedDir);
    run("git push origin main", seedDir);
    const target = head(seedDir);
    const shim = installGitShim({ stallFetch: "first", deafToTerm: true });

    const startedAt = Date.now();
    const { code, stdout } = runUpdate("edge", {
      env: {
        SHIPIT_FETCH_TIMEOUT_SECONDS: "1",
        SHIPIT_FETCH_KILL_GRACE_SECONDS: "1",
        SHIPIT_FETCH_RETRY_DELAYS: "0 0",
        PATH: shim.pathPrefix,
      },
    });

    expect(code).toBe(0);
    // Without `timeout -k` the TERM is ignored and the attempt runs its full
    // 30s: the bound is only real because something escalates to SIGKILL.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
    expect(stdout.match(/retrying in/g)).toHaveLength(1);
    expect(head(shipitDir)).toBe(target);
  });

  it("fails closed when every fetch stalls, recording the timeout's code", () => {
    const before = head(shipitDir);
    const shim = installGitShim({ stallFetch: "always" });

    const { code } = runUpdate("edge", {
      env: {
        SHIPIT_FETCH_TIMEOUT_SECONDS: "1",
        SHIPIT_FETCH_RETRY_DELAYS: "0 0",
        PATH: shim.pathPrefix,
      },
    });

    expect(code).toBe(124); // `timeout`'s code, distinguishing a stall from a 401
    expect(shim.fetchCount()).toBe(3);
    expect(head(shipitDir)).toBe(before);
    expect(fs.existsSync(deployMarker)).toBe(false);
    const marker = JSON.parse(
      fs.readFileSync(path.join(shipitDir, ".update-failed"), "utf8"),
    ) as { exitCode: number };
    expect(marker.exitCode).toBe(124);
  });

  it("rolls back and records 143 when the run is killed mid-build", async () => {
    const prior = head(shipitDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "killed\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-killed", seedDir);
    run("git push origin main", seedDir);

    const code = await killDuringDeploy();

    expect(code).toBe(143); // 128+SIGTERM, not the bare 0 an untrapped kill left
    // The invariant the whole script exists for still holds under a kill.
    expect(head(shipitDir)).toBe(prior);
    const marker = JSON.parse(
      fs.readFileSync(path.join(shipitDir, ".update-failed"), "utf8"),
    ) as { runningSha: string; exitCode: number };
    expect(marker.runningSha).toBe(prior);
    expect(marker.exitCode).toBe(143);
  });

  it("keeps the checkout when the kill lands AFTER the restart", async () => {
    fs.writeFileSync(path.join(seedDir, "v.txt"), "restarted\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-restarted", seedDir);
    run("git push origin main", seedDir);
    const target = head(seedDir);

    // deploy.sh keeps working after `docker compose up -d` returns (its EXIT
    // trap prunes the build cache), so a timeout can land once the NEW image is
    // already live. Rolling back there would leave the checkout BEHIND what is
    // running — the mirror of the bug the rollback exists to prevent.
    const code = await killDuringDeploy('echo built > "$SHIPIT_RESTART_MARKER"\n');

    expect(code).toBe(0); // the update did succeed; only its cleanup was cut short
    expect(head(shipitDir)).toBe(target);
    expect(fs.existsSync(path.join(shipitDir, ".update-failed"))).toBe(false);
    // The marker must not survive to make the NEXT run's failure read as success.
    expect(fs.existsSync(path.join(shipitDir, ".deploy-restarted"))).toBe(false);
  });
});
