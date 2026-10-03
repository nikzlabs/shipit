import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

/**
 * `host/demo-take.sh` in `--dry-run` against a fixture pipeline tree and a
 * fake `docker` on PATH (docs/296 plan §9): the order of a take's steps and
 * what it refuses. Nothing here reaches Docker or a network; the real run is
 * the take on the demo host.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const INSTANCE = "http://100-81-125-94.sslip.io:4123";

let root: string;
let pipeline: string;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [join(pipeline, "host", "demo-take.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, ...env },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(os.tmpdir(), "demo-take-"));
  pipeline = join(root, "shipit-demo", "pipeline");
  mkdirSync(join(pipeline, "scenarios", "website-hero"), { recursive: true });
  cpSync(join(HERE, "host"), join(pipeline, "host"), { recursive: true });
  writeFileSync(join(pipeline, "scenarios", "website-hero", "storyboard.json"), "{}\n");
  mkdirSync(join(root, "bin"));
  const fake = (name: string, body: string) => {
    writeFileSync(join(root, "bin", name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(root, "bin", name), 0o755);
  };
  // `docker image inspect` decides whether the tools image is built: $FAKE_HAS_IMAGE
  // says it exists. Every other call is recorded and fails, which ends a real run there.
  fake("docker", '[ "$1 $2" = "image inspect" ] && { [ -n "${FAKE_HAS_IMAGE:-}" ]; exit; }\necho "$*" >> "$FAKE_CALLS"\nexit 1');
  // The instance name resolves to $FAKE_RESOLVES; this host holds 100.81.125.94.
  fake("getent", 'echo "${FAKE_RESOLVES:-100.81.125.94} STREAM $2"');
  fake("ip", 'echo "3: tailscale0    inet 100.81.125.94/32 scope global tailscale0"');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("host/demo-take.sh", () => {
  it("runs a replay as: instance check, proxy image, instance reset, repo reset, driver, cut", () => {
    const r = run(["replay", "website-hero", "t1", "--instance", `${INSTANCE}/`, "--dry-run"], { FAKE_HAS_IMAGE: "1" });
    expect(r.status, r.stderr).toBe(0);
    const steps = r.stdout.trim().split("\n");
    const tools = /demo-tools:[0-9a-f]{12}/.exec(steps[4])?.[0];
    expect(steps).toEqual([
      "+ require_local_instance",
      `+ bash ${pipeline}/host/demo-proxy-image.sh build replay website-hero`,
      `+ bash ${pipeline}/host/reset-demo-instance.sh`,
      "+ wait_for_instance",
      `+ sudo docker run --rm --network host --env-file /root/shipit-demo-github.env -v ${pipeline}:/demo/pipeline:ro ${tools} bash /demo/pipeline/reset-demo-repo.sh --scenario /demo/pipeline/scenarios/website-hero --instance ${INSTANCE}`,
      `+ tools node /demo/pipeline/driver.mjs --instance ${INSTANCE} --scenario /demo/pipeline/scenarios/website-hero --out /out --mode replay`,
      "+ tools env FFMPEG=ffmpeg bash /demo/pipeline/cut.sh /out/recording.webm /out/beats.json /demo/pipeline/scenarios/website-hero/storyboard.json /out/hero",
    ]);
    // A dry run leaves no take behind to block the real one.
    expect(existsSync(join(root, "shipit-demo", "takes"))).toBe(false);
  });

  it("builds the tools image first when its Dockerfile has none, and extracts the cassette after a record take", () => {
    const r = run(["record", "website-hero", "t1", "--instance", INSTANCE, "--dry-run"]);
    expect(r.status, r.stderr).toBe(0);
    const steps = r.stdout.trim().split("\n");
    expect(steps[1]).toMatch(new RegExp(`^\\+ docker build -q -t demo-tools:[0-9a-f]{12} -f ${pipeline}/host/demo-tools.Dockerfile ${pipeline}/host$`));
    expect(steps[2]).toBe(`+ bash ${pipeline}/host/demo-proxy-image.sh build record website-hero`);
    expect(steps.slice(-3)).toEqual([
      expect.stringContaining("driver.mjs"),
      `+ bash ${pipeline}/host/demo-proxy-image.sh extract website-hero ${root}/shipit-demo/takes/t1/cassette`,
      expect.stringContaining("cut.sh"),
    ]);
  });

  it("refuses an instance that is not this host's own, before anything is built or reset", () => {
    const calls = join(root, "docker-calls");
    const r = run(["replay", "website-hero", "t1", "--instance", "http://other.example:4123"], { FAKE_RESOLVES: "203.0.113.9", FAKE_CALLS: calls });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("resolves to 203.0.113.9, which is not an address of this host");
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(root, "shipit-demo", "takes"))).toBe(false);
  });

  it("passes its own instance, takes the lock, and logs the whole take from the first step", () => {
    const calls = join(root, "docker-calls");
    // The fake docker fails the tools build, so the real run ends at its first step.
    const r = run(["replay", "website-hero", "t1", "--instance", INSTANCE], { FAKE_CALLS: calls });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).not.toContain("refusing");
    expect(readFileSync(calls, "utf8")).toMatch(/^build -q -t demo-tools:/);
    expect(existsSync(join(root, "shipit-demo", ".demo-take.lock"))).toBe(true);
    expect(readFileSync(join(root, "shipit-demo", "takes", "t1", "take.log"), "utf8")).toContain("+ docker build -q -t demo-tools:");
  });

  it("refuses an existing take, an unknown scenario, a bad mode, and a missing instance", () => {
    mkdirSync(join(root, "shipit-demo", "takes", "t1"), { recursive: true });
    const base = ["--instance", INSTANCE, "--dry-run"];
    const existing = run(["replay", "website-hero", "t1", ...base]);
    expect(existing.status).toBe(1);
    expect(existing.stderr).toContain("already exists; a take never overwrites another");
    expect(existing.stdout).toBe("");
    expect(run(["replay", "nope", "t2", ...base]).stderr).toContain("no scenario at");
    expect(run(["rehearse", "website-hero", "t2", ...base]).stderr).toContain("mode must be record or replay");
    expect(run(["replay", "website-hero", "../t2", ...base]).stderr).toContain("names must be lowercase");
    expect(run(["replay", "website-hero", "t2", "--dry-run"]).stderr).toContain("--instance <url> is required");
  });
});

describe("host/demo-tools.Dockerfile", () => {
  it("carries the Playwright version the repo pins, as image tag and as package", () => {
    const pinned = JSON.parse(readFileSync(join(HERE, "..", "..", "package.json"), "utf8")).devDependencies.playwright;
    const dockerfile = readFileSync(join(HERE, "host", "demo-tools.Dockerfile"), "utf8");
    expect(dockerfile).toContain(`FROM mcr.microsoft.com/playwright:v${pinned}-noble@sha256:`);
    expect(dockerfile).toContain(`playwright@${pinned}\n`);
  });
});
