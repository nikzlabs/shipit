import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

/**
 * `reset-demo-repo.sh` against a fake that plays both the demo instance
 * (`/api/…`) and the GitHub REST API (`/repos/…`) on one port, recording every
 * write; `host/reset-demo-instance.sh` in `--dry-run` against a fixture
 * install. Neither test reaches a network (docs/296 plan §6, §9).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const RESET_REPO = join(HERE, "reset-demo-repo.sh");
const RESET_INSTANCE = join(HERE, "host", "reset-demo-instance.sh");
const PIN = "af344fbed791e454f6a0b96245b48f377b2d7aa3";

interface Recorded { method: string; url: string; auth: string | undefined; body: string }

function fakeServer(opts: { instanceSession: "warm" | "listed" | "none"; noRedirect?: boolean; manyBranches?: boolean }): Promise<{ url: string; writes: Recorded[]; close: () => void }> {
  const writes: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (method !== "GET") {
        writes.push({ method, url, auth: req.headers.authorization, body });
        return send(200, {});
      }
      // Instance
      if (url === "/api/bootstrap") return send(200, { runtimeMode: "containerized" });
      if (url === "/api/repos") {
        return send(200, { repos: opts.instanceSession === "warm"
          ? [{ url: "https://github.com/demo/app.git", status: "ready", warmSessionId: "warm-1" }]
          : [{ url: "https://github.com/demo/app.git", status: "ready" }] });
      }
      if (url === "/api/sessions/all") {
        return send(200, { sessions: opts.instanceSession === "listed"
          ? [{ id: "other", remoteUrl: "https://github.com/x/y", workspaceDir: "/w/x" }, { id: "sess-2", remoteUrl: "https://github.com/demo/app", workspaceDir: "/w/2" }]
          : [] });
      }
      if (/^\/api\/sessions\/[^/]+\/pr\/list\?/.test(url)) return send(200, { prs: [{ number: 7, head: "shipit/a" }, { number: 8, head: "shipit/b" }] });
      // GitHub
      if (url === `/repos/demo/app/contents/.claude/settings.json?ref=${PIN}`) {
        if (opts.noRedirect) return send(404, { message: "Not Found" });
        return send(200, { encoding: "base64", content: Buffer.from('{ "env": { "ANTHROPIC_BASE_URL": "http://demo-proxy:8787" } }').toString("base64") });
      }
      if (url === "/repos/demo/app") return send(200, { default_branch: "main" });
      if (url === `/repos/demo/app/git/commits/${PIN}`) return send(200, { sha: PIN });
      if (url === "/repos/demo/app/git/ref/heads/main") return send(200, { object: { sha: "1111111111111111111111111111111111111111" } });
      if (url.startsWith("/repos/demo/app/branches")) {
        if (opts.manyBranches) return send(200, Array.from({ length: 100 }, (_, i) => ({ name: i === 0 ? "main" : `shipit/b${i}` })));
        return send(200, [{ name: "main" }, { name: "shipit/a" }, { name: "shipit/b" }]);
      }
      if (url.startsWith("/repos/demo/app/pulls")) return send(200, [{ number: 7 }, { number: 8 }]);
      send(404, { error: `unhandled ${method} ${url}` });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, writes, close: () => server.close() });
    });
  });
}

// Async on purpose: the fake server lives on this event loop, and a spawnSync
// would block it while curl waits on it — a deadlock, not a slow test.
function runReset(args: string[], env: Record<string, string | undefined>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", [RESET_REPO, ...args], { env: { ...process.env, GITHUB_TOKEN: undefined, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("reset-demo-repo.sh", () => {
  it("is bash -n clean", () => {
    expect(spawnSync("bash", ["-n", RESET_REPO]).status).toBe(0);
  });

  it("closes PRs through the instance, then deletes branches and force-resets main with the token", async () => {
    const fake = await fakeServer({ instanceSession: "warm" });
    try {
      const r = await runReset(["--repo", "demo/app", "--pin", PIN, "--instance", fake.url], { GITHUB_API_URL: fake.url, GITHUB_TOKEN: "ghp_test" });
      expect(r.status, r.stderr).toBe(0);
      expect(fake.writes.map((w) => `${w.method} ${w.url}`)).toEqual([
        "POST /api/sessions/warm-1/pr/7/close",
        "POST /api/sessions/warm-1/pr/8/close",
        "DELETE /repos/demo/app/git/refs/heads/shipit/a",
        "DELETE /repos/demo/app/git/refs/heads/shipit/b",
        "PATCH /repos/demo/app/git/refs/heads/main",
      ]);
      // The instance closes with its own credential: the token never travels to it.
      expect(fake.writes[0].auth).toBeUndefined();
      expect(JSON.parse(fake.writes[0].body)).toEqual({ repo: "demo/app" });
      expect(fake.writes[2].auth).toBe("Bearer ghp_test");
      expect(JSON.parse(fake.writes[4].body)).toEqual({ sha: PIN, force: true });
      expect(r.stderr).toContain("closing PRs through the instance (session warm-1");
    } finally {
      fake.close();
    }
  });

  it("finds a non-warm session on the repo, and falls back to the token when the instance has none", async () => {
    const listed = await fakeServer({ instanceSession: "listed" });
    const none = await fakeServer({ instanceSession: "none" });
    try {
      const a = await runReset(["--repo", "https://github.com/demo/app.git", "--pin", PIN, "--instance", listed.url], { GITHUB_API_URL: listed.url, GITHUB_TOKEN: "t" });
      expect(a.status, a.stderr).toBe(0);
      expect(listed.writes[0].url).toBe("/api/sessions/sess-2/pr/7/close");

      const b = await runReset(["--repo", "demo/app", "--pin", PIN, "--instance", none.url], { GITHUB_API_URL: none.url, GITHUB_TOKEN: "t" });
      expect(b.status, b.stderr).toBe(0);
      expect(b.stderr).toContain("PRs will be closed with GITHUB_TOKEN instead");
      expect(none.writes.slice(0, 2).map((w) => `${w.method} ${w.url}`)).toEqual([
        "PATCH /repos/demo/app/pulls/7",
        "PATCH /repos/demo/app/pulls/8",
      ]);
      expect(JSON.parse(none.writes[0].body)).toEqual({ state: "closed" });
    } finally {
      listed.close();
      none.close();
    }
  });

  it("reads the repo and pin from a storyboard, and --dry-run prints every write and sends none", async () => {
    const fake = await fakeServer({ instanceSession: "warm" });
    const dir = mkdtempSync(join(os.tmpdir(), "reset-sb-"));
    try {
      writeFileSync(join(dir, "storyboard.json"), JSON.stringify({ repo: { url: "https://github.com/demo/app", commit: PIN } }));
      const r = await runReset(["--scenario", dir, "--instance", fake.url, "--dry-run"], { GITHUB_API_URL: fake.url });
      expect(r.status, r.stderr).toBe(0);
      expect(fake.writes).toEqual([]);
      expect(r.stdout.trim().split("\n")).toEqual([
        `would: POST ${fake.url}/api/sessions/warm-1/pr/7/close {"repo":"demo/app"}`,
        `would: POST ${fake.url}/api/sessions/warm-1/pr/8/close {"repo":"demo/app"}`,
        `would: DELETE ${fake.url}/repos/demo/app/git/refs/heads/shipit/a`,
        `would: DELETE ${fake.url}/repos/demo/app/git/refs/heads/shipit/b`,
        `would: PATCH ${fake.url}/repos/demo/app/git/refs/heads/main {"sha":"${PIN}","force":true}`,
      ]);
      expect(r.stderr).toContain("done (dry run)");
    } finally {
      fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses without GITHUB_TOKEN before the first PR close, so a missing token never half-resets the repo", async () => {
    const fake = await fakeServer({ instanceSession: "warm" });
    try {
      // The instance could close the PRs on its own, but branches and main need the token: nothing may start.
      const r = await runReset(["--repo", "demo/app", "--pin", PIN, "--instance", fake.url], { GITHUB_API_URL: fake.url });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("need GITHUB_TOKEN in the environment; nothing was changed");
      expect(fake.writes).toEqual([]);
    } finally {
      fake.close();
    }
  });

  it("refuses a repo whose pinned commit carries no demo-proxy redirect — a real repo with a valid commit", async () => {
    const fake = await fakeServer({ instanceSession: "warm", noRedirect: true });
    try {
      const r = await runReset(["--repo", "demo/app", "--pin", PIN, "--instance", fake.url], { GITHUB_API_URL: fake.url, GITHUB_TOKEN: "t" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("not a demo repo");
      expect(fake.writes).toEqual([]);
    } finally {
      fake.close();
    }
  });

  it("refuses a repo whose branch page is full rather than reset one page of it", async () => {
    const fake = await fakeServer({ instanceSession: "warm", manyBranches: true });
    try {
      const r = await runReset(["--repo", "demo/app", "--pin", PIN, "--instance", fake.url], { GITHUB_API_URL: fake.url, GITHUB_TOKEN: "t" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("100+ branches");
      expect(fake.writes).toEqual([]);
    } finally {
      fake.close();
    }
  });

  it("rejects a short pin and a repo that is not OWNER/NAME", async () => {
    expect((await runReset(["--repo", "demo/app", "--pin", "abc"], {})).stderr).toContain("pin must be a full 40-hex SHA");
    expect((await runReset(["--repo", "just-a-name", "--pin", PIN], {})).stderr).toContain("repo must be OWNER/NAME");
  });
});

describe("host/reset-demo-instance.sh", () => {
  let home: string;
  let proxyCompose: string;

  beforeAll(() => {
    home = mkdtempSync(join(os.tmpdir(), "reset-inst-"));
    mkdirSync(join(home, "deployment", "local"), { recursive: true });
    mkdirSync(join(home, "docker", "local", "prod"), { recursive: true });
    cpSync(join(HERE, "..", "..", "deployment", "local", "lib.sh"), join(home, "deployment", "local", "lib.sh"));
    writeFileSync(join(home, "deployment", "local", "stop.sh"), "#!/usr/bin/env bash\necho stop-ran\n");
    chmodSync(join(home, "deployment", "local", "stop.sh"), 0o755);
    writeFileSync(join(home, "docker", "local", "prod", "compose.yml"), "name: shipit-prod\nservices: {}\n");
    // The operator's marker: what tells the demo host apart from a standard install.
    writeFileSync(join(home, ".shipit-demo-instance"), `${os.hostname()}\n`);
    proxyCompose = join(home, "demo-proxy.compose.yml");
    writeFileSync(proxyCompose, "name: shipit-demo\n");
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("is bash -n clean", () => {
    expect(spawnSync("bash", ["-n", RESET_INSTANCE]).status).toBe(0);
  });

  it("--dry-run prints the sequence in order and runs nothing", () => {
    const r = spawnSync("bash", [RESET_INSTANCE, "--dry-run", "--shipit-home", home, "--proxy-compose", proxyCompose], { encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n")).toEqual([
      `+ sudo docker compose -f ${proxyCompose} down`,
      `+ ${home}/deployment/local/stop.sh`,
      "+ docker volume rm shipit-prod_workspace   (if present)",
      `+ env SHIPIT_HOME=${home} bash -c . "$SHIPIT_HOME/deployment/local/lib.sh" && shipit_build_and_up`,
      `+ sudo docker compose -f ${proxyCompose} up -d`,
    ]);
    expect(r.stdout).not.toContain("stop-ran");
    expect(r.stdout).not.toContain("credentials");
  });

  it("refuses a standard local install — project shipit-prod, the default, but no demo marker", () => {
    const other = mkdtempSync(join(os.tmpdir(), "reset-other-"));
    try {
      cpSync(home, other, { recursive: true });
      rmSync(join(other, ".shipit-demo-instance"));
      const r = spawnSync("bash", [RESET_INSTANCE, "--dry-run", "--shipit-home", other, "--proxy-compose", proxyCompose], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("no demo marker");
      expect(r.stdout).toBe("");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses when the marker names another host", () => {
    const other = mkdtempSync(join(os.tmpdir(), "reset-other-"));
    try {
      cpSync(home, other, { recursive: true });
      writeFileSync(join(other, ".shipit-demo-instance"), "some-other-box\n");
      const r = spawnSync("bash", [RESET_INSTANCE, "--dry-run", "--shipit-home", other, "--proxy-compose", proxyCompose], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("names 'some-other-box'");
      expect(r.stdout).toBe("");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("refuses any install whose Compose project is not shipit-prod, marker or not", () => {
    const other = mkdtempSync(join(os.tmpdir(), "reset-other-"));
    try {
      cpSync(home, other, { recursive: true });
      writeFileSync(join(other, "docker", "local", "prod", "compose.yml"), "name: shipit-stable\nservices: {}\n");
      const r = spawnSync("bash", [RESET_INSTANCE, "--dry-run", "--shipit-home", other, "--proxy-compose", proxyCompose], { encoding: "utf8" });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("refusing");
      expect(r.stdout).toBe("");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
