import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Drives the REAL checkbox prompt from deployment/vps/setup.sh (docs/271) under
 * a pseudo-terminal, in the same spirit as local-install-bind.test.ts and
 * update-script.test.ts, which drive the real install/update shell rather than a
 * transcription of it.
 *
 * Why a pty rather than a unit test of the key map: the prompt only exists
 * because `[ -t 0 ]` is true, and everything that can go wrong with it —
 * arrow-key escape sequences arriving as three bytes, the redraw walking the
 * cursor up the wrong number of lines, echo or the hidden cursor left off at the
 * end — is invisible without a terminal. The failure mode being guarded is "the
 * VPS installer hangs, or hands back a shell that no longer echoes", on a box
 * the operator has just curl|bash'd a script onto.
 *
 * The picker block is extracted from setup.sh between its BEGIN/END markers
 * instead of living in a sourced library file, because the installer runs
 * standalone — `sudo bash -c "$(curl ... setup.sh)"` asks the access question
 * before the repo is cloned, so there is no second file to source at that point
 * (requirements.md req 9).
 */
const SETUP_SH = fileURLToPath(
  new URL("../../../../deployment/vps/setup.sh", import.meta.url),
);
const BEGIN = "# --- BEGIN shipit-picker";
const END = "# --- END shipit-picker";

/** util-linux `script` gives us a pty; without it the interactive cases can't run. */
function hasScript(): boolean {
  try {
    execFileSync("sh", ["-c", "command -v script"], { stdio: "ignore" });
    return process.platform === "linux";
  } catch {
    return false;
  }
}

describe("deployment/vps/setup.sh — checkbox prompt (docs/271)", () => {
  let root: string;
  let pickerPath: string;
  let driverPath: string;

  beforeAll(() => {
    const setup = fs.readFileSync(SETUP_SH, "utf8");
    const begin = setup.indexOf(BEGIN);
    const end = setup.indexOf(END);
    expect(
      begin,
      `${BEGIN} marker missing from setup.sh — the picker must stay extractable`,
    ).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(begin);

    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-picker-"));
    pickerPath = path.join(root, "picker.sh");
    fs.writeFileSync(pickerPath, setup.slice(begin, setup.indexOf("\n", end) + 1));

    // Stands in for a caller: two options, "cloudflare" preselected, then report
    // the answer and whether the prompt ran at all.
    driverPath = path.join(root, "drive.sh");
    fs.writeFileSync(
      driverPath,
      [
        "set -euo pipefail",
        `. "${pickerPath}"`,
        'if ! shipit_pick "cloudflare" \\',
        '  "cloudflare|Cloudflare Tunnel|public HTTPS domain" \\',
        '  "tailscale|Tailscale|tailnet only"; then echo "SKIPPED"; fi',
        'echo "RESULT=[$SHIPIT_PICK_RESULT]"',
        "",
      ].join("\n"),
    );
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Run the driver with a real pty, feeding `keys` as if typed. */
  function pick(keys: string): string {
    return execFileSync("script", ["-qec", `bash ${driverPath}`, "/dev/null"], {
      input: keys,
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  /** The answer the driver printed, with the pty's carriage returns stripped. */
  function answer(out: string): string {
    const m = /RESULT=\[(.*)\]/.exec(out.replace(/\r/g, ""));
    if (!m) throw new Error(`no RESULT line in output: ${JSON.stringify(out)}`);
    return m[1];
  }

  it("is valid bash", () => {
    execFileSync("bash", ["-n", SETUP_SH], { stdio: "pipe" });
  });

  it("without a terminal, answers with the preselection instead of prompting", () => {
    // The curl|bash and CI paths land here: no prompt, today's default (req 7).
    const out = execFileSync("bash", [driverPath], {
      input: "",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(out).toContain("SKIPPED");
    expect(answer(out)).toBe("cloudflare");
  });

  it.runIf(hasScript())(
    "renders a checked and an unchecked row (req 3)",
    () => {
      const out = pick("\n");
      expect(out).toContain("[*] Cloudflare Tunnel");
      expect(out).toContain("[ ] Tailscale");
    },
  );

  it.runIf(hasScript())("confirms the preselection on Enter (req 6)", () => {
    expect(answer(pick("\n"))).toBe("cloudflare");
  });

  it.runIf(hasScript())(
    "arrow down + space selects the second option (reqs 1, 4)",
    () => {
      expect(answer(pick("[B \n"))).toBe("cloudflare,tailscale");
    },
  );

  it.runIf(hasScript())("space toggles a selected option back off", () => {
    // Selecting nothing is how the operator says "don't expose it yet" (req 4).
    expect(answer(pick(" \n"))).toBe("");
  });

  it.runIf(hasScript())("moves with arrows in both directions", () => {
    // Down, select tailscale, back up, deselect cloudflare.
    expect(answer(pick("[B [A \n"))).toBe("tailscale");
  });

  it.runIf(hasScript())("accepts j/k and application-mode arrows", () => {
    // Application cursor mode (\eOB) is what some terminals send instead of \e[B.
    expect(answer(pick("j \n"))).toBe("cloudflare,tailscale");
    expect(answer(pick("OB \n"))).toBe("cloudflare,tailscale");
    // k from the first row wraps to the last.
    expect(answer(pick("k \n"))).toBe("cloudflare,tailscale");
  });

  it.runIf(hasScript())("ignores an unmapped key rather than confirming", () => {
    // A stray keystroke must neither confirm the list nor toggle a row: the
    // space that follows it is what turns the preselection off.
    expect(answer(pick("x \n"))).toBe("");
  });

  it.runIf(hasScript())(
    "restores the cursor and the terminal it borrowed",
    () => {
      // Leaving the cursor hidden (or echo off) hands back an apparently broken
      // shell long after the installer has moved on.
      const out = pick("\n");
      expect(out).toContain("[?25l");
      expect(out.lastIndexOf("[?25h")).toBeGreaterThan(
        out.lastIndexOf("[?25l"),
      );
      const echo = execFileSync(
        "script",
        ["-qec", `bash ${driverPath} >/dev/null 2>&1; stty -a | tr -d '\\r'`, "/dev/null"],
        { input: "\n", encoding: "utf8", timeout: 20_000 },
      );
      // `stty -a` also lists echoe/echok/-echonl, so anchor on the flag itself.
      expect(echo).toMatch(/(^|[ ;])echo([ ;]|$)/m);
      expect(echo).not.toMatch(/(^|[ ;])-echo([ ;]|$)/m);
    },
  );
});
