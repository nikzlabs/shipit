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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
 * The prep blocks that create a directory AS THE WORKER via gosu instead of as
 * root — same redirection discipline as {@link PLUGIN_PREP}, different shape
 * because they need no chown.
 *
 * A block belongs here when its target is one root cannot write. The mounts the
 * orchestrator hands to the session uid are sealed 0700 before the container
 * starts (`chownSessionCredentialsTree` -> `sealDirMode`), and the container
 * drops DAC_OVERRIDE — so a root `mkdir` into `/credentials` can only ever fail.
 * That is not hypothetical: OpenCode's credential dir shipped in the root form
 * and every production boot silently warned, leaving `~/.local/share/opencode` a
 * dangling symlink and killing the agent with EEXIST at startup.
 */
const GOSU_PREP =
  /^if ! gosu "\$\{UID_GID\}:\$\{WORKER_GID\}" mkdir -p (\/[\w-][\w./-]*) 2>\/dev\/null; then$/gm;

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

/** The dirs prepared via gosu, derived from the script for the same reason. */
function gosuPreparedDirs(source: string): string[] {
  return [...source.matchAll(GOSU_PREP)].map((m) => m[1]!);
}

/**
 * The handoff-scheme version the script currently stamps, read from the script
 * rather than hardcoded here.
 *
 * docs/272 — a sentinel names the identity AND the scheme, so that bumping what
 * the walk DOES actually reaches trees an earlier image already claimed. Reading
 * the value means a future bump does not need an edit in every test below; a
 * test that hardcoded it would go green while asserting the old name.
 */
const HANDOFF_SCHEME = (() => {
  const m = /^HANDOFF_SCHEME=(\d+)$/m.exec(readFileSync(ENTRYPOINT, "utf8"));
  if (!m) throw new Error("entrypoint.sh no longer defines HANDOFF_SCHEME");
  return m[1]!;
})();

/** The per-session mount sentinel the current script would look for. */
function uidSentinel(uid: string, gid: string): string {
  return `.shipit-uid-${uid}-${gid}-v${HANDOFF_SCHEME}`;
}

/** The shared-mount (/dep-cache) sentinel the current script would look for. */
function gidSentinel(gid: string): string {
  return `.shipit-gid-${gid}-v${HANDOFF_SCHEME}`;
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
  /**
   * The final privilege drop — the LAST gosu invocation. gosu is used for prep
   * steps too (the OpenCode credential dir, and the readonly-home symlinks), so
   * "the drop" is never `gosu[0]`; an assertion about WHICH form the drop takes
   * must read this rather than index the raw log.
   */
  gosuDrop: string | undefined;
  /** The gosu invocations that are not the drop, in script order. */
  gosuPreps: string[];
  /** The path each gosu-prepared dir was redirected to, in script order. */
  gosuPrepDirs: string[];
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
  /**
   * docs/270 — the SHARED gid, forwarded as `SHIPIT_SESSION_WORKER_GID`. Left
   * unset by default so every pre-docs/270 assertion still describes an
   * orchestrator that forwards only the UID, which the entrypoint must keep
   * booting unchanged.
   */
  workerGid?: string;
  /**
   * Make the stubbed `usermod` fail, standing in for a read-only `/etc`
   * (`SESSION_READONLY_ROOTFS=1`). That is the one boot where the entrypoint
   * genuinely cannot give an allocated uid a passwd entry, so it must fall back
   * to the supplementary-group-clearing drop and say so.
   */
  usermodFails?: boolean;
  /**
   * Make the SHARED-mount group handoff (`chown -R :<gid>`) fail, standing in
   * for a shared cache the walk genuinely could not repair. The stub's normal
   * writability check can't express this: the loop already skipped every mount
   * it cannot write, so by the time the shared branch runs, `chown` on that
   * target always succeeds.
   */
  sharedChownFails?: boolean;
}

