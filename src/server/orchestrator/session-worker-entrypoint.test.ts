/**
 * Regression guards for the non-root worker entrypoint.
 *
 * Two invariants, both learned the hard way:
 *
 *   1. A restored workspace can contain the UID sentinel and every tracked file
 *      as root:root. The sentinel must be ownership-validated: existence alone
 *      would skip the recursive handoff and leave Git LFS unable to replace
 *      pointer files.
 *   2. Adding that validation must NOT make a read-only mount fatal. /uploads is
 *      mounted :ro, so its sentinel can never exist — a missing-sentinel check
 *      that falls through to `chown -R` hits EROFS and, under `set -e`, kills
 *      the entrypoint on EVERY boot. That took session-container creation down
 *      instance-wide.
 *
 * These tests EXECUTE the entrypoint rather than pattern-matching its source. An
 * earlier source-regex-only version of this file passed while (2) was broken in
 * production, which is precisely the failure mode a text assertion cannot see.
 *
 * The harness rewrites the mount list to point at temp dirs and stubs `chown`
 * and `gosu` onto PATH, so the real loop logic runs with no privileges and no
 * access to the real mounts.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const ENTRYPOINT = fileURLToPath(
  new URL("../../../docker/session-worker/entrypoint.sh", import.meta.url),
);

/** The mount list the harness swaps out. Kept as a named anchor so a reshaped
 *  loop fails loudly here instead of silently skipping the substitution. */
const MOUNT_LOOP = /^for d in \/workspace .*; do$/m;

const isRoot = process.getuid?.() === 0;

/** Dirs chmod'ed 0555 must be restored, or temp cleanup can't unlink them. */
const restoreWritable: string[] = [];
afterEach(() => {
  for (const dir of restoreWritable.splice(0)) chmodSync(dir, 0o755);
});

interface RunResult {
  status: number;
  stderr: string;
  /** One entry per `chown` invocation, in order, as the joined argv. */
  chowns: string[];
}

function runEntrypoint(dirs: string[], workerUid: string): RunResult {
  const root = mkdtempSync(join(tmpdir(), "shipit-entrypoint-"));
  const bin = join(root, "bin");
  mkdirSync(bin);

  // Record chown calls instead of performing them: the assertions are about
  // WHICH mounts get the recursive handoff, and stubbing keeps the test free of
  // any privilege requirement (a real `chown uid:gid` needs a matching group).
  // The stub still FAILS on a target it cannot write, the way coreutils chown
  // does on a :ro mount — otherwise the entrypoint's `set -e` abort (the actual
  // production symptom) would be invisible here.
  const chownLog = join(root, "chown.log");
  writeFileSync(chownLog, "");
  writeFileSync(
    join(bin, "chown"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$CHOWN_LOG"',
      'for a in "$@"; do target=$a; done',
      '[ -w "$target" ] && exit 0',
      "echo \"chown: changing ownership of '$target': Read-only file system\" >&2",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  // The entrypoint ends with `exec gosu <uid>:<gid> "$@"`; drop the user spec
  // and run the command so a successful boot exits 0.
  writeFileSync(join(bin, "gosu"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });

  const source = readFileSync(ENTRYPOINT, "utf8");
  expect(source).toMatch(MOUNT_LOOP);
  const script = join(root, "entrypoint.sh");
  writeFileSync(script, source.replace(MOUNT_LOOP, `for d in ${dirs.join(" ")}; do`));

  let status = 0;
  let stderr = "";
  try {
    execFileSync("sh", [script, "true"], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CHOWN_LOG: chownLog,
        SHIPIT_SESSION_WORKER_UID: workerUid,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    status = e.status ?? 1;
    stderr = e.stderr ?? "";
  }

  return {
    status,
    stderr,
    chowns: readFileSync(chownLog, "utf8").split("\n").filter(Boolean),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "shipit-mount-"));
}

describe("session worker ownership sentinel", () => {
  it("keeps valid shell syntax", () => {
    expect(() => execFileSync("sh", ["-n", ENTRYPOINT])).not.toThrow();
  });

  it("hands off every writable mount on a cold boot", () => {
    const a = tempDir();
    const b = tempDir();

    const result = runEntrypoint([a, b], "1000");

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R 1000:1000 ${a}`, `-R 1000:1000 ${b}`]);
  });

  it("re-chowns when a restored sentinel is not owned by the worker UID", () => {
    const dir = tempDir();
    // Stand in for the restored, root-owned sentinel: the marker exists but its
    // owner (this test's uid) differs from the configured worker UID.
    mkdirSync(join(dir, ".shipit-uid-4242"));

    const result = runEntrypoint([dir], "4242");

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R 4242:4242 ${dir}`]);
  });

  it("skips the recursive walk when the sentinel is already worker-owned", () => {
    const dir = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    mkdirSync(join(dir, `.shipit-uid-${uid}`));

    const result = runEntrypoint([dir], uid);

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([]);
  });

  // Running as root defeats the 0555 stand-in for a :ro mount — access(2) grants
  // W_OK to root on a permission-bound dir (unlike a genuinely read-only mount,
  // where it reports EROFS for everyone). CI runs unprivileged, so the guard
  // holds there; skipping beats asserting vacuously.
  it.skipIf(isRoot)("skips a mount it cannot write to instead of failing the boot", () => {
    const readOnly = tempDir();
    const writable = tempDir();
    chmodSync(readOnly, 0o555);
    restoreWritable.push(readOnly);

    const result = runEntrypoint([readOnly, writable], "1000");

    // The prod regression: this exited 1 with "chown: changing ownership of
    // '/uploads': Read-only file system", so no session container could boot.
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Read-only|Permission denied/);
    expect(result.chowns).toEqual([`-R 1000:1000 ${writable}`]);
  });
});
