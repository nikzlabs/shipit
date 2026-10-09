import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * docs/324-scheduled-sessions req 13 — the run's notes folder as the orchestrator really leaves
 * it: created as root and handed to the run session's identity. A session container has no root,
 * so these cases run on CI's runners, where `sudo -n` works; the first case keeps them from
 * skipping there (the pattern of `overlay-redirect-dir.test.ts`).
 */

const RUN_UID = 47_311;
const SCHEDULE = "5b1d0c4e-0000-4000-8000-000000000001";
const RUN = "9a7f3e2d-0000-4000-8000-000000000002";
const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "schedule-notes.ts");

function asRoot(argv: string[]): { status: number | null; stdout: string; stderr: string } {
  const full = process.getuid?.() === 0 ? argv : ["sudo", "-n", ...argv];
  return spawnSync(full[0]!, full.slice(1), { encoding: "utf8" });
}

function asRunIdentity(argv: string[]): { status: number | null; stderr: string } {
  return asRoot(["setpriv", `--reuid=${RUN_UID}`, `--regid=${RUN_UID}`, "--clear-groups", ...argv]);
}

/** The real module, as root, the way the orchestrator calls it. */
function notesAsRoot(root: string, call: string): string {
  const script = `import { ScheduleNotes } from ${JSON.stringify(MODULE)};\n`
    + `const notes = new ScheduleNotes(${JSON.stringify(root)});\n`
    + `console.log(JSON.stringify(${call}));`;
  const res = asRoot([process.execPath, "--import", "tsx", "--input-type=module", "-e", script]);
  if (res.status !== 0) throw new Error(`as root: ${res.stderr}`);
  return res.stdout.trim();
}

const canRunAsRoot = process.platform === "linux" && asRoot(["true"]).status === 0;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) asRoot(["rm", "-rf", root]);
});

describe("the run's notes folder, prepared as root", () => {
  it.runIf(process.env.GITHUB_ACTIONS === "true")("can run as root on CI, so the cases below do not skip there", () => {
    expect(canRunAsRoot).toBe(true);
  });

  it.runIf(canRunAsRoot)("belongs to the run's identity alone, inside parents only ShipIt can change", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-notes-root-"));
    roots.push(tmp);
    fs.chmodSync(tmp, 0o755);
    const root = path.join(tmp, "schedules");

    const dir = JSON.parse(notesAsRoot(root, `notes.prepareRun(${JSON.stringify(SCHEDULE)}, ${JSON.stringify(RUN)}, { uid: ${RUN_UID}, gid: ${RUN_UID} })`)) as string;
    const stat = fs.statSync(dir);
    expect([stat.uid, stat.gid, stat.mode & 0o777]).toEqual([RUN_UID, RUN_UID, 0o700]);
    for (const parent of [root, path.dirname(path.dirname(dir)), path.dirname(dir)]) {
      const p = fs.statSync(parent);
      expect([p.uid, p.mode & 0o022], parent).toEqual([0, 0]);
    }

    // The run writes its own folder, and cannot put anything beside it — not even a link in its place.
    expect(asRunIdentity(["sh", "-c", `echo hello > ${dir}/notes.md`]).status).toBe(0);
    expect(asRunIdentity(["ln", "-s", "/", path.join(path.dirname(dir), "other-run")]).status).not.toBe(0);
    expect(asRunIdentity(["mv", dir, `${dir}-moved`]).status).not.toBe(0);

    // The orchestrator reads it through the safe read, and refuses the link the run plants.
    expect(JSON.parse(notesAsRoot(root, `notes.read(${JSON.stringify(SCHEDULE)}, ${JSON.stringify(RUN)}, "notes.md")`)))
      .toEqual({ path: "notes.md", size: 6, text: "hello\n" });
    expect(asRunIdentity(["ln", "-s", "/etc/shadow", `${dir}/leak.md`]).status).toBe(0);
    expect(() => notesAsRoot(root, `notes.read(${JSON.stringify(SCHEDULE)}, ${JSON.stringify(RUN)}, "leak.md")`))
      .toThrow(/is a link/);

    // Prepared again — a second container start — it keeps the files and the owner.
    notesAsRoot(root, `notes.prepareRun(${JSON.stringify(SCHEDULE)}, ${JSON.stringify(RUN)}, { uid: ${RUN_UID}, gid: ${RUN_UID} })`);
    expect(fs.statSync(dir).uid).toBe(RUN_UID);
    expect(asRoot(["cat", `${dir}/notes.md`]).stdout).toBe("hello\n");
  });
});
