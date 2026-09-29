import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  resolveSecrets,
  collectMcpAgentEnv,
  renderAgentEnvBody,
  writeServiceEnvFilesToRoot,
  removeSessionServiceEnvDir,
  removeSessionSecretsDir,
  writeAgentEnvFile,
  writeIsolatedSecretFiles,
  composeSecretFilePath,
  stageSecretsEntrypoint,
} from "./secret-resolver.js";
import type { ComposeService } from "./compose-generator.js";

describe("collectMcpAgentEnv (docs/088)", () => {
  function stub(opts: {
    agentEnv?: Record<string, string>;
    mcpOAuth?: Record<string, { accessToken: string }>;
  }) {
    return {
      getAllAgentEnv: () => opts.agentEnv ?? {},
      getAllMcpOAuthTokens: () => opts.mcpOAuth ?? {},
    };
  }

  it("returns only mcp__* entries from CredentialStore.agentEnv", () => {
    expect(
      collectMcpAgentEnv(
        stub({
          agentEnv: {
            OPENAI_API_KEY: "sk-test",
            mcp__linear__LINEAR_API_KEY: "lin_api_abc",
            mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz",
          },
        }),
      ),
    ).toEqual({
      mcp__linear__LINEAR_API_KEY: "lin_api_abc",
      mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz",
    });
  });

  it("skips empty values and returns {} when there are no mcp__* keys", () => {
    expect(collectMcpAgentEnv(stub({ agentEnv: { OPENAI_API_KEY: "sk" } }))).toEqual({});
    expect(collectMcpAgentEnv(stub({ agentEnv: { mcp__a__B: "" } }))).toEqual({});
  });

  it("is independent of resolveSecrets — does not consult compose declarations", () => {
    const resolution = resolveSecrets({ services: [], userSecrets: {} });
    expect(resolution.agentValues).toEqual({});
    expect(collectMcpAgentEnv(stub({ agentEnv: { mcp__x__KEY: "v" } }))).toEqual({
      mcp__x__KEY: "v",
    });
  });

  describe("MCP OAuth tokens → MCP_PLATFORM_* env vars (docs/088 Phase 2)", () => {
    it("maps each stored mcpOAuth source to MCP_PLATFORM_<UPPER>", () => {
      expect(
        collectMcpAgentEnv(
          stub({
            mcpOAuth: {
              sentry_oauth: { accessToken: "sntry_at" },
              notion_oauth: { accessToken: "ntn_at" },
            },
          }),
        ),
      ).toEqual({
        MCP_PLATFORM_SENTRY_OAUTH: "sntry_at",
        MCP_PLATFORM_NOTION_OAUTH: "ntn_at",
      });
    });

    it("merges mcp__* secrets with MCP_PLATFORM_* tokens in one map", () => {
      expect(
        collectMcpAgentEnv(
          stub({
            agentEnv: { mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz" },
            mcpOAuth: { notion_oauth: { accessToken: "ntn_at" } },
          }),
        ),
      ).toEqual({
        mcp__sentry__SENTRY_AUTH_TOKEN: "sntrys_xyz",
        MCP_PLATFORM_NOTION_OAUTH: "ntn_at",
      });
    });

    it("skips OAuth entries with no accessToken (defensive)", () => {
      expect(
        collectMcpAgentEnv(
          stub({
            mcpOAuth: {
              // @ts-expect-error — exercising defensive guard
              broken: { refreshToken: "rt_only" },
            },
          }),
        ),
      ).toEqual({});
    });
  });
});

describe("renderAgentEnvBody (docs/088)", () => {
  it("renders sorted KEY=VALUE lines and a ShipIt header", () => {
    const body = renderAgentEnvBody({ B_KEY: "2", A_KEY: "1" });
    expect(body).toContain('A_KEY="1"');
    expect(body).toContain('B_KEY="2"');
    expect(body.indexOf("A_KEY")).toBeLessThan(body.indexOf("B_KEY"));
  });

  it("quotes values the same way as a service env file (planning#624)", () => {
    expect(renderAgentEnvBody({ K: 'sv-$x-1 "q" \\' })).toContain('K="sv-$$x-1 \\"q\\" \\\\"\n');
  });

  it("leaves out a value no environment variable can carry, instead of altering it", () => {
    const body = renderAgentEnvBody({ NUL: "a\0b", OK: "v" });
    expect(body).not.toContain("NUL=");
    expect(body).toContain('OK="v"');
  });

  it("returns an empty string for an empty map", () => {
    expect(renderAgentEnvBody({})).toBe("");
  });
});

describe("resolveSecrets", () => {
  it("returns empty resolution when no service declares secrets", () => {
    const services: ComposeService[] = [
      { name: "web" },
      { name: "db" },
    ];
    const result = resolveSecrets({ services, userSecrets: { STRIPE_KEY: "sk_test" } });
    expect(result.perServiceEnv).toEqual({});
    expect(result.missingByService).toEqual({});
    expect(result.declaredNames).toEqual([]);
  });

  it("produces a per-service env file body when secrets are declared", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk_test_123", UNUSED: "x" },
    });
    expect(result.perServiceEnv.web).toContain('STRIPE_KEY="sk_test_123"');
    expect(result.perServiceEnv.web).not.toContain("UNUSED");
    expect(result.declaredNames).toEqual(["STRIPE_KEY"]);
  });

  it("scopes secrets per service — db doesn't see web's secrets", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
      { name: "api", secrets: ["DATABASE_URL", "REDIS_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: {
        STRIPE_KEY: "sk_test",
        DATABASE_URL: "postgres://x",
        REDIS_URL: "redis://x",
      },
    });
    expect(result.perServiceEnv.web).toContain("STRIPE_KEY=");
    expect(result.perServiceEnv.web).not.toContain("DATABASE_URL");
    expect(result.perServiceEnv.web).not.toContain("REDIS_URL");
    expect(result.perServiceEnv.api).toContain("DATABASE_URL=");
    expect(result.perServiceEnv.api).toContain("REDIS_URL=");
    expect(result.perServiceEnv.api).not.toContain("STRIPE_KEY");
  });

  it("reports missing secrets per service without failing", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL", "REDIS_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    expect(result.missingByService.api).toEqual(["REDIS_URL"]);
    expect(result.perServiceEnv.api).toContain("DATABASE_URL=");
    expect(result.perServiceEnv.api).not.toContain("REDIS_URL=");
  });

  it("treats empty-string user values as missing (defends against blank fields)", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "" },
    });
    expect(result.missingByService.api).toEqual(["DATABASE_URL"]);
  });

  it("sorts keys alphabetically in env files for deterministic output", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["ZED", "ALPHA", "MIDDLE"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { ZED: "z", ALPHA: "a", MIDDLE: "m" },
    });
    const lines = result.perServiceEnv.api.trim().split("\n").filter(l => !l.startsWith("#"));
    expect(lines).toEqual(['ALPHA="a"', 'MIDDLE="m"', 'ZED="z"']);
  });

  it("de-duplicates within a service if the user repeats a name", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL", "DATABASE_URL"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    const matches = result.perServiceEnv.api.match(/DATABASE_URL=/g);
    expect(matches?.length).toBe(1);
  });

  it("writes a multi-line value as one escaped line", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["MULTILINE"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { MULTILINE: "line1\nline2\r\n" },
    });
    expect(result.perServiceEnv.api).toContain('MULTILINE="line1\\nline2\\r\\n"\n');
  });

  it("collects unique declared names across services", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
      { name: "api", secrets: ["DATABASE_URL", "STRIPE_KEY"] },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declaredNames).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
  });
});

