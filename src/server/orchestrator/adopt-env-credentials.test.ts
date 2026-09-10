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

    it("unsets the variable, so no other reader can still reach it", () => {
      adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });
      deleteCredentialRoute(store, "claude-api-key");

      const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-first" };
      const result = adoptEnvCredentials(reboot(), env);

      expect(result.suppressed).toEqual(["ANTHROPIC_API_KEY"]);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it("stays removed even when the deployment rotates the variable", () => {
      adoptEnvCredentials(store, { ANTHROPIC_API_KEY: "sk-first" });
      deleteCredentialRoute(store, "claude-api-key");

      const next = reboot();
      adoptEnvCredentials(next, { ANTHROPIC_API_KEY: "sk-completely-new" });

      expect(next.getCredentialRoute("claude-api-key")).toBeUndefined();
    });

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
      store.setAdoptedEnvCredential("ANTHROPIC_AUTH_TOKEN", { importedValue: "token-older" });

      const next = reboot();
      adoptEnvCredentials(next, { ANTHROPIC_AUTH_TOKEN: "token-shared" });

      expect(next.getCredentialRoute("claude-env-oauth")).toBeDefined();
    });
  });

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
