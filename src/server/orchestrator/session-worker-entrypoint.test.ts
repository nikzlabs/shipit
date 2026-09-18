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

const MOUNT_LOOP = /^for d in \/workspace .*; do$/m;

const PLUGIN_PREP = /^if ! \(mkdir -p (\/[\w-][\w./-]*) && chown .* \1\) 2>\/dev\/null; then$/gm;

const GOSU_PREP =
  /^if ! gosu "\$\{UID_GID\}:\$\{WORKER_GID\}" mkdir -p (\/[\w-][\w./-]*) 2>\/dev\/null; then$/gm;

// Derive paths so new preparation blocks cannot touch real mounts in tests.
function preparedDirs(source: string): string[] {
  return [...source.matchAll(PLUGIN_PREP)].map((m) => m[1]!);
}

function gosuPreparedDirs(source: string): string[] {
  return [...source.matchAll(GOSU_PREP)].map((m) => m[1]!);
}

const HANDOFF_SCHEME = (() => {
  const m = /^HANDOFF_SCHEME=(\d+)$/m.exec(readFileSync(ENTRYPOINT, "utf8"));
  if (!m) throw new Error("entrypoint.sh no longer defines HANDOFF_SCHEME");
  return m[1]!;
})();

function uidSentinel(uid: string, gid: string): string {
  return `.shipit-uid-${uid}-${gid}-v${HANDOFF_SCHEME}`;
}

function gidSentinel(gid: string): string {
  return `.shipit-gid-${gid}-v${HANDOFF_SCHEME}`;
}

// procfs rejects directory creation, including by root.
const UNCREATABLE_PLUGIN_DIR = "/proc/shipit-no-such-dir/plugins";

const isRoot = process.getuid?.() === 0;

