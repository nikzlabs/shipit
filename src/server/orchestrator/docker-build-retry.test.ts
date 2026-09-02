/**
 * Drives the REAL retry helper (deployment/lib/docker-build-retry.sh) with a
 * fake `docker` on PATH, so the classification rules are exercised as shell
 * rather than asserted as text.
 *
 * The incident it exists for: on 2026-09-02 a single TLS handshake timeout to
 * ghcr.io surfaced from BuildKit as `not found`, failed the production update,
 * and rolled the checkout back. The same commit and the same digest pin built
 * fine 40 minutes later. The retry must cover that shape — and must NOT turn a
 * deterministic build failure into three of them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HELPER = fileURLToPath(new URL("../../../deployment/lib/docker-build-retry.sh", import.meta.url));
const DEPLOY_SH = fileURLToPath(new URL("../../../deployment/vps/deploy.sh", import.meta.url));

/** The exact BuildKit line the incident produced. */
const RESOLVE_FAILURE = [
  "target session-worker: failed to solve: ghcr.io/astral-sh/uv:0.12.5@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1:",
  "failed to resolve source metadata for ghcr.io/astral-sh/uv:0.12.5: not found",
].join(" ");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-retry-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Install a fake `docker` that appends one line to a counter file per call and
 * emits `output` on stderr. It fails with `exitCode` until `succeedOnAttempt`
 * (when given), then succeeds — which is how a "blip then recovery" is spelled.
 */
function fakeDocker(output: string, { exitCode = 1, succeedOnAttempt = 0 } = {}): void {
  const script = `#!/bin/bash
echo x >> "${path.join(dir, "calls")}"
n=$(wc -l < "${path.join(dir, "calls")}")
if [ "${succeedOnAttempt}" -gt 0 ] && [ "$n" -ge "${succeedOnAttempt}" ]; then
  echo "build succeeded"
  exit 0
fi
cat >&2 <<'BUILDLOG'
${output}
BUILDLOG
exit ${exitCode}
`;
  const bin = path.join(dir, "docker");
  fs.writeFileSync(bin, script, { mode: 0o755 });
}

/**
 * Source the helper and run it over `docker compose build`, as deploy.sh does.
 *
 * The helper runs in a CHILD bash as a standalone command under `set -euo
 * pipefail`, which is the one arrangement that reproduces production. Calling it
 * from `shipit_docker_build_with_retry … || status=$?` in the driver itself would
 * be wrong: an `||` list disables `errexit` for the whole function body, so an
 * abort inside the helper is invisible. That masked a real bug — the reference
 * grep in the exhaustion note killed deploy.sh outright when the log carried no
 * digest.
 */
