import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import {
  GitHubAppTokenMinter,
  buildAppJwt,
  resolveGitHubAppConfigFromEnv,
  type GitHubAppConfig,
} from "./github-app-token.js";

/** A throwaway RSA keypair so the JWT signing path is exercised for real. */
function testKeyPair(): { publicKey: string; privateKey: string } {
  return generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
}

/** A `fetch` stub that records calls and replays scripted JSON responses. */
function fetchStub(
  responses: { status: number; body: unknown }[],
): { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url as string, init });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("buildAppJwt", () => {
  it("produces a verifiable RS256 JWT with the right claims", () => {
    const { publicKey, privateKey } = testKeyPair();
    const config: GitHubAppConfig = { appId: "12345", privateKey };
    const nowSec = 1_700_000_000;
    const jwt = buildAppJwt(config, nowSec);

    const [headerSeg, payloadSeg, sig] = jwt.split(".");
    const header = decodeSegment(headerSeg);
    const payload = decodeSegment(payloadSeg);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(nowSec - 60); // backdated for clock skew
    expect(payload.exp).toBe(nowSec + 9 * 60); // under GitHub's 10-min cap

    const verify = createVerify("RSA-SHA256");
    verify.update(`${headerSeg}.${payloadSeg}`);
    verify.end();
    expect(verify.verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
  });
});

describe("resolveGitHubAppConfigFromEnv", () => {
  it("returns null when either piece is missing", () => {
    expect(resolveGitHubAppConfigFromEnv({})).toBeNull();
    expect(resolveGitHubAppConfigFromEnv({ GITHUB_APP_ID: "1" })).toBeNull();
    expect(resolveGitHubAppConfigFromEnv({ GITHUB_APP_PRIVATE_KEY: "x" })).toBeNull();
  });

  it("accepts a raw PEM with escaped newlines", () => {
    const { privateKey } = testKeyPair();
    const escaped = privateKey.replace(/\n/g, "\\n");
    const cfg = resolveGitHubAppConfigFromEnv({ GITHUB_APP_ID: "7", GITHUB_APP_PRIVATE_KEY: escaped });
    expect(cfg?.appId).toBe("7");
    expect(cfg?.privateKey).toContain("BEGIN");
    expect(cfg?.privateKey).toContain("\n");
  });

  it("accepts a base64-encoded PEM", () => {
    const { privateKey } = testKeyPair();
    const b64 = Buffer.from(privateKey, "utf8").toString("base64");
    const cfg = resolveGitHubAppConfigFromEnv({ GITHUB_APP_ID: "7", GITHUB_APP_PRIVATE_KEY: b64 });
    expect(cfg?.privateKey).toContain("BEGIN");
  });

  it("returns null when the private key is not a parseable PEM", () => {
    expect(resolveGitHubAppConfigFromEnv({ GITHUB_APP_ID: "7", GITHUB_APP_PRIVATE_KEY: "not-a-key" })).toBeNull();
  });
});

describe("GitHubAppTokenMinter", () => {
  const config = (): GitHubAppConfig => ({ appId: "12345", privateKey: testKeyPair().privateKey });

  it("is inert when no config is supplied", async () => {
    const minter = new GitHubAppTokenMinter({ config: null });
    expect(minter.isConfigured()).toBe(false);
    expect(await minter.getRepoToken("o", "r")).toBeNull();
  });

  it("mints a repo-scoped token: looks up the installation then exchanges it", async () => {
    const { impl, calls } = fetchStub([
      { status: 200, body: { id: 999 } },
      { status: 201, body: { token: "ghs_installation", expires_at: "2099-01-01T00:00:00Z" } },
    ]);
    const minter = new GitHubAppTokenMinter({ config: config(), fetchImpl: impl, now: () => 1_700_000_000_000 });

    const token = await minter.getRepoToken("octo", "hello");
    expect(token).toBe("ghs_installation");

    // Installation lookup is repo-scoped, token mint targets that installation
    expect(calls[0].url).toBe("https://api.github.com/repos/octo/hello/installation");
    expect(calls[1].url).toBe("https://api.github.com/app/installations/999/access_tokens");
    // The mint body scopes to the single repo with a minimal permission set.
    const mintBody = JSON.parse(calls[1].init?.body as string) as Record<string, unknown>;
    expect(mintBody.repositories).toEqual(["hello"]);
    expect(mintBody.permissions).toEqual({ contents: "write", pull_requests: "write", metadata: "read" });
  });

  it("caches the token and does not re-mint within the refresh margin", async () => {
    const { impl, calls } = fetchStub([
      { status: 200, body: { id: 1 } },
      { status: 201, body: { token: "ghs_a", expires_at: "2099-01-01T00:00:00Z" } },
    ]);
    const minter = new GitHubAppTokenMinter({ config: config(), fetchImpl: impl, now: () => 1_700_000_000_000 });

    expect(await minter.getRepoToken("o", "r")).toBe("ghs_a");
    expect(await minter.getRepoToken("o", "r")).toBe("ghs_a");
    expect(calls.length).toBe(2); // only one mint round-trip total
  });

  it("re-mints once the cached token is within the refresh margin of expiry", async () => {
    let now = 1_700_000_000_000;
    // Token expires 6 minutes out; refresh margin is 5 minutes.
    const expiresAt = new Date(now + 6 * 60 * 1000).toISOString();
    const { impl, calls } = fetchStub([
      { status: 200, body: { id: 1 } },
      { status: 201, body: { token: "ghs_first", expires_at: expiresAt } },
      { status: 200, body: { id: 1 } },
      { status: 201, body: { token: "ghs_second", expires_at: "2099-01-01T00:00:00Z" } },
    ]);
    const minter = new GitHubAppTokenMinter({ config: config(), fetchImpl: impl, now: () => now });

    expect(await minter.getRepoToken("o", "r")).toBe("ghs_first");
    now += 2 * 60 * 1000; // now 4 min to expiry — inside the 5-min margin
    expect(await minter.getRepoToken("o", "r")).toBe("ghs_second");
    expect(calls.length).toBe(4);
  });

  it("returns null (not throw) when the installation lookup fails", async () => {
    const { impl } = fetchStub([{ status: 404, body: {} }]);
    const minter = new GitHubAppTokenMinter({ config: config(), fetchImpl: impl, now: () => 1 });
    expect(await minter.getRepoToken("o", "r")).toBeNull();
  });

  it("returns null when the token mint fails", async () => {
    const { impl } = fetchStub([
      { status: 200, body: { id: 1 } },
      { status: 403, body: {} },
    ]);
    const minter = new GitHubAppTokenMinter({ config: config(), fetchImpl: impl, now: () => 1 });
    expect(await minter.getRepoToken("o", "r")).toBeNull();
  });

  it("invalidate() drops the cached token so the next call re-mints", async () => {
    const { impl, calls } = fetchStub([
      { status: 200, body: { id: 1 } },
      { status: 201, body: { token: "ghs_a", expires_at: "2099-01-01T00:00:00Z" } },
      { status: 200, body: { id: 1 } },
      { status: 201, body: { token: "ghs_b", expires_at: "2099-01-01T00:00:00Z" } },
    ]);
    const minter = new GitHubAppTokenMinter({ config: config(), fetchImpl: impl, now: () => 1_700_000_000_000 });

    expect(await minter.getRepoToken("o", "r")).toBe("ghs_a");
    minter.invalidate("o", "r");
    expect(await minter.getRepoToken("o", "r")).toBe("ghs_b");
    expect(calls.length).toBe(4);
  });
});
