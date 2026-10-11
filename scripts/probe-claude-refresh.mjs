// Checks the Claude CLI behaviors that the OAuth refresher depends on (docs/153, "Known limits").
// Run: node --import tsx scripts/probe-claude-refresh.mjs   [CLAUDE_BIN=/path/to/claude]
// All credentials are synthetic, and the local proxy never forwards a request. Each run gets
// its own HOME and working directory under a temp directory, and none of this process's
// environment. The proxy is the only route the CLI is given; nothing here can stop a CLI
// that ignores it, and such a CLI would send the synthetic tokens.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { spawn, execFileSync } from "node:child_process";
import { killProcessTree } from "../src/server/shared/kill-child.ts";
import {
  CLI_REFRESH_WINDOW_MS,
  PROBE_REMAINING_MS,
  REFRESH_PROBE_COMMANDS,
  withDebugCapture,
} from "../src/server/orchestrator/agents/claude/oauth-refresher.ts";

const bin = process.env.CLAUDE_BIN ?? "claude";
const RUN_TIMEOUT_MS = 60_000;
const TOKEN_LIFETIME_S = 8 * 60 * 60;
const HOSTS = ["platform.claude.com", "console.anthropic.com", "api.anthropic.com", "claude.ai"];

// Assembled, so that a secret scanner does not read them as real tokens.
const token = (kind, mark) => ["sk", "ant", kind, mark.repeat(8)].join("-");
const ORIGINAL = { accessToken: token("oat01", "ORIGINAL"), refreshToken: token("ort01", "ORIGINAL") };
const ROTATED = { accessToken: token("oat01", "ROTATED0"), refreshToken: token("ort01", "ROTATED0") };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-refresh-probe-"));
let failed = 0;
let checks = 0;

function check(ok, label, detail = "") {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

function startRecorder() {
  execFileSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-keyout", path.join(root, "key.pem"),
      "-out", path.join(root, "cert.pem"),
      "-subj", `/CN=${HOSTS[0]}`,
      "-addext", `subjectAltName=${HOSTS.map((host) => `DNS:${host}`).join(",")}`,
    ],
    { stdio: "ignore" },
  );
  const secureContext = tls.createSecureContext({
    key: fs.readFileSync(path.join(root, "key.pem")),
    cert: fs.readFileSync(path.join(root, "cert.pem")),
  });
  const recorder = { requests: [], tokenAnswer: "ok", port: 0, close: () => {} };

  const inner = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const isTokenRequest = (req.url ?? "").startsWith("/v1/oauth/token");
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      recorder.requests.push({ host: req.headers.host, method: req.method, url: req.url, isTokenRequest, body: parsed });
      res.setHeader("content-type", "application/json");
      if (!isTokenRequest) {
        res.writeHead(404);
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "probe" } }));
        return;
      }
      if (recorder.tokenAnswer === "invalid_grant") {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }));
        return;
      }
      if (recorder.tokenAnswer === "rate_limited" || recorder.tokenAnswer === "server_error") {
        res.writeHead(recorder.tokenAnswer === "rate_limited" ? 429 : 500);
        res.end(JSON.stringify({ error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        token_type: "Bearer",
        access_token: ROTATED.accessToken,
        refresh_token: ROTATED.refreshToken,
        expires_in: TOKEN_LIFETIME_S,
        scope: typeof parsed.scope === "string" ? parsed.scope : "user:inference user:profile",
      }));
    });
  });

  const proxy = http.createServer((_req, res) => { res.writeHead(503); res.end(); });
  proxy.on("connect", (_req, socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const secure = new tls.TLSSocket(socket, { isServer: true, secureContext });
    secure.on("error", () => {});
    socket.on("error", () => {});
    inner.emit("connection", secure);
  });
  return new Promise((resolve) => {
    proxy.listen(0, "127.0.0.1", () => {
      recorder.port = proxy.address().port;
      recorder.close = () => { proxy.closeAllConnections(); proxy.close(); };
      resolve(recorder);
    });
  });
}

function makeHome(name, msLeft) {
  const home = path.join(root, name);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        ...ORIGINAL,
        expiresAt: Date.now() + msLeft,
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code", "user:mcp_servers"],
        subscriptionType: "max",
      },
      mcpOAuth: { "probe-server": { marker: "kept" } },
    }),
    { mode: 0o600 },
  );
  return home;
}

function readCredentials(home) {
  return JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"));
}

