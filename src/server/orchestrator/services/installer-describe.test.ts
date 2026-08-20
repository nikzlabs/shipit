/**
 * docs/276 — the installers describe their own questions, so an agent can ask
 * the person instead of a terminal picker asking them.
 *
 * What is guarded here, and why each one is invisible when it breaks:
 *
 * 1. **`--describe` runs and parses.** It is emitted by `cat <<JSON` with shell
 *    substitutions inside it, so an unescaped quote in a label produces a
 *    document that is still printed, still exits 0, and cannot be parsed. The
 *    agent's failure mode is then "ShipIt has no questions", not an error.
 * 2. **It changes nothing** (req 6). An agent may run this before the person has
 *    decided to install, so a describe that cloned, wrote a file, or needed root
 *    would make discovery itself the commitment.
 * 3. **The two shared blocks stay identical** — the picker and the harness
 *    question are duplicated between the installers because neither has a repo
 *    to source at the moment it asks (docs/271). A fix applied to one copy and
 *    not the other is invisible until an operator hits it on one platform.
 * 4. **A mistyped answer fails before the host changes.** The failure it
 *    replaces was "Docker is installed, the repo is cloned, and THEN the answer
 *    is rejected".
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HARNESSES } from "../../shared/catalogue/harnesses.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const LOCAL_SETUP = path.join(REPO_ROOT, "deployment/local/setup.sh");
const VPS_SETUP = path.join(REPO_ROOT, "deployment/vps/setup.sh");
const CLOUDFLARE = path.join(REPO_ROOT, "deployment/vps/cloudflare.sh");
const COMMON_BEGIN = "# --- BEGIN shipit-installer-common";
const COMMON_END = "# --- END shipit-installer-common";

interface Option {
  id: string;
  label: string;
  summary: string;
}
interface Question {
  id: string;
  title: string;
  summary: string;
  type: string;
  variable: string;
  valueFormat: string;
  default: string;
  askedWhen: string;
  secret: boolean;
  options: Option[];
}
interface Described {
  schema: string;
  installer: string;
  summary: string;
  command: string;
  needsRoot: boolean;
  platforms: string[];
  instructions: string[];
  questions: Question[];
  parameters: { id: string; title: string; variable: string; default: string }[];
  followUps: { id: string; title: string; command: string; askWhen: string }[];
}

/** The approved default set, from the one file that decides it. */
function defaultHarnesses(): string[] {
  const src = fs.readFileSync(path.join(REPO_ROOT, "docker/agent-cli/install-agent-clis.sh"), "utf8");
  const m = /^DEFAULT_HARNESSES="([^"]*)"/m.exec(src);
  if (!m) throw new Error("DEFAULT_HARNESSES not found in install-agent-clis.sh");
  return m[1].split(/\s+/).filter(Boolean);
}

function sharedBlock(file: string): string {
  const src = fs.readFileSync(file, "utf8");
  const begin = src.indexOf(COMMON_BEGIN);
  const end = src.indexOf(COMMON_END);
  expect(begin, `${COMMON_BEGIN} not found in ${file}`).toBeGreaterThanOrEqual(0);
  expect(end, `${COMMON_END} not found in ${file}`).toBeGreaterThan(begin);
  return src.slice(begin, end);
}

