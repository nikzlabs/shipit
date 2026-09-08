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

/** A fake ffmpeg: answers -filters/-encoders from canned lists, logs every other argv to a file, creates the output. */
function writeShim(dir: string, opts: { filters: string[]; encoders: string[] }): string {
  const shim = join(dir, "ffmpeg-shim");
  writeFileSync(join(dir, "filters.txt"), opts.filters.map((f) => ` ... ${f.padEnd(16)} V->V       canned`).join("\n") + "\n");
  writeFileSync(join(dir, "encoders.txt"), opts.encoders.map((e) => ` V....D ${e.padEnd(20)} canned`).join("\n") + "\n");
  writeFileSync(
    shim,
    `#!/usr/bin/env bash
case "$2" in
  -filters) cat "${dir}/filters.txt"; exit 0 ;;
  -encoders) cat "${dir}/encoders.txt"; exit 0 ;;
esac
printf '%s\\n' "$@" > "${dir}/argv-$(( $(ls "${dir}"/argv-* 2>/dev/null | wc -l) + 1 ))"
: > "\${@: -1}"
`,
  );
  chmodSync(shim, 0o755);
  return shim;
}

interface Fixture {
  dir: string;
  recording: string;
  beats: string;
  storyboard: string;
  out: string;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(os.tmpdir(), "cut-"));
  const recording = join(dir, "take.webm");
  writeFileSync(recording, "");
  const beats = join(dir, "beats.json");
  writeFileSync(beats, JSON.stringify([{ id: "a", actionAt: 1, readyAt: 3 }, { id: "b", actionAt: 10, readyAt: 12 }]));
  const storyboard = join(dir, "storyboard.json");
  writeFileSync(storyboard, JSON.stringify({ beats: [{ id: "a", lead: 1, hold: 2 }, { id: "b", lead: 0, hold: 1 }] }));
  return { dir, recording, beats, storyboard, out: join(dir, "hero") };
}

const EXPECTED_FILTER =
  "[0:v]trim=start=1:end=2,setpts=PTS-STARTPTS[s0];[0:v]trim=start=3:end=5,setpts=PTS-STARTPTS[s1];[0:v]trim=start=12:end=13,setpts=PTS-STARTPTS[s2];[s0][s1][s2]concat=n=3:v=1:a=0[v]";

function runCut(f: Fixture, ffmpeg: string) {
  return spawnSync("bash", [CUT, f.recording, f.beats, f.storyboard, f.out], { encoding: "utf8", env: { ...process.env, FFMPEG: ffmpeg } });
}

const argvOf = (dir: string, n: number) => readFileSync(join(dir, `argv-${n}`), "utf8").split("\n").filter(Boolean);

describe("cut.sh", () => {
  it("exports a muted VP9 webm and a faststart yuv420p mp4 from the plan's filter", () => {
    const f = fixture();
    try {
      const shim = writeShim(f.dir, { filters: ["trim", "setpts", "concat", "pad", "format"], encoders: ["libvpx-vp9", "libx264"] });
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
      const shim = writeShim(f.dir, { filters: ["trim", "setpts", "concat", "pad", "format"], encoders: ["libvpx-vp9"] });
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
