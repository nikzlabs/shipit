import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CredentialStore } from "./credential-store.js";
import { SecretCipher, isEncrypted } from "./secret-cipher.js";

describe("CredentialStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function createTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-cred-store-"));
    return tmpDir;
  }

  // ---- Proactive failover cutoffs (docs/150 reqs 4-6) ----

  describe("failover cutoffs", () => {
    it("defaults both windows to 90% (req 5)", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getFailoverCutoffs("anthropic", "sub")).toEqual({ session: 90, weekly: 90 });
    });

    it("persists per provider, independently", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setFailoverCutoffs("anthropic", "sub", { session: 70 });

      expect(store.getFailoverCutoffs("anthropic", "sub")).toEqual({ session: 70, weekly: 90 });
      expect(store.getFailoverCutoffs("openai", "sub")).toEqual({ session: 90, weekly: 90 });
      // Survives a reload — a restart must not silently revert the user's setting.
      expect(new CredentialStore(dir).getFailoverCutoffs("anthropic", "sub")).toEqual({ session: 70, weekly: 90 });
    });

    it("leaves the other window alone on a partial update", () => {
      const store = new CredentialStore(createTmpDir());
      store.setFailoverCutoffs("anthropic", "sub", { session: 50, weekly: 60 });
      store.setFailoverCutoffs("anthropic", "sub", { weekly: 80 });

      expect(store.getFailoverCutoffs("anthropic", "sub")).toEqual({ session: 50, weekly: 80 });
    });

    // Clamping on READ as well as write: a hand-edited config with a bad value
    // should still yield a working selector rather than throwing every turn.
    it("clamps an out-of-range or non-numeric stored value instead of trusting it", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "shipit-credentials.json"),
        JSON.stringify({ failoverCutoffs: { claude: { session: 0, weekly: 150 } } }),
      );
      expect(new CredentialStore(dir).getFailoverCutoffs("anthropic", "sub")).toEqual({ session: 1, weekly: 100 });
    });
  });

  // ---- Sub-agent defaults (docs/217) ----

  // ---- Benching a string-delivered credential (docs/252 phase 5, req 12) ----

  describe("markCredentialRouteExhausted", () => {
    const routeOf = (id: string, billingMode: "sub" | "key") => ({
      id,
      serviceId: "zai",
      billingMode,
      via: "string" as const,
      label: id,
      isPrimary: false,
      status: "ready" as const,
      createdAt: 0,
      updatedAt: 0,
    });

    it("benches a subscription credential", () => {
      const store = new CredentialStore(createTmpDir());
      store.upsertCredentialRouteWithSecret(routeOf("cred_a", "sub"), "k");
      expect(store.markCredentialRouteExhausted("cred_a", 5_000)?.exhaustedUntil).toBe(5_000);
    });

    it("refuses a metered key — it has no subscription window to exhaust", () => {
      // req 12: keys do not fail over, so benching one would take a session off
      // the credential it selected with nowhere it is allowed to go.
      const store = new CredentialStore(createTmpDir());
      store.upsertCredentialRouteWithSecret(routeOf("cred_k", "key"), "k");
      expect(store.markCredentialRouteExhausted("cred_k", 5_000)).toBeNull();
      expect(store.getCredentialRoute("cred_k")?.exhaustedUntil).toBeUndefined();
    });

    it("the newest refusal's stated reset wins, even when it is earlier", () => {
      // docs/260 req 9 — a re-probe answered with a short, precise reset must
      // supersede an older long estimate; otherwise the credential stays
      // benched for the full 30-minute re-probe cap instead of the five
      // minutes the provider just named. Same rule as `markAccountExhausted`.
      const store = new CredentialStore(createTmpDir());
      store.upsertCredentialRouteWithSecret(routeOf("cred_a", "sub"), "k");
      store.markCredentialRouteExhausted("cred_a", 9_000);
      store.markCredentialRouteExhausted("cred_a", 1_000);
      expect(store.getCredentialRoute("cred_a")?.exhaustedUntil).toBe(1_000);
    });

    it("ignores an unknown id", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.markCredentialRouteExhausted("cred_gone", 5_000)).toBeNull();
    });
  });

  // ---- Agent env ----

  describe("agentEnv", () => {
    it("returns undefined for unset key", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBeUndefined();
    });

    it("set persists and get retrieves", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-test");

      expect(store.getAgentEnv("OPENAI_API_KEY")).toBe("sk-test");
    });

    it("getAllAgentEnv returns all stored keys", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-1");
      store.setAgentEnv("GOOGLE_API_KEY", "AIza-2");

      expect(store.getAllAgentEnv()).toEqual({
        OPENAI_API_KEY: "sk-1",
        GOOGLE_API_KEY: "AIza-2",
      });
    });

    it("new instance reads back saved env", () => {
      const dir = createTmpDir();
      // docs/252 — a name the catalogue does NOT claim as a mode's `storageEnv`.
      // A claimed one (`OPENAI_API_KEY`) is deliberately migrated out of this
      // slot on the next load; that behaviour has its own test below.
      new CredentialStore(dir).setAgentEnv("mcp__acme__TOKEN", "sk-persisted");

      const store2 = new CredentialStore(dir);
      expect(store2.getAgentEnv("mcp__acme__TOKEN")).toBe("sk-persisted");
    });
  });

  // ---- GitHub token ----

  describe("githubToken", () => {
    it("returns null when not set", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getGithubToken()).toBeNull();
    });

    it("set and get round-trip", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_test123");

      expect(store.getGithubToken()).toBe("ghp_test123");
    });

    it("clear removes token", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_test123");
      store.clearGithubToken();

      expect(store.getGithubToken()).toBeNull();
    });

    it("returns null for empty string token", () => {
      const dir = createTmpDir();
      fs.writeFileSync(
        path.join(dir, "shipit-credentials.json"),
        JSON.stringify({ githubToken: "" }),
      );

      const store = new CredentialStore(dir);
      expect(store.getGithubToken()).toBeNull();
    });

    it("new instance reads back saved token", () => {
      const dir = createTmpDir();
      new CredentialStore(dir).setGithubToken("ghp_persisted");

      const store2 = new CredentialStore(dir);
      expect(store2.getGithubToken()).toBe("ghp_persisted");
    });
  });

  // ---- Cross-concern ----

  describe("mixed credentials", () => {
    it("all credential types coexist in one file", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-abc");
      store.setGithubToken("ghp_xyz");

      const raw = JSON.parse(fs.readFileSync(path.join(dir, "shipit-credentials.json"), "utf-8"));
      expect(raw).toEqual({
        agentEnv: { OPENAI_API_KEY: "sk-abc" },
        githubToken: "ghp_xyz",
        // docs/252 — the migration runs on construction and writes the (empty)
        // route list, which is what marks it as done: its absence is what makes
        // a later boot re-import the frozen legacy `providerAccounts` blob.
        credentialRoutes: [],
      });
    });

    it("clear removes everything", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setAgentEnv("OPENAI_API_KEY", "sk-abc");
      store.setGithubToken("ghp_xyz");

      store.clear();
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBeUndefined();
      expect(store.getGithubToken()).toBeNull();
    });
  });

  // ---- Edge cases ----

  describe("edge cases", () => {
    it("handles corrupt JSON gracefully", () => {
      const dir = createTmpDir();
      fs.writeFileSync(path.join(dir, "shipit-credentials.json"), "not json{{{");

      const store = new CredentialStore(dir);
      expect(store.getGithubToken()).toBeNull();
    });

    it("creates directory if missing", () => {
      const dir = createTmpDir();
      const nested = path.join(dir, "sub", "dir");
      const store = new CredentialStore(nested);
      store.setAgentEnv("OPENAI_API_KEY", "sk-test");

      expect(fs.existsSync(path.join(nested, "shipit-credentials.json"))).toBe(true);
    });

    it("file has restrictive permissions", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setGithubToken("ghp_secret");

      const stat = fs.statSync(path.join(dir, "shipit-credentials.json"));
      // 0o600 = owner read/write only
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  // ---- MCP servers (docs/088-mcp-integration) ----

  describe("mcpServers", () => {
    const linear = {
      name: "linear",
      type: "stdio" as const,
      command: "npx",
      args: ["-y", "@anthropic-ai/linear-mcp"],
      env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" },
      enabled: true,
    };

    it("set/get/getAll round-trips and survives reload", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpServer("linear", linear);

      expect(store.getMcpServer("linear")).toEqual(linear);
      expect(Object.keys(store.getAllMcpServers())).toEqual(["linear"]);

      const reloaded = new CredentialStore(dir);
      expect(reloaded.getMcpServer("linear")).toEqual(linear);
    });

    it("enforces config.name === key on write", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpServer("renamed", { ...linear, name: "stale" });
      expect(store.getMcpServer("renamed")?.name).toBe("renamed");
    });

    it("deleteMcpServer removes the blob but not its secrets", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpServer("linear", linear);
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "lin_api_abc");
      store.deleteMcpServer("linear");

      expect(store.getMcpServer("linear")).toBeUndefined();
      expect(store.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe("lin_api_abc");
    });

    it("setMcpSecret rejects non-mcp keys", () => {
      const store = new CredentialStore(createTmpDir());
      expect(() => store.setMcpSecret("OPENAI_API_KEY", "x")).toThrow(/mcp__/);
    });

    it("setMcpSecret persists mcp__* values that survive reload", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "lin_api_abc");
      expect(new CredentialStore(dir).getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBe(
        "lin_api_abc",
      );
    });

    it("deleteMcpSecretsForServer clears only that server's mcp__* keys", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "a");
      store.setMcpSecret("mcp__linear__OTHER", "b");
      store.setMcpSecret("mcp__sentry__SENTRY_AUTH_TOKEN", "c");
      store.setAgentEnv("OPENAI_API_KEY", "sk");

      store.deleteMcpSecretsForServer("linear");

      expect(store.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
      expect(store.getAgentEnv("mcp__linear__OTHER")).toBeUndefined();
      expect(store.getAgentEnv("mcp__sentry__SENTRY_AUTH_TOKEN")).toBe("c");
      expect(store.getAgentEnv("OPENAI_API_KEY")).toBe("sk");
    });

    it("clear() wipes both mcpServers and mcp__* secrets", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpServer("linear", linear);
      store.setMcpSecret("mcp__linear__LINEAR_API_KEY", "lin_api_abc");
      store.clear();

      expect(store.getAllMcpServers()).toEqual({});
      expect(store.getAgentEnv("mcp__linear__LINEAR_API_KEY")).toBeUndefined();
    });
  });

  // ---- MCP OAuth tokens (docs/088 Phase 2) ----

  describe("mcpOAuth", () => {
    it("setMcpOAuthTokens persists and stamps obtainedAt", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("notion_oauth", {
        accessToken: "at_xyz",
        refreshToken: "rt_xyz",
        clientId: "cid",
        expiresAt: 1_700_000_000_000,
      });
      const got = store.getMcpOAuthTokens("notion_oauth");
      expect(got?.accessToken).toBe("at_xyz");
      expect(got?.refreshToken).toBe("rt_xyz");
      expect(got?.clientId).toBe("cid");
      expect(got?.expiresAt).toBe(1_700_000_000_000);
      expect(got?.obtainedAt).toBeTruthy();
    });

    it("preserves a caller-supplied obtainedAt", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("notion_oauth", {
        accessToken: "x",
        obtainedAt: "2024-01-01T00:00:00.000Z",
      });
      expect(store.getMcpOAuthTokens("notion_oauth")?.obtainedAt).toBe(
        "2024-01-01T00:00:00.000Z",
      );
    });

    it("returns a defensive copy from get", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("notion_oauth", { accessToken: "x" });
      const got = store.getMcpOAuthTokens("notion_oauth")!;
      got.accessToken = "mutated";
      expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("x");
    });

    it("getAllMcpOAuthTokens returns a fresh per-entry copy", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("sentry_oauth", { accessToken: "x" });
      store.setMcpOAuthTokens("notion_oauth", { accessToken: "y" });
      const all = store.getAllMcpOAuthTokens();
      all.sentry_oauth.accessToken = "mutated";
      expect(store.getMcpOAuthTokens("sentry_oauth")?.accessToken).toBe("x");
      expect(Object.keys(all).sort()).toEqual(["notion_oauth", "sentry_oauth"]);
    });

    it("deleteMcpOAuthTokens removes a single source", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("sentry_oauth", { accessToken: "x" });
      store.setMcpOAuthTokens("notion_oauth", { accessToken: "y" });
      store.deleteMcpOAuthTokens("sentry_oauth");
      expect(store.getMcpOAuthTokens("sentry_oauth")).toBeUndefined();
      expect(store.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("y");
    });

    it("survives a reload from disk", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpOAuthTokens("notion_oauth", {
        accessToken: "at_xyz",
        refreshToken: "rt_xyz",
      });
      const reloaded = new CredentialStore(dir);
      expect(reloaded.getMcpOAuthTokens("notion_oauth")?.accessToken).toBe("at_xyz");
      expect(reloaded.getMcpOAuthTokens("notion_oauth")?.refreshToken).toBe("rt_xyz");
    });

    it("clear() wipes mcpOAuth tokens too", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthTokens("notion_oauth", { accessToken: "x" });
      store.clear();
      expect(store.getMcpOAuthTokens("notion_oauth")).toBeUndefined();
    });
  });

  describe("mcpOAuthClients (docs/139 — RFC 7591 DCR)", () => {
    it("stores, reads (defensive copy), and persists registered clients", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir);
      store.setMcpOAuthClient("notion_oauth", {
        clientId: "cid",
        clientSecret: "sec",
        registeredAt: 123,
      });
      const got = store.getMcpOAuthClient("notion_oauth")!;
      expect(got.clientId).toBe("cid");
      expect(got.clientSecret).toBe("sec");
      // Mutating the copy doesn't affect the store.
      got.clientId = "mutated";
      expect(store.getMcpOAuthClient("notion_oauth")?.clientId).toBe("cid");
      // Survives a reload.
      const reloaded = new CredentialStore(dir);
      expect(reloaded.getMcpOAuthClient("notion_oauth")?.clientId).toBe("cid");
    });

    it("returns undefined for an unregistered provider", () => {
      const store = new CredentialStore(createTmpDir());
      expect(store.getMcpOAuthClient("notion_oauth")).toBeUndefined();
    });

    it("deleteMcpOAuthClient removes only the targeted client", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthClient("notion_oauth", { clientId: "n", registeredAt: 1 });
      store.setMcpOAuthClient("sentry_oauth", { clientId: "l", registeredAt: 1 });
      store.deleteMcpOAuthClient("notion_oauth");
      expect(store.getMcpOAuthClient("notion_oauth")).toBeUndefined();
      expect(store.getMcpOAuthClient("sentry_oauth")?.clientId).toBe("l");
    });

    it("clear() wipes registered clients too", () => {
      const store = new CredentialStore(createTmpDir());
      store.setMcpOAuthClient("notion_oauth", { clientId: "n", registeredAt: 1 });
      store.clear();
      expect(store.getMcpOAuthClient("notion_oauth")).toBeUndefined();
    });
  });

  // ---- At-rest encryption (docs/220) ----

  describe("encryption", () => {
    it("encrypts the on-disk file but round-trips through the API", () => {
      const dir = createTmpDir();
      const cipher = new SecretCipher(crypto.randomBytes(32));
      const store = new CredentialStore(dir, cipher);
      store.setGithubToken("ghp_secret");
      store.setAgentEnv("mcp__acme__TOKEN", "sk-secret");

      // The raw file is opaque ciphertext — no plaintext token survives.
      const raw = fs.readFileSync(path.join(dir, "shipit-credentials.json"), "utf-8");
      expect(isEncrypted(raw.trim())).toBe(true);
      expect(raw).not.toContain("ghp_secret");
      expect(raw).not.toContain("sk-secret");

      // A new instance with the SAME cipher reads it back.
      const reloaded = new CredentialStore(dir, cipher);
      expect(reloaded.getGithubToken()).toBe("ghp_secret");
      expect(reloaded.getAgentEnv("mcp__acme__TOKEN")).toBe("sk-secret");
    });

    it("keeps mode 0600 on the encrypted file", () => {
      const dir = createTmpDir();
      const store = new CredentialStore(dir, new SecretCipher(crypto.randomBytes(32)));
      store.setGithubToken("ghp_secret");
      const stat = fs.statSync(path.join(dir, "shipit-credentials.json"));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("reads a legacy plaintext file and re-encrypts it on construction", () => {
      const dir = createTmpDir();
      // Seed a legacy plaintext credentials file.
      fs.writeFileSync(
        path.join(dir, "shipit-credentials.json"),
        JSON.stringify({ githubToken: "ghp_legacy" }),
      );

      const cipher = new SecretCipher(crypto.randomBytes(32));
      const store = new CredentialStore(dir, cipher);
      // Value reads through transparently...
      expect(store.getGithubToken()).toBe("ghp_legacy");
      // ...and the file is now encrypted at rest (one-shot migration).
      const raw = fs.readFileSync(path.join(dir, "shipit-credentials.json"), "utf-8");
      expect(isEncrypted(raw.trim())).toBe(true);
      expect(raw).not.toContain("ghp_legacy");
    });

    it("fails closed (throws) on a wrong key rather than wiping data", () => {
      const dir = createTmpDir();
      new CredentialStore(dir, new SecretCipher(crypto.randomBytes(32))).setGithubToken(
        "ghp_secret",
      );
      // A different key must not silently reset the store (which would let the
      // next save overwrite the real encrypted file with an empty one).
      expect(() => new CredentialStore(dir, new SecretCipher(crypto.randomBytes(32)))).toThrow();
    });

    it("fails closed (throws) when the file is encrypted but no cipher is configured", () => {
      const dir = createTmpDir();
      new CredentialStore(dir, new SecretCipher(crypto.randomBytes(32))).setGithubToken(
        "ghp_secret",
      );
      // Encryption turned off (or key missing) over an encrypted file must not
      // be misread as corrupt JSON → reset → overwritten with an empty file.
      expect(() => new CredentialStore(dir)).toThrow(/encrypted/);
    });

    it("repairs a pre-existing looser file mode to 0600 on save", () => {
      const dir = createTmpDir();
      const file = path.join(dir, "shipit-credentials.json");
      // Simulate a legacy plaintext file written with a permissive mode.
      fs.writeFileSync(file, JSON.stringify({ githubToken: "ghp_legacy" }), { mode: 0o644 });
      fs.chmodSync(file, 0o644);

      // Constructing with a cipher re-encrypts (one-shot migration) and chmods.
      new CredentialStore(dir, new SecretCipher(crypto.randomBytes(32)));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });
  });
});