// Values Compose's env-file reader would otherwise change (planning#624).
const AWKWARD_VALUES: Record<string, string> = {
  DOLLAR: "sv-$x-1",
  BRACED: `$\{HOME_PROBE}-$$-$`,
  QUOTES: `it's "quoted"`,
  BACKSLASHES: "a\\b\\\\c\\n\\$x\\",
  HASH: "a #not-a-comment#",
  SPACES: "  lead and trail  ",
  NEWLINES: "-----BEGIN KEY-----\nabc\n-----END KEY-----\n",
  CARRIAGE: "a\rb\r\n",
  QUOTED_START: "'single",
  UNICODE: "é 中文 🚀 ﻿",
};

describe("service env file quoting (planning#624)", () => {
  function envLine(name: string, value: string): string | undefined {
    const { perServiceEnv } = resolveSecrets({
      services: [{ name: "api", secrets: [name] }],
      userSecrets: { [name]: value },
    });
    return perServiceEnv.api.split("\n").find((l) => l.startsWith(`${name}=`));
  }

  it.each([
    ["sv-$x-1", '"sv-$$x-1"'],
    [`$\{HOME}`, `"$$\{HOME}"`],
    [`say "hi"`, '"say \\"hi\\""'],
    ["a\\b\\", '"a\\\\b\\\\"'],
    ["x #y", '"x #y"'],
    ["  padded  ", '"  padded  "'],
    ["a\nb\rc", '"a\\nb\\rc"'],
    ["'single'", `"'single'"`],
  ])("writes %j as %s", (value, written) => {
    expect(envLine("K", value)).toBe(`K=${written}`);
  });

  it.each([
    ["a NUL character", "a\0b", /NUL character/],
    ["an unpaired surrogate", "a\ud800b", /unpaired surrogate/],
  ])("refuses a value with %s rather than altering it", (_label, value, reason) => {
    const result = resolveSecrets({
      services: [{
        name: "api",
        secrets: ["BAD", "GOOD"],
        secretRequirements: [{ name: "BAD", required: true, agent: true }, { name: "GOOD" }],
      }],
      userSecrets: { BAD: value, GOOD: "ok" },
    });
    expect(result.perServiceEnv.api).not.toContain("BAD=");
    expect(result.perServiceEnv.api).toContain('GOOD="ok"');
    expect(result.perServiceValues.api).toEqual({ GOOD: "ok" });
    expect(result.agentValues).toEqual({});
    expect(result.missingByService.api).toEqual(["BAD"]);
    expect(result.missingRequiredByService.api).toEqual(["BAD"]);
    expect(result.refusedByService.api).toEqual([{ name: "BAD", reason: expect.stringMatching(reason) }]);
  });

  it("accepts a value whose surrogates are paired", () => {
    expect(envLine("K", "🚀")).toBe('K="🚀"');
  });
});

