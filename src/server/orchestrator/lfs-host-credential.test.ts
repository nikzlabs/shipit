import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitManager } from "../shared/git.js";
import { LfsUploadError } from "../shared/git-lfs-push.js";
import { configureLfsHostCredentialResolver } from "../shared/git-remote-credential.js";
import { initGlobalGitConfig, setGitIdentity } from "./git-config.js";
import { createLfsHostCredentialResolver, parseLfsHostSecret } from "./lfs-host-credential.js";

const declared = { host: "lfs.example.com", credential: "LFS_CREDENTIAL" };

describe("parseLfsHostSecret", () => {
  it("reads a credential-store line, percent-decoding the username and password", () => {
    expect(parseLfsHostSecret("https://ali%40ce:p%3Ass@LFS.example.com", declared)).toEqual({
      credential: { origin: "https://lfs.example.com", username: "ali@ce", password: "p:ss" },
    });
  });

  it.each([
    ["not a URL", "alice secret", "not a credential line"],
    ["a second line", "https://alice:secret@lfs.example.com\nhttps://x:y@lfs.example.com", "one line"],
    ["an encoded line break", "https://alice:se%0Acret@lfs.example.com", "control character"], // gitleaks:allow
    ["plain http", "http://alice:secret@lfs.example.com", "must be an https:// line"],
    ["a path", "https://alice:secret@lfs.example.com/lfs", "no path"],
    ["no password", "https://alice@lfs.example.com", "both a username and a password"],
    ["another host", "https://alice:secret@other.example.com", "is for `other.example.com`"],
    ["another port", "https://alice:secret@lfs.example.com:8443", "is for `lfs.example.com:8443`"],
  ])("refuses %s, naming the declared host", (_what, value, reason) => {
    const resolution = parseLfsHostSecret(value, declared);
    expect(resolution).toMatchObject({ host: "lfs.example.com" });
    expect("refusal" in resolution && resolution.refusal).toContain(reason);
    expect(JSON.stringify(resolution)).not.toContain("secret\"");
  });
});

describe("createLfsHostCredentialResolver", () => {
  let root: string;
  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();
  const lfsYaml = "lfs:\n  host: lfs.example.com\n  credential: LFS_CREDENTIAL\n";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-host-"));
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");
  });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("declares nothing without an `lfs` section", async () => {
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    run("git init -q -b main", work);
    const resolve = createLfsHostCredentialResolver({ loadSecrets: () => ({}), repoUrlForDir: () => "https://github.com/o/r.git" });
    expect(await resolve(work)).toBeNull();
  });

  // The checkout's origin is agent-editable; pointing it at another repository must
  // not select that repository's secrets.
  it("looks the secret up by ShipIt's record of the repository, never by the checkout's origin", async () => {
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    run("git init -q -b main", work);
    run("git remote add origin https://github.com/other/secrets-owner.git", work);
    fs.writeFileSync(path.join(work, "shipit.yaml"), lfsYaml);
    const keys: string[] = [];
    const resolve = createLfsHostCredentialResolver({
      loadSecrets: (repoUrl) => { keys.push(repoUrl); return {}; },
      repoUrlForDir: (dir) => (dir === work ? "https://github.com/o/r.git" : null),
    });

    const resolution = await resolve(work);

    expect(keys).toEqual(["https://github.com/o/r.git"]);
    expect(resolution && "refusal" in resolution && resolution.refusal).toContain("no such secret");
  });

  it("takes the repository a provisioning caller names over any record", async () => {
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    run("git init -q -b main", work);
    fs.writeFileSync(path.join(work, "shipit.yaml"), lfsYaml);
    const keys: string[] = [];
    const resolve = createLfsHostCredentialResolver({
      loadSecrets: (repoUrl) => { keys.push(repoUrl); return {}; },
      repoUrlForDir: () => null,
    });

    await resolve(work, "https://github.com/o/r.git");

    expect(keys).toEqual(["https://github.com/o/r.git"]);
  });

  it("looks up nothing for a checkout ShipIt has no record of", async () => {
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    run("git init -q -b main", work);
    fs.writeFileSync(path.join(work, "shipit.yaml"), lfsYaml);
    const resolve = createLfsHostCredentialResolver({
      loadSecrets: () => { throw new Error("must not read secrets without a record"); },
      repoUrlForDir: () => null,
    });

    const resolution = await resolve(work);

    expect(resolution).toMatchObject({ host: "lfs.example.com" });
    expect(resolution && "refusal" in resolution && resolution.refusal).toContain("no record");
  });

  it("reads a bare cache's declaration from the ref its LFS fetch uses", async () => {
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    run("git init -q -b main", work);
    fs.writeFileSync(path.join(work, "shipit.yaml"), lfsYaml);
    run("git add -A && git commit -q -m init", work);
    const bare = path.join(root, "cache.git");
    run(`git clone -q --bare ${work} ${bare}`, root);
    const resolve = createLfsHostCredentialResolver({
      loadSecrets: () => ({ LFS_CREDENTIAL: "https://alice:secret@lfs.example.com" }),
      repoUrlForDir: () => "https://github.com/o/r.git",
    });

    expect(await resolve(bare)).toEqual({
      credential: { origin: "https://lfs.example.com", username: "alice", password: "secret" },
    });
    // A renamed default branch leaves HEAD dangling; the cache's LFS fetch then uses
    // the first branch, and the declaration must come from the same ref.
    run("git symbolic-ref HEAD refs/heads/renamed-away", bare);
    expect(() => run("git rev-parse --verify HEAD", bare)).toThrow();
    expect(await resolve(bare)).toMatchObject({ credential: { username: "alice" } });
  });
});