/**
 * docs/252 phase 7 (req 9 + req 13) — the non-turn pin.
 *
 * The store's job is only to say what the user chose; deciding what to RUN is
 * `resolveNonTurnModel`'s. The distinction is load-bearing for a **retired**
 * model: filtering it out here made req 13's read-time successor resolution
 * unreachable, so a retirement silently discarded the user's choice instead of
 * following it through. Found by cross-backend review.
 */
describe("CredentialStore — non-turn model (docs/252 phase 7)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-nonturn-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a pin and clears it with null", () => {
    const store = new CredentialStore(dir);
    expect(store.getNonTurnModel()).toBeUndefined();

    store.setNonTurnModel({ serviceId: "anthropic", billingMode: "sub", modelId: "haiku" });
    expect(store.getNonTurnModel()).toEqual({
      serviceId: "anthropic",
      billingMode: "sub",
      modelId: "haiku",
    });

    store.setNonTurnModel(null);
    expect(store.getNonTurnModel()).toBeUndefined();
  });

  it("refuses a triple the catalogue does not carry", () => {
    const store = new CredentialStore(dir);
    expect(() =>
      store.setNonTurnModel({ serviceId: "anthropic", billingMode: "sub", modelId: "not-a-model" }),
    ).toThrow();
  });

  // The read has to SURVIVE a retirement, because `resolveNonTurnModel` is where
  // req 13's successor lookup lives. Reading it as unset would silently hand the
  // user the derived default instead.
  it("still reports a pin whose model has been retired", () => {
    const store = new CredentialStore(dir);
    store.setNonTurnModel({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" });
    // Write a retired id straight into the file the store reads, since `set`
    // (correctly) refuses one — this is the shape an install carries after a
    // catalogue revision, not something the API can produce.
    const file = path.join(dir, "shipit-credentials.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    data.nonTurnModel = { serviceId: "openai", billingMode: "key", modelId: "gpt-5.6" };
    fs.writeFileSync(file, JSON.stringify(data));

    expect(new CredentialStore(dir).getNonTurnModel()).toEqual({
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.6",
    });
  });

  it("reads a pin naming nothing at all as unset", () => {
    const store = new CredentialStore(dir);
    store.setNonTurnModel({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.4-mini" });
    const file = path.join(dir, "shipit-credentials.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    data.nonTurnModel = { serviceId: "no-such-service", billingMode: "key", modelId: "nope" };
    fs.writeFileSync(file, JSON.stringify(data));

    expect(new CredentialStore(dir).getNonTurnModel()).toBeUndefined();
  });
});

describe("CredentialStore — the two reviewers (docs/261 phase 1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-reviewer-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pin = {
    serviceId: "anthropic",
    billingMode: "sub" as const,
    modelId: "haiku",
    reasoningEffort: "high",
  };

  it("round-trips a pin per slot and clears it with null", () => {
    const store = new CredentialStore(dir);
    // Unset is the auto-configured STATE (req 8), not a missing value — the
    // store never resolves it, so the two stay distinguishable up to the UI.
    expect(store.getReviewerPin("first")).toBeUndefined();
    expect(store.getReviewerPin("second")).toBeUndefined();

    store.setReviewerPin("first", pin);
    expect(store.getReviewerPin("first")).toEqual(pin);
    expect(store.getReviewerPin("second")).toBeUndefined();

    store.setReviewerPin("first", null);
    expect(store.getReviewerPin("first")).toBeUndefined();
  });

  it("keeps the two slots independent, and reports both", () => {
    const store = new CredentialStore(dir);
    store.setReviewerPin("first", pin);
    store.setReviewerPin("second", { ...pin, modelId: "claude-opus-5", reasoningEffort: "max" });
    expect(store.getReviewerPins()).toEqual({
      first: pin,
      second: { ...pin, modelId: "claude-opus-5", reasoningEffort: "max" },
    });
  });

  it("survives a reload", () => {
    new CredentialStore(dir).setReviewerPin("second", pin);
    expect(new CredentialStore(dir).getReviewerPin("second")).toEqual(pin);
  });

  it("refuses a triple the catalogue does not carry", () => {
    const store = new CredentialStore(dir);
    expect(() => store.setReviewerPin("first", { ...pin, modelId: "not-a-model" })).toThrow();
  });

  // req 5 — the reasoning level is PART of the reviewer, so a pin without one is
  // not a reviewer. Pinning is atomic: the whole tuple lands or none of it does.
  it("refuses a pin with no reasoning level", () => {
    const store = new CredentialStore(dir);
    expect(() => store.setReviewerPin("first", { ...pin, reasoningEffort: "  " })).toThrow();
  });

  // Same rule as the non-turn pin: a retirement must be FOLLOWED (docs/252
  // req 13), not silently replaced by the derived default.
  it("still reports a pin whose model has been retired", () => {
    const store = new CredentialStore(dir);
    store.setReviewerPin("first", {
      serviceId: "openai",
      billingMode: "key",
      modelId: "gpt-5.4-mini",
      reasoningEffort: "high",
    });
    const file = path.join(dir, "shipit-credentials.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    data.reviewers = {
      first: {
        serviceId: "openai",
        billingMode: "key",
        modelId: "gpt-5.6",
        reasoningEffort: "high",
      },
    };
    fs.writeFileSync(file, JSON.stringify(data));

    expect(new CredentialStore(dir).getReviewerPin("first")?.modelId).toBe("gpt-5.6");
  });

  it("reads a pin naming nothing at all as unset", () => {
    const store = new CredentialStore(dir);
    store.setReviewerPin("first", pin);
    const file = path.join(dir, "shipit-credentials.json");
    const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    data.reviewers = {
      first: {
        serviceId: "no-such-service",
        billingMode: "key",
        modelId: "nope",
        reasoningEffort: "high",
      },
    };
    fs.writeFileSync(file, JSON.stringify(data));

    expect(new CredentialStore(dir).getReviewerPin("first")).toBeUndefined();
  });

  // The stored sub-agent defaults are DROPPED, not migrated (requirements.md's
  // 2026-08-10 receipt). docs/261 phase 2 deleted the store that wrote them, so
  // the legacy key is written by hand here — which is exactly what an install
  // that had configured one looks like on disk after upgrading. It must load
  // without error, seed nothing, and leave both slots auto-configured.
  it("does not seed a slot from the sub-agent defaults it replaces", () => {
    const file = path.join(dir, "shipit-credentials.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        agentSubAgentDefaults: {
          codex: { model: "gpt-5.4-mini", serviceId: "openai", billingMode: "sub", reasoningEffort: "high" },
        },
      }),
    );
    expect(new CredentialStore(dir).getReviewerPins()).toEqual({});
  });
});

