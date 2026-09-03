import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { credentialledGit, gitCredentialConfig, gitCredentialEnv } from "./git-remote-credential.js";
import { RepoGit } from "../orchestrator/repo-git.js";

/**
 * docs/288-preemptive-github-auth — the credential has to be on the FIRST
 * request.
 *
 * ## Why a real git against a real socket
 *
 * The claim under test is about a *wire* behaviour of git that no amount of
 * inspecting our own argv can prove: over HTTPS git issues the request
 * anonymously and consults a credential helper only after a 401, so a suite that
 * asserted "we passed the right `-c` flags" would have passed just as happily
 * before this feature existed, while every prefetch still went out anonymous.
 * The server here records what actually arrived.
 *
 * The server deliberately does NOT implement git's smart protocol, so every git
 * command below FAILS. That is fine and is the point: the assertion is over the
 * recorded request log, and not implementing the protocol keeps the fixture
 * incapable of accidentally passing for a reason other than the header.
 *
 * The token is never asserted on directly and never reaches an expectation
 * message — the log records whether an `Authorization` header was present, not
 * what it said.
 */

interface Recorded {
  url: string;
  authenticated: boolean;
}

/** A server that records each request and answers `respond`. */
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
    // `server-test-setup.ts` pins `GIT_ALLOW_PROTOCOL=file` so no server test
    // pays for a DNS + TLS round-trip to github.com to learn that a fake URL is
    // fake. That reasoning is about the *external* network; the server below is
    // an ephemeral port on 127.0.0.1 that this file starts and stops, so there
    // is no lookup and no packet leaves the box. `http` is added for the
    // duration of this describe and removed after, so nothing else in the run
    // inherits a wider allowlist.
    originalAllowProtocol = process.env.GIT_ALLOW_PROTOCOL;
    process.env.GIT_ALLOW_PROTOCOL = "file:http";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-preemptive-"));
    execFileSync("git", ["init", "-q", tmpDir]);
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
    // The FIRST request, not merely some later one: an authenticated retry after
    // a 401 is exactly the behaviour this feature replaces.
    expect(server.log[0].authenticated).toBe(true);
  });

  it("sends nothing when no credential is held (req 2)", async () => {
    server = await startRecordingServer((_req, res) => { res.writeHead(404); res.end(); });
    // `token` omitted — the anonymous shape: helpers reset, nothing offered.
    const git = credentialledGit(tmpDir, { origin: server.origin });
    await expect(git.raw(["ls-remote", `${server.origin}/acme/widgets`])).rejects.toThrow();

    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log.every((r) => !r.authenticated)).toBe(true);
  });

  it("retries UNAUTHENTICATED when the credential is refused (req 4)", async () => {
    // The regression this guards: a public repository fetches fine anonymously
    // today, and a stale token would turn that into `fatal: Authentication
    // failed`. Requirement 4 forbids being worse than today's failure, so the
    // refused credential has to fall back to the request ShipIt would have made
    // before this feature.
    server = await startRecordingServer((_req, res, authenticated) => {
      if (authenticated) { res.writeHead(401); res.end(); return; }
      res.writeHead(404); res.end();
    });
    const bare = path.join(tmpDir, "cache.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", bare, "remote", "add", "origin", `${server.origin}/acme/widgets`]);

    const repo = new RepoGit(bare, undefined, async () => TOKEN);
    // Still throws: the fallback restores today's behaviour, it does not invent
    // a success. `fetchCache` throwing is what surfaces the stale cache to the
    // prefetch/claim warning paths (req 4, "the same place").
    await expect(repo.fetchCache(0)).rejects.toThrow();

    expect(server.log[0].authenticated).toBe(true);
    const anonymousRetry = server.log.slice(1).some((r) => !r.authenticated);
    expect(anonymousRetry).toBe(true);
  });

  it("offers nothing to a remote the resolver declines", async () => {
    server = await startRecordingServer((_req, res) => { res.writeHead(404); res.end(); });
    const bare = path.join(tmpDir, "declined.git");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["-C", bare, "remote", "add", "origin", `${server.origin}/acme/widgets`]);

    // What every resolver in the tree does for a host that is not github.com.
    const repo = new RepoGit(bare, undefined, async () => null);
    await expect(repo.fetchCache(0)).rejects.toThrow();

    expect(server.log.length).toBeGreaterThan(0);
    expect(server.log.every((r) => !r.authenticated)).toBe(true);
  });
});

describe("preemptive auth: where the secret is allowed to be (req 3)", () => {
  const credential = { origin: "https://github.com", token: TOKEN } as const;

  it("keeps the token out of the argv", () => {
    // `gitCredentialConfig`'s entries become `-c <entry>` on the command line,
    // which `/proc/<pid>/cmdline` hands to every uid in the container. Base64 is
    // not encryption, so the encoded header must not be there either.
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
