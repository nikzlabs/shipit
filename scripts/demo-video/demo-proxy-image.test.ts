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
  return spawnSync("bash", [join(dir, "demo-proxy-image.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, DOCKER: join(dir, "fake-docker"), FAKE_OUT: dir, ...env },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "demo-proxy-image-"));
  cpSync(SCRIPT, join(dir, "demo-proxy-image.sh"));
  cpSync(join(HERE, "host", "demo-proxy-entrypoint.sh"), join(dir, "demo-proxy-entrypoint.sh"));
  writeFileSync(join(dir, "proxy.mjs"), "// proxy\n");
  writeFileSync(join(dir, "fake-docker"), FAKE_DOCKER);
  chmodSync(join(dir, "fake-docker"), 0o755);
  mkdirSync(join(dir, "cassettes", "taken", "bearer"), { recursive: true });
  writeFileSync(join(dir, "cassettes", "taken", "fingerprints.jsonl"), "{}\n");
  writeFileSync(join(dir, "cassettes", "taken", "bearer", "001.sse"), "sse\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("host/demo-proxy-image.sh", () => {
  it("bakes the mode, the cassette and the pace into a replay image", () => {
    const r = run(["build", "replay", "taken"], { DEMO_PROXY_PACE: "90" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toContain("ENV DEMO_PROXY_MODE=replay DEMO_PROXY_CASSETTE=/cassettes/taken DEMO_PROXY_PACE=90");
    expect(readFileSync(join(dir, "context"), "utf8").trim().split("\n")).toEqual([
      "./Dockerfile", "./cassettes/taken/bearer/001.sse", "./cassettes/taken/fingerprints.jsonl", "./demo-proxy-entrypoint.sh", "./proxy.mjs",
    ]);
  });

  it("refuses to replay a cassette that was never recorded, and to record over one that was", () => {
    expect(run(["build", "replay", "missing"]).stderr).toContain("no recorded take at");
    expect(run(["build", "record", "taken"]).stderr).toContain("already exists");
    expect(existsSync(join(dir, "Dockerfile"))).toBe(false);
  });

  it("builds a record image with an empty target", () => {
    const r = run(["build", "record", "fresh"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "Dockerfile"), "utf8")).toContain("ENV DEMO_PROXY_MODE=record DEMO_PROXY_CASSETTE=/cassettes/fresh");
    expect(readFileSync(join(dir, "context"), "utf8")).not.toContain("cassettes/");
  });

  it("extracts the take from the one container that holds it — another session's proxy holds none", () => {
    const r = run(["extract", "fresh"], { FAKE_IDS: "other claimed", FAKE_TAKES: "claimed" });
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(dir, "cassettes", "fresh", "fingerprints.jsonl"), "utf8")).toContain('"from":"claimed"');
    expect(existsSync(join(dir, "cassettes", "fresh", "bearer", "001.sse"))).toBe(true);
  });

  it("refuses to extract when no container or two containers hold a take, or the name is taken", () => {
    expect(run(["extract", "fresh"], { FAKE_IDS: "other" }).stderr).toContain("no container of demo-proxy:current holds a take");
    expect(run(["extract", "fresh"], { FAKE_IDS: "a b", FAKE_TAKES: "a b" }).stderr).toContain("more than one container");
    expect(existsSync(join(dir, "cassettes", "fresh"))).toBe(false);
    expect(run(["extract", "taken"], { FAKE_IDS: "a", FAKE_TAKES: "a" }).stderr).toContain("already exists");
  });
});
