/**
 * docs/252 phase 2 — the credential-route service.
 *
 * The rules under test are the ones the catalogue decides and the UI must not
 * be trusted to enforce: which modes accept a supplied secret, how many
 * credentials a mode may hold, and that a secret never leaves through the read
 * path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "../credential-store.js";
import { ServiceError } from "./types.js";
import {
  createStringCredential,
  deleteCredentialRoute,
  listCredentialRoutes,
  reorderCredentialRoutes,
  updateStringCredential,
  upsertSingleStringCredential,
} from "./credential-routes.js";
import { collectServiceCredentialEnv } from "../secret-resolver.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cred-routes-"));
}

let store: CredentialStore;

beforeEach(() => {
  store = new CredentialStore(tmpDir());
});

describe("createStringCredential", () => {
  it("stores a key against its (service, billing mode)", () => {
    const { route, routes } = createStringCredential(store, {
      serviceId: "deepseek",
      billingMode: "key",
      secret: "sk-deepseek",
    });
    expect(route.serviceId).toBe("deepseek");
    expect(route.billingMode).toBe("key");
    expect(route.via).toBe("string");
    expect(routes).toHaveLength(1);
    expect(store.getCredentialSecret(route.id)).toBe("sk-deepseek");
  });

  it("never returns the secret on the route record", () => {
    const { route } = createStringCredential(store, {
      serviceId: "openrouter",
      billingMode: "key",
      secret: "sk-or-secret",
    });
    // The whole point of keeping secrets out of `CredentialRoute`: this record
    // is returned verbatim through Settings, so a secret field here would leak.
    expect(JSON.stringify(route)).not.toContain("sk-or-secret");
    expect(JSON.stringify(listCredentialRoutes(store))).not.toContain("sk-or-secret");
  });

  it("refuses a second credential for a key mode (req 12 — keys never fail over)", () => {
    createStringCredential(store, { serviceId: "deepseek", billingMode: "key", secret: "sk-1" });
    expect(() =>
      createStringCredential(store, { serviceId: "deepseek", billingMode: "key", secret: "sk-2" }),
    ).toThrow(ServiceError);
    // And the first one is untouched — a rejected add must not have replaced it.
    expect(store.listCredentialRoutes("deepseek", "key")).toHaveLength(1);
  });

  it("accepts several credentials for a string-delivered subscription (req 12)", () => {
    // GLM's coding plan: a subscription authenticated by a supplied key, and
    // the case the multi-instance storage exists for.
    const first = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "k1" });
    const second = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "k2" });
    expect(store.listCredentialRoutes("zai", "sub")).toHaveLength(2);
    // Appended, not inserted: adding one must never change which credential
    // existing work runs on.
    expect(first.route.priority).toBe(0);
    expect(second.route.priority).toBe(1);
    expect(store.getCredentialSecret(first.route.id)).toBe("k1");
    expect(store.getCredentialSecret(second.route.id)).toBe("k2");
  });

  it("refuses a mode that accepts no supplied secret", () => {
    // OpenAI's subscription is account-backed only — it has a login flow and a
    // credential root, neither of which a pasted string has.
    expect(() =>
      createStringCredential(store, { serviceId: "openai", billingMode: "sub", secret: "sk-x" }),
    ).toThrow(/not authenticated by a supplied secret/);
  });

  it("rejects an unknown service, an unknown mode and an empty secret", () => {
    expect(() => createStringCredential(store, { serviceId: "nope", billingMode: "key", secret: "x" }))
      .toThrow(/Unknown service/);
    expect(() => createStringCredential(store, { serviceId: "deepseek", billingMode: "sub", secret: "x" }))
      .toThrow(/no sub billing mode/);
    expect(() => createStringCredential(store, { serviceId: "deepseek", billingMode: "key", secret: "  " }))
      .toThrow(/cannot be empty/);
  });
});

describe("updateStringCredential", () => {
  it("replaces the secret and renames, leaving the route id stable", () => {
    const { route } = createStringCredential(store, {
      serviceId: "deepseek", billingMode: "key", secret: "old",
    });
    const updated = updateStringCredential(store, route.id, { secret: "new", label: "Work key" });
    expect(updated.route.id).toBe(route.id);
    expect(updated.route.label).toBe("Work key");
    expect(updated.route.labelIsGenerated).toBe(false);
    expect(store.getCredentialSecret(route.id)).toBe("new");
  });

  it("treats an empty secret as a rejection, not as a clear", () => {
    const { route } = createStringCredential(store, {
      serviceId: "deepseek", billingMode: "key", secret: "keep-me",
    });
    expect(() => updateStringCredential(store, route.id, { secret: "" })).toThrow(/cannot be empty/);
    expect(store.getCredentialSecret(route.id)).toBe("keep-me");
  });

  it("refuses to edit an account-backed credential", () => {
    store.upsertProviderAccount({
      id: "acct_1", provider: "claude", label: "Work", isPrimary: false,
      status: "ready", createdAt: 1, updatedAt: 1,
    });
    expect(() => updateStringCredential(store, "acct_1", { label: "x" })).toThrow(/connected account/);
  });
});

describe("deleteCredentialRoute", () => {
  it("removes the route and its secret together", () => {
    const { route } = createStringCredential(store, {
      serviceId: "deepseek", billingMode: "key", secret: "sk-gone",
    });
    deleteCredentialRoute(store, route.id);
    expect(store.getCredentialRoute(route.id)).toBeUndefined();
    // A secret with no record naming it is one nothing would ever clean up.
    expect(store.getCredentialSecret(route.id)).toBeUndefined();
  });
});

describe("reorderCredentialRoutes", () => {
  it("persists the fallback order within one subscription group", () => {
    const a = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "a" }).route;
    const b = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "b" }).route;
    reorderCredentialRoutes(store, "zai", "sub", [b.id, a.id]);
    const group = listCredentialRoutes(store).filter((r) => r.serviceId === "zai" && r.billingMode === "sub");
    expect(group.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(group[0].isPrimary).toBe(true);
    expect(group[1].isPrimary).toBe(false);
  });

  it("rejects a partial order rather than interpreting it", () => {
    const a = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "a" }).route;
    createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "b" });
    expect(() => reorderCredentialRoutes(store, "zai", "sub", [a.id])).toThrow(/exactly once/);
  });
});

describe("upsertSingleStringCredential", () => {
  it("creates once and then replaces, rather than piling up", () => {
    const first = upsertSingleStringCredential(store, "anthropic", "key", "sk-ant-1");
    const second = upsertSingleStringCredential(store, "anthropic", "key", "sk-ant-2");
    expect(second.id).toBe(first.id);
    expect(store.listCredentialRoutes("anthropic", "key")).toHaveLength(1);
    expect(store.getCredentialSecret(first.id)).toBe("sk-ant-2");
  });
});

describe("collectServiceCredentialEnv", () => {
  it("materializes each mode's first credential under its catalogue storageEnv", () => {
    createStringCredential(store, { serviceId: "deepseek", billingMode: "key", secret: "sk-ds" });
    createStringCredential(store, { serviceId: "openrouter", billingMode: "key", secret: "sk-or" });
    expect(collectServiceCredentialEnv(store)).toEqual({
      DEEPSEEK_API_KEY: "sk-ds",
      OPENROUTER_API_KEY: "sk-or",
    });
  });

  it("delivers the group's FIRST credential, so phase 2 cannot change which one a turn uses", () => {
    const first = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-1" }).route;
    const second = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-2" }).route;
    expect(collectServiceCredentialEnv(store).ZAI_CODING_PLAN_KEY).toBe("plan-1");
    // Reordering moves delivery with it — the order IS the selection order.
    reorderCredentialRoutes(store, "zai", "sub", [second.id, first.id]);
    expect(collectServiceCredentialEnv(store).ZAI_CODING_PLAN_KEY).toBe("plan-2");
  });

  it("delivers nothing for an account-backed credential", () => {
    store.upsertProviderAccount({
      id: "acct_1", provider: "claude", label: "Work", isPrimary: false,
      status: "ready", createdAt: 1, updatedAt: 1,
    });
    expect(collectServiceCredentialEnv(store)).toEqual({});
  });
});

describe("process.env is kept in step with what a mode delivers", () => {
  // Load-bearing because `reservedRouteFor` and `AgentRegistry.isAuthConfigured`
  // answer from `process.env`: a revoked credential that stays there is one the
  // orchestrator keeps counting as authentication until a restart.
  const ENV = "DEEPSEEK_API_KEY";
  const PLAN_ENV = "ZAI_CODING_PLAN_KEY";
  // `vi.unstubAllEnvs` restores absence as absence, which a hand-rolled
  // save/restore cannot do without a dynamic delete.
  afterEach(() => { vi.unstubAllEnvs(); });

  it("sets it on create, replaces it on update, and clears it on delete", () => {
    const { route } = createStringCredential(store, {
      serviceId: "deepseek", billingMode: "key", secret: "sk-one",
    });
    expect(process.env[ENV]).toBe("sk-one");

    updateStringCredential(store, route.id, { secret: "sk-two" });
    expect(process.env[ENV]).toBe("sk-two");

    deleteCredentialRoute(store, route.id);
    expect(process.env[ENV]).toBeUndefined();
  });

  it("leaves a value the deployment set alone when a credential is removed", () => {
    // Boot seeding never overwrites a name that is already present, so a
    // deployment-set value is not ours to clear.
    vi.stubEnv(ENV, "deployment-supplied");
    const { route } = createStringCredential(store, {
      serviceId: "deepseek", billingMode: "key", secret: "sk-user",
    });
    // The user's credential does take precedence while it exists...
    expect(process.env[ENV]).toBe("sk-user");
    vi.stubEnv(ENV, "deployment-supplied");
    deleteCredentialRoute(store, route.id);
    expect(process.env[ENV]).toBe("deployment-supplied");
  });

  it("follows a reorder, because the first credential is the delivered one", () => {
    const a = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-a" }).route;
    const b = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-b" }).route;
    expect(process.env[PLAN_ENV]).toBe("plan-a");
    reorderCredentialRoutes(store, "zai", "sub", [b.id, a.id]);
    expect(process.env[PLAN_ENV]).toBe("plan-b");
  });
});
