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
import { credentialStorageEnvNames } from "../../shared/catalogue/index.js";
import { credentialRouteEnvName } from "../../shared/types/domain-types/credential-route.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cred-routes-"));
}

let store: CredentialStore;

beforeEach(() => {
  store = new CredentialStore(tmpDir());
  // Creating a credential assigns the mode's variable in THIS process, so a
  // test would otherwise inherit the previous test's value and the "only touch
  // what we put there" rule would (correctly) refuse to write. Empty counts as
  // absent everywhere these are read.
  for (const name of credentialStorageEnvNames()) vi.stubEnv(name, "");
});

afterEach(() => { vi.unstubAllEnvs(); });

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
    const ds = createStringCredential(store, { serviceId: "deepseek", billingMode: "key", secret: "sk-ds" }).route;
    const or = createStringCredential(store, { serviceId: "openrouter", billingMode: "key", secret: "sk-or" }).route;
    expect(collectServiceCredentialEnv(store)).toEqual({
      DEEPSEEK_API_KEY: "sk-ds",
      OPENROUTER_API_KEY: "sk-or",
      // docs/252 phase 5 — plus a name per credential, which is what lets spawn
      // shaping source the one a session is actually pinned to.
      [credentialRouteEnvName(ds.id)]: "sk-ds",
      [credentialRouteEnvName(or.id)]: "sk-or",
    });
  });

  it("delivers the group's FIRST credential under the group name", () => {
    const first = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-1" }).route;
    const second = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-2" }).route;
    expect(collectServiceCredentialEnv(store).ZAI_CODING_PLAN_KEY).toBe("plan-1");
    // Reordering moves delivery with it — the order IS the selection order.
    reorderCredentialRoutes(store, "zai", "sub", [second.id, first.id]);
    expect(collectServiceCredentialEnv(store).ZAI_CODING_PLAN_KEY).toBe("plan-2");
  });

  it("delivers EVERY credential of a subscription under its own name (docs/252 phase 5)", () => {
    // The group name can carry only one, which was fine while nothing could
    // choose a different one. req 12's failover is exactly that reason: a
    // session moved onto the second key would otherwise keep authenticating
    // with the first, because it is the only one in the environment.
    const first = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-1" }).route;
    const second = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-2" }).route;
    const env = collectServiceCredentialEnv(store);
    expect(env[credentialRouteEnvName(first.id)]).toBe("plan-1");
    expect(env[credentialRouteEnvName(second.id)]).toBe("plan-2");
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

  it("never touches a value the deployment set", () => {
    // Boot seeding skips a name that is already present, so a deployment-set
    // value is not ours to overwrite — and therefore not ours to clear either.
    // An earlier cut wrote over it on create and then deleted it on remove,
    // leaving the deployment unauthenticated until a restart.
    vi.stubEnv(ENV, "deployment-supplied");
    const { route } = createStringCredential(store, {
      serviceId: "deepseek", billingMode: "key", secret: "sk-user",
    });
    expect(process.env[ENV]).toBe("deployment-supplied");
    deleteCredentialRoute(store, route.id);
    expect(process.env[ENV]).toBe("deployment-supplied");
    // The session still receives the user's credential while it exists — these
    // probes ask whether one is present, never which one.
    expect(collectServiceCredentialEnv(store)[ENV]).toBeUndefined();
  });

  it("follows a reorder, because the first credential is the delivered one", () => {
    const a = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-a" }).route;
    const b = createStringCredential(store, { serviceId: "zai", billingMode: "sub", secret: "plan-b" }).route;
    expect(process.env[PLAN_ENV]).toBe("plan-a");
    reorderCredentialRoutes(store, "zai", "sub", [b.id, a.id]);
    expect(process.env[PLAN_ENV]).toBe("plan-b");
  });
});