// Real git + git-lfs against an HTTPS LFS server that requires Basic auth.
describe("GitManager.push to a declared LFS host", () => {
  let root: string;
  let certDir: string;
  let server: https.Server;
  let port = 0;
  let workDir: string;
  let bareDir: string;
  let origGitConfigGlobal: string | undefined;
  const seenCredentials: string[] = [];
  const stored = new Set<string>();

  const run = (cmd: string, cwd: string): string =>
    execSync(cmd, { cwd, stdio: ["pipe", "pipe", "pipe"] }).toString();

  beforeAll(async () => {
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-tls-"));
    run(
      "openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 1 "
      + "-subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1",
      certDir,
    );
    const expected = `Basic ${Buffer.from("alice:s3cret").toString("base64")}`;
    server = https.createServer({
      key: fs.readFileSync(path.join(certDir, "key.pem")),
      cert: fs.readFileSync(path.join(certDir, "cert.pem")),
    }, (req, res) => {
      const auth = req.headers.authorization;
      if (auth) seenCredentials.push(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString());
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const upload = /^\/lfs\/upload\/([0-9a-f]{64})$/.exec(req.url ?? "");
        if (upload) {
          stored.add(upload[1]);
          res.writeHead(200);
          res.end();
          return;
        }
        if (auth !== expected) {
          // 403 once credentials arrive, so a wrong one cannot loop git-lfs.
          res.writeHead(auth ? 403 : 401, { "WWW-Authenticate": "Basic realm=\"lfs\"" });
          res.end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/vnd.git-lfs+json" });
        if (req.url === "/lfs/objects/batch") {
          const { objects } = JSON.parse(Buffer.concat(chunks).toString()) as { objects: { oid: string; size: number }[] };
          res.end(JSON.stringify({
            transfer: "basic",
            objects: objects.map((o) => ({
              ...o,
              authenticated: true,
              actions: { upload: { href: `https://127.0.0.1:${port}/lfs/upload/${o.oid}` } },
            })),
          }));
        } else {
          res.end(JSON.stringify({ ours: [], theirs: [] }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
    fs.rmSync(certDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    seenCredentials.length = 0;
    stored.clear();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-lfs-host-push-"));
    origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
    initGlobalGitConfig(path.join(root, "credentials"));
    setGitIdentity("Test", "test@test.com");
    bareDir = path.join(root, "bare.git");
    workDir = path.join(root, "work");
    fs.mkdirSync(workDir);
    run(`git init -q --bare -b main ${bareDir}`, root);
    run("git init -q -b main", workDir);
    run(`git remote add origin ${bareDir}`, workDir);
    run(`git config http.sslCAInfo ${path.join(certDir, "cert.pem")}`, workDir);
    fs.writeFileSync(path.join(workDir, ".gitattributes"), "*.png filter=lfs diff=lfs merge=lfs -text\n");
    fs.writeFileSync(path.join(workDir, ".lfsconfig"), `[lfs]\n\turl = https://127.0.0.1:${port}/lfs\n`);
    fs.writeFileSync(
      path.join(workDir, "shipit.yaml"),
      `lfs:\n  host: "127.0.0.1:${port}"\n  credential: LFS_CREDENTIAL\n`,
    );
    fs.writeFileSync(path.join(workDir, "art.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 7, 8, 9]));
    run("git add -A && git commit -q -m art", workDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    configureLfsHostCredentialResolver(undefined);
    if (origGitConfigGlobal !== undefined) process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
    else delete process.env.GIT_CONFIG_GLOBAL;
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const secret = (value: string): void => {
    configureLfsHostCredentialResolver(createLfsHostCredentialResolver({
      loadSecrets: () => ({ LFS_CREDENTIAL: value }),
      repoUrlForDir: (dir) => (dir === workDir ? "https://github.com/o/r.git" : null),
    }));
  };

  it("uploads with the declared credential, then pushes the ref", async () => {
    secret(`https://alice:s3cret@127.0.0.1:${port}`);
    const oid = /oid sha256:([0-9a-f]{64})/.exec(run("git cat-file -p HEAD:art.png", workDir))?.[1];

    await new GitManager(workDir).push("origin", "main");

    expect(seenCredentials).toContain("alice:s3cret");
    expect([...stored]).toEqual([oid]);
    expect(run("git rev-parse refs/heads/main", bareDir).trim()).toBe(run("git rev-parse HEAD", workDir).trim());
  });

  it("presents nothing when the secret names another host, and says why in the refusal", async () => {
    secret("https://alice:s3cret@lfs.elsewhere.example");

    const push = new GitManager(workDir).push("origin", "main");

    await expect(push).rejects.toBeInstanceOf(LfsUploadError);
    await expect(push).rejects.toThrow("is for `lfs.elsewhere.example`");
    expect(seenCredentials.join("\n")).not.toContain("s3cret");
    expect(stored.size).toBe(0);
  });
});
