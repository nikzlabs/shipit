import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../credential-store.js";
import { writeGlobalSystemPrompt } from "../global-system-prompt.js";
import {
  ALL_SETTINGS,
  GLOBAL_SETTINGS,
  REPOSITORY_ADDRESS,
  findSetting,
  isPayloadDeclaration,
} from "../../shared/settings-catalogue/index.js";

/** The two own-route settings this read has a reader for. */
const OWN_ROUTE_READ_KEYS = ["advanced.releaseChannel", "network.egressContained"];
import {
  getSettingForAgent,
  listSettingsForAgent,
  projectSettingValue,
  scopeUnreadableReason,
  type SettingsReadDeps,
} from "./settings-read.js";

let tmpDir: string;
let credentialStore: CredentialStore;

function deps(over: Partial<SettingsReadDeps> = {}): SettingsReadDeps {
  return {
    agentRegistry: { list: () => [] } as unknown as SettingsReadDeps["agentRegistry"],
    appWorkspaceDir: tmpDir,
    sessionManager: {
      get: (id: string) => (id === "s1" ? { id, remoteUrl: "" } : undefined),
    } as unknown as SettingsReadDeps["sessionManager"],
    credentialStore,
    readReleaseChannel: async () => "edge",
    ...over,
  };
}

function egressStore(over: Partial<{
  globalEnabled: boolean;
  override: boolean | null;
}> = {}): SettingsReadDeps["egressAllowlistStore"] {
  const globalEnabled = over.globalEnabled ?? true;
  const override = over.override ?? null;
  return {
    getGlobalEnabled: () => globalEnabled,
    getSessionOverride: () => override,
    resolveContained: () => override ?? globalEnabled,
  } as unknown as SettingsReadDeps["egressAllowlistStore"];
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-settings-read-"));
  credentialStore = new CredentialStore(path.join(tmpDir, "credentials"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("listSettingsForAgent", () => {
  it("indexes the whole REGISTRY, not just the payload scalars (req 5, req 7)", async () => {
    // Against ALL_SETTINGS, never GLOBAL_SETTINGS: the same assertion written
    // against the payload source passes while `list` returns a fifth of what
    // req 5 names, because it restates the implementation's own source.
    const { settings } = await listSettingsForAgent(deps(), "s1");
    expect(settings.map((s) => s.key).sort()).toEqual(
      ALL_SETTINGS.map((d) => d.key).sort(),
    );
    // The payload scalars are a strict subset, so equality above is load-bearing.
    expect(ALL_SETTINGS.length).toBeGreaterThan(Object.keys(GLOBAL_SETTINGS).length);
  });

  it("names every scope and every store kind, so req 5 covers both dialogs", async () => {
    const { settings } = await listSettingsForAgent(deps(), "s1");
    expect(new Set(settings.map((e) => e.scope))).toEqual(new Set(["global", "project", "browser"]));
    // A browser value is named with its own reason, never as "no reader yet".
    const browser = settings.filter((e) => e.scope === "browser");
    expect(browser.length).toBeGreaterThan(0);
    expect(browser.every((e) => e.unreadableReason === "browser_local")).toBe(true);
  });

  it("says a per-item setting is per-item, without growing the index per item", async () => {
    const { settings } = await listSettingsForAgent(deps(), "s1");
    // One entry per DECLARATION (req 1): the index length is the catalogue's,
    // whatever number of roles or MCP servers the user happens to have.
    expect(settings).toHaveLength(ALL_SETTINGS.length);
    const perItem = settings.filter((e) => e.address.kind === "item");
    expect(perItem.length).toBeGreaterThan(0);
    expect(perItem.every((e) => e.address.noun && e.notes.some((n) => n.includes("per item")))).toBe(true);
  });

  it("carries the declared label and the description's first sentence", async () => {
    const { settings } = await listSettingsForAgent(deps(), "s1");
    const entry = settings.find((s) => s.key === "advanced.enableSubAgents");
    expect(entry?.label).toBe(GLOBAL_SETTINGS["advanced.enableSubAgents"].label);
    // The "(e.g. …)" mid-sentence must not end the summary.
    expect(entry?.summary).toBe(
      "Lets the agent in a session spawn another agent for a one-shot sub-task (e.g. a second-opinion review from a different model).",
    );
  });

  it("reports the stored value, not the declared default", async () => {
    credentialStore.setDeclaredSetting("advanced.autoFixCi", true);
    const { settings } = await listSettingsForAgent(deps(), "s1");
    const entry = settings.find((s) => s.key === "advanced.autoFixCi");
    // `on` rather than `true`: the catalogue's formatter renders it, not a
    // second formatter here (req 2 — one door for every emitted value).
    expect(entry).toMatchObject({ value: true, display: "on", readable: true });
  });

  it("shows a user_text setting that is not one string, rather than reading it as empty", async () => {
    const { settings } = await listSettingsForAgent(deps(), "s1");
    const identity = settings.find((s) => s.key === "git.identity");
    expect(identity?.value).toMatchObject({ name: expect.any(String), email: expect.any(String) });
    expect(identity?.display).toContain("name");
  });

  it("filters by tab and refuses a tab no setting is on", async () => {
    const { settings, tabs } = await listSettingsForAgent(deps(), "s1", { tab: "git" });
    expect(settings.map((s) => s.key)).toEqual(["git.identity"]);
    expect(tabs).toContain("advanced");
    await expect(listSettingsForAgent(deps(), "s1", { tab: "nope" })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("404s an unknown session rather than reporting defaults for one", async () => {
    await expect(listSettingsForAgent(deps(), "ghost")).rejects.toMatchObject({ statusCode: 404 });
  });

  it("degrades per entry rather than aborting, naming the reason for each kind", async () => {
    const { settings } = await listSettingsForAgent(deps(), "s1");
    const by = (key: string) => settings.find((s) => s.key === key);

    // No egress allowlist store: containment has no reader on this install.
    expect(by("network.egressContained")).toMatchObject({
      readable: false,
      unreadableReason: "no_reader",
    });
    expect(by("network.egressContained")?.effect.state).toBe("uncertain");
    // Bespoke-stored: named and described, with no value until the readers land.
    expect(by("roles[].model")).toMatchObject({ readable: false, unreadableReason: "no_reader" });
    // Browser-local: its own reason, from the declaration, not "no reader yet".
    expect(by("advanced.soundOnFinish")).toMatchObject({
      readable: false,
      unreadableReason: "browser_local",
    });
    // Per-repository, in a session that binds none.
    expect(by("project.allowAgentMerge")).toMatchObject({
      readable: false,
      unreadableReason: "no_repository",
    });

    // The payload settings still read, and the call returned every declaration.
    expect(by("advanced.autoFixCi")?.readable).toBe(true);
    expect(settings).toHaveLength(ALL_SETTINGS.length);
  });

  it("reads every setting the settings payload stores, and only those", async () => {
    const { settings } = await listSettingsForAgent(
      deps({ egressAllowlistStore: egressStore({}) }),
      "s1",
    );
    const readable = settings.filter((s) => s.readable).map((s) => s.key).sort();
    // 13 payload declarations plus the two own-route readers below.
    const expected = ALL_SETTINGS
      .filter((d) => isPayloadDeclaration(d) || OWN_ROUTE_READ_KEYS.includes(d.key))
      .map((d) => d.key)
      .sort();
    expect(readable).toEqual(expected);
  });

  it("degrades the one entry whose read throws, and still returns the rest", async () => {
    const { settings } = await listSettingsForAgent(
      deps({
        readReleaseChannel: async () => {
          throw new Error("host checkout is gone");
        },
      }),
      "s1",
    );
    const channel = settings.find((s) => s.key === "advanced.releaseChannel");
    expect(channel).toMatchObject({ readable: false, unreadableReason: "no_reader" });
    expect(channel?.notes.join(" ")).toContain("could not read");
    // A failing reader's own message can carry whatever it was holding, so it
    // goes to the server log and never into the agent's output.
    expect(JSON.stringify(settings)).not.toContain("host checkout is gone");
    expect(settings.find((s) => s.key === "advanced.autoFixCi")?.readable).toBe(true);
  });

  it("degrades the payload settings together when the bulk stored read fails, and still reads the rest", async () => {
    // The stored half is one read, so its failure costs every payload setting —
    // but not the own-route ones, and not the call.
    const broken = {
      getDeclaredSetting: () => { throw new Error("credentials file is unreadable"); },
    } as unknown as CredentialStore;
    const { settings } = await listSettingsForAgent(
      deps({ credentialStore: broken, egressAllowlistStore: egressStore({ globalEnabled: false }) }),
      "s1",
    );
    expect(settings.find((s) => s.key === "advanced.autoFixCi")).toMatchObject({
      readable: false,
      unreadableReason: "no_reader",
    });
    expect(settings.find((s) => s.key === "network.egressContained")?.value).toBe(false);
    expect(settings.find((s) => s.key === "advanced.releaseChannel")?.value).toBe("edge");
    expect(JSON.stringify(settings)).not.toContain("credentials file is unreadable");
  });

  it("reads an own-route setting through its reader", async () => {
    const { settings } = await listSettingsForAgent(
      deps({ egressAllowlistStore: egressStore({ globalEnabled: false }) }),
      "s1",
    );
    expect(settings.find((s) => s.key === "advanced.releaseChannel")?.value).toBe("edge");
    expect(settings.find((s) => s.key === "network.egressContained")?.value).toBe(false);
  });

  it("shortens the user's own prose in the index and says the whole value is longer", async () => {
    const long = "x".repeat(500);
    await writeGlobalSystemPrompt(tmpDir, long);
    const { settings } = await listSettingsForAgent(deps(), "s1");
    const entry = settings.find((s) => s.key === "instructions.userInstructions");
    expect(String(entry?.value)).toHaveLength(201);
    expect(entry?.notes.join(" ")).toContain("500 characters");
  });
});

describe("scopeUnreadableReason", () => {
  it("degrades a per-repository setting only where no repository is bound", () => {
    expect(scopeUnreadableReason({ scope: "project" }, false)).toBe("no_repository");
    expect(scopeUnreadableReason({ scope: "project" }, true)).toBeNull();
  });

  it("catches a repository ADDRESS even on a setting whose scope is not project", () => {
    expect(
      scopeUnreadableReason({ scope: "global", address: REPOSITORY_ADDRESS }, false),
    ).toBe("no_repository");
  });

  it("leaves a global setting alone in an unbound session", () => {
    expect(scopeUnreadableReason({ scope: "global" }, false)).toBeNull();
  });

  it("does not decide browser-local here — the declaration's projection does", () => {
    // One place makes that judgement, and it is the `withheld` projection, so a
    // browser setting cannot read as browser-local in one path and not another.
    expect(scopeUnreadableReason({ scope: "browser" }, true)).toBeNull();
  });
});

describe("saved is not effective", () => {
  const network = (
    over: Parameters<typeof egressStore>[0],
    container?: { status?: string; egressContainedAtStart?: boolean },
    resolved?: { contained: boolean; userHostsExcluded?: boolean },
  ) =>
    deps({
      egressAllowlistStore: egressStore(over),
      egressEnforcementStatus: "active",
      containerManager: {
        get: () => container,
        resolveEgress: () => resolved,
      },
    });

  it("says live when nothing already fixed decides otherwise", async () => {
    const entry = await getSettingForAgent(network({}), "s1", "network.egressContained");
    expect(entry.effect).toEqual({ state: "live" });
  });

  it("says restart-dependent when the running container started under the other mode", async () => {
    const entry = await getSettingForAgent(
      network({ globalEnabled: true }, { status: "running", egressContainedAtStart: false }),
      "s1",
      "network.egressContained",
    );
    expect(entry.effect.state).toBe("restart-dependent");
    expect(entry.effect.detail).toContain("open");
  });

  it("says excluded, not restart-dependent, for a sandbox whose capability forces containment", async () => {
    // `sandboxLifelineEgressConfig` contains a network-less sandbox whatever the
    // global setting says, and marks it with userHostsExcluded. A restart would
    // not adopt the global value, so promising one would be a false promise.
    const entry = await getSettingForAgent(
      network(
        { globalEnabled: false },
        { status: "running", egressContainedAtStart: true },
        { contained: true, userHostsExcluded: true },
      ),
      "s1",
      "network.egressContained",
    );
    expect(entry.effect.state).toBe("excluded");
    expect(entry.effect.detail).toContain("network capability");
  });

  it("says uncertain when a running container's boot mode is unknown", async () => {
    // A container rediscovered after a ShipIt restart records no boot policy.
    const entry = await getSettingForAgent(
      network({ globalEnabled: true }, { status: "running" }),
      "s1",
      "network.egressContained",
    );
    expect(entry.effect.state).toBe("uncertain");
    expect(entry.effect.detail).toContain("rediscovered");
  });

  it("degrades to uncertain rather than aborting when the probe throws", async () => {
    const entry = await getSettingForAgent(
      deps({
        egressEnforcementStatus: "active",
        egressAllowlistStore: {
          getGlobalEnabled: () => true,
          getSessionOverride: () => { throw new Error("db is gone"); },
          resolveContained: () => true,
        } as unknown as SettingsReadDeps["egressAllowlistStore"],
      }),
      "s1",
      "network.egressContained",
    );
    expect(entry.effect.state).toBe("uncertain");
    // The failure's own words never reach the agent; only the server log has them.
    expect(JSON.stringify(entry)).not.toContain("db is gone");
  });

  it("says excluded for this session when the session sets its own network mode", async () => {
    const entry = await getSettingForAgent(
      network({ globalEnabled: true, override: false }),
      "s1",
      "network.egressContained",
    );
    expect(entry.effect.state).toBe("excluded");
    expect(entry.effect.detail).toContain("own network mode");
  });

  it("says excluded, not restart-dependent, when nothing enforces containment at all", async () => {
    const entry = await getSettingForAgent(
      deps({ egressAllowlistStore: egressStore({}), egressEnforcementStatus: "no-sidecar" }),
      "s1",
      "network.egressContained",
    );
    expect(entry.effect.state).toBe("excluded");
    expect(entry.effect.detail).toContain("no-sidecar");
  });

  it("leaves every READABLE setting live; an unreadable one claims no effect", async () => {
    const { settings } = await listSettingsForAgent(
      deps({ egressAllowlistStore: egressStore({}), egressEnforcementStatus: "active" }),
      "s1",
    );
    const notLive = settings.filter((s) => s.readable && s.effect.state !== "live");
    expect(notLive.map((s) => s.key)).toEqual([]);
    // And a value ShipIt could not read never carries an effect claim.
    expect(settings.filter((s) => !s.readable).every((s) => s.effect.state === "uncertain")).toBe(true);
  });
});

describe("getSettingForAgent", () => {
  it("carries the whole description and the declared shape", async () => {
    const entry = await getSettingForAgent(deps(), "s1", "advanced.releaseChannel");
    expect(entry.description).toBe(GLOBAL_SETTINGS["advanced.releaseChannel"].description);
    expect(entry.valueType).toBe("enum");
    expect(entry.shape.options).toEqual(
      GLOBAL_SETTINGS["advanced.releaseChannel"].type.shape.options,
    );
  });

  it("carries a number's bounds and unit", async () => {
    const entry = await getSettingForAgent(deps(), "s1", "advanced.memoryBudgetMb");
    expect(entry.shape).toMatchObject({ integer: true, nullable: true, unit: "MB" });
    expect(entry.display).toBe("not set");
  });

  it("resolves a model selection live, naming why nothing resolves here", async () => {
    // No credential is configured in this fixture, so the honest live answer is
    // an empty option list and the resolver's own reason — not a silent null.
    const entry = await getSettingForAgent(deps(), "s1", "services.nonTurnModel");
    expect(entry.live).toMatchObject({
      options: [],
      resolved: null,
      unavailableReason: "nothing_eligible",
    });
  });

  it("resolves the eligible models from the credentials that are configured", async () => {
    credentialStore.upsertCredentialRouteWithSecret(
      {
        id: "anthropic-key-fixture",
        serviceId: "anthropic",
        billingMode: "key",
        via: "string",
        status: "ready",
        priority: 0,
        isPrimary: true,
        label: "fixture",
        createdAt: 0,
        updatedAt: 0,
      },
      "sk-ant-fixture",
    );
    const entry = await getSettingForAgent(deps(), "s1", "services.nonTurnModel");
    const live = entry.live as { options: { serviceId: string }[] };
    expect(live.options.length).toBeGreaterThan(0);
    expect(live.options.every((o) => o.serviceId === "anthropic")).toBe(true);
    // The credential itself never rides along with its eligibility.
    expect(JSON.stringify(entry)).not.toContain("sk-ant-fixture");
  });

  it("returns the user's own prose whole, where the index shortened it", async () => {
    const long = "y".repeat(500);
    await writeGlobalSystemPrompt(tmpDir, long);
    const entry = await getSettingForAgent(deps(), "s1", "instructions.userInstructions");
    expect(entry.value).toBe(long);
  });

  it("404s an unknown key by name", async () => {
    await expect(getSettingForAgent(deps(), "s1", "advanced.nope")).rejects.toMatchObject({
      statusCode: 404,
      message: expect.stringContaining("advanced.nope"),
    });
  });

  it("reports a setting the agent may propose as allowed, with no refusal to explain", async () => {
    const entry = await getSettingForAgent(deps(), "s1", "advanced.enableSubAgents");
    expect(entry.propose).toEqual({ allowed: true });
  });
});

/**
 * Req 2 through THIS read's own output paths. The sibling slice's
 * `projection.test.ts` proves the door is safe; this proves the read goes
 * through it, over the real declarations rather than over a synthetic one.
 */
describe("req 2 — nothing of a secret-bearing value reaches the agent", () => {
  const TOKEN = "SENTINEL-CREDENTIAL-MUST-NOT-BE-EMITTED";

  // Every shape a stored value can take, each carrying the sentinel somewhere a
  // formatter that skipped the door would print.
  const POISON: unknown[] = [
    TOKEN,
    [TOKEN],
    { command: TOKEN, args: [`--token=${TOKEN}`], env: { A: TOKEN }, headers: { Authorization: TOKEN } },
    [{ secret: TOKEN, accessToken: TOKEN, prompt: TOKEN }],
  ];

  const withEmits = (kind: string) => ALL_SETTINGS.filter((d) => d.emits.kind === kind);

  it("covers every configured_only and withheld declaration the catalogue has", () => {
    // A count, so a new secret-bearing declaration cannot arrive uncovered.
    expect(withEmits("configured_only").length).toBeGreaterThan(0);
    expect(withEmits("withheld").length).toBeGreaterThan(0);
  });

  it("a configured_only setting says only whether it is configured", () => {
    for (const declaration of withEmits("configured_only")) {
      for (const raw of POISON) {
        for (const detail of [false, true]) {
          const projected = projectSettingValue(declaration, raw, detail);
          expect(projected.value, declaration.key).toEqual({ configured: true });
          expect(projected.display, declaration.key).toBe("configured");
          expect(JSON.stringify(projected), declaration.key).not.toContain(TOKEN);
        }
      }
    }
  });

  it("a withheld setting emits nothing of the value at all", () => {
    for (const declaration of withEmits("withheld")) {
      for (const raw of POISON) {
        const projected = projectSettingValue(declaration, raw, true);
        expect(projected.value, declaration.key).toBeNull();
        expect(JSON.stringify(projected), declaration.key).not.toContain(TOKEN);
      }
    }
  });

  it("an MCP URL emits its scheme and host, never userinfo, path, query or fragment", () => {
    const declaration = findSetting("mcp.servers[].url");
    expect(declaration).toBeDefined();
    // Assembled part by part rather than written as one literal: a
    // `scheme://user:pass@host` string in the source reads as a real credential
    // to any scanner, whatever the value happens to be.
    const url = new URL("https://mcp.example.com");
    url.username = "svc";
    url.password = TOKEN;
    url.pathname = `/v1/${TOKEN}`;
    url.search = `api_key=${TOKEN}`;
    url.hash = TOKEN;

    const projected = projectSettingValue(declaration!, url.toString(), true);
    expect(url.toString()).toContain(TOKEN);
    expect(projected.value).toEqual({ scheme: "https", host: "mcp.example.com" });
    expect(JSON.stringify(projected)).not.toContain(TOKEN);
  });

  it("user_text is the ONE declared exception, and it is a short, named list", () => {
    // Named rather than blanket-excluded: these emit the user's own prose
    // because it is theirs, and review reads the declaration's reason.
    const keys = withEmits("user_text").map((d) => d.key).sort();
    expect(keys.length).toBeGreaterThan(0);
    for (const declaration of withEmits("user_text")) {
      expect(declaration.emits, declaration.key).toHaveProperty("reason");
    }
  });

  it("a setting ShipIt cannot read emits nothing of its stored value, end to end", async () => {
    // Every MCP field is bespoke-stored, so this read has no reader for it. The
    // entry must still be named, and must carry nothing of what is stored.
    const listed = await listSettingsForAgent(deps(), "s1");
    const mcp = listed.settings.filter((e) => e.key.startsWith("mcp.servers"));
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.every((e) => !e.readable)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);

    const detail = await getSettingForAgent(deps(), "s1", "mcp.servers[].env");
    expect(detail.readable).toBe(false);
    expect(JSON.stringify(detail)).not.toContain(TOKEN);
  });
});
