/**
 * docs/252 phase 2 — the three load-time migrations that move existing installs
 * onto `(service, billing mode)`-keyed credentials.
 *
 * Each is a one-way move whose *result* has to keep reproducing forever, so the
 * assertions are about what an install that already had accounts, a key, or
 * routing settings looks like afterwards — not about the mechanism.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";

function seed(data: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-cred-migrate-"));
  fs.writeFileSync(path.join(dir, "shipit-credentials.json"), JSON.stringify(data, null, 2));
  return dir;
}

const account = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  provider: "claude",
  label: `Account ${id}`,
  isPrimary: false,
  priority: 0,
  status: "ready",
  createdAt: 1,
  updatedAt: 2,
  ...over,
});

describe("providerAccounts → credentialRoutes", () => {
  it("lands an account row on its vendor's SUBSCRIPTION mode, delivered as an account", () => {
    const store = new CredentialStore(seed({ providerAccounts: { claude: [account("acct_1")] } }));
    const routes = store.listCredentialRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: "acct_1",
      serviceId: "anthropic",
      billingMode: "sub",
      via: "account",
    });
  });

  it("preserves every field the routing machinery reads", () => {
    // An earlier draft of this design dropped four of these. Each omission is a
    // silent behaviour change: selection filters on `status` and
    // `exhaustedUntil`, balanced routing reads `lastUsedAt`, and duplicate
    // detection and label adoption use `externalId` and `labelIsGenerated`.
    const store = new CredentialStore(seed({
      providerAccounts: {
        codex: [account("acct_2", {
          provider: "codex",
          externalId: "chatgpt-abc",
          labelIsGenerated: true,
          priority: 3,
          lastUsedAt: 4242,
          exhaustedUntil: 9999,
          capabilities: { source: "agent_init", refreshedAt: 7 },
        })],
      },
    }));
    const [route] = store.listCredentialRoutes("openai", "sub");
    expect(route).toMatchObject({
      externalId: "chatgpt-abc",
      labelIsGenerated: true,
      priority: 3,
      lastUsedAt: 4242,
      exhaustedUntil: 9999,
      capabilities: { source: "agent_init", refreshedAt: 7 },
    });
  });

  it("lands an account row as a via:\"account\" credential of its vendor's subscription", () => {
    const store = new CredentialStore(seed({
      providerAccounts: { claude: [account("acct_1", { externalId: "anthropic-xyz" })] },
    }));
    const [migrated] = store.listCredentialRoutes("anthropic", "sub");
    expect(migrated).toMatchObject({ id: "acct_1", serviceId: "anthropic", billingMode: "sub", via: "account", externalId: "anthropic-xyz" });
    expect(store.listCredentialRoutes("openai", "sub")).toEqual([]);
  });

  it("runs once — a later boot cannot resurrect an account the user disconnected", () => {
    const dir = seed({ providerAccounts: { claude: [account("acct_1")] } });
    new CredentialStore(dir).deleteCredentialRoute("acct_1");
    // The legacy blob is still on disk (it is the downgrade path) and must NOT
    // be re-imported: `credentialRoutes` being present is what marks it done.
    expect(new CredentialStore(dir).listCredentialRoutes("anthropic", "sub")).toEqual([]);
  });
});

describe("agentEnv key → credential route", () => {
  it("moves a catalogue storageEnv out of the single slot", () => {
    const store = new CredentialStore(seed({ agentEnv: { OPENAI_API_KEY: "sk-openai" } }));
    const [route] = store.listCredentialRoutes("openai", "key");
    expect(route).toMatchObject({ serviceId: "openai", billingMode: "key", via: "string" });
    expect(store.getCredentialSecret(route.id)).toBe("sk-openai");
    // Moved, not copied: a copy would keep being delivered from the old slot
    // after the user removed the credential.
    expect(store.getAgentEnv("OPENAI_API_KEY")).toBeUndefined();
  });

  it("leaves a name the catalogue does not claim exactly where it is", () => {
    const store = new CredentialStore(seed({
      agentEnv: { mcp__acme__TOKEN: "t", SOMETHING_ELSE: "x" },
    }));
    expect(store.getAgentEnv("mcp__acme__TOKEN")).toBe("t");
    expect(store.getAgentEnv("SOMETHING_ELSE")).toBe("x");
    expect(store.listCredentialRoutes()).toEqual([]);
  });
});

describe("routing settings re-key", () => {
  it("moves AgentId keys onto the vendor's subscription mode", () => {
    const store = new CredentialStore(seed({
      failoverCutoffs: { claude: { session: 70, weekly: 60 } },
      accountSelectionMode: { codex: "balanced" },
    }));
    expect(store.getFailoverCutoffs("anthropic", "sub")).toEqual({ session: 70, weekly: 60 });
    expect(store.getSelectionMode("openai", "sub")).toBe("balanced");
  });

  it("is idempotent — already-migrated keys survive a second load", () => {
    const dir = seed({ failoverCutoffs: { claude: { session: 70, weekly: 60 } } });
    new CredentialStore(dir);
    expect(new CredentialStore(dir).getFailoverCutoffs("anthropic", "sub"))
      .toEqual({ session: 70, weekly: 60 });
  });
});