function runEntrypoint(dirs: string[], workerUid: string, opts: RunOpts = {}): RunResult {
  const workerGid = opts.workerGid ?? workerUid;
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
      // The group-only form is the shared-mount handoff; a test can force it to
      // fail without affecting any other chown the boot makes.
      ...(opts.sharedChownFails
        ? ['case "$2" in :*) echo "chown: cannot access" >&2; exit 1 ;; esac']
        : []),
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
  writeFileSync(join(root, "usermod.marker"), "");
  writeFileSync(
    join(bin, "groupadd"),
    '#!/bin/sh\nprintf "groupadd %s\\n" "$*" >> "$GROUP_LOG"\n',
    { mode: 0o755 },
  );
  // docs/270 — `usermod -u` must MODEL its effect, not just record the call.
  // The entrypoint runs it so that the passwd lookups AFTER it succeed; a stub
  // that only logs leaves `getent` answering "NONE" forever, so a test could
  // not tell a correctly-ordered `usermod` from one placed after the block that
  // needs it. Dropping a marker that the `getent` stub reads makes the ordering
  // observable — which is the property that actually broke in review.
  writeFileSync(
    join(bin, "usermod"),
    [
      "#!/bin/sh",
      'printf "usermod %s\\n" "$*" >> "$GROUP_LOG"',
      // `usermod -u <uid> shipit` — record the uid it moved the account to.
      '[ "$USERMOD_FAILS" = "1" ] && exit 1',
      'case "$1" in -u) printf "%s" "$2" > "$USERMOD_MARKER" ;; esac',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, "stat"),
    [
      "#!/bin/sh",
      // Only the `%g` probe ON A JOURNAL DIR is faked. docs/270 gave the mount
      // loop `%g` probes of its own (the shared-mount sentinel), and a blanket
      // `*%g*` fake answered those from the journal fixture too — which would
      // make a sentinel test pass or fail depending on whether the run happened
      // to set FAKE_JOURNAL_GID. The sentinel's own `%u`/`%g` probes must stay
      // real, so match on the path, not just the format.
      'last=""; for a in "$@"; do last=$a; done',
      'case "$*" in',
      '  *%g*)',
      '    for j in $SHIPIT_JOURNAL_DIRS; do',
      '      if [ "$j" = "$last" ] && [ -n "$FAKE_JOURNAL_GID" ]; then',
      '        echo "$FAKE_JOURNAL_GID"; exit 0',
      "      fi",
      "    done ;;",
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
      // A passwd entry the stubbed `usermod` created — the account moved onto
      // the allocated uid, keeping the image's primary gid.
      '    if [ -s "$USERMOD_MARKER" ] && [ "$2" = "$(cat "$USERMOD_MARKER")" ]; then',
      // eslint-disable-next-line no-template-curly-in-string -- shell expansion, not a JS template
      '      echo "shipit:x:$2:${FAKE_MOVED_GID}::/home/shipit:/bin/sh"; exit 0',
      "    fi",
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
  // Same anchor discipline, and non-vacuous: a reshaped gosu prep block must
  // fail loudly here rather than silently escape redirection and run against the
  // real /credentials — which in a ShipIt session container EXISTS.
  const gosuPrepared = gosuPreparedDirs(source);
  expect(gosuPrepared).toContain("/credentials/.local/share/opencode");

  // Every prepared dir is redirected under this run's temp root, so none of them
  // touches the real filesystem. `pluginDir` overrides only `/plugins` — the one
  // the failure-branch test forces — and the rest stay creatable, so exactly one
  // branch is under test at a time.
  const redirected = new Map(
    [...prepared, ...gosuPrepared].map((d) => [d, join(root, d.replace(/^\//, ""))]),
  );
  if (opts.pluginDir) redirected.set("/plugins", opts.pluginDir);
  const script = join(root, "entrypoint.sh");
  writeFileSync(
    script,
    source
      .replace(MOUNT_LOOP, `for d in ${dirs.join(" ")}; do`)
      .replace(PLUGIN_PREP, (line, dir: string) => line.replaceAll(dir, redirected.get(dir)!))
      .replace(GOSU_PREP, (line, dir: string) => line.replaceAll(dir, redirected.get(dir)!)),
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
      USERMOD_MARKER: join(root, "usermod.marker"),
      USERMOD_FAILS: opts.usermodFails ? "1" : "0",
      FAKE_MOVED_GID: workerGid,
      SHIPIT_SESSION_WORKER_UID: workerUid,
      // Default to a path that does not exist, so a test that isn't about the
      // journal is unaffected by whether the HOST running the suite happens to
      // have /var/log/journal.
      SHIPIT_JOURNAL_DIRS: (opts.journalDirs ?? [join(root, "no-journal")]).join(" "),
      FAKE_JOURNAL_GID: opts.journalGid ?? "",
      // Synthetic by default so `usermod`'s target user is `shipit` on every
      // machine, and so the drop takes the user form (passwd GID == worker UID).
      ...(opts.workerGid ? { SHIPIT_SESSION_WORKER_GID: opts.workerGid } : {}),
      FAKE_PASSWD_LINE: opts.passwdLine ?? `shipit:x:${workerUid}:${workerGid}::/home/shipit:/bin/sh`,
      FAKE_GROUP_LINE: opts.groupLine ?? "",
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const gosu = readFileSync(gosuLog, "utf8").split("\n").filter(Boolean);

  return {
    status: run.status ?? 1,
    stderr: run.stderr ?? "",
    chowns: readFileSync(chownLog, "utf8").split("\n").filter(Boolean),
    groupOps: readFileSync(groupLog, "utf8").split("\n").filter(Boolean),
    gosu,
    gosuDrop: gosu.at(-1),
    gosuPreps: gosu.slice(0, -1),
    gosuPrepDirs: gosuPrepared.map((d) => redirected.get(d)!),
    pluginDir: redirected.get("/plugins")!,
    prepChowns: prepared
      .filter((d) => d !== "/plugins" || !opts.pluginDir)
      .map((d) => `${workerUid}:${workerGid} ${redirected.get(d)!}`),
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
    expect(result.gosuDrop).toContain("1000");
  });

  // docs/268 — OpenCode's credential home. The image symlinks
  // ~/.local/share/opencode at /credentials/.local/share/opencode, so when the
  // target is missing the link DANGLES — and mkdir(2) on a dangling symlink
  // returns EEXIST, which OpenCode's Bun runtime surfaces raw instead of
  // converting. The agent process dies at startup with
  // `EEXIST: file already exists, mkdir '/home/shipit/.local/share/opencode'`.
  //
  // THE regression guard is the creator's IDENTITY, not that a mkdir happened.
  // The first version ran as root and could never work in production: the
  // orchestrator seals the per-session credentials subtree 0700 to the session's
  // own uid BEFORE the container starts, and the container drops DAC_OVERRIDE,
  // so root has no way in — the entrypoint's own mount loop skips /credentials
  // for exactly that reason. Asserting only that the directory exists would pass
  // on the broken form here, where the harness runs unprivileged against a temp
  // dir it already owns.
  it("creates OpenCode's credential dir as the WORKER, never as root", () => {
    for (const [uid, gid] of [
      ["1000", undefined],
      // docs/270 — an allocated per-session uid with the SHARED gid.
      ["2000001", "1000"],
    ] as const) {
      const result = runEntrypoint([tempDir()], uid, gid ? { workerGid: gid } : {});

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("could not prepare");
      expect(result.gosuPrepDirs.length).toBeGreaterThan(0);
      for (const dir of result.gosuPrepDirs) {
        expect(existsSync(dir)).toBe(true);
        expect(result.gosuPreps).toContain(`${uid}:${gid ?? uid} mkdir -p ${dir}`);
        // No chown: the worker created it, so it already owns it. This is also
        // what proves the root `mkdir -p && chown` form is gone.
        expect(result.chowns.some((c) => c.includes(dir))).toBe(false);
      }
    }
  });

  it("re-chowns when a restored sentinel is not owned by the worker UID", () => {
    const dir = tempDir();
    // Stand in for the restored, root-owned sentinel: the marker exists but its
    // owner (this test's uid) differs from the configured worker UID.
    mkdirSync(join(dir, uidSentinel("4242", "4242")));

    const result = runEntrypoint([dir], "4242");

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R 4242:4242 ${dir}`, ...result.prepChowns]);
  });

  it("skips the recursive walk when the sentinel is already worker-owned", () => {
    const dir = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    // The sentinel has to satisfy BOTH halves of the entrypoint's check, and the
    // directory this test creates lands with the process's real GID — which is
    // not the UID on every machine (a ShipIt session container runs uid != gid,
    // e.g. 2000004:1000). Reusing the uid as the gid made the `%g` comparison
    // fail there, so the walk re-ran and the assertion this test exists for
    // could not hold — a harness bug that reported itself as a product bug on
    // exactly the machine the harness doc says to be careful about.
    const gid = String(process.getgid?.() ?? 0);
    mkdirSync(join(dir, uidSentinel(uid, gid)));

    const result = runEntrypoint([dir], uid, { workerGid: gid });

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
    expect(result.gosuDrop).toBe("1000 true");
    expect(result.gosuDrop).not.toContain("1000:1000");
  });

  it("gives a UID with no passwd entry one, rather than dropping lossily", () => {
    // Before docs/270 this case took the explicit `uid:gid` form, which calls
    // setgroups() with an empty list. That was right when "no passwd entry"
    // meant a custom UID nobody had prepared; it is wrong now, when it is the
    // ordinary state of every allocated per-session uid. `usermod` moves the
    // image's own account onto it, so the user form applies and the
    // supplementary groups survive (req 10).
    const result = runEntrypoint([tempDir()], "1000", { passwdLine: "NONE" });

    expect(result.status).toBe(0);
    expect(result.groupOps).toContain("usermod -u 1000 shipit");
    expect(result.gosuDrop).toBe("1000 true");
    expect(result.stderr).not.toContain("without supplementary groups");
  });

  it("still boots, loudly, when the account cannot be moved at all", () => {
    // Read-only /etc. There is genuinely no passwd entry to be had, so the drop
    // keeps the old explicit form rather than guessing a primary GID — running
    // under the wrong one is a worse failure than an unreadable journal.
    const result = runEntrypoint([tempDir()], "1000", {
      passwdLine: "NONE",
      usermodFails: true,
    });

    expect(result.status).toBe(0);
    expect(result.gosuDrop).toBe("1000:1000 true");
    expect(result.stderr).toContain("could not move the shipit account");
    expect(result.stderr).toContain("without supplementary groups");
  });

  it("keeps the explicit uid:gid form when passwd's primary GID disagrees", () => {
    // Running under the wrong primary group is a worse failure than an
    // unreadable journal, so this case must not silently switch forms.
    const result = runEntrypoint([tempDir()], "1000", {
      passwdLine: "shipit:x:1000:2000::/home/shipit:/bin/sh",
    });

    expect(result.gosuDrop).toBe("1000:1000 true");
    expect(result.stderr).toContain("without supplementary groups");
  });

  // ---- docs/270: per-session uids, one shared gid ----

  it("chowns a per-session mount to the allocated uid and the SHARED gid", () => {
    const dir = tempDir();

    const result = runEntrypoint([dir], "2000001", { workerGid: "1000" });

    expect(result.status).toBe(0);
    // Not `2000001:2000001`. The gid is shared on purpose — it is what keeps the
    // dep cache, the pnpm store and the overlay base usable by a session that
    // did not create them (req 9).
    expect(result.chowns).toEqual([`-R 2000001:1000 ${dir}`, ...result.prepChowns]);
  });

  it("rotates the sentinel when only the GID changes", () => {
    const dir = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    // A sentinel from a boot at the same uid but a different gid. Stamping the
    // uid alone would read this as "already handed off" and skip the walk,
    // leaving every file group-owned by a gid nothing uses any more.
    mkdirSync(join(dir, uidSentinel(uid, "4242")));

    const result = runEntrypoint([dir], uid, { workerGid: "1000" });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R ${uid}:1000 ${dir}`, ...result.prepChowns]);
  });

  it("hands a SHARED mount over by group, never by owner", () => {
    // The name matters: the branch is suffix-matched so this reaches it.
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);

    const result = runEntrypoint([shared], "2000001", { workerGid: "1000" });

    expect(result.status).toBe(0);
    // `:1000` — the owner is deliberately untouched. `-R 2000001:1000` here
    // would take the shared cache away from every other session, which is the
    // EACCES-with-no-recovery this mount's own docstring warns about, arriving
    // by a new route.
    expect(result.chowns).toEqual([`-R :1000 ${shared}`, ...result.prepChowns]);
  });

  it("does not re-walk a shared mount whose group is already the shared gid", () => {
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    // Stand in for a cache another session already handed over: the sentinel
    // exists and carries the shared gid. Without the gid-stamped sentinel this
    // walk would run once per SESSION over a multi-gigabyte cache.
    const gid = String(process.getgid?.() ?? 0);
    mkdirSync(join(shared, gidSentinel(gid)));

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual(result.prepChowns);
  });

  // --- docs/272: the sentinel stamps the handoff SCHEME, not just the identity
  //
  // The production shape these exist for: a shared `/dep-cache` claimed by an
  // earlier image keeps that image's treatment for good, because the sentinel
  // has no way to say "the walk changed". Every session of that repo then hits
  // EACCES on cache entries another session wrote — which npm reports as
  // "your cache folder contains root-owned files" on a cache that is not
  // root-owned at all, sending the reader somewhere with no fix in it.

  // Running as root defeats a 0555 stand-in, exactly as it does for the :ro
  // test above — access(2) grants W_OK to root on a permission-bound dir *when
  // it has CAP_DAC_OVERRIDE*, which a root test runner does and a session
  // container does not. CI runs unprivileged, so the guard holds there.
  it.skipIf(isRoot)("hands off a shared cache it cannot WRITE, which is the whole fault", () => {
    // The production root cause, in one fixture. `[ -w "$d" ] || continue` was
    // written on the premise that root passes W_OK for every read-write mount.
    // It does not: that needs CAP_DAC_OVERRIDE, and the session container drops
    // it (measured bounding set: CHOWN, FOWNER, KILL, SETGID, SETUID). A
    // /dep-cache chowned away from root by the handoff's OWN first run is then
    // `other`-class `r-x` to root, so the probe skipped it on every later boot
    // and the branch that would repair it was never reached — self-latching, and
    // it silently disabled docs/270's group+setgid pass and docs/271's group
    // write on every deployment that had ever claimed a cache.
    //
    // The walk needs CAP_CHOWN and CAP_FOWNER, not write permission, so being
    // unable to write the directory must NOT stop it.
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    const gid = String(process.getgid?.() ?? 0);
    chmodSync(shared, 0o555);
    restoreWritable.push(shared);

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R :${gid} ${shared}`, ...result.prepChowns]);
  });

  it("writes the shared sentinel as the WORKER, never as root", () => {
    // Root cannot create it: no CAP_DAC_OVERRIDE, and a shared cache is not
    // root-owned. Only the uid the walk has just made group-writable can, which
    // is also why the sentinel can only be written AFTER the walk rather than
    // claimed before it.
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    const gid = String(process.getgid?.() ?? 0);

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.gosuPreps).toContain(`2000001:${gid} mkdir ${join(shared, gidSentinel(gid))}`);
    expect(existsSync(join(shared, gidSentinel(gid)))).toBe(true);
  });

  it("re-walks a shared cache whose sentinel is from a superseded handoff scheme", () => {
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    const gid = String(process.getgid?.() ?? 0);
    // The pre-docs/272 name: right gid, no scheme. Existence alone used to mean
    // "handed off", so the mode passes added since never reached this cache.
    mkdirSync(join(shared, `.shipit-gid-${gid}`));

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R :${gid} ${shared}`, ...result.prepChowns]);
    // And the superseded sentinel is not left behind to accumulate one dir per
    // deployment — but only because the walk that supersedes it succeeded.
    expect(existsSync(join(shared, `.shipit-gid-${gid}`))).toBe(false);
    expect(existsSync(join(shared, gidSentinel(gid)))).toBe(true);
  });

  it("re-walks a per-session mount whose sentinel is from a superseded scheme", () => {
    const dir = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    mkdirSync(join(dir, `.shipit-uid-${uid}-${gid}`));

    const result = runEntrypoint([dir], uid, { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R ${uid}:${gid} ${dir}`, ...result.prepChowns]);
    expect(existsSync(join(dir, `.shipit-uid-${uid}-${gid}`))).toBe(false);
    expect(existsSync(join(dir, uidSentinel(uid, gid)))).toBe(true);
  });

  it("writes no sentinel when the shared-cache handoff fails, so the next boot retries", () => {
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    const gid = String(process.getgid?.() ?? 0);

    const result = runEntrypoint([shared], "2000001", {
      workerGid: gid,
      sharedChownFails: true,
    });

    // A boot that survives is half the requirement; the other half is that it
    // leaves NO sentinel. A sentinel is a record that the handoff HAPPENED, so
    // it is written only after the walk returns — one that latched a failure
    // would make every later boot skip a walk that never ran.
    expect(result.status).toBe(0);
    expect(existsSync(join(shared, gidSentinel(gid)))).toBe(false);
    expect(result.stderr).toContain("did not complete");
  });

  it("keeps its claim when only the shared cache's MODE pass fails", () => {
    // A shared cache is written concurrently by every session of its repo, so a
    // file another session unlinks mid-walk makes `chmod -R` return non-zero
    // routinely. That must neither kill the boot (it is a simple command under
    // `set -e`) nor release a claim whose GROUP handoff — the part the handoff
    // is actually for — did succeed.
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    const gid = String(process.getgid?.() ?? 0);
    // An unreadable subdirectory makes `chmod -R` report a failure and exit
    // non-zero after descending as far as it can — the same shape as the walk
    // losing a path another session unlinked under it, and reproducible.
    const unreadable = join(shared, "sub");
    mkdirSync(unreadable);
    writeFileSync(join(unreadable, "entry"), "");
    chmodSync(unreadable, 0o000);
    restoreWritable.push(unreadable);

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R :${gid} ${shared}`, ...result.prepChowns]);
    expect(existsSync(join(shared, gidSentinel(gid)))).toBe(true);
    // And the pass AFTER the failing one still ran: setgid on the cache root is
    // what makes an entry a later session creates inherit the shared group, so
    // an aborted handoff would be silently worse than no handoff.
    expect(statSync(shared).mode & 0o2000).toBe(0o2000);
  });

  it("moves the image account onto an allocated uid so the drop keeps its groups", () => {
    // An allocated uid has no passwd entry in the image, so without this the
    // drop takes the setgroups-clearing form on EVERY session and ops sessions
    // silently lose the host journal (req 10).
    const result = runEntrypoint([tempDir()], "2000001", {
      workerGid: "1000",
      passwdLine: "NONE",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toContain("usermod -u 2000001 shipit");
  });

  it("does not touch the image account when the uid already resolves", () => {
    // The pre-docs/270 case: uid 1000 IS the image's `shipit`. Running usermod
    // there would be a pointless mutation of /etc on every boot.
    const result = runEntrypoint([tempDir()], "1000");

    expect(result.status).toBe(0);
    expect(result.groupOps.some((c) => c.startsWith("usermod -u"))).toBe(false);
    expect(result.gosuDrop).toBe("1000 true");
  });

  it("aligns the journal group for an allocated uid, which needs usermod FIRST", () => {
    // The ordering defect this catches: the journal block resolves the worker's
    // account with `getent passwd "$UID_GID"` and `break`s when there is none.
    // With `usermod` placed next to the drop it enables — after this block —
    // an allocated uid is moved onto an account the journal group was never
    // added to, the drop still succeeds, and the journal is silently
    // unreadable. Indistinguishable from having no `usermod` at all, which is
    // why asserting that `usermod` merely RAN is not enough.
    const journal = journalDir();

    const result = runEntrypoint([tempDir()], "2000001", {
      workerGid: "1000",
      passwdLine: "NONE",
      journalDirs: [journal],
      journalGid: "143",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([
      "usermod -u 2000001 shipit",
      "groupadd -g 143 shipit-journal-143",
      "usermod -aG shipit-journal-143 shipit",
    ]);
  });

  it("takes the supplementary-group-preserving drop for an allocated uid", () => {
    // What `usermod` buys: a passwd entry for the allocated uid whose primary
    // gid is the shared one, so `gosu <uid>` (the user form) applies.
    const result = runEntrypoint([tempDir()], "2000001", {
      workerGid: "1000",
      passwdLine: "shipit:x:2000001:1000::/home/shipit:/bin/sh",
    });

    expect(result.status).toBe(0);
    expect(result.gosuDrop).toBe("2000001 true");
    expect(result.stderr).not.toContain("without supplementary groups");
  });

  // ---- docs/270: the workspace walk must not re-own hardlinked git objects ----

  /**
   * Run the entrypoint's own `chown_workspace` against a fixture tree.
   *
   * Extracted and EXECUTED rather than asserted against as source. The branch
   * cannot be reached through {@link runEntrypoint} without putting a real
   * `/workspace` in the mount list, and the thing under test is a `find`
   * expression whose prune/`-o` precedence no amount of reading proves. The
   * anchor is the function's own definition line, so a rename or a reshape fails
   * here loudly instead of silently testing nothing.
   *
   * `shipitDepDirs` stands in for the orchestrator-forwarded SHIPIT_DEP_DIRS
   * (planning#415): `undefined` = an orchestrator that predates the variable,
   * `""` = an explicitly empty list, anything else = the colon-joined
   * `agent.dep-dirs` value.
   */
  function runChownWorkspace(tree: string, shipitDepDirs?: string): string[] {
    const source = readFileSync(ENTRYPOINT, "utf8");
    const start = source.indexOf("chown_workspace() {");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const fn = source.slice(start, end + 3);

    const root = mkdtempSync(join(tmpdir(), "shipit-chownws-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const log = join(root, "chown.log");
    writeFileSync(log, "");
    writeFileSync(
      join(bin, "chown"),
      '#!/bin/sh\nshift 2\nfor a in "$@"; do printf "%s\\n" "$a" >> "$CHOWN_LOG"; done\n',
      { mode: 0o755 },
    );
    const script = join(root, "fragment.sh");
    writeFileSync(script, `set -eu\nUID_GID=2000001\nWORKER_GID=1000\n${fn}\nchown_workspace "$1"\n`);
    const run = spawnSync("sh", [script, tree], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CHOWN_LOG: log,
        ...(shipitDepDirs === undefined ? {} : { SHIPIT_DEP_DIRS: shipitDepDirs }),
      },
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    return readFileSync(log, "utf8").split("\n").filter(Boolean).sort();
  }

  it("chowns object DIRECTORIES but never the hardlinked object FILES", () => {
    // `git clone --local` hardlinks `.git/objects` from the shared bare cache
    // into every session clone — measured: bare and two clones report the same
    // inode. An inode has one owner across all its links, so chowning an object
    // file here would hand THIS session ownership (chmod and rewrite rights) of
    // content every sibling session and the cache read. Under one shared uid
    // that was invisible; under per-session uids it is the cross-session write
    // docs/270 exists to close.
    const tree = tempDir();
    mkdirSync(join(tree, ".git/objects/4d"), { recursive: true });
    mkdirSync(join(tree, ".git/objects/pack"), { recursive: true });
    mkdirSync(join(tree, ".git/lfs/objects/ab/cd"), { recursive: true });
    mkdirSync(join(tree, ".pnpm-store/v3"), { recursive: true });
    mkdirSync(join(tree, "src"), { recursive: true });
    for (const f of [
      ".git/config", ".git/objects/4d/deadbeef", ".git/objects/pack/p.pack",
      ".git/lfs/objects/ab/cd/oid", ".pnpm-store/v3/blob", "src/a.ts",
    ]) writeFileSync(join(tree, f), "");

    const chowned = runChownWorkspace(tree);

    // The object FILES are absent…
    expect(chowned).not.toContain(join(tree, ".git/objects/4d/deadbeef"));
    expect(chowned).not.toContain(join(tree, ".git/objects/pack/p.pack"));
    expect(chowned).not.toContain(join(tree, ".git/lfs/objects/ab/cd/oid"));
    // …but the object DIRECTORIES are there, or the worker could not create a
    // new object inside a fanout directory.
    expect(chowned).toContain(join(tree, ".git/objects/4d"));
    expect(chowned).toContain(join(tree, ".git/objects/pack"));
    expect(chowned).toContain(join(tree, ".git/lfs/objects/ab/cd"));
    // Ordinary content is untouched by the exclusion — the walk is not a no-op.
    expect(chowned).toContain(join(tree, "src/a.ts"));
    expect(chowned).toContain(join(tree, ".git/config"));
  });

  // docs/271 / github#2374 — the handoff chowned the checkout and left its mode
  // alone, so a root-materialized tree stayed 0644/0755 and the only channel a
  // Compose service has into the workspace (the shared group, since it can never
  // be the owner) carried read and not write.
  it("leaves the workspace group-writable, without re-moding hardlinked objects", () => {
    const tree = tempDir();
    mkdirSync(join(tree, ".git/objects/4d"), { recursive: true });
    mkdirSync(join(tree, ".git/lfs/objects/ab/cd"), { recursive: true });
    mkdirSync(join(tree, "src"), { recursive: true });
    for (const f of [
      ".git/objects/4d/deadbeef", ".git/lfs/objects/ab/cd/oid", "src/a.ts", "run.sh",
    ]) {
      writeFileSync(join(tree, f), "");
    }
    chmodSync(join(tree, ".git/lfs/objects/ab/cd/oid"), 0o444);
    chmodSync(join(tree, "src"), 0o755);
    chmodSync(join(tree, "src/a.ts"), 0o644);
    chmodSync(join(tree, "run.sh"), 0o755);
    // A hardlinked object file: 0444, and its mode belongs to an inode the bare
    // cache and every sibling clone share.
    chmodSync(join(tree, ".git/objects/4d/deadbeef"), 0o444);

    runChownWorkspace(tree);

    const mode = (p: string) => statSync(join(tree, p)).mode & 0o7777;
    // Directories: group write + traverse, and setgid so an entry a service
    // creates inherits the shared group rather than the service's own.
    expect(mode("src")).toBe(0o2775);
    // Files: group write; `X` keeps an executable executable and promotes
    // nothing that was not.
    expect(mode("src/a.ts")).toBe(0o664);
    expect(mode("run.sh")).toBe(0o775);
    // The object files are left exactly as they were — same reason they are not
    // chowned. LFS asserted beside git's own store: the two are separate patterns
    // in the `find`, so one can be dropped without the other failing.
    expect(mode(".git/objects/4d/deadbeef")).toBe(0o444);
    expect(mode(".git/lfs/objects/ab/cd/oid")).toBe(0o444);
    // The object DIRECTORY is moded, or the worker could not add an object.
    expect(mode(".git/objects/4d")).toBe(0o2775);
  });

  it("does not descend into the shared pnpm store", () => {
    // Mounted NESTED under /workspace and shared per runtime, so it gets the
    // group treatment from the orchestrator instead. A `chown -R` here would
    // take it from every other session.
    const tree = tempDir();
    mkdirSync(join(tree, ".pnpm-store/v3"), { recursive: true });
    writeFileSync(join(tree, ".pnpm-store/v3/blob"), "");
    writeFileSync(join(tree, "keep.txt"), "");

    const chowned = runChownWorkspace(tree);

    expect(chowned.some((p) => p.includes(".pnpm-store"))).toBe(false);
    expect(chowned).toContain(join(tree, "keep.txt"));
  });

  // ---- planning#415: the walk must not descend into the declared dep dirs ----
  //
  // A dep dir mounted as a docs/183 overlay carries a base generation SHARED by
  // every session of the repo as its lowerdir. `chown` sets ATTR_UID whenever
  // the argument is not -1 — even when the value does not change — so chowning
  // a lower-only entry forces a copy-up of that file into this session's
  // private upper layer, which defeats the sharing docs/183 exists for. The
  // fix mirrors the orchestrator-side worktree walk: prune the dep dirs, hand
  // only each ROOT over (the root IS the per-session upperdir's root, so it is
  // an in-place upper operation).

  it("does not descend into a declared dep dir, and hands only its ROOT over", () => {
    const tree = tempDir();
    mkdirSync(join(tree, "node_modules/react"), { recursive: true });
    writeFileSync(join(tree, "node_modules/react/package.json"), "");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src/a.ts"), "");
    // Pin the modes the "untouched" assertions below read: the suite's ambient
    // umask is 002, so a fresh 0777/0666 creation lands 0775/0664 and would
    // make an untouched entry indistinguishable from a chmodded one.
    chmodSync(join(tree, "node_modules/react"), 0o755);
    chmodSync(join(tree, "node_modules/react/package.json"), 0o644);

    const chowned = runChownWorkspace(tree, "node_modules");

    // Exactly ONE node_modules entry — the root, from the shallow pass. The
    // deep walk never reached react/ or its contents.
    expect(chowned.filter((p) => p.includes("node_modules"))).toEqual([
      join(tree, "node_modules"),
    ]);
    // Ordinary content is untouched by the exclusion — the walk is not a no-op.
    expect(chowned).toContain(join(tree, "src/a.ts"));

    // The root got the full shallow treatment: group write + setgid, so the
    // session (and a Compose service at another uid, via the shared group) can
    // create entries in its upper layer…
    expect(statSync(join(tree, "node_modules")).mode & 0o7777).toBe(0o2775);
    // …while everything INSIDE keeps the mode it had — no chmod descended,
    // which on a real overlay is the copy-up storm the prune exists to stop.
    expect(statSync(join(tree, "node_modules/react")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(tree, "node_modules/react/package.json")).mode & 0o7777).toBe(0o644);
  });

  it("prunes every declared dep dir, a nested one included", () => {
    const tree = tempDir();
    for (const d of ["node_modules/x", "client/node_modules/y", "vendor/z", "src"]) {
      mkdirSync(join(tree, d), { recursive: true });
      writeFileSync(join(tree, d, "f"), "");
    }

    const chowned = runChownWorkspace(tree, "node_modules:client/node_modules:vendor");

    // No entry INSIDE any declared dep dir was chowned…
    for (const inside of ["node_modules/x/f", "client/node_modules/y/f", "vendor/z/f"]) {
      expect(chowned).not.toContain(join(tree, inside));
    }
    // …every dep-dir ROOT was, by the shallow pass…
    for (const root of ["node_modules", "client/node_modules", "vendor"]) {
      expect(chowned).toContain(join(tree, root));
    }
    // …and `client` itself is still walked — the prune starts at its child.
    expect(chowned).toContain(join(tree, "client"));
    expect(chowned).toContain(join(tree, "src/f"));
  });

  it("refuses a symlinked dep dir whole, so chmod cannot follow it out of the tree", () => {
    const tree = tempDir();
    const target = tempDir();
    writeFileSync(join(target, "f"), "");
    // mkdtemp lands 0700; pin 0755 so a followed chmod (g+rwxs → 0o2775) is
    // distinguishable from an untouched target.
    chmodSync(target, 0o755);
    symlinkSync(target, join(tree, "vendor"));

    const chowned = runChownWorkspace(tree, "vendor");

    // Neither the link nor what it points at. `chown -h` alone would be safe on
    // the link itself, but the shallow pass also chmods, and `chmod` FOLLOWS a
    // symlink — refusing the whole dep dir is the only coherent answer, and it
    // is the one `reconcileDepDirCacheOwnership` takes orchestrator-side.
    expect(chowned.some((p) => p.includes("vendor"))).toBe(false);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
  });

  it("still descends for an orchestrator that predates the dep-dir list", () => {
    // Deliberately asserted, not assumed: an older orchestrator forwards no
    // SHIPIT_DEP_DIRS, and an explicitly empty list forwards nothing either —
    // both must boot byte-for-byte as before, including the descent. The prune
    // is a new contract between the two sides, not a retrofit of the old boot.
    const tree = tempDir();
    mkdirSync(join(tree, "node_modules/react"), { recursive: true });
    writeFileSync(join(tree, "node_modules/react/package.json"), "");

    for (const depDirs of [undefined, ""]) {
      const chowned = runChownWorkspace(tree, depDirs);
      expect(chowned).toContain(join(tree, "node_modules/react/package.json"));
    }
  });

  it("drops to a group-writable umask, so a shared cache stays shared", () => {
    // req 9. The boot handoff gives /dep-cache and the pnpm store the shared
    // GROUP and setgid, so entries inherit the group — but group WRITE comes
    // from the umask. At the default 022 every entry a session creates lands
    // 0644, and the next session (same group, different uid) can read it and
    // not modify it. npm's cacache APPENDS to its index-v5 entries, so that is
    // an EACCES on the second session's install, not a theoretical loss.
    //
    // Asserted on the script because a umask is process state the chown log
    // cannot show: the stubs record arguments, and `umask` takes none.
    const source = readFileSync(ENTRYPOINT, "utf8");
    const umask = source.indexOf("\numask 002");
    const drop = source.lastIndexOf("exec gosu");
    expect(umask).toBeGreaterThan(-1);
    // Before the drop, so the exec'd worker inherits it.
    expect(umask).toBeLessThan(drop);
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
