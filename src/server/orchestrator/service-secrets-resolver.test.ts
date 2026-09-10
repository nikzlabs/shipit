import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ServiceSecretsResolver } from "./service-secrets-resolver.js";
import type { ComposeService } from "./compose-generator.js";
import type { PluginCredentialDeclaration } from "../shared/plugin-credentials.js";

const PALETTE: PluginCredentialDeclaration = {
  repo: "art-kit",
  plugin: "palette",
  alias: "artk",
  credentials: [
    { name: "FAL_KEY", optional: false },
    { name: "OPENAI_API_KEY", optional: false },
  ],
};

let sessionDir: string;
let workspaceDir: string;

beforeEach(() => {
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-resolver-"));
  workspaceDir = path.join(sessionDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function makeResolver(opts: {
  userSecrets?: Record<string, string>;
  accountEnv?: Record<string, string>;
  plugins?: () => PluginCredentialDeclaration[];
}) {
  return new ServiceSecretsResolver({
    sessionId: "s1",
    workspaceDir,
    serviceEnvDir: path.join(sessionDir, "service-env"),
    secretsLoader: async () => opts.userSecrets ?? {},
    ...(opts.accountEnv ? { accountAgentEnvLoader: () => opts.accountEnv! } : {}),
    ...(opts.plugins ? { pluginCredentialsLoader: opts.plugins } : {}),
  });
}

const apiService: ComposeService[] = [
  {
    name: "api",
    secrets: ["DATABASE_URL", "FAL_KEY"],
    secretRequirements: [
      { name: "DATABASE_URL", required: true, description: "Postgres URL" },
      { name: "FAL_KEY" },
    ],
  } as unknown as ComposeService,
];

describe("plugin credential needs on secrets_status (req 23)", () => {
  it("groups each plugin's declared names with their satisfaction", async () => {
    const resolver = makeResolver({
      userSecrets: { FAL_KEY: "fixture-live" },
      plugins: () => [PALETTE],
    });
    await resolver.sync([]);

    expect(resolver.getSnapshot().plugins).toEqual([
      {
        repo: "art-kit",
        plugin: "palette",
        alias: "artk",
        credentials: [
          { name: "FAL_KEY", satisfied: true, optional: false },
          { name: "OPENAI_API_KEY", satisfied: false, optional: false },
        ],
      },
    ]);
  });

  it("a plugin-only name becomes a settable row, claimed by the plugin", async () => {
    const resolver = makeResolver({ plugins: () => [PALETTE] });
    await resolver.sync([]);
    const snapshot = resolver.getSnapshot();

    expect(snapshot.declared).toEqual([
      { name: "FAL_KEY", services: [], plugins: ["artk"], pluginRequired: true },
      { name: "OPENAI_API_KEY", services: [], plugins: ["artk"], pluginRequired: true },
    ]);
  });

  it("says whether a claiming plugin can work without the name", async () => {
    const resolver = makeResolver({
      plugins: () => [
        {
          repo: "art-kit",
          plugin: "palette",
          alias: "artk",
          credentials: [
            { name: "FAL_KEY", optional: false },
            { name: "PIXELLAB_KEY", optional: true },
          ],
        },
      ],
    });
    await resolver.sync([]);
    const byName = new Map(resolver.getSnapshot().declared.map((d) => [d.name, d]));
    expect(byName.get("FAL_KEY")?.pluginRequired).toBe(true);
    expect(byName.get("PIXELLAB_KEY")?.pluginRequired).toBe(false);
    expect(byName.get("PIXELLAB_KEY")?.plugins).toEqual(["artk"]);
  });

  it("never writes a plugin's answer onto compose's `required`", async () => {
    const resolver = makeResolver({
      plugins: () => [
        { repo: "art-kit", plugin: "palette", alias: "artk", credentials: [{ name: "FAL_KEY", optional: false }] },
      ],
    });
    await resolver.sync(apiService);
    const falKey = resolver.getSnapshot().declared.find((d) => d.name === "FAL_KEY");
    expect(falKey?.pluginRequired).toBe(true);
    expect(falKey?.required).toBeUndefined();
    expect(resolver.getSnapshot().missingRequired).not.toContain("FAL_KEY");
  });

  it("does not fire the project's blocking secrets banner", async () => {
    const resolver = makeResolver({ plugins: () => [PALETTE] });
    await resolver.sync([]);
    expect(resolver.getSnapshot().missingRequired).toEqual([]);
  });

  it("a name claimed by a service AND a plugin stays one row with both claimants", async () => {
    const resolver = makeResolver({ plugins: () => [PALETTE] });
    await resolver.sync(apiService);
    const snapshot = resolver.getSnapshot();

    const falKey = snapshot.declared.filter((d) => d.name === "FAL_KEY");
    expect(falKey).toHaveLength(1);
    expect(falKey[0]).toMatchObject({ services: ["api"], plugins: ["artk"] });

    const dbUrl = snapshot.declared.find((d) => d.name === "DATABASE_URL");
    expect(dbUrl).toMatchObject({ required: true, description: "Postgres URL", services: ["api"] });
    expect(dbUrl?.plugins).toBeUndefined();
    expect(snapshot.missingRequired).toEqual(["DATABASE_URL"]);
  });

  it("ShipIt's account-level credentials never satisfy a plugin's declared name", async () => {
    const resolver = makeResolver({
      userSecrets: {},
      accountEnv: { OPENAI_API_KEY: "fixture-account-level", MCP_PLATFORM_NOTION: "tok" },
      plugins: () => [PALETTE],
    });
    await resolver.sync([]);
    const snapshot = resolver.getSnapshot();

    expect(snapshot.plugins[0].credentials).toEqual([
      { name: "FAL_KEY", satisfied: false, optional: false },
      { name: "OPENAI_API_KEY", satisfied: false, optional: false },
    ]);
    expect(snapshot.agentValues.OPENAI_API_KEY).toBe("fixture-account-level");
  });

  it("an empty stored value is a gap, matching what compose does with it", async () => {
    const resolver = makeResolver({ userSecrets: { FAL_KEY: "" }, plugins: () => [PALETTE] });
    await resolver.sync([]);
    expect(resolver.getSnapshot().plugins[0].credentials[0]).toEqual({
      name: "FAL_KEY",
      satisfied: false,
      optional: false,
    });
  });

  it("a failing plugin loader leaves the compose secrets pass intact", async () => {
    const resolver = makeResolver({
      userSecrets: { DATABASE_URL: "postgres://x" },
      plugins: () => {
        throw new Error("state dir vanished");
      },
    });
    await resolver.sync(apiService);
    const snapshot = resolver.getSnapshot();
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.declared.map((d) => d.name)).toEqual(["DATABASE_URL", "FAL_KEY"]);
  });

  it("no loader at all is the pre-plugin behaviour, unchanged", async () => {
    const resolver = makeResolver({ userSecrets: { DATABASE_URL: "postgres://x" } });
    await resolver.sync(apiService);
    const snapshot = resolver.getSnapshot();
    expect(snapshot.plugins).toEqual([]);
    expect(snapshot.declared.every((d) => d.plugins === undefined)).toBe(true);
  });

  it("the published snapshot is a copy — a subscriber cannot mutate resolver state", async () => {
    const seen: ReturnType<ServiceSecretsResolver["getSnapshot"]>[] = [];
    const resolver = new ServiceSecretsResolver({
      sessionId: "s1",
      workspaceDir,
      serviceEnvDir: path.join(sessionDir, "service-env"),
      secretsLoader: async () => ({}),
      pluginCredentialsLoader: () => [PALETTE],
      onSnapshot: (s) => seen.push(s),
    });
    await resolver.sync([]);

    seen[0].plugins[0].credentials[0].satisfied = true;
    seen[0].plugins.length = 0;
    expect(resolver.getSnapshot().plugins[0].credentials[0].satisfied).toBe(false);
  });
});

describe("plugin credential DELIVERY to services (req 23)", () => {
  const paletteService = { name: "probe", credentials: ["FAL_KEY", "OPENAI_API_KEY"] };

  it("delivers exactly the declared names the project has a value for", async () => {
    const resolver = makeResolver({
      userSecrets: { FAL_KEY: "fixture-live", DATABASE_URL: "postgres://x" },
      plugins: () => [PALETTE],
    });
    await resolver.sync([], [paletteService]);

    expect(resolver.getPluginServiceEnv()).toEqual({ probe: { FAL_KEY: "fixture-live" } });
  });

  it("what the card calls satisfied is what the container gets", async () => {
    const resolver = makeResolver({
      userSecrets: { FAL_KEY: "fixture-live" },
      plugins: () => [PALETTE],
    });
    await resolver.sync([], [paletteService]);

    const delivered = resolver.getPluginServiceEnv()!.probe;
    for (const need of resolver.getSnapshot().plugins[0].credentials) {
      expect(need.name in delivered).toBe(need.satisfied);
    }
  });

  it("carries a value of any shape, unaltered", async () => {
    const awkward = `line1\nline2 # not a comment $\{HOME} "quoted"`;
    const resolver = makeResolver({
      userSecrets: { FAL_KEY: awkward },
      plugins: () => [PALETTE],
    });
    await resolver.sync([], [paletteService]);
    expect(resolver.getPluginServiceEnv()!.probe.FAL_KEY).toBe(awkward);
  });

  it("ShipIt's account-level credentials are never delivered to a plugin service", async () => {
    const resolver = makeResolver({
      userSecrets: {},
      accountEnv: { OPENAI_API_KEY: "fixture-account-level" },
      plugins: () => [PALETTE],
    });
    await resolver.sync([], [paletteService]);
    expect(resolver.getPluginServiceEnv()).toEqual({ probe: {} });
  });

  it("a service whose plugin declares nothing is delivered nothing", async () => {
    const resolver = makeResolver({ userSecrets: { FAL_KEY: "x" }, plugins: () => [PALETTE] });
    await resolver.sync([], [{ name: "sidecar", credentials: [] }]);
    expect(resolver.getPluginServiceEnv()).toEqual({ sidecar: {} });
  });

  it("a service that goes away leaves nothing behind", async () => {
    const resolver = makeResolver({ userSecrets: { FAL_KEY: "v" }, plugins: () => [PALETTE] });
    await resolver.sync([], [paletteService]);
    await resolver.sync([], []);
    expect(resolver.getPluginServiceEnv()).toEqual({});
  });

  it("nothing is written to disk for a plugin service", async () => {
    const resolver = makeResolver({ userSecrets: { FAL_KEY: "v" }, plugins: () => [PALETTE] });
    await resolver.sync(apiService, [paletteService]);
    const envRoot = path.join(sessionDir, "service-env", "s1");
    expect(fs.readdirSync(envRoot)).toEqual([".env.api"]);
  });

  it("the published env map is a copy — a caller cannot mutate resolver state", async () => {
    const resolver = makeResolver({ userSecrets: { FAL_KEY: "v" }, plugins: () => [PALETTE] });
    await resolver.sync([], [paletteService]);
    resolver.getPluginServiceEnv()!.probe.FAL_KEY = "tampered";
    expect(resolver.getPluginServiceEnv()!.probe.FAL_KEY).toBe("v");
  });

  it("no plugin services at all is the pre-plugin behaviour, unchanged", async () => {
    const resolver = makeResolver({ userSecrets: { DATABASE_URL: "postgres://x" } });
    await resolver.sync(apiService);
    expect(resolver.getPluginServiceEnv()).toEqual({});
    expect(resolver.getServiceEnvFiles()?.api).toBeDefined();
  });
});
