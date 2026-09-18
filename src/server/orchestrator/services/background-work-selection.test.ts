/**
 * docs/299 phase 2d — the two halves that stand between a user and a direct
 * call: what the selector is allowed to offer, and what a save will accept.
 *
 * Both used to be answered by "which installed harness can run this", which is
 * the wrong question for a model provider ShipIt calls itself (req 3).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { upsertSingleStringCredential } from "./credential-routes.js";
import { buildAgentListPayload, getGlobalSettings, saveGlobalSettings } from "./settings.js";
import { ServiceError } from "./types.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";

vi.mock("../../shared/installed-harnesses.js", () => ({
  isHarnessInstalled: () => false,
  readInstalledHarnesses: () => [],
}));

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-bgwork-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Nothing installed: the only route left to a model provider is a direct call.
function registry(installed: string[] = []): AgentRegistry {
  return {
    available: () => [],
    list: () =>
      ["claude", "codex"].map((id) => ({
        id,
        name: id,
        installed: installed.includes(id),
        hasRunnableModels: installed.includes(id),
        capabilities: { models: [], supportedPermissionModes: ["auto"], skillInvocationPrefix: "/" },
        eligibleModels: [],
      })),
  } as unknown as AgentRegistry;
}

function storeWithKey(serviceId: string, billingMode: "sub" | "key"): CredentialStore {
  const store = new CredentialStore(tmpDir());
  upsertSingleStringCredential(store, serviceId, billingMode, "sk-test-key");
  return store;
}

/** Reads the list off a throwaway store, since building it also seeds a pin. */
function optionsFor(serviceId: string, billingMode: "sub" | "key") {
  return buildAgentListPayload(registry(), storeWithKey(serviceId, billingMode), undefined)
    .backgroundWorkModels;
}

describe("the background-work option list rides agent_list and bootstrap", () => {
  it("offers a key-only model provider that no installed harness can reach", () => {
    const options = optionsFor("deepseek", "key");

    expect(options.length).toBeGreaterThan(0);
    expect(options.every((m) => m.serviceId === "deepseek")).toBe(true);
  });

  it("offers nothing for a credential that needs a harness nobody installed", () => {
    expect(optionsFor("anthropic", "sub")).toEqual([]);
  });

  it("sends the same list on the bootstrap read as on the agent_list push", async () => {
    const store = storeWithKey("deepseek", "key");
    const push = buildAgentListPayload(registry(), store, undefined).backgroundWorkModels;
    const bootstrap = await getGlobalSettings(registry(), tmpDir(), store, undefined);

    expect(bootstrap.backgroundWorkModels).toEqual(push);
    expect(bootstrap.backgroundWorkModels.length).toBeGreaterThan(0);
  });
});

describe("saving a background-work model", () => {
  const save = (credentialStore: CredentialStore, modelId: string, serviceId: string) =>
    saveGlobalSettings({
      agentRegistry: registry(),
      appWorkspaceDir: tmpDir(),
      credentialStore,
      nonTurnModel: { serviceId, billingMode: "key", modelId },
    });

  it("accepts a selection only a direct call can run", async () => {
    // The LAST option, because the seed a save also triggers writes the first —
    // so asserting the first would pass with the write removed.
    const options = optionsFor("anthropic", "key");
    const chosen = options[options.length - 1]!;
    expect(chosen.modelId).not.toBe(options[0]!.modelId);

    const store = storeWithKey("anthropic", "key");
    expect(store.getNonTurnModel()).toBeUndefined();

    await save(store, chosen.modelId, "anthropic");

    expect(store.getNonTurnModel()).toEqual({
      serviceId: "anthropic",
      billingMode: "key",
      modelId: chosen.modelId,
    });
  });

  it("still refuses a selection nothing on this install can run", async () => {
    const store = storeWithKey("deepseek", "key");

    await expect(save(store, "no-such-model", "deepseek")).rejects.toBeInstanceOf(ServiceError);
    expect(store.getNonTurnModel()).toBeUndefined();
  });
});
