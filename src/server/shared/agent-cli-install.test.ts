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

function defaultHarnesses(): string[] {
  const m = /^DEFAULT_HARNESSES="([^"]*)"/m.exec(scriptSource());
  if (!m) throw new Error("DEFAULT_HARNESSES not found in install-agent-clis.sh");
  return m[1].split(/\s+/).filter(Boolean);
}

function instructions(dockerfile: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, "docker", dockerfile), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
}

const CLI_IMAGES = [
  "Dockerfile.prod",
  "Dockerfile.dev",
  "Dockerfile.dogfood",
  "Dockerfile.session-worker.prod",
  "Dockerfile.session-worker.dev",
];

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
    const setup = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
    const match = /^HARNESS_ROWS=\(\n([\s\S]*?)^\)/m.exec(setup);
    expect(match, `HARNESS_ROWS not found in ${file}`).toBeTruthy();
    const offered = [...(match?.[1] ?? "").matchAll(/^\s*"([a-z]+)\|/gm)]
      .map((m) => m[1])
      .sort();
    expect(offered).toEqual(HARNESSES.map((h) => h.id).slice().sort());
  });

  it("the approved default set names only catalogue harnesses", () => {
    const ids = new Set<string>(HARNESSES.map((h) => h.id));
    for (const id of defaultHarnesses()) {
      expect(ids.has(id), `DEFAULT_HARNESSES names '${id}', which is not a harness`).toBe(true);
    }
    expect(defaultHarnesses().length).toBeGreaterThan(0);
  });

  it.each(INSTALLERS)("the %s installer preselects exactly the approved default set", (_name, file) => {
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
    expect(instructions(dockerfile)).toMatch(/^ARG SHIPIT_HARNESSES=$/m);
  });

  it.each(CLI_IMAGES)("%s puts the npm .bin dir AHEAD of /usr/local/bin on PATH (planning#444)", (dockerfile) => {
    // Compose every PATH assignment; a single line cannot establish the final order.
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
    expect(src).not.toContain("npm ci --ignore-scripts");
  });
});

describe("install-agent-clis.sh behaviour", () => {
  let tmp: string;
  let agentCliDir: string;
  let binDir: string;
  let report: string;

  const PLATFORM = `${process.platform}-${process.arch}`;

  // The Grok launcher fails so only the decompressed platform binary can pass.
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
    run();
    expect(declared().slice().sort()).toEqual(defaultHarnesses().slice().sort());
    for (const id of defaultHarnesses()) {
      const binary = HARNESSES.find((h) => (h.id as string) === id)?.binary;
      expect(binary, `'${id}' is not a catalogue harness`).toBeTruthy();
      expect(exists(path.join(binDir, binary!)), id).toBe(true);
    }
    expect(exists(path.join(binDir, "playwright-mcp"))).toBe(true);
  });

  it("keeps the Codex auth dependency for an OpenCode-only install without offering its harness", () => {
    run("opencode");
    expect(declared()).toEqual(["opencode"]);
    expect(exists(path.join(binDir, "opencode"))).toBe(true);
    expect(exists(path.join(binDir, "codex"))).toBe(true);
    expect(exists(path.join(agentCliDir, "node_modules/@openai/codex"))).toBe(true);
    expect(exists(path.join(binDir, "claude"))).toBe(false);
  });

  it("prunes a deselected harness, its platform packages and its bins", () => {
    run("codex");
    expect(declared()).toEqual(["codex"]);
    expect(exists(path.join(binDir, "claude"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/.bin/claude"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/@anthropic-ai/claude-code"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/@anthropic-ai/claude-code-linux-x64"))).toBe(false);
    expect(exists(path.join(binDir, "grok"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/.bin/grok"))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/@xai-official/grok"))).toBe(false);
    expect(exists(path.join(agentCliDir, `node_modules/@xai-official/grok-${PLATFORM}`))).toBe(false);
    expect(exists(path.join(agentCliDir, "node_modules/@openai/codex"))).toBe(true);
    expect(exists(path.join(binDir, "codex"))).toBe(true);
  });

  it("grok: decompresses the payload in place and links PATH at the binary, not the launcher (planning#442)", () => {
    run("grok");
    expect(declared()).toEqual(["grok"]);
    const rawBinary = path.join(agentCliDir, `node_modules/@xai-official/grok-${PLATFORM}/bin/grok`);
    expect(fs.readlinkSync(path.join(binDir, "grok"))).toBe(rawBinary);
    expect(fs.statSync(rawBinary).mode & 0o777).toBe(0o755);
    expect(exists(`${rawBinary}.br`)).toBe(false);
    expect(execFileSync(path.join(binDir, "grok"), ["--version"], { encoding: "utf8" }))
      .toContain("grok 9.9.9");
  });

  it("grok: removes the launcher shim, so PATH cannot resolve to it (planning#444)", () => {
    run("grok");
    expect(exists(path.join(agentCliDir, "node_modules/.bin/grok"))).toBe(false);
    run();
    for (const id of defaultHarnesses()) {
      const binary = HARNESSES.find((h) => (h.id as string) === id)?.binary;
      expect(exists(path.join(agentCliDir, `node_modules/.bin/${binary!}`)), id).toBe(true);
    }
  });

  it("grok: resolves to the real binary under the images' own PATH order (planning#444)", () => {
    run("grok");
    const containerPath = `${path.join(agentCliDir, "node_modules/.bin")}${path.delimiter}${binDir}`;
    // Restrict PATH so an installed host binary cannot satisfy the test.
    const sh = (script: string): string =>
      execFileSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { PATH: containerPath } });
    const resolved = sh("command -v grok").trim();
    expect(resolved).toBe(path.join(binDir, "grok"));
    expect(resolved).not.toContain("node_modules");
    expect(sh("grok --version")).toContain("grok 9.9.9");
  });

  it("fails the build when a selected harness's binary does not execute", () => {
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
    run("");
    expect(declared().slice().sort()).toEqual(defaultHarnesses().slice().sort());
  });

  it("fails the build when the selection names nothing", () => {
    expect(() => run(",")).toThrow(/selected no harnesses/);
  });
});
