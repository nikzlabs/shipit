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
    for (const q of local.questions) {
      expect(vps.questions.map((v) => v.id)).toContain(q.id);
    }
  });

  it("asks the local harness question where its two dependencies are met", () => {
    // Persistence needs lib.sh; the build needs the persisted answer.
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
    // Both scripts must work before a library is available to source.
    expect(sharedBlock(LOCAL_SETUP)).toBe(sharedBlock(VPS_SETUP));
  });

  it("asks for no fractional read timeout, which bash 3.2 rejects", () => {
    const block = sharedBlock(LOCAL_SETUP);
    expect(block).toContain("BASH_VERSINFO");
    expect(block, "a literal fractional -t reaches bash 3.2").not.toMatch(/-t\s+[0-9]*\.[0-9]/);
  });

  for (const { name, script } of INSTALLERS) {
    it(`${name}: --help names --describe, which is how an agent finds it`, () => {
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
    const src = fs.readFileSync(CLOUDFLARE, "utf8");
    const written = src.slice(src.indexOf('cat > "$CONFIG_FILE"'), src.indexOf("EOC\n", src.indexOf('cat > "$CONFIG_FILE"')));
    expect(written).not.toContain("CF_API_TOKEN");
  });

  it("names every question's variable in the operator documentation", () => {
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
