import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// A real PTY exposes key-sequence, cursor, and echo failures that piped input cannot.
const SETUP_SH = fileURLToPath(
  new URL("../../../../deployment/vps/setup.sh", import.meta.url),
);
const BEGIN = "# --- BEGIN shipit-picker";
const END = "# --- END shipit-picker";

function hasScript(): boolean {
  return has("script");
}

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

  function pick(keys: string): string {
    return execFileSync("script", ["-qec", `bash ${driverPath}`, "/dev/null"], {
      input: keys,
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  function answer(out: string): string {
    const m = /RESULT=\[(.*)\]/.exec(out.replace(/\r/g, ""));
    if (!m) throw new Error(`no RESULT line in output: ${JSON.stringify(out)}`);
    return m[1];
  }

  it("is valid bash", () => {
    execFileSync("bash", ["-n", SETUP_SH], { stdio: "pipe" });
  });

  it("without a terminal, answers with the preselection instead of prompting", () => {
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
    expect(answer(pick(" \n"))).toBe("");
  });

  it.runIf(hasScript())("moves with arrows in both directions", () => {
    expect(answer(pick("[B [A \n"))).toBe("tailscale");
  });

  it.runIf(hasScript())("accepts j/k and application-mode arrows", () => {
    expect(answer(pick("j \n"))).toBe("cloudflare,tailscale");
    expect(answer(pick("OB \n"))).toBe("cloudflare,tailscale");
    expect(answer(pick("k \n"))).toBe("cloudflare,tailscale");
  });

  it.runIf(hasScript())("ignores an unmapped key rather than confirming", () => {
    expect(answer(pick("x \n"))).toBe("");
  });

  it.runIf(hasScript())("hides the cursor while drawing, and puts it back", () => {
    const out = pick("\n");
    expect(out).toContain("[?25l");
    expect(out.lastIndexOf("[?25h")).toBeGreaterThan(out.lastIndexOf("[?25l"));
  });

  describe.runIf(hasPython())("terminal state afterwards", () => {
    // Own the PTY so Ctrl-C does not kill the observer with the picker.
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
      // read can restore saved -echo after the signal trap restores echo.
      expect(ptyRun("\x03")).toEqual({ echo: true, exit: 130 });
    });
  });

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

  describe("--dry-run", () => {
    const KNOWN_WRITES = ["/etc/shipit/setup.conf", "/etc/shipit/shipit.env"];

    function dryRun(env: Record<string, string> = {}, args = ["--dry-run"]): string {
      // A missing flag could start a real installation on a root test runner.
      if (!args.includes("--dry-run") && env.SHIPIT_DRY_RUN !== "1") {
        throw new Error("dryRun() called without --dry-run or SHIPIT_DRY_RUN=1");
      }
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
      const out = dryRun();
      expect(out).toContain("run tailscale.sh");
      expect(out).not.toContain("run cloudflare.sh");
      expect(out).toContain("harnesses: claude,codex,opencode (default)");
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
      const out = execFileSync(
        "script",
        ["-qec", `bash ${SETUP_SH} --dry-run`, "/dev/null"],
        { input: " \n\x1b[B\x1b[B \n", encoding: "utf8", timeout: 30_000 },
      ).replace(/\r/g, "");
      expect(out).toContain("[ ] Cloudflare Tunnel");
      expect(out).toContain("[*] Tailscale");
      expect(out).toContain("run cloudflare.sh");
      expect(out).toContain("run tailscale.sh");
      expect(out).toContain("SHIPIT_HARNESSES=claude,codex");
    });
  });

  describe("env pre-answer validation", () => {
    function check(fn: string, value: string): boolean {
      const setup = fs.readFileSync(SETUP_SH, "utf8");
      const body = new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?^\\}`, "m").exec(setup);
      expect(body, `${fn}() not found in setup.sh`).not.toBeNull();
      const script = [
        'SUPPORTED_HARNESSES="claude codex opencode"',
        body![0],
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
      ["Claude,Codex", true],
      ["claude, codex", true],
      ["claude,", true],
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
      [",", false],
      ["bogus", false],
    ])("SHIPIT_ACCESS=%j -> %s", (value, expected) => {
      expect(check("access_valid", value)).toBe(expected);
    });
  });
});
