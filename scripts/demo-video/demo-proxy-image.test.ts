import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

/**
 * `host/demo-proxy-image.sh` against a fake `docker` (docs/296 plan §2, §9):
 * what goes into the image for each mode, and which container a recorded take
 * is copied out of. No Docker daemon is involved.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "host", "demo-proxy-image.sh");

let dir: string;

/**
 * `build` keeps the Dockerfile and the context's file list; `ps` prints
 * $FAKE_IDS; `cp <id>:… -` streams a one-take cassette for ids in $FAKE_TAKES
 * and fails for the rest, as `docker cp` does for a path that is not there.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  build)
    ctx="\${@: -1}"
    cp "$ctx/Dockerfile" "$FAKE_OUT/Dockerfile"
    (cd "$ctx" && find . -type f | sort) > "$FAKE_OUT/context"
    ;;
  ps) for id in \${FAKE_IDS:-}; do echo "$id"; done ;;
  cp)
    id="\${2%%:*}"; name="\${2##*/}"
    case " \${FAKE_TAKES:-} " in *" $id "*) ;; *) exit 1 ;; esac
    t=$(mktemp -d); mkdir -p "$t/$name/bearer"
    echo "{\\"from\\":\\"$id\\"}" > "$t/$name/fingerprints.jsonl"; echo sse > "$t/$name/bearer/001.sse"
    tar -c -C "$t" "$name"; rm -rf "$t"
    ;;
  *) echo "fake docker: unexpected $*" >&2; exit 64 ;;
esac
`;

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [join(dir, "pipeline", "host", "demo-proxy-image.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, DOCKER: join(dir, "fake-docker"), FAKE_OUT: dir, ...env },
  });
}

// The script finds its inputs by the repo's own layout: proxy.mjs one level up, the scenarios beside it.
beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "demo-proxy-image-"));
  mkdirSync(join(dir, "pipeline", "host"), { recursive: true });
  cpSync(SCRIPT, join(dir, "pipeline", "host", "demo-proxy-image.sh"));
  cpSync(join(HERE, "host", "demo-proxy-entrypoint.sh"), join(dir, "pipeline", "host", "demo-proxy-entrypoint.sh"));
  writeFileSync(join(dir, "pipeline", "proxy.mjs"), "// proxy\n");
  writeFileSync(join(dir, "fake-docker"), FAKE_DOCKER);
  chmodSync(join(dir, "fake-docker"), 0o755);
  const committed = join(dir, "pipeline", "scenarios", "taken", "cassette");
  mkdirSync(join(committed, "bearer"), { recursive: true });
  writeFileSync(join(committed, "fingerprints.jsonl"), "{}\n");
  writeFileSync(join(committed, "bearer", "001.sse"), "sse\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("host/demo-proxy-image.sh", () => {
  it("bakes the mode, the scenario's committed cassette and the pace into a replay image", () => {
    const r = run(["build", "replay", "taken"], { DEMO_PROXY_PACE: "90" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toContain("ENV DEMO_PROXY_MODE=replay DEMO_PROXY_CASSETTE=/cassettes/taken DEMO_PROXY_PACE=90");
    expect(readFileSync(join(dir, "context"), "utf8").trim().split("\n")).toEqual([
      "./Dockerfile", "./cassettes/taken/bearer/001.sse", "./cassettes/taken/fingerprints.jsonl", "./demo-proxy-entrypoint.sh", "./proxy.mjs",
    ]);
  });

  it("refuses to replay a scenario with no committed cassette", () => {
    expect(run(["build", "replay", "missing"]).stderr).toContain("no committed cassette at");
    expect(existsSync(join(dir, "Dockerfile"))).toBe(false);
  });

  it("builds a record image with an empty target, whatever is committed", () => {
    const r = run(["build", "record", "taken"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toContain("ENV DEMO_PROXY_MODE=record DEMO_PROXY_CASSETTE=/cassettes/taken");
    expect(readFileSync(join(dir, "context"), "utf8")).not.toContain("cassettes/");
  });

  it("extracts the take from the one container that holds it — another session's proxy holds none", () => {
    const dest = join(dir, "takes", "t1", "cassette");
    const r = run(["extract", "fresh", dest], { FAKE_IDS: "other claimed", FAKE_TAKES: "claimed" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dest, "fingerprints.jsonl"), "utf8")).toContain('"from":"claimed"');
    expect(existsSync(join(dest, "bearer", "001.sse"))).toBe(true);
  });

  it("refuses to extract when no container or two containers hold a take, or the destination exists", () => {
    const dest = join(dir, "takes", "t1", "cassette");
    expect(run(["extract", "fresh", dest], { FAKE_IDS: "other" }).stderr).toContain("no container of demo-proxy:current holds a take");
    expect(run(["extract", "fresh", dest], { FAKE_IDS: "a b", FAKE_TAKES: "a b" }).stderr).toContain("more than one container");
    expect(existsSync(dest)).toBe(false);
    expect(run(["extract", "fresh", dir], { FAKE_IDS: "a", FAKE_TAKES: "a" }).stderr).toContain("already exists");
  });
});