const hasRealSetfacl = (() => {
  try {
    execFileSync("sh", ["-c", "command -v setfacl"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const restoreWritable: string[] = [];
afterEach(() => {
  for (const dir of restoreWritable.splice(0)) chmodSync(dir, 0o755);
});

interface RunResult {
  status: number;
  stderr: string;
  chowns: string[];
  groupOps: string[];
  gosu: string[];
  gosuDrop: string | undefined;
  gosuPreps: string[];
  gosuPrepDirs: string[];
  pluginDir: string;
  prepChowns: string[];
}

interface RunOpts {
  journalDirs?: string[];
  journalGid?: string;
  /** "NONE" makes the lookup fail. */
  passwdLine?: string;
  groupLine?: string;
  pluginDir?: string;
  workerGid?: string;
  hideSetfacl?: boolean;
  usermodFails?: boolean;
  sharedChownFails?: boolean;
}

function runEntrypoint(dirs: string[], workerUid: string, opts: RunOpts = {}): RunResult {
  const workerGid = opts.workerGid ?? workerUid;
  const root = mkdtempSync(join(tmpdir(), "shipit-entrypoint-"));
  const bin = join(root, "bin");
  mkdirSync(bin);

  // Simulate read-only failures without changing real ownership.
  const chownLog = join(root, "chown.log");
  writeFileSync(chownLog, "");
  writeFileSync(
    join(bin, "chown"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$CHOWN_LOG"',
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
  const gosuLog = join(root, "gosu.log");
  writeFileSync(gosuLog, "");
  writeFileSync(
    join(bin, "gosu"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GOSU_LOG"\nshift\nexec "$@"\n',
    { mode: 0o755 },
  );
  if (!opts.hideSetfacl) {
    writeFileSync(join(bin, "setfacl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }

  const groupLog = join(root, "group.log");
  writeFileSync(groupLog, "");
  writeFileSync(join(root, "usermod.marker"), "");
  writeFileSync(
    join(bin, "groupadd"),
    '#!/bin/sh\nprintf "groupadd %s\\n" "$*" >> "$GROUP_LOG"\n',
    { mode: 0o755 },
  );
  // Update the passwd stub so tests detect incorrect usermod ordering.
  writeFileSync(
    join(bin, "usermod"),
    [
      "#!/bin/sh",
      'printf "usermod %s\\n" "$*" >> "$GROUP_LOG"',
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
      // Keep sentinel ownership probes real; fake only journal paths.
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
      'case "$1" in',
      "  passwd)",
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
  const gosuPrepared = gosuPreparedDirs(source);
  expect(gosuPrepared).toContain("/credentials/.local/share/opencode");
  expect(gosuPrepared).toContain("/credentials/.grok");

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
      SHIPIT_JOURNAL_DIRS: (opts.journalDirs ?? [join(root, "no-journal")]).join(" "),
      FAKE_JOURNAL_GID: opts.journalGid ?? "",
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

function journalDir(): string {
  return mkdtempSync(join(tmpdir(), "shipit-journal-"));
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "shipit-mount-"));
}

// The basename selects the workspace branch in the entrypoint.
function workspaceMount(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "shipit-ws-")), "workspace");
  mkdirSync(dir);
  return dir;
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
      ...result.prepChowns,
    ]);
  });

  it("prepares the plugin link dir for the worker UID", () => {
    const dir = tempDir();

    const result = runEntrypoint([dir], "1000");

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("could not prepare");
    expect(result.prepChowns.length).toBeGreaterThan(0);
    expect(result.chowns).toEqual(expect.arrayContaining(result.prepChowns));
  });

  it("never fails the boot when the plugin link dir cannot be prepared, and warns instead", () => {
    const dir = tempDir();

    const result = runEntrypoint([dir], "1000", { pluginDir: UNCREATABLE_PLUGIN_DIR });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not prepare /plugins");
    expect(result.chowns).toEqual([`-R 1000:1000 ${dir}`, ...result.prepChowns]);
    expect(result.gosuDrop).toContain("1000");
  });

  it("creates OpenCode's credential dir as the WORKER, never as root", () => {
    for (const [uid, gid] of [
      ["1000", undefined],
      ["2000001", "1000"],
    ] as const) {
      const result = runEntrypoint([tempDir()], uid, gid ? { workerGid: gid } : {});

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("could not prepare");
      expect(result.gosuPrepDirs.length).toBeGreaterThan(0);
      for (const dir of result.gosuPrepDirs) {
        expect(existsSync(dir)).toBe(true);
        expect(result.gosuPreps).toContain(`${uid}:${gid ?? uid} mkdir -p ${dir}`);
        expect(result.chowns.some((c) => c.includes(dir))).toBe(false);
      }
    }
  });

  it("re-chowns when a restored sentinel is not owned by the worker UID", () => {
    const dir = tempDir();
    mkdirSync(join(dir, uidSentinel("4242", "4242")));

    const result = runEntrypoint([dir], "4242");

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R 4242:4242 ${dir}`, ...result.prepChowns]);
  });

  it("skips the recursive walk when the sentinel is already worker-owned", () => {
    const dir = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    mkdirSync(join(dir, uidSentinel(uid, gid)));

    const result = runEntrypoint([dir], uid, { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual(result.prepChowns);
  });

  // Root can bypass mode 0555, so it cannot use this read-only fixture.
  it.skipIf(isRoot)("skips a mount it cannot write to instead of failing the boot", () => {
    const readOnly = tempDir();
    const writable = tempDir();
    chmodSync(readOnly, 0o555);
    restoreWritable.push(readOnly);

    const result = runEntrypoint([readOnly, writable], "1000");

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/Read-only|Permission denied/);
    expect(result.chowns).toEqual([`-R 1000:1000 ${writable}`, ...result.prepChowns]);
  });

  it.skipIf(isRoot)("walks a workspace it cannot write, which is the only kind there is", () => {
    const ws = workspaceMount();
    writeFileSync(join(ws, "a.ts"), "");
    chmodSync(ws, 0o555);
    restoreWritable.push(ws);

    const result = runEntrypoint([ws], "1000");

    expect(result.status).toBe(0);
    // find controls argument order and batch size.
    expect(result.chowns.some((c) => c.startsWith("-h 1000:1000 ") && c.includes(join(ws, "a.ts"))))
      .toBe(true);
    expect(result.chowns).not.toContain(`-R 1000:1000 ${ws}`);
  });

  it("still claims a root-owned per-session mount through the generic path", () => {
    const mount = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);

    const result = runEntrypoint([mount], uid, { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toContain(`-R ${uid}:${gid} ${mount}`);
    expect(existsSync(join(mount, uidSentinel(uid, gid)))).toBe(true);
  });

  it("skips a workspace already handed over under the CURRENT scheme", () => {
    const ws = workspaceMount();
    writeFileSync(join(ws, "a.ts"), "");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);
    mkdirSync(join(ws, uidSentinel(uid, gid)));

    const result = runEntrypoint([ws], uid, { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual(result.prepChowns);
  });

  it("stamps the current scheme AS THE WORKER after a cold walk", () => {
    const ws = workspaceMount();
    writeFileSync(join(ws, "a.ts"), "");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);

    const result = runEntrypoint([ws], uid, { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.gosuPreps).toContain(`${uid}:${gid} mkdir ${join(ws, uidSentinel(uid, gid))}`);
    expect(existsSync(join(ws, uidSentinel(uid, gid)))).toBe(true);
  });

  // Omitting the stub cannot hide a system setfacl while PATH includes system tools.
  it.skipIf(hasRealSetfacl)("stamps nothing when the ACL step could not run, so the next boot retries", () => {
    const ws = workspaceMount();
    writeFileSync(join(ws, "a.ts"), "");
    const uid = String(process.getuid?.() ?? 0);
    const gid = String(process.getgid?.() ?? 0);

    const result = runEntrypoint([ws], uid, { workerGid: gid, hideSetfacl: true });

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/setfacl not found/);
    expect(result.stderr).toMatch(/will be retried on the next boot/);
    expect(existsSync(join(ws, uidSentinel(uid, gid)))).toBe(false);
    expect(result.chowns).toContain(`-h ${uid}:${gid} ${ws} ${join(ws, "a.ts")}`);
  });
});

describe("host journal readability (#1917)", () => {
  it("joins the group that actually owns the mount, by the host's GID", () => {
    const mount = journalDir();

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
    const result = runEntrypoint([tempDir()], "1000");

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([]);
  });

  it("drops privileges with the gosu USER form so the groups survive", () => {
    const result = runEntrypoint([tempDir()], "1000");

    expect(result.status).toBe(0);
    expect(result.gosuDrop).toBe("1000 true");
    expect(result.gosuDrop).not.toContain("1000:1000");
  });

  it("gives a UID with no passwd entry one, rather than dropping lossily", () => {
    const result = runEntrypoint([tempDir()], "1000", { passwdLine: "NONE" });

    expect(result.status).toBe(0);
    expect(result.groupOps).toContain("usermod -u 1000 shipit");
    expect(result.gosuDrop).toBe("1000 true");
    expect(result.stderr).not.toContain("without supplementary groups");
  });

  it("still boots, loudly, when the account cannot be moved at all", () => {
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
    const result = runEntrypoint([tempDir()], "1000", {
      passwdLine: "shipit:x:1000:2000::/home/shipit:/bin/sh",
    });

    expect(result.gosuDrop).toBe("1000:1000 true");
    expect(result.stderr).toContain("without supplementary groups");
  });

  it("chowns a per-session mount to the allocated uid and the SHARED gid", () => {
    const dir = tempDir();

    const result = runEntrypoint([dir], "2000001", { workerGid: "1000" });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R 2000001:1000 ${dir}`, ...result.prepChowns]);
  });

  it("rotates the sentinel when only the GID changes", () => {
    const dir = tempDir();
    const uid = String(process.getuid?.() ?? 0);
    mkdirSync(join(dir, uidSentinel(uid, "4242")));

    const result = runEntrypoint([dir], uid, { workerGid: "1000" });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R ${uid}:1000 ${dir}`, ...result.prepChowns]);
  });

  it("hands a SHARED mount over by group, never by owner", () => {
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);

    const result = runEntrypoint([shared], "2000001", { workerGid: "1000" });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R :1000 ${shared}`, ...result.prepChowns]);
  });

  it("does not re-walk a shared mount whose group is already the shared gid", () => {
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    const gid = String(process.getgid?.() ?? 0);
    mkdirSync(join(shared, gidSentinel(gid)));

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual(result.prepChowns);
  });

  it.skipIf(isRoot)("hands off a shared cache it cannot WRITE, which is the whole fault", () => {
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
    mkdirSync(join(shared, `.shipit-gid-${gid}`));

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R :${gid} ${shared}`, ...result.prepChowns]);
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

    expect(result.status).toBe(0);
    expect(existsSync(join(shared, gidSentinel(gid)))).toBe(false);
    expect(result.stderr).toContain("did not complete");
  });

  it("keeps its claim when only the shared cache's MODE pass fails", () => {
    const shared = join(tempDir(), "dep-cache");
    mkdirSync(shared);
    const gid = String(process.getgid?.() ?? 0);
    // An unreadable directory simulates a partial chmod failure.
    const unreadable = join(shared, "sub");
    mkdirSync(unreadable);
    writeFileSync(join(unreadable, "entry"), "");
    chmodSync(unreadable, 0o000);
    restoreWritable.push(unreadable);

    const result = runEntrypoint([shared], "2000001", { workerGid: gid });

    expect(result.status).toBe(0);
    expect(result.chowns).toEqual([`-R :${gid} ${shared}`, ...result.prepChowns]);
    expect(existsSync(join(shared, gidSentinel(gid)))).toBe(true);
    expect(statSync(shared).mode & 0o2000).toBe(0o2000);
  });

  it("moves the image account onto an allocated uid so the drop keeps its groups", () => {
    const result = runEntrypoint([tempDir()], "2000001", {
      workerGid: "1000",
      passwdLine: "NONE",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toContain("usermod -u 2000001 shipit");
  });

  it("does not touch the image account when the uid already resolves", () => {
    const result = runEntrypoint([tempDir()], "1000");

    expect(result.status).toBe(0);
    expect(result.groupOps.some((c) => c.startsWith("usermod -u"))).toBe(false);
    expect(result.gosuDrop).toBe("1000 true");
  });

  it("aligns the journal group for an allocated uid, which needs usermod FIRST", () => {
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
    const result = runEntrypoint([tempDir()], "2000001", {
      workerGid: "1000",
      passwdLine: "shipit:x:2000001:1000::/home/shipit:/bin/sh",
    });

    expect(result.status).toBe(0);
    expect(result.gosuDrop).toBe("2000001 true");
    expect(result.stderr).not.toContain("without supplementary groups");
  });

  function runChownWorkspace(
    tree: string,
    shipitDepDirs?: string,
    opts: { setfaclExits?: number; omitSetfacl?: boolean } = {},
  ): { chowns: string[]; acls: string[]; status: number } {
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
    // Test path selection here; session-worker-uid.test.ts tests real ACLs.
    const aclLog = join(root, "setfacl.log");
    writeFileSync(aclLog, "");
    if (!opts.omitSetfacl) {
      writeFileSync(
        join(bin, "setfacl"),
        `#!/bin/sh\nshift 4\nfor a in "$@"; do printf "%s\\n" "$a" >> "$SETFACL_LOG"; done\nexit ${opts.setfaclExits ?? 0}\n`,
        { mode: 0o755 },
      );
    }
    for (const tool of ["find", "chmod"]) {
      const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      symlinkSync(real, join(bin, tool));
    }
    const script = join(root, "fragment.sh");
    writeFileSync(
      script,
      `set -eu\nUID_GID=2000001\nWORKER_GID=1000\n${fn}\nrc=0\nchown_workspace "$1" || rc=$?\nexit $rc\n`,
    );
    const run = spawnSync("/bin/sh", [script, tree], {
      env: {
        PATH: opts.omitSetfacl ? bin : `${bin}:${process.env.PATH ?? ""}`,
        CHOWN_LOG: log,
        SETFACL_LOG: aclLog,
        ...(shipitDepDirs === undefined ? {} : { SHIPIT_DEP_DIRS: shipitDepDirs }),
      },
      encoding: "utf8",
    });
    if (!opts.omitSetfacl) expect(run.status).toBe(0);
    const lines = (p: string): string[] => readFileSync(p, "utf8").split("\n").filter(Boolean).sort();
    return { chowns: lines(log), acls: lines(aclLog), status: run.status ?? 1 };
  }

  it("chowns object DIRECTORIES but never the hardlinked object FILES", () => {
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

    const { chowns: chowned } = runChownWorkspace(tree);

    expect(chowned).not.toContain(join(tree, ".git/objects/4d/deadbeef"));
    expect(chowned).not.toContain(join(tree, ".git/objects/pack/p.pack"));
    expect(chowned).not.toContain(join(tree, ".git/lfs/objects/ab/cd/oid"));
    expect(chowned).toContain(join(tree, ".git/objects/4d"));
    expect(chowned).toContain(join(tree, ".git/objects/pack"));
    expect(chowned).toContain(join(tree, ".git/lfs/objects/ab/cd"));
    expect(chowned).toContain(join(tree, "src/a.ts"));
    expect(chowned).toContain(join(tree, ".git/config"));
  });

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
    chmodSync(join(tree, ".git/objects/4d/deadbeef"), 0o444);

    runChownWorkspace(tree);

    const mode = (p: string) => statSync(join(tree, p)).mode & 0o7777;
    expect(mode("src")).toBe(0o2775);
    expect(mode("src/a.ts")).toBe(0o664);
    expect(mode("run.sh")).toBe(0o775);
    expect(mode(".git/objects/4d/deadbeef")).toBe(0o444);
    expect(mode(".git/lfs/objects/ab/cd/oid")).toBe(0o444);
    expect(mode(".git/objects/4d")).toBe(0o2775);
  });

  it("gives every workspace directory a default group ACL, with the same prunes", () => {
    const tree = tempDir();
    mkdirSync(join(tree, ".git/objects/4d"), { recursive: true });
    mkdirSync(join(tree, ".pnpm-store/v3"), { recursive: true });
    mkdirSync(join(tree, "node_modules/left-pad"), { recursive: true });
    mkdirSync(join(tree, "src"), { recursive: true });
    for (const f of ["src/a.ts", ".git/objects/4d/deadbeef", ".pnpm-store/v3/blob"]) {
      writeFileSync(join(tree, f), "");
    }

    const { acls } = runChownWorkspace(tree, "node_modules");

    expect(acls).toContain(tree);
    expect(acls).toContain(join(tree, "src"));
    expect(acls).toContain(join(tree, ".git/objects/4d"));
    expect(acls).not.toContain(join(tree, "src/a.ts"));
    expect(acls).not.toContain(join(tree, ".pnpm-store"));
    expect(acls).not.toContain(join(tree, ".pnpm-store/v3"));
    expect(acls).not.toContain(join(tree, "node_modules"));
    expect(acls).not.toContain(join(tree, "node_modules/left-pad"));
  });

  it("chown_workspace reports failure when it cannot do ACLs at all, and only then", () => {
    const tree = tempDir();
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src/a.ts"), "");

    expect(runChownWorkspace(tree, undefined, { omitSetfacl: true }).status).not.toBe(0);
    expect(runChownWorkspace(tree, undefined, { setfaclExits: 1 }).status).toBe(0);
    expect(runChownWorkspace(tree).status).toBe(0);
  });

  it("does not descend into the shared pnpm store", () => {
    const tree = tempDir();
    mkdirSync(join(tree, ".pnpm-store/v3"), { recursive: true });
    writeFileSync(join(tree, ".pnpm-store/v3/blob"), "");
    writeFileSync(join(tree, "keep.txt"), "");

    const { chowns: chowned } = runChownWorkspace(tree);

    expect(chowned.some((p) => p.includes(".pnpm-store"))).toBe(false);
    expect(chowned).toContain(join(tree, "keep.txt"));
  });

  it("does not descend into a declared dep dir, and hands only its ROOT over", () => {
    const tree = tempDir();
    mkdirSync(join(tree, "node_modules/react"), { recursive: true });
    writeFileSync(join(tree, "node_modules/react/package.json"), "");
    mkdirSync(join(tree, "src"), { recursive: true });
    writeFileSync(join(tree, "src/a.ts"), "");
    // Override umask 002 so the test can detect an unwanted chmod.
    chmodSync(join(tree, "node_modules/react"), 0o755);
    chmodSync(join(tree, "node_modules/react/package.json"), 0o644);

    const { chowns: chowned } = runChownWorkspace(tree, "node_modules");

    expect(chowned.filter((p) => p.includes("node_modules"))).toEqual([
      join(tree, "node_modules"),
    ]);
    expect(chowned).toContain(join(tree, "src/a.ts"));

    expect(statSync(join(tree, "node_modules")).mode & 0o7777).toBe(0o2775);
    expect(statSync(join(tree, "node_modules/react")).mode & 0o7777).toBe(0o755);
    expect(statSync(join(tree, "node_modules/react/package.json")).mode & 0o7777).toBe(0o644);
  });

  it("prunes every declared dep dir, a nested one included", () => {
    const tree = tempDir();
    for (const d of ["node_modules/x", "client/node_modules/y", "vendor/z", "src"]) {
      mkdirSync(join(tree, d), { recursive: true });
      writeFileSync(join(tree, d, "f"), "");
    }

    const { chowns: chowned } = runChownWorkspace(tree, "node_modules:client/node_modules:vendor");

    for (const inside of ["node_modules/x/f", "client/node_modules/y/f", "vendor/z/f"]) {
      expect(chowned).not.toContain(join(tree, inside));
    }
    for (const root of ["node_modules", "client/node_modules", "vendor"]) {
      expect(chowned).toContain(join(tree, root));
    }
    expect(chowned).toContain(join(tree, "client"));
    expect(chowned).toContain(join(tree, "src/f"));
  });

  it("refuses a symlinked dep dir whole, so chmod cannot follow it out of the tree", () => {
    const tree = tempDir();
    const target = tempDir();
    writeFileSync(join(target, "f"), "");
    // Set a mode that changes if chmod follows the symlink.
    chmodSync(target, 0o755);
    symlinkSync(target, join(tree, "vendor"));

    const { chowns: chowned } = runChownWorkspace(tree, "vendor");

    expect(chowned.some((p) => p.includes("vendor"))).toBe(false);
    expect(statSync(target).mode & 0o7777).toBe(0o755);
  });

  it("still descends for an orchestrator that predates the dep-dir list", () => {
    const tree = tempDir();
    mkdirSync(join(tree, "node_modules/react"), { recursive: true });
    writeFileSync(join(tree, "node_modules/react/package.json"), "");

    for (const depDirs of [undefined, ""]) {
      const { chowns: chowned } = runChownWorkspace(tree, depDirs);
      expect(chowned).toContain(join(tree, "node_modules/react/package.json"));
    }
  });

  it("drops to a group-writable umask, so a shared cache stays shared", () => {
    // The command stubs cannot observe the inherited umask.
    const source = readFileSync(ENTRYPOINT, "utf8");
    const umask = source.indexOf("\numask 002");
    const drop = source.lastIndexOf("exec gosu");
    expect(umask).toBeGreaterThan(-1);
    expect(umask).toBeLessThan(drop);
  });

  it("leaves the legacy root runtime untouched", () => {
    const result = runEntrypoint([tempDir()], "", {
      journalDirs: [journalDir()],
      journalGid: "143",
    });

    expect(result.status).toBe(0);
    expect(result.groupOps).toEqual([]);
    expect(result.gosu).toEqual([]);
  });
});
