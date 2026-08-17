/**
 * docs/252 phase 9 (req 14) — the harness install is a build input.
 *
 * Two things are guarded here, because neither fails visibly at the time the
 * mistake is made:
 *
 * 1. **The installer script's harness mapping matches the catalogue.** Adding a
 *    harness to `catalogue/harnesses.ts` without teaching the script its npm
 *    package would produce an image whose install report names a harness that is
 *    not in it — the registry would then offer a binary that does not exist.
 * 2. **Every image that carries the CLIs goes through that one script**, with the
 *    `SHIPIT_HARNESSES` build arg. The orchestrator and the session worker install
 *    the CLIs independently; a selection wired into only one of them leaves an
 *    uninstalled harness still offered in the picker (orchestrator) or a picked
 *    harness with nothing to spawn (worker). Same reason the git-lfs install has a
 *    Dockerfile guard rather than a comment.
 *
 * The script's own behaviour — parsing, pruning, the report it writes — is
 * exercised below against a stub `npm`, because the alternative is discovering a
 * shell bug during a production deploy.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HARNESSES } from "./catalogue/harnesses.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "docker/agent-cli/install-agent-clis.sh");

function scriptSource(): string {
  return fs.readFileSync(SCRIPT, "utf8");
}

/** Dockerfile instructions with comments stripped (comments discuss the flags). */
function instructions(dockerfile: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, "docker", dockerfile), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

/** Every image that installs the agent CLIs. */
const CLI_IMAGES = [
  "Dockerfile.prod",
  "Dockerfile.dev",
  "Dockerfile.dogfood",
  "Dockerfile.session-worker.prod",
  "Dockerfile.session-worker.dev",
];

describe("installer script ↔ catalogue", () => {
  it("KNOWN_HARNESSES lists exactly the catalogue's harnesses", () => {
    const match = /^KNOWN_HARNESSES="([^"]*)"/m.exec(scriptSource());
    expect(match, "KNOWN_HARNESSES not found in install-agent-clis.sh").toBeTruthy();
    const declared = (match?.[1] ?? "").split(/\s+/).filter(Boolean).sort();
    expect(declared).toEqual(HARNESSES.map((h) => h.id).slice().sort());
  });

  it("the VPS installer offers exactly the catalogue's harnesses", () => {
    // A third list of harness ids (the interactive prompt validates the answer
    // before persisting it, so it cannot ask the catalogue at runtime). Without
    // this assertion a new harness would install correctly and still be
    // unofferable — `setup.sh` would reject the operator's answer as invalid.
    const setup = fs.readFileSync(path.join(REPO_ROOT, "deployment/vps/setup.sh"), "utf8");
    const match = /^HARNESS_ROWS=\(\n([\s\S]*?)^\)/m.exec(setup);
    expect(match, "HARNESS_ROWS not found in deployment/vps/setup.sh").toBeTruthy();
    const offered = [...(match?.[1] ?? "").matchAll(/^\s*"([a-z]+)\|/gm)]
      .map((m) => m[1])
      .sort();
    expect(offered).toEqual(HARNESSES.map((h) => h.id).slice().sort());
  });

  it("maps every harness to an npm package and to its catalogue binary", () => {
    const src = scriptSource();
    const pkgCases = src.slice(src.indexOf("harness_pkg_prefix()"), src.indexOf("harness_bin()"));
    const binCases = src.slice(src.indexOf("harness_bin()"), src.indexOf("contains()"));
    for (const harness of HARNESSES) {
      expect(pkgCases, `no package mapping for '${harness.id}'`).toContain(`${harness.id})`);
      expect(binCases, `no binary mapping for '${harness.id}'`).toContain(`echo "${harness.binary}"`);
    }
  });
});

describe("every image installs the CLIs through the shared script", () => {
  it.each(CLI_IMAGES)("%s declares the SHIPIT_HARNESSES build arg", (dockerfile) => {
    // Empty on purpose (docs/271): the default lives in install-agent-clis.sh's
    // KNOWN_HARNESSES, so a newly added harness is on by default everywhere
    // without five Dockerfiles to remember. A value here would override it.
    expect(instructions(dockerfile)).toMatch(/^ARG SHIPIT_HARNESSES=$/m);
  });

  it.each(CLI_IMAGES)("%s runs install-agent-clis rather than its own npm ci", (dockerfile) => {
    const src = instructions(dockerfile);
    expect(src).toContain("COPY docker/agent-cli/install-agent-clis.sh /usr/local/bin/install-agent-clis");
    expect(src).toMatch(/RUN[^\n]*install-agent-clis$/m);
    // The hand-rolled install this replaced would silently ignore the selection.
    expect(src).not.toContain("npm ci --ignore-scripts");
  });
});

