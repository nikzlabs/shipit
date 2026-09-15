import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";

// Avoid spawning npm.
vi.mock("../templates.js", async (importOriginal) => {
  const mod = await importOriginal() as Record<string, unknown>;
  return { ...mod, generatePackageLock: vi.fn().mockResolvedValue(undefined) };
});
import { GitManager } from "../../shared/git.js";
import { SessionManager } from "../sessions.js";
import { ChatHistoryManager } from "../chat-history.js";
import { AuthManager } from "../agents/claude/auth-manager.js";
import type { FastifyInstance } from "fastify";
import {
  StubAuthManager,
  StubGitHubAuthManager,
  FakeClaudeProcess,
  createTestDatabaseManager,
} from "./test-helpers.js";
import { DatabaseManager } from "../../shared/database.js";
import { GitHubAuthManager } from "../github-auth.js";
import { CredentialStore } from "../credential-store.js";
import { initGlobalGitConfig, setGitIdentity } from "../git-config.js";
import { saveGlobalSettings } from "../services/index.js";
import { AgentRegistry } from "../../shared/agent-registry.js";
import {
  bool,
  credentialStoreField,
  defineSetting,
  GLOBAL_SETTINGS,
  payloadDeclarations,
  plain,
} from "../../shared/settings-catalogue/index.js";
import type { GlobalSettings } from "../services/types.js";
import type { StoredGlobalSettings, StoredSettingsOf } from "../../shared/settings-catalogue/index.js";

/**
 * docs/299-agent-settings-access req 7 — a setting added to the catalogue and
 * nowhere else is described, typed and round-trips through the settings route.
 *
 * The half req 7 also asks for — that the same setting is readable BY THE AGENT,
 * carrying its description — is not executable yet: `shipit settings list` / `get`
 * and the agent-ops relay are a later slice. What holds structurally today is
 * that the agent's view will be a projection of this registry, so there is no
 * second place for a declaration to be missing from.
 */

type Assert<T extends true> = T;
type Extends<A, B> = A extends B ? true : false;

const PROBE_KEY = "advanced.probeSetting";

// Declared here rather than in the catalogue file, because the point is that a
// declaration is the ONLY edit a new setting needs: nothing below adds a route,
// a service field, a store accessor or a type.
const PROBE_DECLARATION = defineSetting({
  key: PROBE_KEY,
  tab: "advanced",
  scope: "global",
  label: "Probe setting",
  description: "Declared for this test and nowhere else.",
  type: bool({ default: false }),
  store: { kind: "credential-store", field: "probeSetting" },
  wire: "probeSetting",
  emits: plain(),
  propose: { kind: "yes" },
});

// Compile-time half of req 7: a catalogue with one more declaration types one
// more payload field, and the field is typed from its declaration's value type.
const _PROBE_CATALOGUE = { ...GLOBAL_SETTINGS, [PROBE_KEY]: PROBE_DECLARATION } as const;
type ProbePayload = StoredSettingsOf<typeof _PROBE_CATALOGUE>;
type _ProbeSettingIsTyped = Assert<Extends<ProbePayload, { probeSetting: boolean }>>;

// Fails the day `GlobalSettings` carries fewer settings than the catalogue
// declares. It cannot tell a derived field from a hand-written one of the same
// type — nothing at the type level can — so it is a floor, not the guarantee.
type _StoredHalfReachesThePayload = Assert<Extends<GlobalSettings, StoredGlobalSettings>>;

const registry = GLOBAL_SETTINGS as unknown as Record<string, unknown>;

