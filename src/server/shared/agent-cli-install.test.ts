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
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HARNESSES } from "./catalogue/harnesses.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = path.join(REPO_ROOT, "docker/agent-cli/install-agent-clis.sh");

function scriptSource(): string {
  return fs.readFileSync(SCRIPT, "utf8");
}

/** The approved default set — the harnesses an install with no selection gets. */
function defaultHarnesses(): string[] {
  const m = /^DEFAULT_HARNESSES="([^"]*)"/m.exec(scriptSource());
  if (!m) throw new Error("DEFAULT_HARNESSES not found in install-agent-clis.sh");
  return m[1].split(/\s+/).filter(Boolean);
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

/** Both installers ask the harness question, so both carry the two lists. */
const INSTALLERS: [string, string][] = [
  ["VPS", "deployment/vps/setup.sh"],
  ["local", "deployment/local/setup.sh"],
];

describe("installer script ↔ catalogue", () => {
  it("KNOWN_HARNESSES lists exactly the catalogue's harnesses", () => {
    const match = /^KNOWN_HARNESSES="([^"]*)"/m.exec(scriptSource());
    expect(match, "KNOWN_HARNESSES not found in install-agent-clis.sh").toBeTruthy();
    const declared = (match?.[1] ?? "").split(/\s+/).filter(Boolean).sort();
    expect(declared).toEqual(HARNESSES.map((h) => h.id).slice().sort());
  });

  it.each(INSTALLERS)("the %s installer offers exactly the catalogue's harnesses", (_name, file) => {
    // A third list of harness ids (the interactive prompt validates the answer
    // before persisting it, so it cannot ask the catalogue at runtime). Without
    // this assertion a new harness would install correctly and still be
    // unofferable — `setup.sh` would reject the operator's answer as invalid.
    const setup = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const match = /^HARNESS_ROWS=\(\n([\s\S]*?)^\)/m.exec(setup);
    expect(match, `HARNESS_ROWS not found in ${file}`).toBeTruthy();
    const offered = [...(match?.[1] ?? "").matchAll(/^\s*"([a-z]+)\|/gm)]
      .map((m) => m[1])
      .sort();
    expect(offered).toEqual(HARNESSES.map((h) => h.id).slice().sort());
  });

  it("the approved default set names only catalogue harnesses", () => {
    // DEFAULT_HARNESSES is hand-maintained and deliberately NOT the catalogue, so
    // nothing forces a new harness into it — but a typo, or an id left behind
    // after a harness is removed, would fail the image build with "unknown
    // harness" long after the edit.
    const ids = new Set<string>(HARNESSES.map((h) => h.id));
    for (const id of defaultHarnesses()) {
      expect(ids.has(id), `DEFAULT_HARNESSES names '${id}', which is not a harness`).toBe(true);
    }
    expect(defaultHarnesses().length).toBeGreaterThan(0);
  });

  it.each(INSTALLERS)("the %s installer preselects exactly the approved default set", (_name, file) => {
    // Three copies exist because each setup.sh describes and asks its question
    // while it is a string piped from curl, so neither can read
    // install-agent-clis.sh. They must agree, or an operator who accepts the
    // prompt's defaults gets a different install from one who never sees it.
    const setup = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const match = /^HARNESS_DEFAULT="([^"]*)"/m.exec(setup);
    expect(match, `HARNESS_DEFAULT not found in ${file}`).toBeTruthy();
    const preselected = (match?.[1] ?? "").split(",").filter(Boolean).sort();
    expect(preselected).toEqual(defaultHarnesses().slice().sort());
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
    // DEFAULT_HARNESSES, so changing what a default install gets is one edit
    // rather than five Dockerfiles. A value here would override it.
    expect(instructions(dockerfile)).toMatch(/^ARG SHIPIT_HARNESSES=$/m);
  });

  it.each(CLI_IMAGES)("%s puts the npm .bin dir AHEAD of /usr/local/bin on PATH (planning#444)", (dockerfile) => {
    // Not an aspiration — the PREMISE the installer's grok block rests on, pinned
    // so it cannot drift silently. Because `.bin` wins a bare-name lookup, a
    // `.bin/<harness>` entry that is a DIFFERENT PROGRAM from its /usr/local/bin
    // link is the one that runs. That is how grok spawned the npm launcher (a
    // ~157MB bootstrap into $GROK_HOME, per turn) despite /usr/local/bin/grok
    // pointing straight at the real binary.
    //
    // If this assertion ever fails, the ordering was changed: re-check whether
    // the grok shim deletion is still the right remedy, rather than deleting
    // this test. The other harnesses' links point INTO `.bin`, so the prepend is
    // load-bearing for them and this is not a suggestion to reorder it.
    // Composed rather than pattern-matched on one line. The session-worker
    // images set PATH FIVE times (npm-global, the agent CLIs, Java, the Android
    // SDK, Gradle), each prepending through `${PATH}`, so an assertion about a
    // single line proves nothing about the order the container actually gets —
    // it would just happen to read whichever line came first in the file.
    // Replay them in order against a base that contains /usr/local/bin, exactly
    // as Docker would, and ask the question that matters about the RESULT.
    const lines = [...instructions(dockerfile).matchAll(/^ENV PATH=(?:"([^"]*)"|(\S+))$/gm)]
      .map((m) => m[1] ?? m[2]!);
    expect(lines.length, `${dockerfile} sets no ENV PATH`).toBeGreaterThan(0);
    const composed = lines.reduce(
      // eslint-disable-next-line no-template-curly-in-string -- Dockerfile syntax being parsed, not a JS template
      (acc, line) => line.replaceAll("${PATH}", acc),
      "/usr/local/bin:/usr/bin:/bin",
    );
    const npmBin = composed.split(":").indexOf("/opt/agent-cli/node_modules/.bin");
    const usrLocal = composed.split(":").indexOf("/usr/local/bin");
    expect(npmBin, `${dockerfile} never puts the agent-cli .bin dir on PATH`).toBeGreaterThanOrEqual(0);
    expect(usrLocal).toBeGreaterThanOrEqual(0);
    expect(npmBin).toBeLessThan(usrLocal);
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

  /** The platform suffix the installer computes for grok's payload package. */
  const PLATFORM = `${process.platform}-${process.arch}`;

  /**
   * A stub `npm` that materializes what the real one would: every harness
   * package, its platform-specific optional dependencies (the reason the script
   * prunes by prefix rather than by exact name), and the `.bin` shims.
   *
   * Grok is materialized in its REAL published shape (planning#442): the
   * platform package carries only a brotli `grok.br`, and the `.bin/grok` shim
   * is a launcher whose runtime install dance ShipIt must never depend on — the
   * stub's shim fails loudly, so a regression that links or executes it turns
   * the build red instead of passing on launcher behaviour.
   *
   * `breakBin` overwrites one harness's shim with a failing script — the
   * "installed but does not execute" shape the exec verification must catch.
   */
  function stubNpm(opts?: { breakBin?: string }): string {
    const dir = path.join(tmp, "stub-bin");
    fs.mkdirSync(dir, { recursive: true });
    const grokBr = zlib
      .brotliCompressSync(Buffer.from(`#!/bin/sh\necho "grok 9.9.9 (stub)"\n`))
      .toString("base64");
    const npm = path.join(dir, "npm");
    fs.writeFileSync(npm, `#!/bin/sh
set -eu
[ "\${1:-}" = "ci" ] || exit 0
mkdir -p node_modules/@anthropic-ai/claude-code node_modules/@anthropic-ai/claude-code-linux-x64
mkdir -p node_modules/@openai/codex node_modules/@openai/codex-linux-x64
mkdir -p node_modules/opencode node_modules/opencode-linux-x64
mkdir -p node_modules/@xai-official/grok/bin "node_modules/@xai-official/grok-${PLATFORM}/bin"
mkdir -p node_modules/@playwright/mcp node_modules/.bin
for b in claude codex opencode playwright-mcp; do
  printf '#!/bin/sh\\necho %s\\n' "$b" > "node_modules/.bin/$b"
  chmod 0755 "node_modules/.bin/$b"
done
printf '#!/bin/sh\\necho "the grok launcher must never run" >&2\\nexit 1\\n' > node_modules/.bin/grok
chmod 0755 node_modules/.bin/grok
printf '%s' "${grokBr}" | base64 -d > "node_modules/@xai-official/grok-${PLATFORM}/bin/grok.br"
${opts?.breakBin ? `printf '#!/bin/sh\\nexit 1\\n' > "node_modules/.bin/${opts.breakBin}"` : ""}
`);
    fs.chmodSync(npm, 0o755);
    return dir;
  }

  function run(selection?: string, opts?: { breakBin?: string }): string {
    return execFileSync("sh", [SCRIPT], {
      encoding: "utf8",
      // Explicit, because with no `stdio` Node captures the child's stderr AND
      // echoes it to ours — so the failure cases below, whose whole point is
      // that the script rejects the selection, print their expected ERROR line
      // into the test log as if something had gone wrong. Captured stderr still
      // reaches the thrown error's message, which is what those tests match on.
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${stubNpm(opts)}:${process.env.PATH ?? ""}`,
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

  it("installs DEFAULT_HARNESSES by default, not every known harness (docs/271)", () => {
    // Asserted against the script's own approved list. Deliberately NOT against
    // the catalogue: a newly integrated harness is installable and offerable at
    // once, but reaches every default install only when someone adds it to that
    // line. An assertion against HARNESSES would quietly demand the opposite.
    run();
    expect(declared().slice().sort()).toEqual(defaultHarnesses().slice().sort());
    for (const id of defaultHarnesses()) {
      const binary = HARNESSES.find((h) => (h.id as string) === id)?.binary;
      expect(binary, `'${id}' is not a catalogue harness`).toBeTruthy();
      expect(exists(path.join(binDir, binary!)), id).toBe(true);
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
    // Grok too — its packages live under a scope prefix (docs/274), and a
    // deselected grok must leave neither the shim nor the payload behind.
    expect(exists(path.join(binDir, "grok"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/.bin/grok"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/@xai-official/grok"))).toBe(false);
    expect(exists(path.join(agentCliDir, `node_modules/@xai-official/grok-${PLATFORM}`))).toBe(false);
    // The selected one is untouched.
    expect(exists(path.join(agentCliDir, "node_modules/@openai/codex"))).toBe(true);
    expect(exists(path.join(binDir, "codex"))).toBe(true);
  });

  it("grok: decompresses the payload in place and links PATH at the binary, not the launcher (planning#442)", () => {
    run("grok");
    expect(declared()).toEqual(["grok"]);
    const rawBinary = path.join(agentCliDir, `node_modules/@xai-official/grok-${PLATFORM}/bin/grok`);
    // The link target is the decompressed platform binary itself. The `.bin`
    // launcher's runtime install dance (copy 157MB into $GROK_HOME per spawn,
    // or decompress into the read-only install tree) must never be on the path.
    expect(fs.readlinkSync(path.join(binDir, "grok"))).toBe(rawBinary);
    // Decompressed 0755 (root-owned at build time, so world-execute is what
    // makes it runnable by the session uid), brotli source removed.
    expect(fs.statSync(rawBinary).mode & 0o777).toBe(0o755);
    expect(exists(`${rawBinary}.br`)).toBe(false);
    // And it genuinely executes — the payload round-tripped the compression.
    expect(execFileSync(path.join(binDir, "grok"), ["--version"], { encoding: "utf8" }))
      .toContain("grok 9.9.9");
  });

  it("grok: removes the launcher shim, so PATH cannot resolve to it (planning#444)", () => {
    run("grok");
    // Linking $BIN_DIR at the real binary was never sufficient: every image
    // prepends `$AGENT_CLI_DIR/node_modules/.bin` to PATH, AHEAD of $BIN_DIR, so
    // `grok` by name found the launcher — verified in a live container, where
    // `command -v grok` answered `/opt/agent-cli/node_modules/.bin/grok`. The
    // launcher then bootstraps ~157MB into $GROK_HOME, and ShipIt hands every
    // spawn a fresh throwaway one, so that is a per-TURN cost.
    expect(exists(path.join(agentCliDir, "node_modules/.bin/grok"))).toBe(false);
    // The other harnesses keep theirs — their $BIN_DIR links point INTO `.bin`,
    // which is what the PATH prepend is for. This fix is one divergent shim, not
    // a reordering that would change resolution for all of them.
    run();
    for (const id of defaultHarnesses()) {
      const binary = HARNESSES.find((h) => (h.id as string) === id)?.binary;
      expect(exists(path.join(agentCliDir, `node_modules/.bin/${binary!}`)), id).toBe(true);
    }
  });

  it("grok: resolves to the real binary under the images' own PATH order (planning#444)", () => {
    run("grok");
    // The assertion the bug needed and nobody had: not "the link exists" but
    // "a bare-name lookup, under the PATH every image actually sets, lands on
    // the real binary". The stub's launcher exits 1 with a loud message, so a
    // regression that leaves it resolvable turns this red rather than passing on
    // launcher behaviour.
    const containerPath = `${path.join(agentCliDir, "node_modules/.bin")}${path.delimiter}${binDir}`;
    // `/bin/sh` by absolute path, deliberately: the whole point is to hand the
    // shell ONLY the two directories the images put on PATH, so a `grok` that
    // happens to be installed on the machine running the suite cannot answer the
    // lookup and make a regression look green.
    const sh = (script: string): string =>
      execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: containerPath } });
    const resolved = sh("command -v grok").trim();
    expect(resolved).toBe(path.join(binDir, "grok"));
    expect(resolved).not.toContain("node_modules");
    expect(sh("grok --version")).toContain("grok 9.9.9");
  });

  it("fails the build when a selected harness's binary does not execute", () => {
    // The planning#442 shape: every existence check passes (the shim is there,
    // executable, linked) but running it fails. The old symlink-only
    // verification shipped exactly this as a green build.
    expect(() => run("claude", { breakBin: "claude" })).toThrow(/'claude --version' does not execute/);
    expect(exists(report)).toBe(false);
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
    // image with no agent at all.
    run("");
    expect(declared().slice().sort()).toEqual(defaultHarnesses().slice().sort());
  });

  it("fails the build when the selection names nothing", () => {
    expect(() => run(",")).toThrow(/selected no harnesses/);
  });
});