function runHelper({ attempts = 3, delay = "0" } = {}): { status: number; output: string } {
  const driver = path.join(dir, "driver.sh");
  fs.writeFileSync(
    driver,
    `exec 2>&1
if bash -c 'set -euo pipefail
. "$1"
shipit_docker_build_with_retry docker compose -f compose.yml build --pull session-worker' _ "${HELPER}"; then
  echo "EXIT:0"
else
  echo "EXIT:$?"
fi
`,
  );
  const out = execFileSync("/bin/bash", [driver], {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      TMPDIR: dir,
      SHIPIT_BUILD_ATTEMPTS: String(attempts),
      SHIPIT_BUILD_RETRY_DELAY: delay,
    },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { status: Number(/EXIT:(\d+)/.exec(out)?.[1]), output: out };
}

/** Capture files the helper left behind in TMPDIR (which is `dir`). */
const leakedLogs = (): string[] => fs.readdirSync(dir).filter((f) => f.startsWith("shipit-build."));

const calls = (): number => {
  const f = path.join(dir, "calls");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").length : 0;
};

describe("shipit_docker_build_with_retry", () => {
  it("runs the build exactly once when it succeeds", () => {
    fakeDocker("", { succeedOnAttempt: 1 });
    expect(runHelper().status).toBe(0);
    expect(calls()).toBe(1);
  });

  // The incident shape. Its operator-visible text is indistinguishable from a
  // deleted digest, so it MUST be retried — the network error that caused it is
  // only in the dockerd journal.
  it("retries the 'failed to resolve source metadata / not found' shape and succeeds", () => {
    fakeDocker(RESOLVE_FAILURE, { succeedOnAttempt: 2 });
    expect(runHelper().status).toBe(0);
    expect(calls()).toBe(2);
  });

  it.each([
    ["TLS handshake timeout", 'failed to do request: Head "https://ghcr.io/v2/...": net/http: TLS handshake timeout'],
    ["i/o timeout", "dial tcp 140.82.121.34:443: i/o timeout"],
    ["connection reset", "read tcp 10.0.0.2:52000->140.82.121.34:443: connection reset by peer"],
    ["registry 5xx", "unexpected status: 503 Service Unavailable"],
  ])("retries a %s", (_label, output) => {
    fakeDocker(output, { succeedOnAttempt: 2 });
    expect(runHelper().status).toBe(0);
    expect(calls()).toBe(2);
  });

  // The other half of the bargain: a deterministic failure must cost one build,
  // not three. Three attempts at a broken `npm ci` is minutes per deploy.
  it("does not retry a deterministic build failure, and preserves its exit status", () => {
    fakeDocker("npm ERR! code E404\nnpm ERR! notarget No matching version found", { exitCode: 17 });
    expect(runHelper().status).toBe(17);
    expect(calls()).toBe(1);
  });

  // A missing COPY source produces `failed to solve: … not found` too. Matching
  // that alone would retry every broken Dockerfile three times.
  it("does not retry a missing build-context file", () => {
    fakeDocker(
      'failed to solve: failed to compute cache key: failed to calculate checksum of ref abc::xyz: "/app/missing.txt": not found',
    );
    expect(runHelper().status).not.toBe(0);
    expect(calls()).toBe(1);
  });

  // `failed to resolve source metadata` alone is not enough either: a private
  // image with no credentials fails the same step, deterministically.
  it("does not retry a resolve failure that is an auth refusal, not a 'not found'", () => {
    fakeDocker("failed to solve: failed to resolve source metadata for ghcr.io/acme/private:1.0: unauthorized");
    expect(runHelper().status).not.toBe(0);
    expect(calls()).toBe(1);
  });

  // deploy.sh already has a disk-space preflight and an EXIT-trap prune; a full
  // disk must surface immediately rather than be retried into. The fixture
  // carries a transient phrase TOO, so the test fails if the ENOSPC exclusion is
  // removed — a disk that fills mid-build really does produce both.
  it("does not retry a full disk, even alongside a transient-looking error", () => {
    fakeDocker(
      [
        "failed to do request: Head https://ghcr.io/v2/...: net/http: TLS handshake timeout",
        "failed to solve: write /var/lib/docker/tmp/x: no space left on device",
      ].join("\n"),
    );
    expect(runHelper().status).not.toBe(0);
    expect(calls()).toBe(1);
  });

  // A garbage override must not turn `[ "$attempt" -ge "$attempts" ]` into a
  // comparison that always fails inside an `if` — that is an infinite retry loop
  // in the unattended updater.
  it("falls back to the default bound when the attempt count is not a number", () => {
    fakeDocker("net/http: TLS handshake timeout");
    expect(runHelper({ attempts: "abc" as unknown as number }).status).not.toBe(0);
    expect(calls()).toBe(3);
  });

  it("runs at least one build when the attempt count is zero", () => {
    fakeDocker("", { succeedOnAttempt: 1 });
    expect(runHelper({ attempts: 0 }).status).toBe(0);
    expect(calls()).toBe(1);
  });

  // The bug the old `|| status=$?` driver hid: with no digest in the log, the
  // note's reference grep matches nothing, and under `set -euo pipefail` that
  // assignment aborted deploy.sh on the spot — no note, no cleanup, and docker's
  // exit status replaced by grep's.
  it("survives a resolution failure whose log carries no digest", () => {
    fakeDocker("failed to solve: failed to resolve source metadata for ghcr.io/astral-sh/uv:0.12.5: not found", {
      exitCode: 23,
    });
    const { status, output } = runHelper({ attempts: 1 });
    expect(status).toBe(23);
    expect(output).toContain("docker buildx imagetools inspect <image-ref>");
    expect(leakedLogs()).toEqual([]);
  });

  // Under `pipefail` bash reports the RIGHTMOST failure, so a `tee` that fails
  // too (a full /tmp) would hand deploy.sh tee's status instead of docker's, and
  // the updater's failure breadcrumb would record the wrong exit code.
  it("reports docker's exit status, not tee's, when both fail", () => {
    fakeDocker("npm ERR! code E404", { exitCode: 23 });
    fs.writeFileSync(path.join(dir, "tee"), '#!/bin/bash\n/usr/bin/tee "$@" || true\nexit 9\n', { mode: 0o755 });
    expect(runHelper().status).toBe(23);
  });

  it("removes its capture file on success and on failure", () => {
    fakeDocker("", { succeedOnAttempt: 1 });
    runHelper();
    expect(leakedLogs()).toEqual([]);
    fs.rmSync(path.join(dir, "calls"), { force: true });
    fakeDocker("npm ERR! code E404", { exitCode: 3 });
    runHelper();
    expect(leakedLogs()).toEqual([]);
  });

  it("stops after the configured attempt count on a persistent transient error", () => {
    fakeDocker("net/http: TLS handshake timeout");
    expect(runHelper({ attempts: 2 }).status).not.toBe(0);
    expect(calls()).toBe(2);
  });

  // The lower-priority half of the incident: the operator saw `not found` and
  // went looking for a deleted digest. On exhaustion, say what settles it.
  it("prints the imagetools hint, naming the reference, when resolution stays broken", () => {
    fakeDocker(RESOLVE_FAILURE);
    const { output } = runHelper({ attempts: 2 });
    expect(output).toContain(
      "docker buildx imagetools inspect ghcr.io/astral-sh/uv:0.12.5@sha256:e85be844203885286c60ffad8a858d48afb6c5a5c237ca0e67f12e74b8f174b1",
    );
    expect(output).toMatch(/COMMONLY a transient/);
  });

  it("stays quiet about the registry on an unrelated failure", () => {
    fakeDocker("npm ERR! code E404", { exitCode: 3 });
    expect(runHelper().output).not.toMatch(/imagetools/);
  });
});

describe("deployment/vps/deploy.sh routes its builds through the retry", () => {
  const src = fs
    .readFileSync(DEPLOY_SH, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  it("sources the shared helper", () => {
    expect(src).toMatch(/deployment\/lib\/docker-build-retry\.sh/);
  });

  // A bare `docker compose … build` added later would silently opt back out of
  // the retry, which is exactly the state the incident happened in.
  it("has no un-retried `docker compose build` left", () => {
    // `\sbuild\s` and not `\bbuild\b` — the latter also matches `--no-build`,
    // which is the `up` line and correctly builds nothing.
    const builds = [...src.matchAll(/^(\S*)\s*docker compose [^\n]*\sbuild\s[^\n]*$/gm)];
    expect(builds.length).toBeGreaterThan(0);
    for (const [line, prefix] of builds) {
      expect(prefix, `un-retried build in deploy.sh: ${line.trim()}`).toBe("shipit_docker_build_with_retry");
    }
  });

  // `--pull` force-resolves every external reference on each deploy and the
  // Dockerfile pinning guards (docker-build-cache.test.ts) depend on it. The
  // retry must not have been "fixed" by weakening it — so check both that the
  // array still carries it AND that the retried build still expands the array.
  it("still builds with --pull", () => {
    expect(src).toMatch(/BUILD_ARGS=\("--pull"\)/);
    expect(src).toMatch(/shipit_docker_build_with_retry docker compose [^\n]*"\$\{BUILD_ARGS\[@\]\}"/);
  });
});
