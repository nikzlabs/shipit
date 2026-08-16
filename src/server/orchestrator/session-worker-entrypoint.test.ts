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
import { execFileSync, spawnSync } from "node:child_process";
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

/**
 * The `/plugins` preparation the harness redirects at a temp path, same anchor
 * discipline as MOUNT_LOOP.
 *
 * This test EXECUTES the entrypoint against the real filesystem, so leaving the
 * literal `/plugins` in made the result depend on the machine running the suite.
 * The first version of these assertions was written on the premise that CI runs
 * unprivileged and therefore "genuinely cannot prepare /plugins" — true on the
 * runner, and false in a ShipIt session container, where `/plugins` EXISTS and is
 * owned by the worker UID (the container's own entrypoint made it). There the
 * step succeeds, records a chown nothing expected, and five exact-match
 * assertions fail. Redirecting the path makes both branches deterministic
 * everywhere: a writable temp dir exercises the success path, an unwritable one
 * exercises the warning.
 */
const PLUGIN_PREP = /^if ! \(mkdir -p (\/[\w-][\w./-]*) && chown .* \1\) 2>\/dev\/null; then$/gm;

/**
 * The absolute paths the entrypoint prepares this way, in the order it does.
 *
 * Deliberately DERIVED from the script rather than listed here. The suite
 * already learned this lesson the expensive way once, and then again: the
 * companion-CLI slice added a second block (`/plugin-bin`) after this harness
 * was written, and because the harness redirected only the literal `/plugins`,
 * the new block ran against the real root — succeeding on a dev box, warning in
 * CI. A hard-coded list would have gone stale the same way; matching the shape
 * means a third block is redirected the day it lands.
 */
function preparedDirs(source: string): string[] {
  return [...source.matchAll(PLUGIN_PREP)].map((m) => m[1]!);
}

/**
 * A path no process can mkdir, root included — procfs rejects directory
 * creation. Stands in for the boot where `/` is not writable.
 */
const UNCREATABLE_PLUGIN_DIR = "/proc/shipit-no-such-dir/plugins";

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
  /** One entry per `groupadd`/`usermod` invocation, in order, as `cmd argv`. */
  groupOps: string[];
  /** One entry per `gosu` invocation, as the joined argv (the user spec first). */
  gosu: string[];
  /** The path the `/plugins` step was redirected to for this run. */
  pluginDir: string;
  /**
   * The chown each prepared dir contributes, in script order — every prep block
   * the entrypoint has, not a list this file maintains. Tests that assert the
   * WHOLE chown log spread this rather than naming `/plugins` alone, so adding a
   * prep block to the entrypoint does not silently need a test edit.
   */
  prepChowns: string[];
}

interface RunOpts {
  /** Journal mounts to expose via SHIPIT_JOURNAL_DIRS. Default: none. */
  journalDirs?: string[];
  /** GID `stat -c %g` reports for those mounts — stands in for the HOST's GID. */
  journalGid?: string;
  /**
   * Override the `getent passwd <uid>` line; "NONE" makes the lookup fail.
   * Defaults to a synthetic `shipit` entry whose primary GID matches the worker
   * UID — the name and GID MUST NOT come from the machine running the suite (CI
   * runs as `packer`, dev boxes as `shipit`, and uid 1000 resolves differently
   * on each).
   */
  passwdLine?: string;
  /**
   * Override the `getent group <gid>` line; default is "no such group", so the
   * group-creation branch is reached deterministically everywhere.
   */
  groupLine?: string;
  /**
   * Where the entrypoint's `/plugins` step points. Defaults to a creatable path
   * under the run's temp root — the production case, where the step succeeds.
   * Pass {@link UNCREATABLE_PLUGIN_DIR} to exercise the best-effort failure.
   */
  pluginDir?: string;
}

