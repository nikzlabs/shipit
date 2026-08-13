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