function composeCommand(): string[] | undefined {
  for (const cmd of [["docker", "compose"], ["docker-compose"]]) {
    if (spawnSync(cmd[0], [...cmd.slice(1), "version"], { stdio: "ignore" }).status === 0) return cmd;
  }
  return undefined;
}
const compose = composeCommand();

// The unit tests above pin the encoding; this checks it against Compose's own reader.
describe.skipIf(!compose)("Compose reads a service env file back verbatim (planning#624)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("delivers every awkward value unchanged", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "compose-env-roundtrip-"));
    const { perServiceEnv } = resolveSecrets({
      services: [{ name: "svc", secrets: Object.keys(AWKWARD_VALUES) }],
      userSecrets: AWKWARD_VALUES,
    });
    const envFile = path.join(tmpDir, ".env.svc");
    fs.writeFileSync(envFile, perServiceEnv.svc);
    const composeFile = path.join(tmpDir, "compose.yml");
    fs.writeFileSync(composeFile, [
      "services:",
      "  svc:",
      "    image: alpine",
      `    env_file: [${JSON.stringify(envFile)}]`,
      "    environment:",
      '      CONTROL: "a$$b"',
      "",
    ].join("\n"));

    const [bin, ...pre] = compose!;
    const out = execFileSync(bin, [...pre, "-p", "roundtrip", "-f", composeFile, "config", "--format", "json"], {
      // Referenced names are set, so any interpolation would show.
      env: { ...process.env, x: "LEAKED", HOME_PROBE: "LEAKED" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const environment = JSON.parse(out.toString("utf-8")).services.svc.environment as Record<string, string>;
    // `config` writes each literal `$` as `$$`; CONTROL shows whether this version does.
    const unescape = environment.CONTROL === "a$$b"
      ? (v: string) => v.replaceAll("$$", "$")
      : (v: string) => v;
    expect(unescape(environment.CONTROL)).toBe("a$b");
    for (const [name, value] of Object.entries(AWKWARD_VALUES)) {
      expect(unescape(environment[name]), name).toBe(value);
    }
  });
});

const ENTRYPOINT = fileURLToPath(new URL("../../../docker/secrets-entrypoint.sh", import.meta.url));

// Service images start the wrapper with whatever /bin/sh they ship; bash runs it in POSIX mode.
const SHELLS = [["sh"], ["dash"], ["bash"], ["bash", "--posix"], ["busybox", "sh"]]
  .filter(([bin, ...pre]) => spawnSync(bin, [...pre, "-c", "exit 0"], { stdio: "ignore" }).status === 0)
  .map((shell) => [shell.join(" "), shell] as const);
const CAT = execFileSync("sh", ["-c", "command -v cat"]).toString("utf-8").trim();

// Names a shell treats specially, plus every variable bash knows when it is installed.
const SHELL_NAMES = [...new Set([
  "PIPESTATUS", "SHLVL", "_", "UID", "PPID", "OPTIND", "IFS", "PS4", "LANG", "LC_ALL", "RANDOM", "SECONDS",
  "LINENO", "PATH", "FUNCNEST", "EXECIGNORE", "GLOBIGNORE", "POSIXLY_CORRECT", "LD_PRELOAD",
  ...(spawnSync("bash", ["-c", "compgen -v"], { env: { PATH: process.env.PATH } })
    .stdout?.toString("utf-8").split("\n") ?? []),
])].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));

