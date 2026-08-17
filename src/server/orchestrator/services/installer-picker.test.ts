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
 * (requirements.md req 10).
 */
const SETUP_SH = fileURLToPath(
  new URL("../../../../deployment/vps/setup.sh", import.meta.url),
);
const BEGIN = "# --- BEGIN shipit-picker";
const END = "# --- END shipit-picker";

/** util-linux `script` gives us a pty; without it the interactive cases can't run. */
function hasScript(): boolean {
  return has("script");
}

/** The signal cases need a pty we still hold after the child is interrupted. */
function hasPython(): boolean {
  return has("python3");
}

function has(bin: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" });
    return process.platform === "linux";
  } catch {
    return false;
  }
}

describe("deployment/vps/setup.sh — checkbox prompt (docs/271)", () => {
  let root: string;
  let pickerPath: string;
  let driverPath: string;
  let probePath: string;
  /** Wrapper so the pty probe, which execs one script, can pass `--dry-run`. */
  let SETUP_SH_DRY: string;

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

    SETUP_SH_DRY = path.join(root, "dry.sh");
    fs.writeFileSync(SETUP_SH_DRY, `exec bash ${SETUP_SH} --dry-run\n`);

    // Runs the driver on a pty we own, feeds it keys, and reports the pty's
    // termios plus the exit status once the child is gone.
    probePath = path.join(root, "probe.py");
    fs.writeFileSync(
      probePath,
      [
        "import os, pty, select, sys, termios, time",
        "script, keys_hex = sys.argv[1], sys.argv[2]",
        "# argv[3], when given, is a file to redirect the child's stdout into.",
        "redirect = sys.argv[3] if len(sys.argv) > 3 else None",
        "pid, fd = pty.fork()",
        "if pid == 0:",
        "    if redirect:",
        "        os.dup2(os.open(redirect, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644), 1)",
        "    os.execv('/bin/bash', ['bash', script])",
        "time.sleep(1.0)  # let the list render before typing at it",
        "os.write(fd, bytes.fromhex(keys_hex))",
        "time.sleep(1.0)",
        "try:",
        "    while select.select([fd], [], [], 0.2)[0]:",
        "        if not os.read(fd, 4096):",
        "            break",
        "except OSError:",
        "    pass",
        "echo = bool(termios.tcgetattr(fd)[3] & termios.ECHO)",
        "_, status = os.waitpid(pid, 0)",
        "print('ECHO=%s EXIT=%d' % ('on' if echo else 'off', os.waitstatus_to_exitcode(status)))",
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
    // The curl|bash and CI paths land here: no prompt, today's default (req 8).
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

  it.runIf(hasScript())("hides the cursor while drawing, and puts it back", () => {
    const out = pick("\n");
    expect(out).toContain("[?25l");
    expect(out.lastIndexOf("[?25h")).toBeGreaterThan(out.lastIndexOf("[?25l"));
  });

  describe.runIf(hasPython())("terminal state afterwards", () => {
    /**
     * Reads the pty's own termios after the picker exits. That is the only way
     * to observe this: `script` delivers Ctrl-C to the whole foreground process
     * group, so any wrapper that could report the state is killed alongside the
     * picker. `keys` is hex-encoded so control bytes survive argv.
     */
    function ptyRun(keys: string): { echo: boolean; exit: number } {
      const out = execFileSync(
        "python3",
        [probePath, driverPath, Buffer.from(keys, "latin1").toString("hex")],
        { encoding: "utf8", timeout: 30_000 },
      );
      const m = /ECHO=(on|off) EXIT=(-?\d+)/.exec(out);
      if (!m) throw new Error(`unreadable probe output: ${JSON.stringify(out)}`);
      return { echo: m[1] === "on", exit: Number(m[2]) };
    }

    it("leaves echo on after a normal confirm", () => {
      expect(ptyRun("\n")).toEqual({ echo: true, exit: 0 });
    });

    it("leaves echo on after Ctrl-C", () => {
      // The regression this exists for: an `stty -echo` around the read loop
      // looks correct and is not. `read` re-applies the termios it saved — which
      // by then is already `-echo` — when an interrupt tears it down, AFTER the
      // trap has restored it. That leaves the operator typing blind in their own
      // shell long after the installer is gone. `read -s` is what keeps the
      // saved state echoing, so nothing in the picker may hand-set echo.
      expect(ptyRun("\x03")).toEqual({ echo: true, exit: 130 });
    });
  });

  /**
   * `sudo bash setup.sh | tee install.log` is a normal way to run an installer:
   * stdin is the terminal, stdout is not. The typed prompts this replaced worked
   * under it, so the checklist has to as well — it draws on /dev/tty rather than
   * on stdout.
   *
   * The bug this pins is quiet and expensive. When the picker gave up on a
   * redirected stdout it still handed back the *preselection*, which is
   * byte-identical to an operator ticking exactly those boxes — so the installer
   * recorded a default it never asked about as a deliberate choice and wrote it
   * to /etc/shipit/shipit.env, freezing the harness set and clobbering any
   * narrower one a re-run should have left alone.
   */
  describe.runIf(hasPython())("with stdout redirected (`| tee`)", () => {
    function runRedirected(keys: string): string {
      const log = path.join(root, "install.log");
      execFileSync(
        "python3",
        [
          probePath,
          SETUP_SH_DRY,
          Buffer.from(keys, "latin1").toString("hex"),
          log,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      return fs.readFileSync(log, "utf8").replace(/\r/g, "");
    }

    it("still asks, and honours what was typed", () => {
      // Space+Enter adds Cloudflare beside the default Tailscale; down, down,
      // space, Enter drops OpenCode. Neither is a default, so an answer that
      // reflects them proves the list was drawn and read.
      const out = runRedirected(" \n\x1b[B\x1b[B \n");
      expect(out).toContain("SHIPIT_ACCESS=cloudflare,tailscale");
      expect(out).toContain("SHIPIT_HARNESSES=claude,codex");
    });

    it("reports an answered question as answered", () => {
      const out = runRedirected("\n\n");
      expect(out).toContain("(selected)");
      expect(out).not.toContain("no terminal to ask on");
    });
  });

  /**
   * `--dry-run` asks both questions and exits before the installer touches the
   * host.  /**
   * `--dry-run` asks both questions and exits before the installer touches the
   * host. These drive the REAL setup.sh, not the extracted block: that is the
   * point of putting the dry run inside the installer rather than in a preview
   * script beside it, so what an operator previews cannot drift from what runs.
   */
  describe("--dry-run", () => {
    const KNOWN_WRITES = ["/etc/shipit/setup.conf", "/etc/shipit/shipit.env"];

    /** Runs the installer in dry mode, and fails if it wrote anything on the way. */
    function dryRun(env: Record<string, string> = {}, args = ["--dry-run"]): string {
      // A helper that can invoke this script for real is a footgun: on a root
      // runner a forgotten flag starts apt-get and Docker. Refuse up front.
      if (!args.includes("--dry-run") && env.SHIPIT_DRY_RUN !== "1") {
        throw new Error("dryRun() called without --dry-run or SHIPIT_DRY_RUN=1");
      }
      // Contents, not just existence: on a box that has already been installed
      // once, both files exist, and an overwrite is exactly the damage a dry run
      // must not do.
      const snapshot = (): (string | null)[] =>
        KNOWN_WRITES.map((f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null));
      const before = snapshot();
      const out = execFileSync("bash", [SETUP_SH, ...args], {
        input: "",
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(snapshot()).toEqual(before);
      return out;
    }

    it("asks nothing and installs nothing when the answers are preset", () => {
      // No --dry-run argument: SHIPIT_DRY_RUN is the form that works through
      // `sudo bash -c "$(curl …)"`, where passing an argument is awkward.
      const out = dryRun(
        {
          SHIPIT_DRY_RUN: "1",
          SHIPIT_ACCESS: "cloudflare",
          SHIPIT_HARNESSES: "Codex",
        },
        [],
      );
      expect(out).toContain("DRY RUN");
      expect(out).toContain("run cloudflare.sh");
      expect(out).not.toContain("run tailscale.sh");
      expect(out).toContain("harnesses: codex");
    });

    it("reports the defaults when nothing is preset and nothing can be asked", () => {
      // Tailscale-only access, the approved harness set (docs/271-installer-checkbox-prompts reqs 6, 7).
      const out = dryRun();
      expect(out).toContain("run tailscale.sh");
      expect(out).not.toContain("run cloudflare.sh");
      expect(out).toContain("harnesses: claude,codex,opencode (default)");
      // The summary doubles as the recipe for repeating the same install.
      expect(out).toContain("SHIPIT_ACCESS=tailscale");
      expect(out).toContain("SHIPIT_HARNESSES=claude,codex,opencode");
    });

    it("says so when neither access option is chosen", () => {
      const out = dryRun({ SHIPIT_ACCESS: "none" });
      expect(out).toContain("expose nothing");
      expect(out).toContain("SHIPIT_ACCESS=none");
    });

    it("rejects an unknown argument instead of installing", () => {
      expect(() =>
        execFileSync("bash", [SETUP_SH, "--nope"], { stdio: "pipe" }),
      ).toThrow();
    });

    it.runIf(hasScript())("asks both questions at a terminal", () => {
      // Space, Enter on the access list (adds Cloudflare beside the default
      // Tailscale); down, down, space, Enter on the harness list (drops
      // OpenCode). This is the whole prompt path of the real installer.
      const out = execFileSync(
        "script",
        ["-qec", `bash ${SETUP_SH} --dry-run`, "/dev/null"],
        { input: " \n\x1b[B\x1b[B \n", encoding: "utf8", timeout: 30_000 },
      ).replace(/\r/g, "");
      expect(out).toContain("[ ] Cloudflare Tunnel");
      expect(out).toContain("[*] Tailscale");
      expect(out).toContain("run cloudflare.sh");
      expect(out).toContain("run tailscale.sh");
      // Down, down, space turned OpenCode off, so the answer narrows.
      expect(out).toContain("SHIPIT_HARNESSES=claude,codex");
    });
  });

  /**
   * The picker cannot produce an invalid answer, so these validators exist for
   * the pre-answers a scripted install sets. Their bar is not "looks sane" but
   * "accepts exactly what docker/agent-cli/install-agent-clis.sh accepts" —
   * that script lowercases and strips whitespace before its own check, so a
   * stricter test here would reject `SHIPIT_HARNESSES="Claude,Codex"` installs
   * that work today and fail them at the question instead.
   */
  describe("env pre-answer validation", () => {
    function check(fn: string, value: string): boolean {
      const setup = fs.readFileSync(SETUP_SH, "utf8");
      const body = new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(setup);
      expect(body, `${fn}() not found in setup.sh`).not.toBeNull();
      const script = [
        'SUPPORTED_HARNESSES="claude codex opencode"',
        body![0],
        // The callers normalize before validating; mirror that here.
        `v="$(printf '%s' "$1" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')"`,
        `if ${fn} "$v"; then echo VALID; else echo INVALID; fi`,
      ].join("\n");
      const out = execFileSync("bash", ["-s", value], {
        input: script,
        encoding: "utf8",
      });
      return out.includes("VALID") && !out.includes("INVALID");
    }

    it.each([
      ["claude,codex", true],
      ["codex", true],
      // Mixed case and spaces reach the image build fine, so they must reach it.
      ["Claude,Codex", true],
      ["claude, codex", true],
      ["claude,", true],
      // Names nothing at all: caught here rather than minutes into the build.
      [",", false],
      [" ", false],
      ["bogus", false],
      ["claude,bogus", false],
    ])("SHIPIT_HARNESSES=%j -> %s", (value, expected) => {
      expect(check("harnesses_valid", value)).toBe(expected);
    });

    it.each([
      ["cloudflare", true],
      ["cloudflare,tailscale", true],
      ["Tailscale", true],
      // "none" is handled before the validator; "," must not silently mean it.
      [",", false],
      ["bogus", false],
    ])("SHIPIT_ACCESS=%j -> %s", (value, expected) => {
      expect(check("access_valid", value)).toBe(expected);
    });
  });
});