// Returns what the refresher sees: the exit, the output, and the token requests the CLI made.
function run(recorder, name, command, msLeft, tokenAnswer = "ok") {
  const home = makeHome(name, msLeft);
  const debugFile = path.join(home, "probe.debug.log");
  recorder.requests = [];
  recorder.tokenAnswer = tokenAnswer;
  const proxyUrl = `http://127.0.0.1:${recorder.port}`;
  return new Promise((resolve) => {
    // Nothing of this process's environment, so that no real credential or config directory leaks in.
    const child = spawn(bin, withDebugCapture(command, debugFile), {
      // Not the caller's directory: the CLI reads project settings from where it runs.
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        NODE_EXTRA_CA_CERTS: path.join(root, "cert.pem"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => killProcessTree(child, "SIGKILL", { label: "claude-refresh-probe" }), RUN_TIMEOUT_MS);
    const finish = (exitCode) => {
      clearTimeout(timer);
      let debug = "";
      try { debug = fs.readFileSync(debugFile, "utf8"); } catch { /* none written */ }
      resolve({
        home,
        exitCode,
        stdout,
        stderr,
        debug,
        tokenRequests: recorder.requests.filter((request) => request.isTokenRequest),
      });
    };
    child.on("exit", (code) => finish(code));
    child.on("error", (err) => { stderr += String(err); finish(null); });
  });
}

const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;
const isRotated = (home) => {
  const oauth = readCredentials(home).claudeAiOauth;
  return oauth.accessToken === ROTATED.accessToken && oauth.refreshToken === ROTATED.refreshToken;
};

async function main() {
  let version = "unknown";
  try {
    version = execFileSync(bin, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: root } }).trim();
  } catch (err) {
    console.error(`cannot run ${bin}: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  console.log(`claude CLI: ${version} (${bin})`);
  const recorder = await startRecorder();
  const { tier1, tier2 } = REFRESH_PROBE_COMMANDS;
  const outside = CLI_REFRESH_WINDOW_MS + 30_000;
  const inside = CLI_REFRESH_WINDOW_MS - 30_000;

  try {
    // (a) The refresher's tier 1 command line is accepted.
    const healthy = await run(recorder, "a-healthy", tier1, 45 * 60_000);
    let status = null;
    try { status = JSON.parse(healthy.stdout); } catch { /* not JSON */ }
    check(
      healthy.exitCode === 0 && status?.loggedIn === true && healthy.debug.length > 0,
      "(a) tier 1 runs with the debug flags and writes the debug file",
      `exit=${healthy.exitCode} stderr=${healthy.stderr.trim().slice(0, 120)}`,
    );

    // (b) A refresh is requested only when the file says the window's length or less is left.
    check(healthy.tokenRequests.length === 0, "(b) tier 1: no token request with 45.0 min left");
    const justOutside = await run(recorder, "b-outside", tier1, outside);
    check(
      justOutside.tokenRequests.length === 0,
      `(b) tier 1: no token request with ${minutes(outside)} left`,
      "the CLI's refresh window is wider than CLI_REFRESH_WINDOW_MS",
    );
    const justInside = await run(recorder, "b-inside", tier1, inside);
    const grant = justInside.tokenRequests[0]?.body ?? {};
    check(
      justInside.tokenRequests.length > 0 && grant.grant_type === "refresh_token" && grant.refresh_token === ORIGINAL.refreshToken,
      `(b) tier 1: an ordinary refresh_token grant with ${minutes(inside)} left`,
      `token requests=${justInside.tokenRequests.length} grant_type=${grant.grant_type}`,
    );
    check(!("expires_in" in grant), "(b) the grant asks for no lifetime of its own", `expires_in=${grant.expires_in}`);
    const tier2Outside = await run(recorder, "b-tier2-outside", tier2, 10 * 60_000);
    check(tier2Outside.tokenRequests.length === 0, "(b) tier 2: no token request with 10.0 min left");

    // (c) The copy's claimed life makes each tier refresh, and the result lands in the file it read.
    for (const [label, command] of [["tier 1", tier1], ["tier 2", tier2]]) {
      const claimed = await run(recorder, `c-${label.replace(" ", "")}`, command, PROBE_REMAINING_MS);
      const after = readCredentials(claimed.home);
      const lifetimeMs = after.claudeAiOauth.expiresAt - Date.now();
      check(
        isRotated(claimed.home) && Math.abs(lifetimeMs - TOKEN_LIFETIME_S * 1000) < 2 * 60_000,
        `(c) ${label}: with ${minutes(PROBE_REMAINING_MS)} claimed, the new tokens and expiry are written to the copy`,
        `token requests=${claimed.tokenRequests.length} rotated=${isRotated(claimed.home)} lifetime=${minutes(lifetimeMs)}`,
      );
      check(after.mcpOAuth?.["probe-server"]?.marker === "kept", `(c) ${label}: the file's other keys are kept`);
    }

    // (d) invalid_grant blanks the file the CLI ran against; a failure that can pass does not.
    for (const [answer, status] of [["rate_limited", 429], ["server_error", 500]]) {
      const transient = await run(recorder, `d-${answer}`, tier1, PROBE_REMAINING_MS, answer);
      const kept = readCredentials(transient.home).claudeAiOauth;
      check(
        transient.tokenRequests.length > 0 && kept.accessToken === ORIGINAL.accessToken && kept.refreshToken === ORIGINAL.refreshToken,
        `(d) an HTTP ${status} from the token host leaves the credentials file as it was`,
        `token requests=${transient.tokenRequests.length} accessToken=${kept.accessToken ? "kept" : "empty"}`,
      );
    }
    const rejected = await run(recorder, "d-rejected", tier1, PROBE_REMAINING_MS, "invalid_grant");
    const blanked = readCredentials(rejected.home).claudeAiOauth;
    check(
      rejected.tokenRequests.length > 0 && blanked.accessToken === "" && blanked.refreshToken === "",
      "(d) invalid_grant blanks the credentials file",
      `token requests=${rejected.tokenRequests.length} accessToken=${blanked.accessToken ? "kept" : "empty"}`,
    );
    console.log(
      `info  the debug capture ${/invalid_grant/i.test(rejected.debug) ? "names" : "does not name"} invalid_grant`
        + " (the refresher accepts both)",
    );
  } finally {
    recorder.close();
  }
  console.log(`${checks} checks, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