function describeInstaller(script: string, env: NodeJS.ProcessEnv = {}): Described {
  const out = execFileSync("bash", [script, "--describe"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return JSON.parse(out) as Described;
}

const INSTALLERS: { name: string; script: string }[] = [
  { name: "local", script: LOCAL_SETUP },
  { name: "vps", script: VPS_SETUP },
];

describe("installers describe their own questions (docs/276)", () => {
  for (const { name, script } of INSTALLERS) {
    describe(`${name} installer`, () => {
      it("prints a parseable document naming itself", () => {
        const doc = describeInstaller(script);
        expect(doc.schema).toBe("shipit.installer/1");
        expect(doc.installer).toBe(name);
        expect(doc.command).toContain("setup.sh");
        expect(doc.questions.length).toBeGreaterThan(0);
      });

      it("tells the agent to ask the person rather than choose (req 8)", () => {
        // The JSON is the only thing an agent is guaranteed to read, so the two
        // rules that are not mechanically enforceable have to travel in it.
        const joined = describeInstaller(script).instructions.join(" ").toLowerCase();
        expect(joined).toContain("do not choose for the person");
        expect(joined).toContain("secret");
      });

      it("gives every question a variable, a default and a stated condition", () => {
        for (const q of describeInstaller(script).questions) {
          expect(q.variable, `${q.id} has no variable`).toMatch(/^SHIPIT_[A-Z_]+$/);
          expect(q.title.length, `${q.id} has no title`).toBeGreaterThan(0);
          expect(q.summary.length, `${q.id} has no summary`).toBeGreaterThan(0);
          expect(["multi_select", "select", "text", "confirm"]).toContain(q.type);
          expect(q.askedWhen.length, `${q.id} does not say when it is asked`).toBeGreaterThan(0);
          expect(typeof q.secret).toBe("boolean");
          if (q.type === "text") {
            expect(q.options, `${q.id} is free text but carries options`).toEqual([]);
            continue;
          }
          expect(q.options.length, `${q.id} offers nothing`).toBeGreaterThan(0);
          const ids = q.options.map((o) => o.id);
          expect(new Set(ids).size, `${q.id} repeats an option id`).toBe(ids.length);
          for (const o of q.options) {
            expect(o.id).toMatch(/^[a-z0-9_-]+$/);
            expect(o.label.length).toBeGreaterThan(0);
          }
          // A default naming an option that does not exist would be rejected by
          // the installer's own validator — as an answer the agent read HERE.
          for (const value of q.default.split(",").filter(Boolean)) {
            expect(ids, `${q.id} defaults to '${value}', which it does not offer`).toContain(value);
          }
        }
      });

      it("offers exactly the catalogue's harnesses, preselecting the approved set", () => {
        const doc = describeInstaller(script);
        const harnesses = doc.questions.find((q) => q.id === "harnesses");
        expect(harnesses, "no harness question").toBeTruthy();
        expect(harnesses?.variable).toBe("SHIPIT_HARNESSES");
        expect(harnesses?.options.map((o) => o.id).sort()).toEqual(
          HARNESSES.map((h) => h.id).slice().sort(),
        );
        expect(harnesses?.default.split(",").filter(Boolean).sort()).toEqual(
          defaultHarnesses().slice().sort(),
        );
      });

      it("defaults the containment question to on, so omitting it never disables it (req 12)", () => {
        const egress = describeInstaller(script).questions.find((q) => q.id === "egress");
        expect(egress, "no egress question").toBeTruthy();
        expect(egress?.default).toBe("on");
        expect(egress?.options.map((o) => o.id).sort()).toEqual(["off", "on"]);
      });

      it("answers to SHIPIT_DESCRIBE, for the one-liner that cannot pass an argument", () => {
        const out = execFileSync("bash", [script], {
          encoding: "utf8",
          env: { ...process.env, SHIPIT_DESCRIBE: "1" },
        });
        expect((JSON.parse(out) as Described).installer).toBe(name);
      });
    });
  }

  it("asks the same questions in the same shape on both installers (req 9)", () => {
    const local = describeInstaller(LOCAL_SETUP);
    const vps = describeInstaller(VPS_SETUP);
    const keys = (q: Question) => Object.keys(q).sort().join(",");
    const shape = keys(local.questions[0]);
    for (const q of [...local.questions, ...vps.questions]) {
      expect(keys(q), `question '${q.id}' has a different shape`).toBe(shape);
    }
    // The two questions the local installer asks are the VPS installer's, so an
    // agent that handles one handles the other.
    for (const q of local.questions) {
      expect(vps.questions.map((v) => v.id)).toContain(q.id);
    }
  });

  it("asks the local harness question where its two dependencies are met", () => {
    // Ordering, not style. `shipit_persist_env` comes from lib.sh, which only
    // exists after the clone, and the answer is a build arg — so the question
    // has to sit between the source and the build. Moved above the source it
    // would die with "command not found" at the very END of an install that had
    // already pulled images; moved below the build it would apply one run late.
    const src = fs.readFileSync(LOCAL_SETUP, "utf8");
    const source = src.indexOf('. "$SHIPIT_HOME/deployment/local/lib.sh"');
    const ask = src.indexOf("\nresolve_harnesses\n");
    const persist = src.indexOf("shipit_persist_env SHIPIT_HARNESSES");
    const build = src.indexOf("\nshipit_build_and_up");
    expect(source).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(source);
    expect(persist).toBeGreaterThan(ask);
    expect(build).toBeGreaterThan(persist);
  });

  it("keeps the shared block byte-identical between the two installers", () => {
    // Duplicated on purpose: both scripts are curl|bash'd as a string, so
    // neither has a library to source when it asks or describes (docs/271).
    expect(sharedBlock(LOCAL_SETUP)).toBe(sharedBlock(VPS_SETUP));
  });

  it("asks for no fractional read timeout, which bash 3.2 rejects", () => {
    // /bin/bash on macOS is 3.2, and `read -t 0.05` there is not slow — it is an
    // error: the arrow key's remaining bytes are never read, and the complaint is
    // printed into the middle of the list. The picker was VPS-only until now, so
    // this platform is new to it and the whole class needs pinning, not one line.
    const block = sharedBlock(LOCAL_SETUP);
    expect(block).toContain("BASH_VERSINFO");
    expect(block, "a literal fractional -t reaches bash 3.2").not.toMatch(/-t\s+[0-9]*\.[0-9]/);
  });

  for (const { name, script } of INSTALLERS) {
    it(`${name}: --help names --describe, which is how an agent finds it`, () => {
      // Discovery is the weak link in the whole feature: --describe is useless to
      // an agent that never learns it exists, and an agent reaches for --help
      // long before it reads a README. The unknown-argument error carries the
      // same names, so a wrong guess also lands on the right answer.
      const help = execFileSync("bash", [script, "--help"], { encoding: "utf8" });
      expect(help).toContain("--describe");
      expect(help).toContain("--dry-run");
      expect(help).toContain("SHIPIT_HARNESSES");
      const bad = spawnSync("bash", [script, "--nope"], { encoding: "utf8" });
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("--describe");
    });
  }

  it("marks the Cloudflare token secret and never stores it (req 11)", () => {
    const token = describeInstaller(VPS_SETUP).questions.find(
      (q) => q.id === "cloudflare_api_token",
    );
    expect(token?.secret).toBe(true);
    expect(token?.variable).toBe("SHIPIT_CF_API_TOKEN");
    // /etc/shipit/setup.conf is re-read on every run and survives the install,
    // so the token must not reach the heredoc that writes it.
    const src = fs.readFileSync(CLOUDFLARE, "utf8");
    const written = src.slice(src.indexOf('cat > "$CONFIG_FILE"'), src.indexOf("EOC\n", src.indexOf('cat > "$CONFIG_FILE"')));
    expect(written).not.toContain("CF_API_TOKEN");
  });

  it("names every question's variable in the operator documentation", () => {
    // The table in deployment/README.md is what a person reads when they are not
    // using an agent; a variable that exists only in JSON is undiscoverable.
    const readme = fs.readFileSync(path.join(REPO_ROOT, "deployment/README.md"), "utf8");
    for (const script of [LOCAL_SETUP, VPS_SETUP]) {
      for (const q of describeInstaller(script).questions) {
        expect(readme, `${q.variable} is not documented`).toContain(q.variable);
      }
    }
  });
});

describe("--describe changes nothing (req 6)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-describe-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  for (const { name, script } of INSTALLERS) {
    for (const flag of ["--describe", "--dry-run"]) {
      it(`${name} ${flag}: writes no file and clones nothing`, () => {
        // Both previews sit ahead of the preflight, so they also run on a machine
        // with no Docker — which is most of the machines someone previews on.
        const target = path.join(home, "shipit");
        const out = execFileSync("bash", [script, flag], {
          encoding: "utf8",
          env: { ...process.env, HOME: home, SHIPIT_HOME: target },
          stdio: ["ignore", "pipe", "pipe"],
        });
        expect(out.length).toBeGreaterThan(0);
        expect(fs.existsSync(target), `the installer cloned during ${flag}`).toBe(false);
        expect(fs.readdirSync(home)).toEqual([]);
      });
    }

    it(`${name} --dry-run: reports the harness answer it would use`, () => {
      // The line an operator checks before committing to the install. With no
      // terminal the question falls through to the approved default, which is
      // exactly what a real non-interactive run would build.
      const out = execFileSync("bash", [script, "--dry-run"], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, SHIPIT_HOME: path.join(home, "shipit") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(out).toContain(`SHIPIT_HARNESSES=${defaultHarnesses().join(",")}`);
    });
  }
});

describe("a mistyped answer fails before the host changes (docs/276)", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-preanswer-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function run(script: string, env: NodeJS.ProcessEnv) {
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, SHIPIT_HOME: path.join(home, "shipit"), ...env },
      // No terminal: every question falls back to its default, so the run can
      // only stop on the validation being tested.
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  for (const { name, script } of INSTALLERS) {
    it(`${name}: rejects an unknown harness id, naming the valid ones`, () => {
      const r = run(script, { SHIPIT_HARNESSES: "clawed" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("SHIPIT_HARNESSES");
      for (const h of HARNESSES) expect(r.stderr).toContain(h.id);
      expect(fs.existsSync(path.join(home, "shipit"))).toBe(false);
    });

    it(`${name}: rejects an egress answer that is neither on nor off`, () => {
      const r = run(script, { SHIPIT_EGRESS: "maybe" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("SHIPIT_EGRESS");
      expect(fs.existsSync(path.join(home, "shipit"))).toBe(false);
    });
  }

  it("vps: rejects an unknown access id", () => {
    const r = run(VPS_SETUP, { SHIPIT_ACCESS: "ngrok" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("SHIPIT_ACCESS");
  });
});
