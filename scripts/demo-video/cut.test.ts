import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

/**
 * `cut.sh` is a thin wrapper: probe the ffmpeg, ask cut-plan.mjs for the filter,
 * run one export per container. A shim ffmpeg that records its argv is what
 * makes the wrapper's decisions observable without a real encoder; the one
 * ffmpeg in this container (Playwright's, VP8 + no concat) is used only to
 * prove the capability check refuses it with a message that names what it lacks.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const CUT = join(HERE, "cut.sh");
const PLAYWRIGHT_FFMPEG = "/opt/playwright-browsers/ffmpeg-1011/ffmpeg-linux";

const FULL_FILTERS = ["trim", "setpts", "concat", "blackdetect", "pad", "format"];

/**
 * A fake ffmpeg: answers -filters/-encoders from canned lists; a blackdetect
 * pass (`-vf blackdetect…`) prints the canned detector line to stderr and
 * touches nothing; every other invocation logs its argv to a file and creates
 * the output. An ffprobe shim beside it answers the duration query, since
 * cut.sh looks for ffprobe next to $FFMPEG first.
 */
function writeShim(dir: string, opts: { filters: string[]; encoders: string[]; blackEnd?: number; duration?: number }): string {
  const shim = join(dir, "ffmpeg");
  writeFileSync(join(dir, "filters.txt"), opts.filters.map((f) => ` ... ${f.padEnd(16)} V->V       canned`).join("\n") + "\n");
  writeFileSync(join(dir, "encoders.txt"), opts.encoders.map((e) => ` V....D ${e.padEnd(20)} canned`).join("\n") + "\n");
  const blackLine =
    opts.blackEnd === undefined
      ? ":"
      : `echo "[blackdetect @ 0x55d1] black_start:0.16 black_end:${opts.blackEnd} black_duration:${(opts.blackEnd - 0.16).toFixed(2)}" >&2`;
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
case "$2" in
  -filters) cat "${dir}/filters.txt"; exit 0 ;;
  -encoders) cat "${dir}/encoders.txt"; exit 0 ;;
esac
for a in "$@"; do
  case "$a" in blackdetect=*) printf '%s\\n' "$@" > "${dir}/blackdetect-argv"; ${blackLine}; exit 0 ;; esac
done
printf '%s\\n' "$@" > "${dir}/argv-$(( $(ls "${dir}"/argv-* 2>/dev/null | wc -l) + 1 ))"
: > "\${@: -1}"
`,
  );
  chmodSync(shim, 0o755);
  const probe = join(dir, "ffprobe");
  writeFileSync(probe, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/ffprobe-argv"\necho "${opts.duration ?? 70.5}"\n`);
  chmodSync(probe, 0o755);
  return shim;
}

interface Fixture {
  dir: string;
  recording: string;
  beats: string;
  storyboard: string;
  out: string;
}

function fixture(runJson?: Record<string, unknown>): Fixture {
  const dir = mkdtempSync(join(os.tmpdir(), "cut-"));
  const recording = join(dir, "take.webm");
  writeFileSync(recording, "");
  const beats = join(dir, "beats.json");
  writeFileSync(beats, JSON.stringify([{ id: "a", actionAt: 1, readyAt: 3 }, { id: "b", actionAt: 10, readyAt: 12 }]));
  const storyboard = join(dir, "storyboard.json");
  writeFileSync(storyboard, JSON.stringify({ beats: [{ id: "a", lead: 1, hold: 2 }, { id: "b", lead: 0, hold: 1 }] }));
  if (runJson) writeFileSync(join(dir, "run.json"), JSON.stringify(runJson));
  return { dir, recording, beats, storyboard, out: join(dir, "hero") };
}

const EXPECTED_FILTER =
  "[0:v]trim=start=1:end=2,setpts=PTS-STARTPTS[s0];[0:v]trim=start=3:end=5,setpts=PTS-STARTPTS[s1];[0:v]trim=start=12:end=13,setpts=PTS-STARTPTS[s2];[s0][s1][s2]concat=n=3:v=1:a=0[v]";

function runCut(f: Fixture, ffmpeg: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [CUT, f.recording, f.beats, f.storyboard, f.out], { encoding: "utf8", env: { ...process.env, FFMPEG: ffmpeg, ...env } });
}

