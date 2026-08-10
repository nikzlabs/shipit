/**
 * docs/252 phase 4 — the sub-agent defaults model is a TRIPLE, validated.
 *
 * Phase 3 accepted a bare id and had the server resolve the `(service, mode)`
 * from the eligible set. That could only ever produce one answer, so a
 * deliberate choice between two services offering the same id was
 * inexpressible (req 5). Accepting the pair from the client is the fix;
 * validating it against the harness's eligible set is what keeps it from being
 * a hole (req 8).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveGlobalSettings } from "./settings.js";
import { ServiceError } from "./types.js";
import { CredentialStore } from "../credential-store.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";
import type { EligibleModel } from "../../shared/agent-registry.js";

const OPENROUTER_OPUS: EligibleModel = {
  serviceId: "openrouter",
  serviceName: "OpenRouter",
  billingMode: "key",
  modelId: "anthropic/claude-opus-5",
  label: "Opus 5",
};
const VERCEL_OPUS: EligibleModel = { ...OPENROUTER_OPUS, serviceId: "vercel", serviceName: "Vercel AI Gateway" };

function registry(eligibleModels: EligibleModel[]): AgentRegistry {
  const info = {
    id: "claude",
    name: "Claude Code",
    installed: true,
    hasRunnableModels: eligibleModels.length > 0,
    eligibleModels,
    capabilities: {
      models: [...new Set(eligibleModels.map((m) => m.modelId))],
      supportedPermissionModes: ["auto"],
      toolNames: [],
      supportsReview: true,
    },
  };
  return {
    get: (id: string) => (id === "claude" ? info : undefined),
    list: () => [info],
    available: () => (info.hasRunnableModels ? [info] : []),
  } as unknown as AgentRegistry;
}

let tmpDir: string;
let credentialStore: CredentialStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-defaults-"));
  credentialStore = new CredentialStore(path.join(tmpDir, "credentials.json"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function save(patch: Record<string, unknown>, eligible = [OPENROUTER_OPUS, VERCEL_OPUS]) {
  return saveGlobalSettings({
    agentRegistry: registry(eligible),
    appWorkspaceDir: tmpDir,
    credentialStore,
    agentSubAgentDefaults: { claude: patch },
  });
}

describe("sub-agent defaults — model selection", () => {
  it("stores the service the client named, not the first one offering the id", async () => {
    await save({
      model: "anthropic/claude-opus-5",
      serviceId: "vercel",
      billingMode: "key",
    });
    expect(credentialStore.getAgentSubAgentDefaults("claude")).toMatchObject({
      model: "anthropic/claude-opus-5",
      serviceId: "vercel",
      billingMode: "key",
    });
  });

  it("still resolves a bare id, for a client that sends no pair", async () => {
    await save({ model: "anthropic/claude-opus-5" });
    expect(credentialStore.getAgentSubAgentDefaults("claude")).toMatchObject({
      serviceId: "openrouter",
      billingMode: "key",
    });
  });

  it("refuses a pair the harness cannot run rather than silently choosing another", async () => {
    await expect(
      save({ model: "anthropic/claude-opus-5", serviceId: "vercel", billingMode: "key" }, [
        OPENROUTER_OPUS,
      ]),
    ).rejects.toBeInstanceOf(ServiceError);
    expect(credentialStore.getAgentSubAgentDefaults("claude")?.model).toBeUndefined();
  });

  it("refuses a model no eligible service offers", async () => {
    await expect(save({ model: "gpt-5.5" })).rejects.toBeInstanceOf(ServiceError);
  });

  it("clears the model and its service together", async () => {
    await save({ model: "anthropic/claude-opus-5", serviceId: "vercel", billingMode: "key" });
    await save({ model: null });
    const stored = credentialStore.getAgentSubAgentDefaults("claude");
    expect(stored?.model).toBeUndefined();
    expect(stored?.serviceId).toBeUndefined();
  });

  it("falls back to the static model list when no credential source is wired", async () => {
    // An empty eligible set means the registry has no credential source (a
    // worker, a test), not that nothing is eligible — refusing every write on
    // that basis would be worse than the staleness the check guards against.
    const staticInfo = {
      id: "claude",
      name: "Claude Code",
      installed: true,
      hasRunnableModels: true,
      eligibleModels: [],
      capabilities: { models: ["claude-opus-5"], supportedPermissionModes: ["auto"] },
    };
    const staticRegistry = {
      get: () => staticInfo,
      list: () => [staticInfo],
      available: () => [staticInfo],
    } as unknown as AgentRegistry;
    await saveGlobalSettings({
      agentRegistry: staticRegistry,
      appWorkspaceDir: tmpDir,
      credentialStore,
      agentSubAgentDefaults: { claude: { model: "claude-opus-5" } },
    });
    expect(credentialStore.getAgentSubAgentDefaults("claude")?.model).toBe("claude-opus-5");
  });
});
