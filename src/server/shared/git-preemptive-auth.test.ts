import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { credentialledGit, gitCredentialConfig, gitCredentialEnv } from "./git-remote-credential.js";
import { RepoGit } from "../orchestrator/repo-git.js";
import { GitManager } from "./git.js";
import { initGlobalGitConfig, setGitIdentity } from "../orchestrator/git-config.js";

interface Recorded {
  url: string;
  authenticated: boolean;
}

function startRecordingServer(
  respond: (req: http.IncomingMessage, res: http.ServerResponse, authenticated: boolean) => void,
): Promise<{ origin: string; log: Recorded[]; close: () => Promise<void> }> {
  const log: Recorded[] = [];
  const server = http.createServer((req, res) => {
    const authenticated = Boolean(req.headers.authorization);
    log.push({ url: req.url ?? "", authenticated });
    respond(req, res, authenticated);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        log,
        close: () => new Promise((done) => { server.close(() => { done(); }); }),
      });
    });
  });
}

const TOKEN = { username: "x-access-token", password: "ghs_preemptive_test_token_value" };

describe("preemptive auth: what reaches the wire", () => {
  let tmpDir: string;
  let server: Awaited<ReturnType<typeof startRecordingServer>>;
  let originalAllowProtocol: string | undefined;

  beforeEach(() => {
    // Permit HTTP for the local recording server, then restore the file-only default.
    originalAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file:http";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-preemptive-"));
    execFileSync("git", ["init", "-q", tmpDir]);
    initGlobalGitConfig(tmpDir);
    setGitIdentity("Test", "test@test.com");
  });

  afterEach(async () => {
    if (originalAllowProtocol === undefined) delete process.env.GIT_ALLOW_PROTOCOL;
    else process.env.GIT_ALLOW_PROTOCOL = originalAllowProtocol;
    await server?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends the credential on the FIRST request when one is held (req 1)", async () => {
    server = await startRecordingServer((_req, res) => { res.writeHead(404); res.end(); });
    const git = credentialledGit(tmpDir, { origin: server.origin, token: TOKEN });
    await expect(git.raw(["ls-remote", `${server.origin}/acme/widgets`])).rejects.toThrow();

    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log[0].authenticated).toBe(true);
  });

  it("sends nothing when no credential is held (req 2)", async () => {
    server = await startRecordingServer((_req, res) => { res.writeHead(404); res.end(); });
    const git = credentialledGit(tmpDir, { origin: server.origin });
    await expect(git.raw(["ls-remote", `${server.origin}/acme/widgets`])).rejects.toThrow();

    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log.every((r) => !r.authenticated)).toBe(true);
  });

  it("retries UNAUTHENTICATED when the credential is refused (req 4)", async () => {
    server = await startRecordingServer((_req, res, authenticated) => {
      if (authenticated) { res.writeHead(401); res.end(); return; }
      res.writeHead(404); res.end();
    });
    const bare = path.join(tmpDir, "cache.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", bare, "remote", "add", "origin", `${server.origin}/acme/widgets`]);

    const repo = new RepoGit(bare, undefined, async () => TOKEN);
    // The recording server rejects git requests; only the headers are under test.
    await expect(repo.fetchCache(0)).rejects.toThrow();

    expect(server.log[0].authenticated).toBe(true);
    const anonymousRetry = server.log.slice(1).some((r) => !r.authenticated);
    expect(anonymousRetry).toBe(true);
  });

  it("retries a GitManager READ unauthenticated when the credential is refused (req 4)", async () => {
    server = await startRecordingServer((_req, res, authenticated) => {
      if (authenticated) { res.writeHead(401); res.end(); return; }
      res.writeHead(404); res.end();
    });
    const manager = new GitManager(tmpDir, { resolveRemoteCredential: async () => TOKEN });
    execFileSync("git", ["-C", tmpDir, "remote", "add", "origin", `${server.origin}/acme/widgets`]);

    await expect(manager.fetch("origin")).rejects.toThrow();

    expect(server.log[0].authenticated).toBe(true);
    expect(server.log.slice(1).some((r) => !r.authenticated)).toBe(true);
  });

  it("does NOT retry a push — an anonymous receive-pack cannot succeed (req 4)", async () => {
    server = await startRecordingServer((_req, res, authenticated) => {
      if (authenticated) { res.writeHead(401); res.end(); return; }
      res.writeHead(404); res.end();
    });
    const manager = new GitManager(tmpDir, { resolveRemoteCredential: async () => TOKEN });
    execFileSync("git", ["-C", tmpDir, "remote", "add", "origin", `${server.origin}/acme/widgets`]);
    fs.writeFileSync(path.join(tmpDir, "f.txt"), "x\n");
    await manager.autoCommit("a turn");

    await expect(manager.push("origin")).rejects.toThrow();

    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log.every((r) => r.authenticated)).toBe(true);
  });

  it("does NOT widen an EXPLICIT credential to the global helper on refusal", async () => {
    server = await startRecordingServer((_req, res, authenticated) => {
      if (authenticated) { res.writeHead(401); res.end(); return; }
      res.writeHead(404); res.end();
    });
    const bare = path.join(tmpDir, "plugin.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", bare, "remote", "add", "origin", `${server.origin}/acme/plugin`]);

    const repo = new RepoGit(bare, { origin: server.origin, token: TOKEN }, async () => TOKEN);
    await expect(repo.fetchCache(0)).rejects.toThrow();

    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log.every((r) => r.authenticated)).toBe(true);
  });

  it("offers nothing to a remote the resolver declines", async () => {
    server = await startRecordingServer((_req, res) => { res.writeHead(404); res.end(); });
    const bare = path.join(tmpDir, "declined.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", bare, "remote", "add", "origin", `${server.origin}/acme/widgets`]);

    const repo = new RepoGit(bare, undefined, async () => null);
    await expect(repo.fetchCache(0)).rejects.toThrow();

    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log.every((r) => !r.authenticated)).toBe(true);
  });
});

describe("preemptive auth: where the secret is allowed to be (req 3)", () => {
  const credential = { origin: "https://github.com", token: TOKEN } as const;

  it("keeps the token out of the argv", () => {
    const argv = gitCredentialConfig(credential).join(" ");
    expect(argv).not.toContain(TOKEN.password);
    expect(argv).not.toContain(Buffer.from(`${TOKEN.username}:${TOKEN.password}`).toString("base64"));
    expect(argv).not.toMatch(/extraheader/i);
  });

  it("carries the preemptive header in the environment instead", () => {
    const env = gitCredentialEnv(credential);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from(`${TOKEN.username}:${TOKEN.password}`).toString("base64")}`,
    );
  });

  it("writes no environment pairs at all for the anonymous shape", () => {
    expect(gitCredentialEnv({ origin: "https://github.com" })).toEqual({});
  });
});
