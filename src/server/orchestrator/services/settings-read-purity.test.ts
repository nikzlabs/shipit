import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { createStringCredential } from "./credential-routes.js";
import {
  buildAgentListPayload,
  getGlobalSettings,
  saveGlobalSettings,
  seedAndBuildAgentListPayload,
} from "./settings.js";
import type { AgentRegistry } from "../../shared/agent-registry.js";

/**
 * Reading the global settings does not choose a background-work model
 * (planning#578).
 *
 * The pin used to be written while the payload was assembled, so opening the
 * Settings dialog, connecting the event stream, or saving an unrelated setting
 * each pinned a model nobody named. Seeding now happens where eligibility
 * changes; these tests hold the two halves apart — the read writes no pin, and
 * the change still writes one.
 *
 * Scoped to the pin on purpose, and it is not a claim that a read writes nothing
 * at all: `resolveHarnessOnboarding` stamps `harnessOnboardingCompletedAt` on
 * read, deliberately and for reasons of its own.
 */

const dirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-read-purity-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function registry(): AgentRegistry {
  return {
    list: () => [
      {
        id: "claude",
        name: "Claude Code",
        installed: true,
        hasRunnableModels: true,
        capabilities: {
          models: [],
          supportsReview: true,
          supportsSteering: true,
          supportsCompaction: true,
          supportedPermissionModes: ["auto"],
          skillInvocationPrefix: "/",
        },
      },
    ],
    available: () => [],
  } as unknown as AgentRegistry;
}

/**
 * An install that CAN be seeded and has not been: a directly callable key and no
 * pin. Without the credential every assertion below would pass with the seeding
 * left on the read path, which is the shape this file exists to catch.
 */
function eligibleInstall(): { store: CredentialStore; workspaceDir: string } {
  const workspaceDir = tmpDir();
  const store = new CredentialStore(path.join(workspaceDir, "credentials"));
  createStringCredential(store, {
    serviceId: "deepseek",
    billingMode: "key",
    secret: "sk-test-deepseek",
  });
  expect(store.getNonTurnModel()).toBeUndefined();
  return { store, workspaceDir };
}

describe("reading the global settings leaves the background-model pin alone", () => {
  it("does not pin a model when the settings payload is built", async () => {
    const { store, workspaceDir } = eligibleInstall();

    const settings = await getGlobalSettings(registry(), workspaceDir, store);

    expect(store.getNonTurnModel()).toBeUndefined();
    // The payload still answers with a model, so nothing about the dialog needs
    // the write: the resolver falls back to the same first eligible one.
    expect(settings.nonTurnModelResolved).toMatchObject({ serviceId: "deepseek" });
  });

  it("does not pin a model when an unrelated setting is saved", async () => {
    const { store, workspaceDir } = eligibleInstall();

    await saveGlobalSettings({
      agentRegistry: registry(),
      appWorkspaceDir: workspaceDir,
      credentialStore: store,
      autoFixCi: true,
    });

    expect(store.getDeclaredSetting("advanced.autoFixCi")).toBe(true);
    expect(store.getNonTurnModel()).toBeUndefined();
  });

  it("does not pin a model when the agent list is built for a reader", () => {
    const { store } = eligibleInstall();

    const payload = buildAgentListPayload(registry(), store, undefined);

    expect(store.getNonTurnModel()).toBeUndefined();
    expect(payload.nonTurnModel).toBeNull();
  });
});

describe("a change in eligibility still seeds", () => {
  it("pins the first eligible model when the change is announced", () => {
    const { store } = eligibleInstall();

    const payload = seedAndBuildAgentListPayload(registry(), store, undefined);

    expect(store.getNonTurnModel()).toMatchObject({ serviceId: "deepseek", billingMode: "key" });
    expect(payload.nonTurnModel).toMatchObject({ serviceId: "deepseek" });
  });

  it("leaves a pin the user chose where it is", () => {
    const { store } = eligibleInstall();
    // Deliberately NOT the model the seed would pick, so the assertion cannot
    // pass on a seed that happened to write the same value.
    const chosen = { serviceId: "zai", billingMode: "key" as const, modelId: "glm-5.2" };
    store.setNonTurnModel(chosen);

    seedAndBuildAgentListPayload(registry(), store, undefined);

    expect(store.getNonTurnModel()).toEqual(chosen);
  });
});