const argvOf = (dir: string, n: number) => readFileSync(join(dir, `argv-${n}`), "utf8").split("\n").filter(Boolean);

describe("cut.sh", () => {
  it("exports a muted VP9 webm and a faststart yuv420p mp4 from the plan's filter", () => {
    const f = fixture();
    try {
      const shim = writeShim(f.dir, { filters: FULL_FILTERS, encoders: ["libvpx-vp9", "libx264"] });
      const result = runCut(f, shim);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("keeping 4s");

      const webm = argvOf(f.dir, 1);
      expect(webm).toContain(f.recording);
      expect(webm[webm.indexOf("-filter_complex") + 1]).toBe(EXPECTED_FILTER);
      expect(webm[webm.indexOf("-map") + 1]).toBe("[v]");
      expect(webm).toContain("-an");
      expect(webm[webm.indexOf("-c:v") + 1]).toBe("libvpx-vp9");
      expect(webm[webm.length - 1]).toBe(`${f.out}.webm`);
      expect(existsSync(`${f.out}.webm`)).toBe(true);

      const mp4 = argvOf(f.dir, 2);
      expect(mp4[mp4.indexOf("-filter_complex") + 1]).toBe(`${EXPECTED_FILTER};[v]pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p[m]`);
      expect(mp4[mp4.indexOf("-map") + 1]).toBe("[m]");
      expect(mp4).toContain("-an");
      expect(mp4[mp4.indexOf("-c:v") + 1]).toBe("libx264");
      expect(mp4[mp4.indexOf("-pix_fmt") + 1]).toBe("yuv420p");
      expect(mp4[mp4.indexOf("-movflags") + 1]).toBe("+faststart");
      expect(mp4[mp4.length - 1]).toBe(`${f.out}.mp4`);
      expect(existsSync(`${f.out}.mp4`)).toBe(true);
      expect(existsSync(join(f.dir, "argv-3"))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("skips the mp4, and says so, when the ffmpeg has no libx264", () => {
    const f = fixture();
    try {
      const shim = writeShim(f.dir, { filters: FULL_FILTERS, encoders: ["libvpx-vp9"] });
      const result = runCut(f, shim);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(`${f.out}.webm`)).toBe(true);
      expect(existsSync(`${f.out}.mp4`)).toBe(false);
      expect(existsSync(join(f.dir, "argv-2"))).toBe(false);
      expect(result.stderr).toContain("skipping");
      expect(result.stderr).toContain("libx264");
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it("refuses an ffmpeg without the concat filter, naming what is missing", () => {
    const f = fixture();
    try {
      const shim = writeShim(f.dir, { filters: ["trim", "pad"], encoders: ["libvpx"] });
      const result = runCut(f, shim);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("filter setpts");
      expect(result.stderr).toContain("filter concat");
      expect(result.stderr).toContain("encoder libvpx-vp9");
      expect(result.stderr).not.toContain("filter trim");
      expect(existsSync(join(f.dir, "argv-1"))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync(PLAYWRIGHT_FFMPEG))("refuses Playwright's bundled ffmpeg (VP8 only, no concat) — plan §5", () => {
    const f = fixture();
    try {
      const result = runCut(f, PLAYWRIGHT_FFMPEG);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("filter concat");
      expect(result.stderr).toContain("encoder libvpx-vp9");
      expect(existsSync(`${f.out}.webm`)).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  describe("anchor", () => {
    // The fixture's raw slices are [1,2] [3,5] [12,13]; with the driver leaving
    // the splash at 1.9 s and the file showing it end at 0.48 s, every slice
    // moves 1.42 s earlier.
    const ANCHORED_FILTER =
      "[0:v]trim=start=0:end=0.58,setpts=PTS-STARTPTS[s0];[0:v]trim=start=1.58:end=3.58,setpts=PTS-STARTPTS[s1];[0:v]trim=start=10.58:end=11.58,setpts=PTS-STARTPTS[s2];[s0][s1][s2]concat=n=3:v=1:a=0[v]";

    it("runs blackdetect on the recording and hands the anchor pair to cut-plan", () => {
      const f = fixture({ anchor: { wallAt: 1.9 }, wallDuration: 66.3 });
      try {
        const shim = writeShim(f.dir, { filters: FULL_FILTERS, encoders: ["libvpx-vp9"], blackEnd: 0.48, duration: 70.5 });
        const result = runCut(f, shim);
        expect(result.status, result.stderr).toBe(0);

        const detect = readFileSync(join(f.dir, "blackdetect-argv"), "utf8").split("\n").filter(Boolean);
        expect(detect[detect.indexOf("-i") + 1]).toBe(f.recording);
        expect(detect[detect.indexOf("-vf") + 1]).toBe("blackdetect=d=0.08:pix_th=0.10");
        expect(detect).toContain("-an");
        expect(detect.slice(-2)).toEqual(["null", "-"]);
        expect(existsSync(join(f.dir, "-"))).toBe(false);
        const probe = readFileSync(join(f.dir, "ffprobe-argv"), "utf8");
        expect(probe).toContain("format=duration");

        expect(result.stderr).toContain("anchor: driver left the splash at 1.9s, video shows it at 0.48s (file 70.5s)");
        expect(result.stderr).not.toContain("WARNING");
        const webm = argvOf(f.dir, 1);
        expect(webm[webm.indexOf("-filter_complex") + 1]).toBe(ANCHORED_FILTER);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });

    it("refuses to cut when run.json has an anchor but blackdetect finds no splash", () => {
      const f = fixture({ anchor: { wallAt: 1.9 }, wallDuration: 72.5 });
      try {
        const shim = writeShim(f.dir, { filters: FULL_FILTERS, encoders: ["libvpx-vp9"], duration: 70.5 });
        const result = runCut(f, shim);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("blackdetect found no black splash");
        expect(result.stderr).toContain("CUT_UNANCHORED=1");
        expect(existsSync(join(f.dir, "argv-1"))).toBe(false);

        // The override falls back to wall − video, loudly.
        const forced = runCut(f, shim, { CUT_UNANCHORED: "1" });
        expect(forced.status, forced.stderr).toBe(0);
        expect(forced.stderr).toContain("WARNING: no black-splash anchor; falling back to wall − video (72.5s − 70.5s)");
        expect(existsSync(join(f.dir, "argv-1"))).toBe(true);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });

    it("refuses when run.json has an anchor but ffprobe cannot read the duration", () => {
      const f = fixture({ anchor: { wallAt: 1.9 } });
      try {
        const shim = writeShim(f.dir, { filters: FULL_FILTERS, encoders: ["libvpx-vp9"], blackEnd: 0.48 });
        rmSync(join(f.dir, "ffprobe"));
        const result = runCut(f, shim, { FFPROBE: join(f.dir, "no-such-ffprobe") });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("ffprobe could not read the duration");
        expect(existsSync(join(f.dir, "argv-1"))).toBe(false);
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });

    it("warns and uses wall − video for a run.json from before the splash", () => {
      const f = fixture({ wallDuration: 72.5 });
      try {
        const shim = writeShim(f.dir, { filters: FULL_FILTERS, encoders: ["libvpx-vp9"], blackEnd: 0.48, duration: 70.5 });
        const result = runCut(f, shim);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(join(f.dir, "blackdetect-argv"))).toBe(false);
        expect(result.stderr).toContain("WARNING: no black-splash anchor; falling back to wall − video (72.5s − 70.5s)");
        const webm = argvOf(f.dir, 1);
        // Offset 2: [1,2] is gone, [3,5] → [1,3], [12,13] → [10,11].
        expect(webm[webm.indexOf("-filter_complex") + 1]).toBe(
          "[0:v]trim=start=1:end=3,setpts=PTS-STARTPTS[s0];[0:v]trim=start=10:end=11,setpts=PTS-STARTPTS[s1];[s0][s1]concat=n=2:v=1:a=0[v]",
        );
      } finally {
        rmSync(f.dir, { recursive: true, force: true });
      }
    });
  });

  it("fails on a missing input before touching ffmpeg", () => {
    const f = fixture();
    try {
      const shim = writeShim(f.dir, { filters: ["trim", "setpts", "concat"], encoders: ["libvpx-vp9"] });
      const result = spawnSync("bash", [CUT, join(f.dir, "nope.webm"), f.beats, f.storyboard, f.out], {
        encoding: "utf8",
        env: { ...process.env, FFMPEG: shim },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no such file");
      expect(existsSync(join(f.dir, "argv-1"))).toBe(false);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