describe("Integration: settings derive from the catalogue (docs/299 req 7)", () => {
  let app: FastifyInstance;
  let tmpDir: string;
  let credentialStore: CredentialStore;
  let dbManager: DatabaseManager;

  const credentialsFile = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(tmpDir, "shipit-credentials.json"), "utf-8")) as
      Record<string, unknown>;

  beforeEach(async () => {
    registry[PROBE_KEY] = PROBE_DECLARATION;
    dbManager = createTestDatabaseManager();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-settings-derivation-"));
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test User", "test@test.com");
    credentialStore = new CredentialStore(tmpDir);

    app = await buildApp({
      createGitManager: (dir: string) => new GitManager(dir),
      databaseManager: dbManager,
      sessionManager: new SessionManager(dbManager),
      authManager: new StubAuthManager() as unknown as AuthManager,
      githubAuthManager: new StubGitHubAuthManager() as unknown as GitHubAuthManager,
      agentFactory: () => new FakeClaudeProcess() as never,
      credentialStore,
      credentialsDir: tmpDir,
      chatHistoryManager: new ChatHistoryManager(dbManager),
      workspaceDir: tmpDir,
      serveStatic: false,
    });
  });

  afterEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the probe key this test added
    delete registry[PROBE_KEY];
    await app.close();
    dbManager.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Ignore cleanup errors
    }
  });

  const bootstrapSettings = async (): Promise<Record<string, unknown>> => {
    const res = await app.inject({ method: "GET", url: "/api/bootstrap" });
    return (res.json() as { settings: Record<string, unknown> }).settings;
  };

  it("serves the declared default with no edit to the settings payload", async () => {
    expect(await bootstrapSettings()).toMatchObject({ probeSetting: false });
  });

  it("round-trips through PUT /api/settings, and persists under the declared field", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { probeSetting: true },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).probeSetting).toBe(true);
    expect(await bootstrapSettings()).toMatchObject({ probeSetting: true });
    expect(credentialsFile().probeSetting).toBe(true);
  });

  it("refuses a bad value with the declaration's own validation", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { probeSetting: "yes" },
    });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("Probe setting must be true or false");
    expect(credentialsFile().probeSetting).toBeUndefined();
  });

  it("omits an unset pin rather than sending null, which is the payload clients already read", async () => {
    const settings = await bootstrapSettings();
    expect(settings).not.toHaveProperty("nonTurnModel");
  });

  it("carries the declaration's label and description, which is what the agent will read", () => {
    const declared = payloadDeclarations().find((d) => d.wire === "probeSetting");
    expect(declared?.label).toBe("Probe setting");
    expect(declared?.description).toBe("Declared for this test and nowhere else.");
  });

  it("writes nothing when the save is rejected", async () => {
    // The shipped save wrote each block as it reached it, so a 400 from a later
    // block left an earlier toggle on. Enabling auto-fix CI is not something a
    // failed request may do.
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { autoFixCi: true, probeSetting: true, roles: null },
    });

    expect(res.statusCode).toBe(400);
    expect(credentialStore.getAutoFixCi()).toBe(false);
    expect(credentialsFile().autoFixCi).toBeUndefined();
    expect(credentialsFile().probeSetting).toBeUndefined();
  });

  // Declared validation is stricter than the hand-written chain it replaced; the
  // two inputs a client can actually produce keep the answer they always gave.
  it("still clears the memory budget for a value that means unset", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { memoryBudgetMb: 8192 } });
    const res = await app.inject({
      method: "PUT", url: "/api/settings", payload: { memoryBudgetMb: -1 },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).memoryBudgetMb).toBeNull();
    expect(credentialsFile().memoryBudgetMb).toBeUndefined();
  });

  it("still clears the instructions box when the value is not text", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { systemPrompt: "Be brief" } });
    const res = await app.inject({
      method: "PUT", url: "/api/settings", payload: { systemPrompt: null },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as Record<string, unknown>).systemPrompt).toBe("");
    expect(fs.existsSync(path.join(tmpDir, ".shipit", "system-prompt.md"))).toBe(false);
  });

  it("cannot save a field no declaration names", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { undeclaredSetting: true },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("undeclaredSetting");
    expect(credentialsFile().undeclaredSetting).toBeUndefined();
  });

  const saveWith = (patch: Record<string, unknown>) => saveGlobalSettings({
    agentRegistry: new AgentRegistry(),
    appWorkspaceDir: tmpDir,
    credentialStore,
    ...patch,
  });

  it("does not let one save overwrite a role another created while it waited", async () => {
    await app.inject({
      method: "POST",
      url: "/api/credential-routes",
      payload: { serviceId: "deepseek", billingMode: "key", secret: "sk-test", label: "test" },
    });
    const role = (description: string) => ({
      writer: {
        description,
        params: {
          kind: "pinned", harnessId: "claude", serviceId: "deepseek",
          billingMode: "key", modelId: "deepseek-flash",
        },
      },
    });

    // A role plan carries an existence check. The first save awaits its scalar
    // write; the second creates the role in that gap. Applying a plan made
    // before the gap would overwrite what the second one created.
    const settled = await Promise.allSettled([
      saveWith({ autoCreatePr: true, roles: role("first") }),
      saveWith({ roles: role("second") }),
    ]);

    expect(settled.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(credentialStore.getRole("writer")?.description).toBe("second");
  });

  it("fires an automation's enabled callback once when two saves enable it at once", async () => {
    let enabled = 0;
    const save = () => saveWith({ autoFixCi: true, onAutoFixCiEnabled: () => { enabled += 1; } });

    await Promise.all([save(), save()]);

    // Reading the previous value through an await lets the second save see
    // `false` as well, and remediation then refreshes every snapshot twice.
    expect(enabled).toBe(1);
  });

  // docs/303 req 23 — turning the card back on has to mark the stored cards
  // stale, or the user reads an old card as if the last turn had written it.
  it("fires the status-card hook only when the setting goes off → on", async () => {
    const enabled: number[] = [];
    const save = (sessionStatusCard: boolean) => saveWith({
      sessionStatusCard,
      onSessionStatusCardEnabled: () => { enabled.push(enabled.length); },
    });

    await save(false);
    expect(enabled).toHaveLength(0);

    await save(true);
    expect(enabled).toHaveLength(1);

    await save(true);
    await save(false);
    expect(enabled).toHaveLength(1);
  });

  it("gives every credential-store setting a field of its own", () => {
    const fields = payloadDeclarations()
      .filter((d) => d.store.kind === "credential-store")
      .map((d) => credentialStoreField(d.key as never));

    expect(fields.length).toBeGreaterThan(0);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("writes each declared setting to the field its declaration names", async () => {
    // This cannot catch a mis-spelled field on its own — the read follows the
    // same spelling and round-trips fine. It catches a field two declarations
    // share; the fixture in `credential-store.test.ts` is what pins the spelling
    // against the keys shipped installs already wrote.
    for (const declaration of payloadDeclarations()) {
      if (declaration.store.kind !== "credential-store") continue;
      if (declaration.type.kind !== "bool") continue;
      const field = credentialStoreField(declaration.key as never);
      const flipped = !(declaration.type.defaultValue as boolean);

      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { [declaration.wire]: flipped },
      });

      expect(res.statusCode).toBe(200);
      expect(credentialsFile()[field]).toBe(flipped);
      expect((await bootstrapSettings())[declaration.wire]).toBe(flipped);
    }
  });
});
