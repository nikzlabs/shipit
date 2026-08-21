/**
 * docs/262 req 23 — plugin credential needs on the `secrets_status` snapshot.
 *
 * The other half of `plugin-credentials.test.ts`: that file proves which store
 * decides satisfaction; this one proves the snapshot the browser receives
 * groups the answer per plugin, keeps one row per stored secret, and does not
 * let a plugin's gap escalate into the project's blocking secrets banner.
 */

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
  credentials: ["FAL_KEY", "OPENAI_API_KEY"],
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
          { name: "FAL_KEY", satisfied: true },
          { name: "OPENAI_API_KEY", satisfied: false },
        ],
      },
    ]);
  });

  it("a plugin-only name becomes a settable row, claimed by the plugin", async () => {
    const resolver = makeResolver({ plugins: () => [PALETTE] });
    await resolver.sync([]);
    const snapshot = resolver.getSnapshot();

    expect(snapshot.declared).toEqual([
      { name: "FAL_KEY", services: [], plugins: ["artk"] },
      { name: "OPENAI_API_KEY", services: [], plugins: ["artk"] },
    ]);
  });

  it("does not fire the project's blocking secrets banner", async () => {
    // `missingRequired` drives "configure secrets to run this project" in the
    // preview. A plugin's missing key is reported on the plugin's own card; it
    // does not stop the project's services from running.
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

    // A plugin never gets to rewrite the project's own declaration metadata.
    const dbUrl = snapshot.declared.find((d) => d.name === "DATABASE_URL");
    expect(dbUrl).toMatchObject({ required: true, description: "Postgres URL", services: ["api"] });
    expect(dbUrl?.plugins).toBeUndefined();
    expect(snapshot.missingRequired).toEqual(["DATABASE_URL"]);
  });

  it("ShipIt's account-level credentials never satisfy a plugin's declared name", async () => {
    // `accountAgentEnvLoader` carries the user's provider/agent tokens and MCP
    // OAuth into the AGENT's environment. req 23 puts them out of a plugin's
    // reach: satisfaction reads the project's secret store and nothing else.
    const resolver = makeResolver({
      userSecrets: {},
      accountEnv: { OPENAI_API_KEY: "fixture-account-level", MCP_PLATFORM_NOTION: "tok" },
      plugins: () => [PALETTE],
    });
    await resolver.sync([]);
    const snapshot = resolver.getSnapshot();

    expect(snapshot.plugins[0].credentials).toEqual([
      { name: "FAL_KEY", satisfied: false },
      { name: "OPENAI_API_KEY", satisfied: false },
    ]);
    // …and the account value is still there for the agent, untouched.
    expect(snapshot.agentValues.OPENAI_API_KEY).toBe("fixture-account-level");
  });

  it("an empty stored value is a gap, matching what compose does with it", async () => {
    const resolver = makeResolver({ userSecrets: { FAL_KEY: "" }, plugins: () => [PALETTE] });
    await resolver.sync([]);
    expect(resolver.getSnapshot().plugins[0].credentials[0]).toEqual({
      name: "FAL_KEY",
      satisfied: false,
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

/**
 * docs/262 req 23 — the DELIVERY half. The snapshot above says which declared
 * names a plugin has a value for; these prove the plugin's service containers
 * actually receive exactly those, from the consuming project's own store.
 *
 * The defect this closes: the card reported `satisfied` while a plugin service
 * was started with nothing, because the compose path merged only the fragment's
 * own environment with ShipIt's `SHIPIT_*` names.
 */
describe("plugin credential DELIVERY to services (req 23)", () => {
  /** One surfaced plugin service of the `palette` plugin above. */
  const paletteService = { name: "probe", credentials: ["FAL_KEY", "OPENAI_API_KEY"] };

  it("delivers exactly the declared names the project has a value for", async () => {
    const resolver = makeResolver({
      userSecrets: { FAL_KEY: "fixture-live", DATABASE_URL: "postgres://x" },
      plugins: () => [PALETTE],
    });
    await resolver.sync([], [paletteService]);

    // Declared and set → delivered. Declared and unset → omitted, never sent
    // empty, so a missing key stays a named gap instead of a third-party
    // authentication error. Stored but never declared → not a plugin's to have.
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
    // The reason delivery is the override's `environment` and not an env file:
    // Compose's env-file parser applies quote, comment and `${VAR}` handling to
    // what it reads, so these would not arrive as stored.
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
    // Values ride the generated override, which lives in the session state dir.
    // No new file, no sweep, and no path for the project's own secrets pass —
    // which runs from callers that used to know nothing about plugins — to
    // delete a running plugin's credentials.
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