/**
 * docs/264 phase 1 (reqs 1, 2, 18) — the role store.
 *
 * Three properties carry most of the weight here: uniqueness is the map's rather
 * than a check's, the reviewer is **synthesized** so an empty store still has
 * it, and a name is whatever the user typed.
 */
describe("CredentialStore — agent roles (docs/264 phase 1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-roles-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pinned = {
    kind: "pinned" as const,
    harnessId: "claude" as const,
    serviceId: "anthropic",
    billingMode: "key" as const,
    modelId: "claude-opus-5",
    reasoningEffort: "high",
  };

  // ---- The synthesized reviewer (req 2) ----

  it("yields the reviewer on a completely empty store, with automatic params", () => {
    const store = new CredentialStore(dir);
    expect(store.getRoles()).toEqual([{ name: "reviewer", params: { kind: "auto" } }]);
    // No record was written to get it — the point of synthesizing rather than
    // seeding is that there is nothing to migrate, nothing to upgrade
    // idempotently, and nothing an install could have deleted before the
    // reserved-name rule existed.
    const file = path.join(dir, "shipit-credentials.json");
    const onDisk = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    expect(onDisk.roles).toBeUndefined();
  });

  it("carries the reviewer's editable metadata without ever storing its params", () => {
    const store = new CredentialStore(dir);
    store.setRole("reviewer", {
      name: "reviewer",
      description: "The second opinion",
      prompt: "Review the diff for correctness only.",
      params: { kind: "auto" },
    });
    expect(store.getRole("reviewer")).toEqual({
      name: "reviewer",
      description: "The second opinion",
      prompt: "Review the diff for correctness only.",
      params: { kind: "auto" },
    });
    // On disk it is metadata only: `params` is never written, which is what
    // keeps the reviewer's params resolved rather than pinned.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "shipit-credentials.json"), "utf8"));
    expect(onDisk.roles.reviewer).toEqual({
      description: "The second opinion",
      prompt: "Review the diff for correctness only.",
    });
    expect(new CredentialStore(dir).getRole("reviewer")?.description).toBe("The second opinion");
  });

  it("refuses to delete the reviewer or to pin its params (req 2)", () => {
    const store = new CredentialStore(dir);
    expect(() => store.setRole("reviewer", null)).toThrow(/cannot be deleted/);
    expect(() => store.setRole("reviewer", { name: "reviewer", params: pinned })).toThrow(
      /resolved by ShipIt and cannot be pinned/,
    );
  });

  it("rejects automatic params for every name but the reserved one", () => {
    const store = new CredentialStore(dir);
    expect(() =>
      store.setRole("deep-dive", { name: "deep-dive", params: { kind: "auto" } }),
    ).toThrow(/Only the "reviewer" role may have automatic params/);
  });

  // ---- Ordinary roles ----

  it("round-trips a pinned role and deletes it with null", () => {
    const store = new CredentialStore(dir);
    store.setRole("deep-dive", { name: "deep-dive", description: "Thorough", params: pinned });
    expect(store.getRole("deep-dive")).toEqual({
      name: "deep-dive",
      description: "Thorough",
      params: pinned,
    });
    expect(new CredentialStore(dir).getRole("deep-dive")?.params).toEqual(pinned);

    store.setRole("deep-dive", null);
    expect(store.getRole("deep-dive")).toBeUndefined();
    // The reviewer is untouched by a delete of something else.
    expect(store.getRoles().map((r) => r.name)).toEqual(["reviewer"]);
  });

  it("sorts by name at read time, with no stored rank", () => {
    const store = new CredentialStore(dir);
    store.setRole("zebra", { name: "zebra", params: pinned });
    store.setRole("alpha", { name: "alpha", params: pinned });
    expect(store.getRoles().map((r) => r.name)).toEqual(["alpha", "reviewer", "zebra"]);
  });

  it("keeps uniqueness by name — a second write to one name replaces it", () => {
    const store = new CredentialStore(dir);
    store.setRole("deep-dive", { name: "deep-dive", description: "first", params: pinned });
    store.setRole("deep-dive", { name: "deep-dive", description: "second", params: pinned });
    expect(store.getRoles().filter((r) => r.name === "deep-dive")).toHaveLength(1);
    expect(store.getRole("deep-dive")?.description).toBe("second");
  });

  // ---- Req 18: any name the user types ----

  it("accepts any name the user types — spaces, case, punctuation, non-Latin", () => {
    const store = new CredentialStore(dir);
    for (const name of ["deep dive", "Deep-Dive", "код-ревью", "reviewer #2", "🔍 scan"]) {
      store.setRole(name, { name, params: pinned });
      expect(store.getRole(name)?.params).toEqual(pinned);
    }
  });

  /**
   * Reservation is an **exact-string** match. Req 18 says "no case rule", so
   * `Reviewer` is a different name and an ordinary pinned role — folding case
   * would be a restriction nobody asked for, on the one requirement that says
   * not to add restrictions.
   */
  it("treats a differently-cased `Reviewer` as an ordinary role", () => {
    const store = new CredentialStore(dir);
    store.setRole("Reviewer", { name: "Reviewer", params: pinned });
    expect(store.getRole("Reviewer")?.params).toEqual(pinned);
    // …and the reserved one is still automatic, still undeletable.
    expect(store.getRole("reviewer")?.params).toEqual({ kind: "auto" });
    expect(() => store.setRole("reviewer", null)).toThrow();
  });

  /**
   * The name is stored **exactly as typed** — no trimming, no normalization.
   * Req 18 enforces uniqueness and nothing else, and a rewritten key is a rule
   * the user cannot see: it silently merges two names they meant to keep apart,
   * and it can walk a name into the reserved one.
   */
  it("stores the name verbatim, so surrounding whitespace is part of it", () => {
    const store = new CredentialStore(dir);
    store.setRole(" deep dive ", { name: " deep dive ", params: pinned });
    expect(store.getRole(" deep dive ")?.params).toEqual(pinned);
    expect(store.getRole("deep dive")).toBeUndefined();
    // The sharp end of the same rule: a padded "reviewer" is an ordinary role,
    // not the reserved one, so it can be pinned and deleted like any other.
    store.setRole(" reviewer ", { name: " reviewer ", params: pinned });
    expect(store.getRole(" reviewer ")?.params).toEqual(pinned);
    expect(store.getRole("reviewer")?.params).toEqual({ kind: "auto" });
    store.setRole(" reviewer ", null);
    expect(store.getRole(" reviewer ")).toBeUndefined();
  });

  it("refuses a name that is blank once whitespace is discounted", () => {
    const store = new CredentialStore(dir);
    expect(() => store.setRole("   ", { name: "   ", params: pinned })).toThrow(/cannot be blank/);
  });

  it("refuses only a pathological length, not a length a human would type", () => {
    const store = new CredentialStore(dir);
    // 500 characters is absurd for a name and still accepted: the bound is a
    // guard on the store, not a product rule (req 18).
    const long = "x".repeat(500);
    store.setRole(long, { name: long, params: pinned });
    expect(store.getRole(long)?.params).toEqual(pinned);

    const absurd = "x".repeat(10_001);
    expect(() => store.setRole(absurd, { name: absurd, params: pinned })).toThrow(
      /longer than 10000/,
    );
  });

  it("bounds the stored description and standing instructions", () => {
    const store = new CredentialStore(dir);
    expect(() =>
      store.setRole("a", { name: "a", description: "x".repeat(501), params: pinned }),
    ).toThrow(/description cannot be longer/);
    expect(() =>
      store.setRole("a", { name: "a", prompt: "x".repeat(20_001), params: pinned }),
    ).toThrow(/standing instructions cannot be longer/);
  });

  it("ignores a stored entry that carries no params — it is metadata, not a role", () => {
    // Hand-written on disk: the shape the reserved key uses, under a name that
    // is not reserved. Returning it as a role would produce one with nothing to
    // run on.
    fs.writeFileSync(
      path.join(dir, "shipit-credentials.json"),
      JSON.stringify({ roles: { orphan: { description: "left behind" } } }),
    );
    const store = new CredentialStore(dir);
    expect(store.getRole("orphan")).toBeUndefined();
    expect(store.getRoles().map((r) => r.name)).toEqual(["reviewer"]);
  });
});