function runEntrypoint(dirs: string[], workerUid: string, opts: RunOpts = {}): RunResult {
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
  // The entrypoint ends with `exec gosu <user-spec> "$@"`; record the spec (the
  // #1917 assertions are about WHICH form is used), then drop it and run the
  // command so a successful boot still exits 0.
  const gosuLog = join(root, "gosu.log");
  writeFileSync(gosuLog, "");
  writeFileSync(
    join(bin, "gosu"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GOSU_LOG"\nshift\nexec "$@"\n',
    { mode: 0o755 },
  );

  // #1917 journal-group alignment. `groupadd`/`usermod` are recorded rather than
  // performed (both need root). `stat` and `getent` delegate to the real binaries
  // except for the two lookups a test must control: the journal mount's GID
  // (a test cannot chown a temp dir to an arbitrary group) and the worker's
  // passwd entry.
  const groupLog = join(root, "group.log");
  writeFileSync(groupLog, "");
  for (const cmd of ["groupadd", "usermod"]) {
    writeFileSync(
      join(bin, cmd),
      `#!/bin/sh\nprintf "${cmd} %s\\n" "$*" >> "$GROUP_LOG"\n`,
      { mode: 0o755 },
    );
  }
  writeFileSync(
    join(bin, "stat"),
    [
      "#!/bin/sh",
      // Only the `%g` probe is faked; the sentinel's `%u` probe must stay real.
      'case "$*" in',
      '  *%g*) if [ -n "$FAKE_JOURNAL_GID" ]; then echo "$FAKE_JOURNAL_GID"; exit 0; fi ;;',
      "esac",
      'exec /usr/bin/stat "$@"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "getent"),
    [
      "#!/bin/sh",
      // Both lookups the entrypoint makes are answered from the fixture, never
      // from the host's real passwd/group databases — otherwise the assertions
      // depend on who the CI runner happens to be.
      'case "$1" in',
      "  passwd)",
      '    if [ "$FAKE_PASSWD_LINE" = "NONE" ]; then exit 2; fi',
      '    echo "$FAKE_PASSWD_LINE"; exit 0 ;;',
      "  group)",
      '    if [ -z "$FAKE_GROUP_LINE" ]; then exit 2; fi',
      '    echo "$FAKE_GROUP_LINE"; exit 0 ;;',
      "esac",
      "exit 2",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const source = readFileSync(ENTRYPOINT, "utf8");
  expect(source).toMatch(MOUNT_LOOP);
  const prepared = preparedDirs(source);
  expect(prepared).toContain("/plugins");

  // Every prepared dir is redirected under this run's temp root, so none of them
  // touches the real filesystem. `pluginDir` overrides only `/plugins` — the one
  // the failure-branch test forces — and the rest stay creatable, so exactly one
  // branch is under test at a time.
  const redirected = new Map(prepared.map((d) => [d, join(root, d.replace(/^\//, ""))]));
  if (opts.pluginDir) redirected.set("/plugins", opts.pluginDir);
  const script = join(root, "entrypoint.sh");
  writeFileSync(
    script,
    source
      .replace(MOUNT_LOOP, `for d in ${dirs.join(" ")}; do`)
      .replace(PLUGIN_PREP, (line, dir: string) => line.replaceAll(dir, redirected.get(dir)!)),
  );

  // spawnSync, not execFileSync: the entrypoint WARNS on stderr while still
  // exiting 0 (an unreadable journal must never fail the boot), and execFileSync
  // surfaces stderr only when the child throws.
  const run = spawnSync("sh", [script, "true"], {
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CHOWN_LOG: chownLog,
      GOSU_LOG: gosuLog,
      GROUP_LOG: groupLog,
      SHIPIT_SESSION_WORKER_UID: workerUid,
      // Default to a path that does not exist, so a test that isn't about the
      // journal is unaffected by whether the HOST running the suite happens to
      // have /var/log/journal.
      SHIPIT_JOURNAL_DIRS: (opts.journalDirs ?? [join(root, "no-journal")]).join(" "),
      FAKE_JOURNAL_GID: opts.journalGid ?? "",
      // Synthetic by default so `usermod`'s target user is `shipit` on every
      // machine, and so the drop takes the user form (passwd GID == worker UID).
      FAKE_PASSWD_LINE: opts.passwdLine ?? `shipit:x:${workerUid}:${workerUid}::/home/shipit:/bin/sh`,
      FAKE_GROUP_LINE: opts.groupLine ?? "",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  return {
    status: run.status ?? 1,
    stderr: run.stderr ?? "",
    chowns: readFileSync(chownLog, "utf8").split("\n").filter(Boolean),
    groupOps: readFileSync(groupLog, "utf8").split("\n").filter(Boolean),
    gosu: readFileSync(gosuLog, "utf8").split("\n").filter(Boolean),
    pluginDir: redirected.get("/plugins")!,
    prepChowns: prepared
      .filter((d) => d !== "/plugins" || !opts.pluginDir)
      .map((d) => `${workerUid}:${workerUid} ${redirected.get(d)!}`),
  };
}

/** A journal mount at `dir`, as the ops container sees the host's bind mount. */
function journalDir(): string {
  return mkdtempSync(join(tmpdir(), "shipit-journal-"));
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
    expect(result.chowns).toEqual([
      `-R 1000:1000 ${a}`,
      `-R 1000:1000 ${b}`,
      // Non-recursive, and last: the prepared dirs are plain directories, not
      // mounts, so they need neither a sentinel nor a walk.
      ...result.prepChowns,
    ]);
  });

  // docs/262 — /plugins holds the symlinks into the read-only plugin store. The
  // worker creates them AFTER the privilege drop, and `/` is root-owned, so
  // without a handoff here the non-root worker EACCESes and the agent-facing
  // plugin path silently never appears (found in review; the unit tests used
  // writable temp dirs and could not see it).
  //
  it("prepares the plugin link dir for the worker UID", () => {
    const dir = tempDir();

    const result = runEntrypoint([dir], "1000");

    expect(result.status).toBe(0);
    // Nothing warned — the assertion that catches a prep block the harness
    // failed to redirect, since an unredirected one runs against the real root.
    expect(result.stderr).not.toContain("could not prepare");
    // …and the redirection is not vacuous: every block the script has chowned.
    expect(result.prepChowns.length).toBeGreaterThan(0);
    expect(result.chowns).toEqual(expect.arrayContaining(result.prepChowns));
  });

  // The step is best-effort: on a host where `/` is not writable it must NOT
  // abort the boot under `set -e`, and it must say so on stderr — a missing
  // plugin surface has to be diagnosable, which is how the original EACCES bug
  // hid. The failure is forced with an uncreatable path rather than inferred
  // from the host, which is what made the earlier version of this suite pass in
  // CI and fail in a session container.
  it("never fails the boot when the plugin link dir cannot be prepared, and warns instead", () => {
    const dir = tempDir();

    const result = runEntrypoint([dir], "1000", { pluginDir: UNCREATABLE_PLUGIN_DIR });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not prepare /plugins");
    // The real mounts still got their handoff — one optional step failing must
    // not cost the boot anything else.
    expect(result.chowns).toEqual([`-R 1000:1000 ${dir}`, ...result.prepChowns]);
    // And the worker still starts, under the configured UID.
    expect(result.gosu[0]).toContain("1000");
  });

  it("re-chowns when a restored sentinel is not owned by the worker UID", () => {
    const dir = tempDir();
    // Stand in for the restored, root-owned sentinel: the marker exists but its
    // owner (this test's uid) differs from the configured worker UID.
    mkdirSync(join(dir, ".shipit-uid-4242"));

    const result = runEntrypoint([dir], "4242");

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R 4242:4242 ${dir}`, ...result.prepChowns]);
  });

  it("skips the recursive walk when the sentinel is already worker-owned", () => {
    const dir = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    mkdirSync(join(dir, `.shipit-uid-${uid}`));

    const result = runEntrypoint([dir], uid);

    expect(result.status).toBe(0);
    // The MOUNT walk is skipped; the prepared dirs are not mounts and are
    // prepared regardless.
    expect(result.chowns).toEqual(result.prepChowns);
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
    expect(result.chowns).toEqual([`-R 1000:1000 ${writable}`, ...result.prepChowns]);
  });
});

/**
 * #1917 — an ops session could not read the host journal: `journalctl -D
 * /var/log/journal` returned only user-scoped noise, and `id` reported
 * `groups=1000(shipit)` even though the ops image's build ASSERTS that shipit is
 * in `systemd-journal` and `adm`. Two independent defects:
 *
 *   1. GID. The host's journal files are 0640 root:systemd-journal and a bind
 *      mount carries the *numeric* GID through unchanged, but the image's
 *      `groupadd -rf systemd-journal` allocates whatever GID is free in the
 *      image. Matching by name is not matching at all.
 *   2. The drop. `gosu <uid>:<gid>` calls setgroups() with an empty list, so
 *      whatever the image or step 1 established was discarded microseconds
 *      before the agent started.
 */
describe("host journal readability (#1917)", () => {
  it("joins the group that actually owns the mount, by the host's GID", () => {
    const mount = journalDir();

    // GID 143 exists on the host but not in this image — the create branch.
    const result = runEntrypoint([tempDir()], "1000", {
      journalDirs: [mount],
      journalGid: "143",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([
      "groupadd -g 143 shipit-journal-143",
      "usermod -aG shipit-journal-143 shipit",
    ]);
  });

  it("reuses an existing group when one already carries the host GID", () => {
    const mount = journalDir();

    // A container group already carries GID 143 — the image's own
    // `systemd-journal` happening to line up with the host's. Nothing is created.
    const result = runEntrypoint([tempDir()], "1000", {
      journalDirs: [mount],
      journalGid: "143",
      groupLine: "systemd-journal:x:143:",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps.some((c) => c.startsWith("groupadd"))).toBe(false);
    expect(result.groupOps).toContain("usermod -aG systemd-journal shipit");
  });

  it("covers every mounted journal path, not just the first", () => {
    const result = runEntrypoint([tempDir()], "1000", {
      journalDirs: [journalDir(), journalDir()],
      journalGid: "143",
    });

    expect(result.groupOps.filter((c) => c.startsWith("usermod"))).toHaveLength(2);
  });

  it("never joins GID 0 — that is a privilege gain, not a read grant", () => {
    const result = runEntrypoint([tempDir()], "1000", {
      journalDirs: [journalDir()],
      journalGid: "0",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([]);
  });

  it("ignores a non-numeric GID rather than creating a junk group", () => {
    const result = runEntrypoint([tempDir()], "1000", {
      journalDirs: [journalDir()],
      journalGid: "not-a-gid",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([]);
  });

  it("touches no groups for a session with no journal mounted", () => {
    // Every non-ops session takes this path.
    const result = runEntrypoint([tempDir()], "1000");

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([]);
  });

  it("drops privileges with the gosu USER form so the groups survive", () => {
    // THE regression guard. `gosu 1000:1000` wipes the supplementary set, which
    // is what made the image's build-time membership invisible at runtime.
    const result = runEntrypoint([tempDir()], "1000");

    expect(result.status).toBe(0);
    expect(result.gosu).toEqual(["1000 true"]);
    expect(result.gosu.some((c) => c.includes("1000:1000"))).toBe(false);
  });

  it("still boots, loudly, when the worker UID has no passwd entry", () => {
    // The user form would take the primary GID from passwd, so with no entry we
    // must keep the old explicit form rather than guess.
    const result = runEntrypoint([tempDir()], "1000", { passwdLine: "NONE" });

    expect(result.status).toBe(0);
    expect(result.gosu).toEqual(["1000:1000 true"]);
    expect(result.stderr).toContain("without supplementary groups");
  });

  it("keeps the explicit uid:gid form when passwd's primary GID disagrees", () => {
    // Running under the wrong primary group is a worse failure than an
    // unreadable journal, so this case must not silently switch forms.
    const result = runEntrypoint([tempDir()], "1000", {
      passwdLine: "shipit:x:1000:2000::/home/shipit:/bin/sh",
    });

    expect(result.gosu).toEqual(["1000:1000 true"]);
    expect(result.stderr).toContain("without supplementary groups");
  });

  it("leaves the legacy root runtime untouched", () => {
    // Flag off (docs/150): no chown, no group work, no drop at all.
    const result = runEntrypoint([tempDir()], "", {
      journalDirs: [journalDir()],
      journalGid: "143",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([]);
    expect(result.gosu).toEqual([]);
  });
});
