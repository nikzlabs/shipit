import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CredentialStore } from "../credential-store.js";
import { writeGlobalSystemPrompt } from "../global-system-prompt.js";
import { GLOBAL_SETTINGS } from "../../shared/settings-catalogue/index.js";
import {
  getSettingForAgent,
  listSettingsForAgent,
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
  it("indexes every declaration, so a setting declared once is readable with no edit here", async () => {
    const { settings } = await listSettingsForAgent(deps(), "s1");
    expect(settings.map((s) => s.key).sort()).toEqual(Object.keys(GLOBAL_SETTINGS).sort());
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
    expect(entry).toMatchObject({ value: true, display: "true", readable: true });
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

  it("degrades one entry rather than aborting when a setting cannot be read", async () => {
    // No egress allowlist store: containment has no reader on this install.
    const { settings } = await listSettingsForAgent(deps(), "s1");
    const contained = settings.find((s) => s.key === "network.egressContained");
    expect(contained).toMatchObject({ readable: false, unreadableReason: "no_reader" });
    expect(contained?.effect.state).toBe("uncertain");
    // Every other global setting still came back.
    expect(settings.filter((s) => s.readable).length).toBe(settings.length - 1);
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
  it("names a browser setting instead of dropping it", () => {
    expect(scopeUnreadableReason({ scope: "browser" }, true)).toBe("browser_local");
  });

  it("degrades a per-repository setting only where no repository is bound", () => {
    expect(scopeUnreadableReason({ scope: "project" }, false)).toBe("no_repository");
    expect(scopeUnreadableReason({ scope: "project" }, true)).toBeNull();
  });

  it("leaves a global setting alone in an unbound session", () => {
    expect(scopeUnreadableReason({ scope: "global" }, false)).toBeNull();
  });
});

describe("saved is not effective", () => {
  const network = (over: Parameters<typeof egressStore>[0], container?: unknown) =>
    deps({
      egressAllowlistStore: egressStore(over),
      egressEnforcementStatus: "active",
      ...(container ? { containerManager: { get: () => container } as SettingsReadDeps["containerManager"] } : {}),
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

  it("leaves every other setting live", async () => {
    const { settings } = await listSettingsForAgent(
      deps({ egressAllowlistStore: egressStore({}), egressEnforcementStatus: "active" }),
      "s1",
    );
    const notLive = settings.filter((s) => s.effect.state !== "live").map((s) => s.key);
    expect(notLive).toEqual([]);
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

  it("resolves a model selection live", async () => {
    const entry = await getSettingForAgent(deps(), "s1", "services.nonTurnModel");
    expect(entry.live).toBeDefined();
    expect(entry.live).toHaveProperty("options");
    expect(entry.live).toHaveProperty("resolved");
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

  it("says why a setting cannot be changed on the agent's behalf", async () => {
    const entry = await getSettingForAgent(deps(), "s1", "advanced.enableSubAgents");
    expect(entry.propose).toEqual({ allowed: true });
  });
});