describe("install-agent-clis.sh behaviour", () => {
  let tmp: string;
  let agentCliDir: string;
  let binDir: string;
  let report: string;

  /**
   * A stub `npm` that materializes what the real one would: every harness
   * package, its platform-specific optional dependencies (the reason the script
   * prunes by prefix rather than by exact name), and the `.bin` shims.
   */
  function stubNpm(): string {
    const dir = path.join(tmp, "stub-bin");
    fs.mkdirSync(dir, { recursive: true });
    const npm = path.join(dir, "npm");
    fs.writeFileSync(npm, `#!/bin/sh
set -eu
[ "\${1:-}" = "ci" ] || exit 0
mkdir -p node_modules/@anthropic-ai/claude-code node_modules/@anthropic-ai/claude-code-linux-x64
mkdir -p node_modules/@openai/codex node_modules/@openai/codex-linux-x64
mkdir -p node_modules/opencode node_modules/opencode-linux-x64
mkdir -p node_modules/@playwright/mcp node_modules/.bin
for b in claude codex opencode playwright-mcp; do
  printf '#!/bin/sh\\necho %s\\n' "$b" > "node_modules/.bin/$b"
  chmod 0755 "node_modules/.bin/$b"
done
`);
    fs.chmodSync(npm, 0o755);
    return dir;
  }

  function run(selection?: string): string {
    return execFileSync("sh", [SCRIPT], {
      encoding: "utf8",
      env: {
        PATH: `${stubNpm()}:${process.env.PATH ?? ""}`,
        HOME: tmp,
        AGENT_CLI_DIR: agentCliDir,
        BIN_DIR: binDir,
        SHIPIT_AGENTS_INSTALL_REPORT: report,
        ...(selection === undefined ? {} : { SHIPIT_HARNESSES: selection }),
      },
    });
  }

  function declared(): string[] {
    return (JSON.parse(fs.readFileSync(report, "utf8")) as { harnesses: string[] }).harnesses;
  }

  const exists = (p: string): boolean => fs.existsSync(p);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cli-install-"));
    agentCliDir = path.join(tmp, "opt/agent-cli");
    binDir = path.join(tmp, "usr/local/bin");
    report = path.join(tmp, "opt/shipit/agents/installed.json");
    fs.mkdirSync(agentCliDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("installs every known harness by default (docs/271)", () => {
    // Asserted against the catalogue, not a literal list: a harness added there
    // must be on by default, which is the whole point of deriving the default
    // from KNOWN_HARNESSES rather than spelling it out in five Dockerfiles.
    run();
    expect(declared().slice().sort()).toEqual(HARNESSES.map((h) => h.id).slice().sort());
    for (const harness of HARNESSES) {
      expect(exists(path.join(binDir, harness.binary)), harness.id).toBe(true);
    }
    // Not a harness — the browser MCP server ships regardless of the selection.
    expect(exists(path.join(binDir, "playwright-mcp"))).toBe(true);
  });

  it("prunes a deselected harness, its platform packages and its bins", () => {
    run("codex");
    expect(declared()).toEqual(["codex"]);
    expect(exists(path.join(binDir, "claude"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/.bin/claude"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/@anthropic-ai/claude-code"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/@anthropic-ai/claude-code-linux-x64"))).toBe(false);
    // The selected one is untouched.
    expect(exists(path.join(agentCliDir, "node_modules/@openai/codex"))).toBe(true);
    expect(exists(path.join(binDir, "codex"))).toBe(true);
  });

  it("normalizes case, spacing and order", () => {
    run(" Codex, CLAUDE ,codex ");
    expect(declared()).toEqual(["codex", "claude"]);
  });

  it("fails the build on an unknown harness instead of silently dropping it", () => {
    expect(() => run("claude,cursor")).toThrow(/unknown harness 'cursor'/);
    expect(exists(report)).toBe(false);
  });

  it("treats an empty value as unset — `--build-arg SHIPIT_HARNESSES=` gets the default", () => {
    // Matches the compose-level `${SHIPIT_HARNESSES:-}` substitution, so an
    // operator who blanks the line in shipit.env gets the default rather than an
    // image with no agent at all. That default is every known harness (docs/271),
    // derived from KNOWN_HARNESSES rather than spelled out — this asserts the
    // catalogue, so a harness added there is on by default or this test fails.
    run("");
    expect(declared().sort()).toEqual(HARNESSES.map((h) => h.id).sort());
  });

  it("fails the build when the selection names nothing", () => {
    expect(() => run(",")).toThrow(/selected no harnesses/);
  });
});