describe("Docker-secrets mode delivers values verbatim (planning#625)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-entrypoint-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Stands in for Compose, which mounts each file at /run/secrets/shipit-<NAME>.
  function mountSecrets(files: Record<string, string | Buffer>): { script: string; mountDir: string } {
    const mountDir = fs.mkdtempSync(path.join(tmpDir, "run-secrets-"));
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(mountDir, `shipit-${name}`), body);
    }
    const source = fs.readFileSync(ENTRYPOINT, "utf-8");
    expect(source).toContain("/run/secrets/shipit-");
    const script = `${mountDir}.sh`;
    fs.writeFileSync(script, source.replaceAll("/run/secrets", mountDir));
    return { script, mountDir };
  }

  // The service's command writes out the environment it was started with.
  function start(shell: readonly string[], script: string, envPath = process.env.PATH) {
    const [bin, ...pre] = shell;
    const result = spawnSync(bin, [...pre, script, CAT, "/proc/self/environ"], {
      cwd: tmpDir,
      env: { PATH: envPath },
    });
    const env = new Map<string, string>();
    for (const entry of result.stdout.toString("utf-8").split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    return { status: result.status, stderr: result.stderr.toString("utf-8"), env };
  }

  const values: Record<string, string> = {
    ...AWKWARD_VALUES,
    TRAILING_NEWLINES: "value\n\n\n",
    ONLY_NEWLINES: "\n\n",
    TRAILING_DOT: "value.",
    ONLY_DOT: ".",
    SHELL_SYNTAX: "`id` $(id) $HOME \"$@\" * -n",
    ENDS_IN_READ_MARKER: "x.0",
    // The old wrapper's loop variable, which later iterations overwrote.
    f: "not a path",
    // Each of these, set before the other files are read, would stop the reads.
    PATH: "/nonexistent-bin",
    EXECIGNORE: "*cat*",
    FUNCNEST: "1",
    LC_ALL: "C",
    zz_after_the_others: "z",
  };

  it.each(SHELLS)("%s exports every stored value unchanged", (_label, shell) => {
    const { perServiceValues } = resolveSecrets({
      services: [{ name: "svc", secrets: Object.keys(values) }],
      userSecrets: values,
    });
    const { sessionDir, written } = writeIsolatedSecretFiles({
      rootDir: path.join(tmpDir, "secrets"),
      sessionId: "s1",
      values: perServiceValues.svc,
    });
    expect(written).toEqual(Object.keys(values).sort());
    const { script } = mountSecrets(Object.fromEntries(
      written.map((name) => [name, fs.readFileSync(path.join(sessionDir, name))]),
    ));
    // A PATH entry that runs code if the wrapper ever puts it into eval, and a
    // cat that fails if any secret is already set while it reads.
    const trap = path.join(tmpDir, "bin$(touch pwned)");
    fs.mkdirSync(trap);
    fs.writeFileSync(path.join(trap, "cat"), [
      "#!/bin/sh",
      ...Object.keys(values).filter((name) => name !== "PATH").map((name) =>
        `[ -z "\${${name}+x}" ] || { echo "cat saw secret ${name}" >&2; exit 1; }`),
      `exec '${CAT}' "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });

    const { status, stderr, env } = start(shell, script, `${trap}:${process.env.PATH}`);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    for (const [name, value] of Object.entries(values)) {
      expect(env.get(name), name).toBe(value);
    }
    expect(fs.existsSync(path.join(tmpDir, "pwned"))).toBe(false);
  });

  it.each(SHELLS)("%s delivers each name a shell treats specially exactly, or stops with a reason", (_label, shell) => {
    const wrong: string[] = [];
    for (const name of SHELL_NAMES) {
      const { script } = mountSecrets({ [name]: "v\n", AAAA: "a\n", zzzz: "z\n" });
      const { status, stderr, env } = start(shell, script);
      const exact = status === 0 && env.get(name) === "v\n" && env.get("AAAA") === "a\n" && env.get("zzzz") === "z\n";
      const refused = status !== 0 && stderr.trim() !== "" && env.size === 0;
      if (!exact && !refused) wrong.push(`${name}: status ${status}, got ${JSON.stringify(env.get(name))}`);
    }
    expect(wrong).toEqual([]);
  });

  it.each(SHELLS)("%s stops the start for a file not named after an environment variable", (_label, shell) => {
    const { script } = mountSecrets({ "A;touch pwned": "v" });
    const { status, stderr, env } = start(shell, script);
    expect(status).not.toBe(0);
    expect(env.size).toBe(0);
    expect(stderr).toContain("is not named after an environment variable");
    expect(fs.existsSync(path.join(tmpDir, "pwned"))).toBe(false);
  });

  it.each(SHELLS)("%s stops the start when it finds no secret file", (_label, shell) => {
    const { script } = mountSecrets({});
    const { status, stderr, env } = start(shell, script);
    expect(status).not.toBe(0);
    expect(env.size).toBe(0);
    expect(stderr).toContain("no secret file is readable");
  });

  it.each(SHELLS)("%s stops the start, not delivering partial output, when cat fails", (_label, shell) => {
    const { script } = mountSecrets({ K: "v" });
    // Its partial output even ends like a successful read.
    const failing = path.join(tmpDir, "failing-bin");
    fs.mkdirSync(failing);
    fs.writeFileSync(path.join(failing, "cat"), "#!/bin/sh\nprintf 'partial.0'\nexit 1\n", { mode: 0o755 });
    const { status, stderr, env } = start(shell, script, `${failing}:${process.env.PATH}`);
    expect(status).not.toBe(0);
    expect(env.size).toBe(0);
    expect(stderr).toContain("secret K could not be read");
  });
});

describe("resolveSecrets — Phase 2 extended syntax", () => {
  it("flags missing-required secrets via missingRequiredByService", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL", "OPTIONAL_KEY"],
        secretRequirements: [
          { name: "DATABASE_URL", required: true },
          { name: "OPTIONAL_KEY" },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.missingByService.api).toEqual(["DATABASE_URL", "OPTIONAL_KEY"]);
    expect(result.missingRequiredByService.api).toEqual(["DATABASE_URL"]);
  });

  it("does not flag a satisfied required secret", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", required: true }],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    expect(result.missingRequiredByService).toEqual({});
    expect(result.missingByService).toEqual({});
  });

  it("aggregates declared secrets across services with merged metadata", () => {
    const services: ComposeService[] = [
      {
        name: "web",
        secrets: ["STRIPE_KEY"],
        secretRequirements: [{ name: "STRIPE_KEY", description: "Stripe publishable key" }],
      },
      {
        name: "api",
        secrets: ["STRIPE_KEY", "DATABASE_URL"],
        secretRequirements: [
          { name: "STRIPE_KEY", required: true },
          { name: "DATABASE_URL", description: "Postgres URL", required: true },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared).toHaveLength(2);

    const stripe = result.declared.find((d) => d.name === "STRIPE_KEY");
    expect(stripe).toBeDefined();
    expect(stripe?.required).toBe(true);
    expect(stripe?.description).toBe("Stripe publishable key");
    expect(stripe?.services).toEqual(["api", "web"]);

    const db = result.declared.find((d) => d.name === "DATABASE_URL");
    expect(db?.services).toEqual(["api"]);
    expect(db?.required).toBe(true);
  });

  it("preserves agent flag in declared aggregate", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true }],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared[0].agent).toBe(true);
  });

  it("preserves source field in declared aggregate", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["ANTHROPIC_API_KEY"],
        secretRequirements: [{ name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth" }],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared[0].source).toBe("platform:claude_oauth");
  });

  it("falls back to legacy string-only secrets when secretRequirements absent", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk_test" },
    });
    expect(result.declared).toEqual([
      { name: "STRIPE_KEY", services: ["api"] },
    ]);
    expect(result.missingRequiredByService).toEqual({});
  });

  it("declared list is sorted alphabetically by name", () => {
    const services: ComposeService[] = [
      { name: "svc", secrets: ["ZED", "ALPHA", "MIDDLE"] },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared.map((d) => d.name)).toEqual(["ALPHA", "MIDDLE", "ZED"]);
  });
});

describe("resolveSecrets — Phase 3 agent injection", () => {
  it("collects values for entries marked agent: true", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL", "STRIPE_KEY"],
        secretRequirements: [
          { name: "DATABASE_URL", agent: true },
          { name: "STRIPE_KEY" },
        ],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://u:p@db:5432/app", STRIPE_KEY: "sk_test" },
    });
    expect(result.agentValues).toEqual({ DATABASE_URL: "postgres://u:p@db:5432/app" });
    expect(result.agentEnv).toContain('DATABASE_URL="postgres://u:p@db:5432/app"');
    expect(result.agentEnv).not.toContain("STRIPE_KEY");
  });

  it("excludes agent: true entries with no value", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true, required: true }],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.agentValues).toEqual({});
    expect(result.agentEnv).toBe("");
    expect(result.missingRequiredByService.api).toEqual(["DATABASE_URL"]);
  });

  it("returns empty agentEnv string when no agent entries exist", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk_test" },
    });
    expect(result.agentValues).toEqual({});
    expect(result.agentEnv).toBe("");
  });

  it("de-duplicates when the same name is agent: true in multiple services", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true }],
      },
      {
        name: "worker",
        secrets: ["DATABASE_URL"],
        secretRequirements: [{ name: "DATABASE_URL", agent: true }],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { DATABASE_URL: "postgres://x" },
    });
    expect(result.agentValues).toEqual({ DATABASE_URL: "postgres://x" });
    const lines = result.agentEnv.trim().split("\n").filter((l) => !l.startsWith("#"));
    expect(lines).toEqual(['DATABASE_URL="postgres://x"']);
  });
});

describe("writeAgentEnvFile", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-"));
    const dir = path.join(tmpDir, "workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const stateOf = (dir: string) => path.resolve(dir, "..", "state");

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes .env.agent into the session state dir, outside the clone", () => {
    const dir = setup();
    const written = writeAgentEnvFile({
      workspaceDir: dir,
      body: "DATABASE_URL=postgres://x\n",
    });
    expect(written).toBe(path.join("..", "state", ".env.agent"));
    const contents = fs.readFileSync(path.join(stateOf(dir), ".env.agent"), "utf-8");
    expect(contents).toContain("DATABASE_URL=postgres://x");
    expect(fs.existsSync(path.join(dir, ".shipit"))).toBe(false);
  });

  it("removes .env.agent when body is empty", () => {
    const dir = setup();
    const state = stateOf(dir);
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(path.join(state, ".env.agent"), "OLD=1\n");
    const result = writeAgentEnvFile({ workspaceDir: dir, body: "" });
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(state, ".env.agent"))).toBe(false);
  });

  it("creates the state dir if missing when body is non-empty", () => {
    const dir = setup();
    expect(fs.existsSync(stateOf(dir))).toBe(false);
    writeAgentEnvFile({ workspaceDir: dir, body: "X=1\n" });
    expect(fs.existsSync(path.join(stateOf(dir), ".env.agent"))).toBe(true);
  });

  it("is a no-op when body is empty and file doesn't exist", () => {
    const dir = setup();
    expect(() => writeAgentEnvFile({ workspaceDir: dir, body: "" })).not.toThrow();
  });

  it("refuses a clone that is not <sessionDir>/workspace", () => {
    const flat = fs.mkdtempSync(path.join(os.tmpdir(), "agent-env-flat-"));
    try {
      expect(() => writeAgentEnvFile({ workspaceDir: flat, body: "X=1\n" })).toThrow(
        /<sessionDir>\/workspace/,
      );
    } finally {
      fs.rmSync(flat, { recursive: true, force: true });
    }
  });
});

describe("resolveSecrets — source: platform:* no longer forwarded (docs/184)", () => {
  it("resolves a platform-sourced entry from userSecrets[name]", () => {
    const services: ComposeService[] = [
      {
        name: "orchestrator",
        secrets: ["GITHUB_TOKEN"],
        secretRequirements: [
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
        ],
      },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { GITHUB_TOKEN: "ghp_user_supplied" },
    });
    expect(result.perServiceEnv.orchestrator).toContain('GITHUB_TOKEN="ghp_user_supplied"');
    expect(result.missingByService).toEqual({});
  });

  it("treats a platform-sourced entry with no matching user secret as missing", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["ANTHROPIC_API_KEY"],
        secretRequirements: [
          { name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth", required: true },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.perServiceEnv.api).not.toContain("ANTHROPIC_API_KEY=");
    expect(result.missingByService.api).toEqual(["ANTHROPIC_API_KEY"]);
    expect(result.missingRequiredByService.api).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("reports a warning (one per entry) for each unhonored platform source", () => {
    const services: ComposeService[] = [
      {
        name: "orchestrator",
        secrets: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "SENTRY_DSN"],
        secretRequirements: [
          { name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth" },
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
          { name: "SENTRY_DSN" },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.platformSourceWarnings).toEqual([
      { service: "orchestrator", name: "ANTHROPIC_API_KEY", source: "platform:claude_oauth" },
      { service: "orchestrator", name: "GITHUB_TOKEN", source: "platform:github_token" },
    ]);
  });

  it("emits no warning when no entry declares a platform source", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["DATABASE_URL"] },
    ];
    const result = resolveSecrets({ services, userSecrets: { DATABASE_URL: "postgres://x" } });
    expect(result.platformSourceWarnings).toEqual([]);
  });

  it("regression: a real GitHub token is never injected from platform state", () => {
    const services: ComposeService[] = [
      {
        name: "evil",
        secrets: ["GITHUB_TOKEN"],
        secretRequirements: [
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
        ],
      },
    ];
    const noSecret = resolveSecrets({ services, userSecrets: {} });
    expect(noSecret.perServiceEnv.evil).not.toContain("GITHUB_TOKEN=");
    expect(noSecret.missingByService.evil).toEqual(["GITHUB_TOKEN"]);

    const withSecret = resolveSecrets({
      services,
      userSecrets: { GITHUB_TOKEN: "ghp_user_dedicated" },
    });
    expect(withSecret.perServiceEnv.evil).toContain('GITHUB_TOKEN="ghp_user_dedicated"');
  });

  it("still preserves the source field on the declared aggregate (parsed, not honored)", () => {
    const services: ComposeService[] = [
      {
        name: "api",
        secrets: ["GITHUB_TOKEN"],
        secretRequirements: [
          { name: "GITHUB_TOKEN", source: "platform:github_token" },
        ],
      },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.declared[0].source).toBe("platform:github_token");
  });
});

describe("perServiceValues (Phase 1 follow-up)", () => {
  it("captures resolved key-value pairs per service", () => {
    const services: ComposeService[] = [
      { name: "web", secrets: ["STRIPE_KEY"] },
      { name: "api", secrets: ["DATABASE_URL", "STRIPE_KEY"] },
    ];
    const result = resolveSecrets({
      services,
      userSecrets: { STRIPE_KEY: "sk", DATABASE_URL: "postgres://x" },
    });
    expect(result.perServiceValues.web).toEqual({ STRIPE_KEY: "sk" });
    expect(result.perServiceValues.api).toEqual({
      DATABASE_URL: "postgres://x",
      STRIPE_KEY: "sk",
    });
  });

  it("omits services that didn't declare any secret with a value", () => {
    const services: ComposeService[] = [
      { name: "api", secrets: ["MISSING_KEY"] },
    ];
    const result = resolveSecrets({ services, userSecrets: {} });
    expect(result.perServiceValues.api).toEqual({});
  });
});

describe("writeIsolatedSecretFiles (Phase 1 follow-up)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "isolated-secrets-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes one file per secret under <rootDir>/<sessionId>/", () => {
    const dir = setup();
    const result = writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "abc123",
      values: { DATABASE_URL: "postgres://x", STRIPE_KEY: "sk_test" },
    });
    expect(result.written).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    expect(fs.readFileSync(path.join(dir, "abc123", "DATABASE_URL"), "utf-8")).toBe("postgres://x");
    expect(fs.readFileSync(path.join(dir, "abc123", "STRIPE_KEY"), "utf-8")).toBe("sk_test");
  });

  it("sweeps stale files that aren't in the new values map", () => {
    const dir = setup();
    const sessionDir = path.join(dir, "s1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "REMOVED_KEY"), "old");
    fs.writeFileSync(path.join(sessionDir, "KEPT_KEY"), "old");

    writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "s1",
      values: { KEPT_KEY: "new" },
    });

    expect(fs.existsSync(path.join(sessionDir, "REMOVED_KEY"))).toBe(false);
    expect(fs.readFileSync(path.join(sessionDir, "KEPT_KEY"), "utf-8")).toBe("new");
  });

  it("creates the session directory if missing", () => {
    const dir = setup();
    expect(fs.existsSync(path.join(dir, "fresh"))).toBe(false);
    writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "fresh",
      values: { X: "1" },
    });
    expect(fs.existsSync(path.join(dir, "fresh"))).toBe(true);
  });

  it("creates files with restrictive permissions", () => {
    const dir = setup();
    writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "s",
      values: { K: "v" },
    });
    const stat = fs.statSync(path.join(dir, "s", "K"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns an empty written list when values is empty", () => {
    const dir = setup();
    const result = writeIsolatedSecretFiles({
      rootDir: dir,
      sessionId: "empty",
      values: {},
    });
    expect(result.written).toEqual([]);
  });
});

describe("composeSecretFilePath (Phase 1 follow-up)", () => {
  it("uses hostDir when provided (orchestrator-in-container)", () => {
    expect(composeSecretFilePath({
      rootDir: "/internal/secrets",
      hostDir: "/host/shipit-secrets",
      sessionId: "abc",
      name: "DATABASE_URL",
    })).toBe("/host/shipit-secrets/abc/DATABASE_URL");
  });

  it("falls back to rootDir when hostDir is omitted (orchestrator-on-host)", () => {
    expect(composeSecretFilePath({
      rootDir: "/var/shipit/secrets",
      sessionId: "abc",
      name: "DATABASE_URL",
    })).toBe("/var/shipit/secrets/abc/DATABASE_URL");
  });
});

describe("stageSecretsEntrypoint (planning#287)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "entrypoint-staging-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function bakedWrapper(dir: string): string {
    const src = path.join(dir, "baked.sh");
    fs.writeFileSync(src, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    return src;
  }

  it("copies the wrapper to <rootDir>/_entrypoint/ and returns that path", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const hostPath = stageSecretsEntrypoint({
      rootDir: root,
      sessionId: "abc123",
      sourcePath: bakedWrapper(dir),
    });
    const staged = path.join(root, "_entrypoint", "secrets-entrypoint.sh");
    expect(hostPath).toBe(staged);
    expect(fs.readFileSync(staged, "utf-8")).toContain("exec \"$@\"");
    expect(fs.statSync(staged).mode & 0o777).toBe(0o755);
  });

  it("maps the returned path through hostDir (orchestrator-in-container)", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const hostPath = stageSecretsEntrypoint({
      rootDir: root,
      hostDir: "/var/lib/shipit/secrets",
      sessionId: "abc123",
      sourcePath: bakedWrapper(dir),
    });
    expect(hostPath).toBe("/var/lib/shipit/secrets/_entrypoint/secrets-entrypoint.sh");
    expect(fs.existsSync(path.join(root, "_entrypoint", "secrets-entrypoint.sh"))).toBe(true);
  });

  it("survives a session's secret sweep and teardown", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const staged = stageSecretsEntrypoint({
      rootDir: root,
      sessionId: "abc123",
      sourcePath: bakedWrapper(dir),
    })!;
    writeIsolatedSecretFiles({ rootDir: root, sessionId: "abc123", values: { K: "v" } });
    writeIsolatedSecretFiles({ rootDir: root, sessionId: "abc123", values: {} });
    fs.rmSync(path.join(root, "abc123"), { recursive: true, force: true });
    expect(fs.existsSync(staged)).toBe(true);
  });

  it("is idempotent across reconciles and refreshes a changed wrapper", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    const src = bakedWrapper(dir);
    stageSecretsEntrypoint({ rootDir: root, sessionId: "s1", sourcePath: src });
    fs.writeFileSync(src, "#!/bin/sh\n# v2\nexec \"$@\"\n", { mode: 0o755 });
    const staged = stageSecretsEntrypoint({ rootDir: root, sessionId: "s2", sourcePath: src })!;
    expect(fs.readFileSync(staged, "utf-8")).toContain("# v2");
    expect(fs.readdirSync(path.join(root, "_entrypoint"))).toEqual(["secrets-entrypoint.sh"]);
  });

  it("returns null (rather than throwing) when the source is missing", () => {
    const dir = setup();
    const root = path.join(dir, "secrets");
    expect(stageSecretsEntrypoint({
      rootDir: root,
      sessionId: "s1",
      sourcePath: path.join(dir, "does-not-exist.sh"),
    })).toBeNull();
    expect(fs.readdirSync(path.join(root, "_entrypoint"))).toEqual([]);
  });
});

describe("writeServiceEnvFilesToRoot (docs/183)", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "service-env-183-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const rootDir = path.join(tmpDir, "service-env");
    fs.mkdirSync(workspaceDir, { recursive: true });
    return { workspaceDir, rootDir };
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes env files under <root>/<sessionId>/ and returns absolute paths", () => {
    const { workspaceDir, rootDir } = setup();
    const { serviceEnvFiles, sessionDir } = writeServiceEnvFilesToRoot({
      rootDir,
      sessionId: "sess1",
      workspaceDir,
      perServiceEnv: {
        web: "STRIPE_KEY=sk_test\n",
        api: "DATABASE_URL=postgres://x\n",
      },
    });

    expect(sessionDir).toBe(path.join(rootDir, "sess1"));
    expect(serviceEnvFiles.web).toBe(path.join(rootDir, "sess1", ".env.web"));
    expect(serviceEnvFiles.api).toBe(path.join(rootDir, "sess1", ".env.api"));
    expect(fs.readFileSync(serviceEnvFiles.web, "utf-8")).toContain("STRIPE_KEY=sk_test");
    expect(fs.readFileSync(serviceEnvFiles.api, "utf-8")).toContain("DATABASE_URL=postgres://x");
  });

  it("does NOT create .shipit/.env.<service> in the workspace", () => {
    const { workspaceDir, rootDir } = setup();
    writeServiceEnvFilesToRoot({
      rootDir,
      sessionId: "sess1",
      workspaceDir,
      perServiceEnv: { web: "STRIPE_KEY=sk_test\n" },
    });
    expect(fs.existsSync(path.join(workspaceDir, ".shipit", ".env.web"))).toBe(false);
  });


  it("removes stale external .env.<svc> files for services that no longer declare secrets", () => {
    const { workspaceDir, rootDir } = setup();
    const sessionDir = path.join(rootDir, "sess1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".env.removed"), "STALE=1\n");

    writeServiceEnvFilesToRoot({
      rootDir,
      sessionId: "sess1",
      workspaceDir,
      perServiceEnv: { web: "NEW=1\n" },
    });

    expect(fs.existsSync(path.join(sessionDir, ".env.removed"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, ".env.web"))).toBe(true);
  });

  it("throws when the root resolves inside the workspace (fail closed)", () => {
    const { workspaceDir } = setup();
    const insideRoot = path.join(workspaceDir, "service-env");
    expect(() =>
      writeServiceEnvFilesToRoot({
        rootDir: insideRoot,
        sessionId: "sess1",
        workspaceDir,
        perServiceEnv: { web: "X=1\n" },
      }),
    ).toThrow(/inside the agent workspace/);
    expect(fs.existsSync(insideRoot)).toBe(false);
  });

  it("throws when the root IS the workspace", () => {
    const { workspaceDir } = setup();
    expect(() =>
      writeServiceEnvFilesToRoot({
        rootDir: workspaceDir,
        sessionId: "sess1",
        workspaceDir,
        perServiceEnv: { web: "X=1\n" },
      }),
    ).toThrow(/inside the agent workspace/);
  });

  it("follows symlinks: a root symlinked to inside the workspace is rejected", () => {
    const { workspaceDir, rootDir } = setup();
    const insideTarget = path.join(workspaceDir, "leaky-service-env");
    fs.mkdirSync(insideTarget, { recursive: true });
    fs.symlinkSync(insideTarget, rootDir);

    expect(() =>
      writeServiceEnvFilesToRoot({
        rootDir,
        sessionId: "sess1",
        workspaceDir,
        perServiceEnv: { web: "X=1\n" },
      }),
    ).toThrow(/inside the agent workspace/);
    expect(fs.existsSync(path.join(insideTarget, "sess1"))).toBe(false);
  });

  it("removeSessionServiceEnvDir drops the session dir and is a no-op when absent", () => {
    const { rootDir } = setup();
    const sessionDir = path.join(rootDir, "sess1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, ".env.web"), "SECRET=1\n");

    removeSessionServiceEnvDir({ rootDir, sessionId: "sess1" });
    expect(fs.existsSync(sessionDir)).toBe(false);

    expect(() => removeSessionServiceEnvDir({ rootDir, sessionId: "sess1" })).not.toThrow();
    expect(() => removeSessionServiceEnvDir({ rootDir, sessionId: "" })).not.toThrow();
    expect(fs.existsSync(rootDir)).toBe(true);
  });

  it("removeSessionSecretsDir drops the Docker-secrets session dir and is a no-op when absent/empty", () => {
    const { rootDir } = setup();
    const sessionDir = path.join(rootDir, "sess1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "DATABASE_URL"), "postgres://x");

    removeSessionSecretsDir({ internalDir: rootDir, sessionId: "sess1" });
    expect(fs.existsSync(sessionDir)).toBe(false);

    expect(() => removeSessionSecretsDir({ internalDir: rootDir, sessionId: "sess1" })).not.toThrow();
    expect(() => removeSessionSecretsDir({ internalDir: rootDir, sessionId: "" })).not.toThrow();
    expect(fs.existsSync(rootDir)).toBe(true);
  });
});
