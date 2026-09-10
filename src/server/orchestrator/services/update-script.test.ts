import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execSync, spawn } from "node:child_process";

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

  const runUpdate = (
    channel: string,
    {
      deployExit = 0,
      env = {},
    }: { deployExit?: number; env?: Record<string, string> } = {},
  ): { code: number; stdout: string } => {
    fs.writeFileSync(path.join(shipitDir, ".release-channel"), channel);
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
    // Short sleeps keep the TERM-ignoring shim stalled after its process group is signalled.
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

  const killDuringDeploy = (beforeReady = ""): Promise<number | null> =>
    new Promise((resolve) => {
      // Write the polled marker last so the signal cannot precede beforeReady.
      fs.writeFileSync(
        deployStub,
        `#!/bin/bash\n${beforeReady}echo ran > "${deployMarker}"\nsleep 30\n`,
      );
      fs.chmodSync(deployStub, 0o755);
      fs.writeFileSync(path.join(shipitDir, ".release-channel"), "edge");
      const child = spawn("bash", [UPDATE_SCRIPT], {
        env: { ...process.env, SHIPIT_DIR: shipitDir, SHIPIT_DEPLOY_SCRIPT: deployStub },
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      const waitForBuild = setInterval(() => {
        if (!fs.existsSync(deployMarker)) return;
        clearInterval(waitForBuild);
        process.kill(-child.pid!, "SIGTERM");
      }, 50);
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

    fs.writeFileSync(path.join(seedDir, "v.txt"), "0\n");
    run("git add -A && git commit -m c0", seedDir);
    run("git push origin main", seedDir);

    run(`git clone ${bareDir} .`, shipitDir);
    run("git config user.email test@test.com && git config user.name Test", shipitDir);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("advances stable across a DIVERGED (force-pushed) branch where git pull would abort", () => {
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "1\n");
    run("git add -A && git commit -m c1", seedDir);
    run("git tag v1.0.0 && git push origin stable --tags", seedDir);

    run("git fetch origin --tags", shipitDir);
    run("git reset --hard v1.0.0", shipitDir);
    const oldRelease = head(shipitDir);

    run("git reset --hard HEAD~1", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "1.1-rewritten\n");
    run("git add -A && git commit -m c1-prime", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "2\n");
    run("git add -A && git commit -m c2", seedDir);
    run("git tag v1.1.0 && git push origin stable --force --tags", seedDir);
    const target = head(seedDir);

    expect(
      run(`git merge-base --is-ancestor ${oldRelease} ${target}; echo $?`, seedDir).trim(),
    ).toBe("1");

    const { code } = runUpdate("stable");

    expect(code).toBe(0);
    expect(head(shipitDir)).toBe(target);
    expect(fs.existsSync(deployMarker)).toBe(true);
    expect(fs.existsSync(path.join(shipitDir, ".update-failed"))).toBe(false);
  });

  it("picks the highest FINAL tag reachable from origin/stable, ignoring rc tags", () => {
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "final\n");
    run("git add -A && git commit -m rel", seedDir);
    const relCommit = head(seedDir);
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
    run("git tag v3.0.0-rc.1 && git push origin stable --tags", seedDir);
    const before = head(shipitDir);

    const { code } = runUpdate("stable");

    expect(code).not.toBe(0);
    expect(head(shipitDir)).toBe(before);
    expect(fs.existsSync(deployMarker)).toBe(false);
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
    const prior = head(shipitDir);
    run("git checkout -b stable", seedDir);
    fs.writeFileSync(path.join(seedDir, "v.txt"), "1\n");
    run("git add -A && git commit -m c1", seedDir);
    run("git tag v1.0.0 && git push origin stable --tags", seedDir);
    const target = head(seedDir);
    expect(target).not.toBe(prior);

    const { code } = runUpdate("stable", { deployExit: 1 });

    expect(code).not.toBe(0);
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
    run(`git remote set-url origin ${path.join(root, "gone.git")}`, shipitDir);

    const { code, stdout } = runUpdate("edge", {
      env: { SHIPIT_FETCH_RETRY_DELAYS: "0 0" },
    });

    expect(code).toBe(128);
    expect(stdout.match(/retrying in/g)).toHaveLength(2);
    expect(head(shipitDir)).toBe(before);
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
    expect(stdout.match(/retrying in/g)).toHaveLength(1);
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
    expect(shim.fetchCount()).toBe(1);
    expect(head(shipitDir)).toBe(target);
  });

  it("abandons a fetch that stalls and retries it", () => {
    fs.writeFileSync(path.join(seedDir, "v.txt"), "edge4\n");
    run("git checkout main", seedDir);
    run("git add -A && git commit -m c-edge4", seedDir);
    run("git push origin main", seedDir);
    const target = head(seedDir);
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

    expect(code).toBe(124);
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

    expect(code).toBe(143);
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

    const code = await killDuringDeploy('echo built > "$SHIPIT_RESTART_MARKER"\n');

    expect(code).toBe(0);
    expect(head(shipitDir)).toBe(target);
    expect(fs.existsSync(path.join(shipitDir, ".update-failed"))).toBe(false);
    expect(fs.existsSync(path.join(shipitDir, ".deploy-restarted"))).toBe(false);
  });
});
