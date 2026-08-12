/**
 * docs/252 req 20 — a deployment-supplied credential is an ordinary credential.
 *
 * The happy path is one line and is not what this file is for. What it pins is
 * the three things adoption has to get right that nobody sees until they go
 * wrong: a rotated variable, a removal that must stick, and a route id that
 * pinned sessions already hold.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { adoptEnvCredentials } from "./adopt-env-credentials.js";
import { deleteCredentialRoute } from "./services/credential-routes.js";

let dir: string;
let store: CredentialStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-env-"));
  store = new CredentialStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A fresh store over the same directory — i.e. the next boot. */
const reboot = () => new CredentialStore(dir);

describe("adoptEnvCredentials", () => {
  it("turns a deployment's variable into a stored, listed credential", () => {
    const env = { ANTHROPIC_API_KEY: "sk-first" };
    const result = adoptEnvCredentials(store, env);

    expect(result.adopted).toEqual(["ANTHROPIC_API_KEY"]);
    const route = store.getCredentialRoute("claude-api-key");
    expect(route).toMatchObject({ serviceId: "anthropic", billingMode: "key", via: "string", status: "ready" });
    expect(store.getCredentialSecret("claude-api-key")).toBe("sk-first");
  });

  /**
   * The reserved id, and the reason it is not a detail. `envRouteIdFor` maps
   * the three legacy variables to ids that session rows written before this
   * feature already hold. Minting a `cred_…` one instead would orphan every
   * session pinned to the credential, at the moment adoption first runs.
   */
  it("keeps the legacy reserved route id rather than minting a new one", () => {
    adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "oauth-token", OPENAI_API_KEY: "sk-openai" });
    expect(store.getCredentialRoute("claude-env-oauth")?.billingMode).toBe("sub");
    expect(store.getCredentialRoute("codex-api-key")?.billingMode).toBe("key");
    expect(store.listCredentialRoutes().some((r) => r.id.startsWith("cred_"))).toBe(false);
  });

  it("is idempotent across boots", () => {
    adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });
    const second = adoptEnvCredentials(reboot(), { ANTHROPIC_API_KEY: "sk-first" });

    expect(second).toEqual({ adopted: [], rotated: [], suppressed: [], alreadyStored: [] });
    expect(reboot().listCredentialRoutes("anthropic", "key")).toHaveLength(1);
  });

  it("does nothing when the deployment sets nothing", () => {
    expect(adoptEnvCredentials(store, {})).toEqual({ adopted: [], rotated: [], suppressed: [], alreadyStored: [] });
    expect(store.listCredentialRoutes()).toHaveLength(0);
  });

  it("ignores a variable set to whitespace, which is not a credential", () => {
    adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "   " });
    expect(store.listCredentialRoutes()).toHaveLength(0);
  });

  describe("rotation", () => {
    it("re-imports a changed variable over its own previous value", () => {
      adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });

      const next = reboot();
      const result = adoptEnvCredentials(next, { ANTHROPIC_API_KEY: "sk-rotated" });

      expect(result.rotated).toEqual(["ANTHROPIC_API_KEY"]);
      expect(next.getCredentialSecret("claude-api-key")).toBe("sk-rotated");
    });

    /**
     * The half that is easy to get wrong. Once the user replaces the secret
     * from the row's `⋯`, the row is theirs — a deployment that still has the
     * old variable set must not silently put it back on the next restart. The
     * test is the stored value against the value adoption last imported, not a
     * flag: a flag records how the row *started*.
     */
    it("leaves a secret the user replaced by hand, however many boots later", () => {
      adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });
      store.setCredentialSecret("claude-api-key", "sk-typed-by-the-user");

      const next = reboot();
      const result = adoptEnvCredentials(next, { ANTHROPIC_API_KEY: "sk-rotated" });

      expect(result.rotated).toEqual([]);
      expect(next.getCredentialSecret("claude-api-key")).toBe("sk-typed-by-the-user");
    });
  });

  describe("deletion is a deletion", () => {
    it("does not re-import a row the user removed", () => {
      adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });
      deleteCredentialRoute(store, "claude-api-key");

      const next = reboot();
      const result = adoptEnvCredentials(next, { ANTHROPIC_API_KEY: "sk-first" });

      expect(result.adopted).toEqual([]);
      expect(next.getCredentialRoute("claude-api-key")).toBeUndefined();
    });

    /**
     * Remembering is not enough on its own: `listConfiguredCredentials` and
     * `stringSelectionFor` read the raw variable too, so a removal that only
     * suppressed the ROW would leave the credential working and the user's
     * removal a no-op. Unsetting it once, here, is what makes every downstream
     * reader see the absence without any of them learning about removals.
     */
    it("unsets the variable, so no other reader can still reach it", () => {
      adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });
      deleteCredentialRoute(store, "claude-api-key");

      const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-first" };
      const result = adoptEnvCredentials(reboot(), env);

      expect(result.suppressed).toEqual(["ANTHROPIC_API_KEY"]);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    /**
     * The removal is permanent for that variable, including across a later
     * rotation. "Re-import when the deployment changes the value" is defensible
     * and was rejected: the user's removal is an explicit act, and a clause that
     * resurrects a credential when something they cannot see changes is not one
     * they could predict.
     */
    it("stays removed even when the deployment rotates the variable", () => {
      adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });
      deleteCredentialRoute(store, "claude-api-key");

      const next = reboot();
      adoptEnvCredentials(next, { ANTHROPIC_API_KEY: "sk-completely-new" });

      expect(next.getCredentialRoute("claude-api-key")).toBeUndefined();
    });

    /**
     * And the memory is scoped to the variable, not to the mode: removing a
     * hand-added credential of the same `(service, mode)` must leave adoption
     * free to run.
     */
    it("records nothing when the removed credential was added by hand", () => {
      const store2 = new CredentialStore(dir);
      store2.upsertCredentialRouteWithSecret({
        id: "cred_hand", serviceId: "anthropic", billingMode: "key", via: "string",
        label: "By hand", isPrimary: false, priority: 0, status: "ready",
        createdAt: 1, updatedAt: 1,
      }, "sk-hand");
      deleteCredentialRoute(store2, "cred_hand");

      const next = reboot();
      expect(adoptEnvCredentials(next, { ANTHROPIC_API_KEY: "sk-first" }).adopted)
        .toEqual(["ANTHROPIC_API_KEY"]);
    });
  });

  /**
   * req 20 is "behave exactly as if I would add the service manually", and
   * adding a second API key by hand is REFUSED (409): req 12 says keys never
   * fail over, so a second is storage no routing rule can reach. Adopting past
   * that would put two keys on a card the API allows one of — and the variable
   * is already shadowed by the stored credential today, so nothing is lost by
   * leaving it exactly as unused as it is.
   */
  it("does not adopt a second key into a mode that holds exactly one", () => {
    store.upsertCredentialRouteWithSecret({
      id: "cred_hand", serviceId: "anthropic", billingMode: "key", via: "string",
      label: "Mine", isPrimary: false, priority: 0, status: "ready",
      createdAt: 1, updatedAt: 1,
    }, "sk-hand");

    const result = adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-from-env" });

    expect(result.adopted).toEqual([]);
    expect(store.listCredentialRoutes("anthropic", "key")).toHaveLength(1);
  });

  it("still adopts a second credential into a subscription, which is what failover is for", () => {
    store.upsertCredentialRouteWithSecret({
      id: "cred_hand", serviceId: "anthropic", billingMode: "sub", via: "string",
      label: "Mine", isPrimary: false, priority: 0, status: "ready",
      createdAt: 1, updatedAt: 1,
    }, "token-hand");

    expect(adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "token-env" }).adopted)
      .toEqual(["ANTHROPIC_AUTH_TOKEN"]);
    expect(store.listCredentialRoutes("anthropic", "sub")).toHaveLength(2);
  });

  /**
   * **One token, one row.** The bug this prevents was visible in the dogfood
   * instance: the seeder POSTs every `storageEnv` it finds, so the same
   * `ANTHROPIC_AUTH_TOKEN` was stored as "Anthropic plan (dogfood secret)" and
   * then adopted again as "Anthropic (ANTHROPIC_AUTH_TOKEN)" — one credential,
   * listed twice, and offered to itself as a failover target that can only fail
   * with it. Compared by VALUE because provenance is exactly what is missing.
   */
  describe("the same secret is one credential", () => {
    const alreadyStored = (secret: string) => {
      store.upsertCredentialRouteWithSecret({
        id: "cred_seeded", serviceId: "anthropic", billingMode: "sub", via: "string",
        label: "Anthropic plan (dogfood secret)", isPrimary: false, priority: 0,
        status: "ready", createdAt: 1, updatedAt: 1,
      }, secret);
    };

    it("does not adopt a variable a stored credential already holds", () => {
      alreadyStored("token-shared");

      const result = adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "token-shared" });

      expect(result.adopted).toEqual([]);
      expect(result.alreadyStored).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
      expect(store.listCredentialRoutes("anthropic", "sub")).toHaveLength(1);
    });

    it("still adopts when the stored credential is a DIFFERENT secret", () => {
      alreadyStored("token-mine");
      expect(adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "token-from-env" }).adopted)
        .toEqual(["ANTHROPIC_AUTH_TOKEN"]);
      expect(store.listCredentialRoutes("anthropic", "sub")).toHaveLength(2);
    });

    /**
     * The version without the guard shipped, so an install can already hold the
     * duplicate. Adoption withdraws one it created — and only one it still
     * owns, which is what keeps this from deleting a credential the user has
     * made their own.
     */
    it("withdraws a duplicate it created before the rule existed", () => {
      adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "token-shared" });
      alreadyStored("token-shared");
      expect(reboot().listCredentialRoutes("anthropic", "sub")).toHaveLength(2);

      const next = reboot();
      const result = adoptEnvCredentials(next, { ANTHROPIC_AUTH_TOKEN: "token-shared" });

      expect(result.alreadyStored).toEqual(["ANTHROPIC_AUTH_TOKEN"]);
      expect(next.getCredentialRoute("claude-env-oauth")).toBeUndefined();
      expect(next.listCredentialRoutes("anthropic", "sub").map((r) => r.id)).toEqual(["cred_seeded"]);
    });

    it("keeps a duplicate the user has renamed, because it is theirs now", () => {
      adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "token-shared" });
      const adoptedRow = store.getCredentialRoute("claude-env-oauth")!;
      store.upsertCredentialRoute({ ...adoptedRow, label: "My backup", labelIsGenerated: false });
      alreadyStored("token-shared");

      const next = reboot();
      adoptEnvCredentials(next, { ANTHROPIC_AUTH_TOKEN: "token-shared" });

      expect(next.getCredentialRoute("claude-env-oauth")?.label).toBe("My backup");
    });

    it("keeps a duplicate whose secret the user replaced, for the same reason", () => {
      adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "token-shared" });
      store.setCredentialSecret("claude-env-oauth", "token-shared");
      alreadyStored("token-shared");
      // Their replacement happens to equal the env value, but the record says
      // it is no longer the value adoption imported.
      store.setAdoptedEnvCredential("ANTHROPIC_AUTH_TOKEN", { importedValue: "token-older" });

      const next = reboot();
      adoptEnvCredentials(next, { ANTHROPIC_AUTH_TOKEN: "token-shared" });

      expect(next.getCredentialRoute("claude-env-oauth")).toBeDefined();
    });
  });

  /**
   * docs/150 req 2 — adopting must not silently change which credential
   * existing work runs on, exactly as adding one by hand must not.
   */
  it("appends to the group's order rather than taking the front", () => {
    store.upsertCredentialRouteWithSecret({
      id: "cred_existing", serviceId: "anthropic", billingMode: "sub", via: "string",
      label: "Mine", isPrimary: false, priority: 0, status: "ready",
      createdAt: 1, updatedAt: 1,
    }, "token-mine");

    adoptEnvCredentials(store, { ANTHROPIC_AUTH_TOKEN: "token-from-env" });

    expect(store.getCredentialRoute("claude-env-oauth")?.priority).toBe(1);
  });
});
