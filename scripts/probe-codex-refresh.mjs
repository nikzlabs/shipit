// Checks the Codex CLI behaviors that the OAuth refresher depends on (docs/154).
// Run: node --import tsx scripts/probe-codex-refresh.mjs   [CODEX_BIN=/path/to/codex]
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
import { CodexOAuthRefresher } from "../src/server/orchestrator/agents/codex/oauth-refresher.ts";

const bin = process.env.CODEX_BIN ?? "codex";
const RUN_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
// A session's own CLI refreshes only this close to expiry; the refresher's 45-minute lead must stay longer.
const SESSION_CLI_REFRESH_WINDOW_MS = 5 * 60_000;
const ACCOUNT_ID = "00000000-0000-4000-8000-000000000000";
const HOSTS = ["auth.openai.com", "chatgpt.com", "api.openai.com", "*.openai.com", "*.chatgpt.com"];
const SESSION_TURN = ["exec", "--skip-git-repo-check", "ok"];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-refresh-probe-"));
let failed = 0;
let checks = 0;

function check(ok, label, detail = "") {
  checks++;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

// Unsigned, so that no scanner and no server can take them for real tokens. The CLI reads `exp` only.
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (mark, expiresAt) => [
  b64({ alg: "RS256", typ: "JWT" }),
  b64({
    exp: Math.floor(expiresAt / 1000),
    mark,
    email: "probe@example.invalid",
    "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_user_id: "user-probe", chatgpt_account_id: ACCOUNT_ID },
  }),
  Buffer.from(`probe-signature-${mark}`).toString("base64url"),
].join(".");
const refreshToken = (mark) => ["rt", "probe", mark].join("_");
const markOf = (token) => {
  if (typeof token !== "string") return "none";
  if (token.startsWith("rt_probe_")) return token.slice("rt_probe_".length);
  try {
    return JSON.parse(Buffer.from(token.replace(/^Bearer /, "").split(".")[1], "base64url").toString("utf8")).mark ?? "other";
  } catch {
    return "other";
  }
};

function startRecorder() {
  const openssl = (args) => execFileSync("openssl", args, { cwd: root, stdio: "ignore" });
  // A leaf that a separate CA signed: the CLI's TLS library refuses a CA certificate as a server's own.
  openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", "ca.key", "-out", "ca.pem",
    "-subj", "/CN=codex-refresh-probe-ca", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign"]);
  openssl(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", `/CN=${HOSTS[0]}`]);
  fs.writeFileSync(path.join(root, "leaf.ext"), [
    "basicConstraints=CA:FALSE",
    "keyUsage=digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    `subjectAltName=${HOSTS.map((host) => `DNS:${host}`).join(",")}`,
  ].join("\n"));
  openssl(["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "1", "-extfile", "leaf.ext"]);
  const secureContext = tls.createSecureContext({
    key: fs.readFileSync(path.join(root, "leaf.key")),
    cert: fs.readFileSync(path.join(root, "leaf.pem")),
  });
  const recorder = { requests: [], tokenAnswer: "ok", port: 0, close: () => {} };

  const answerToken = (res) => {
    const refuse = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (recorder.tokenAnswer === "ok") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id_token: jwt("ROTATED", Date.now() + 10 * DAY_MS),
        access_token: jwt("ROTATED", Date.now() + 10 * DAY_MS),
        refresh_token: refreshToken("ROTATED"),
      }));
    } else if (recorder.tokenAnswer === "rate_limited") {
      refuse(429, { error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } });
    } else if (recorder.tokenAnswer === "server_error") {
      refuse(500, { error: { message: "Internal error", type: "server_error" } });
    } else {
      refuse(401, { error: { message: "probe refusal", type: "invalid_request_error", param: null, code: recorder.tokenAnswer } });
    }
  };

  const inner = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const url = req.url ?? "";
      const kind = url.startsWith("/oauth/token") ? "token" : req.method === "POST" && /\/responses(\?|$)/.test(url) ? "model" : "other";
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      recorder.requests.push({ kind, host: req.headers.host, url, body: parsed, bearer: markOf(req.headers.authorization) });
      if (kind === "token") {
        answerToken(res);
      } else if (kind === "model") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id: "resp_probe" } },
          { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "msg_probe", content: [{ type: "output_text", text: "ok" }] } },
          { type: "response.completed", response: { id: "resp_probe", usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } },
        ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } else if (url.includes("/accounts/check")) {
        // A model call needs this answer first. The origin's trailing slash is necessary.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          accounts: [{ id: ACCOUNT_ID, name: "probe", plan_type: "pro", structure: "personal", workspace_backend_origin: "https://chatgpt.com/", account_routing_override: "us", profile_picture_url: null }],
          default_account_id: ACCOUNT_ID,
          account_ordering: [ACCOUNT_ID],
        }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "probe: not found", type: "not_found" } }));
      }
    });
  });
  // The model call tries a WebSocket first, and goes to HTTPS after this refusal.
  inner.on("upgrade", (req, socket) => {
    recorder.requests.push({ kind: "websocket", host: req.headers.host, url: req.url ?? "", body: {}, bearer: markOf(req.headers.authorization) });
    socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
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

const authFile = (home) => path.join(home, ".codex", "auth.json");
const readTokens = (home) => JSON.parse(fs.readFileSync(authFile(home), "utf8")).tokens;
const holds = (home, mark) => markOf(readTokens(home).access_token) === mark && markOf(readTokens(home).refresh_token) === mark;

function writeAuth(home, mark, msLeft) {
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const file = authFile(home);
  fs.writeFileSync(`${file}.next`, JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt(mark, Date.now() + msLeft),
      access_token: jwt(mark, Date.now() + msLeft),
      refresh_token: refreshToken(mark),
      account_id: ACCOUNT_ID,
    },
    last_refresh: new Date().toISOString(),
  }), { mode: 0o600 });
  fs.renameSync(`${file}.next`, file);
}

// Nothing of this process's environment, so that no real credential or config directory leaks in.
function cliEnv(recorder, home, codexHome) {
  const proxyUrl = `http://127.0.0.1:${recorder.port}`;
  const ca = path.join(root, "ca.pem");
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    CODEX_CA_CERTIFICATE: ca,
    SSL_CERT_FILE: ca,
  };
}

// The refresher's own tick, with the real binary: its messages, its reading of the CLI's log.
async function refresh(recorder, name, { msLeft, tokenAnswer = "ok", force = false, onLoaded = null }) {
  const accountRoot = path.join(root, name);
  writeAuth(accountRoot, "ORIGINAL", msLeft);
  recorder.requests = [];
  recorder.tokenAnswer = tokenAnswer;
  const refresher = new CodexOAuthRefresher({
    credentialsDir: path.join(root, `${name}-credentials`),
    providerAccountManager: { list: () => [{ id: name }], resolveCredentialRoot: () => accountRoot },
    repushAccountToken: () => {},
    sseBroadcast: () => {},
    runtimeMode: "containerized",
    lateRotationWaitMs: 0,
    spawn: (_command, args, options) => {
      // The refresher's own working directory and homes; the rest of the environment is the probe's.
      const child = spawn(bin, args, { ...options, env: cliEnv(recorder, options.env.HOME, options.env.CODEX_HOME) });
      // Registered before the refresher's listener, so it runs before the refresh request is sent.
      if (onLoaded) child.stdout.on("data", (chunk) => { if (String(chunk).includes('"id":0')) onLoaded(accountRoot); });
      return child;
    },
  });
  const log = console.log;
  console.log = () => {};
  let outcome;
  let healed = null;
  try {
    if (force) healed = await refresher.ensureFresh(name, { force: true });
    else [{ outcome }] = await refresher.refreshNow(name);
  } finally {
    console.log = log;
    refresher.stop();
  }
  return {
    home: accountRoot,
    outcome,
    healed,
    tokenRequests: recorder.requests.filter((request) => request.kind === "token"),
    modelCalls: recorder.requests.filter((request) => request.kind === "model" || request.kind === "websocket"),
  };
}

// A session's turn, as near as one command gets: the CLI makes a model call.
function sessionTurn(recorder, name, msLeft) {
  const home = path.join(root, name);
  writeAuth(home, "ORIGINAL", msLeft);
  fs.mkdirSync(path.join(home, "cwd"), { recursive: true });
  recorder.requests = [];
  recorder.tokenAnswer = "ok";
  return new Promise((resolve) => {
    const child = spawn(bin, SESSION_TURN, {
      cwd: path.join(home, "cwd"),
      env: cliEnv(recorder, home),
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => killProcessTree(child, "SIGKILL", { label: "codex-refresh-probe" }), RUN_TIMEOUT_MS);
    const finish = (exitCode) => {
      clearTimeout(timer);
      const order = recorder.requests.filter((request) => request.kind !== "other" && request.kind !== "websocket");
      resolve({ home, exitCode, order, tokenRequests: order.filter((request) => request.kind === "token") });
    };
    child.on("exit", (code) => finish(code));
    child.on("error", () => finish(null));
  });
}

const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;

async function main() {
  let version = "unknown";
  try {
    version = execFileSync(bin, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: root }, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (err) {
    console.error(`cannot run ${bin}: ${err.message}`);
    process.exitCode = 2;
    return;
  }
  console.log(`codex CLI: ${version} (${bin})`);
  const recorder = await startRecorder();

  try {
    // (a) The refresher's call refreshes a token at the start of the 45-minute margin, with one request.
    const early = await refresh(recorder, "a-margin", { msLeft: 45 * 60_000 });
    const grant = early.tokenRequests[0] ?? { body: {} };
    check(early.outcome === "rotated" && holds(early.home, "ROTATED"),
      "(a) the on-demand refresh rotates a token that has 45.0 min left, and the CLI writes it to the account's file",
      `outcome=${early.outcome}`);
    check(
      early.tokenRequests.length === 1 && grant.host === "auth.openai.com" && grant.body.grant_type === "refresh_token"
        && grant.body.refresh_token === refreshToken("ORIGINAL"),
      "(a) it sends one ordinary refresh_token grant",
      `token requests=${early.tokenRequests.length} grant_type=${grant.body.grant_type}`,
    );
    check(early.modelCalls.length === 0, "(a) it makes no model call", `model calls=${early.modelCalls.length}`);

    // (b) A forced heal refreshes a token that is not near expiry.
    const forced = await refresh(recorder, "b-forced", { msLeft: 9 * DAY_MS, force: true });
    check(forced.healed === true && holds(forced.home, "ROTATED") && forced.tokenRequests.length === 1,
      "(b) a forced refresh rotates a token that has 9 days left",
      `healed=${forced.healed} token requests=${forced.tokenRequests.length}`);

    // (c) A refused grant: the refresher reads the code, and the CLI leaves the file as it was.
    for (const code of ["refresh_token_reused", "refresh_token_invalidated", "refresh_token_expired"]) {
      const refused = await refresh(recorder, `c-${code}`, { msLeft: 45 * 60_000, tokenAnswer: code });
      check(refused.outcome === "revoked" && refused.tokenRequests.length === 1,
        `(c) ${code}: the refresher reports the rejected grant after one request`,
        `outcome=${refused.outcome} token requests=${refused.tokenRequests.length}`);
      check(holds(refused.home, "ORIGINAL"), `(c) ${code}: the CLI leaves the account's file as it was`);
    }

    // (d) A failure that can pass is not a rejected grant, and the CLI does not repeat the request.
    for (const [answer, status, expected] of [["rate_limited", 429, "rate_limited"], ["server_error", 500, "unknown_failure"]]) {
      const transient = await refresh(recorder, `d-${answer}`, { msLeft: 45 * 60_000, tokenAnswer: answer });
      check(transient.outcome === expected && transient.tokenRequests.length === 1 && holds(transient.home, "ORIGINAL"),
        `(d) an HTTP ${status} from the token host: ${expected}, one request, the file as it was`,
        `outcome=${transient.outcome} token requests=${transient.tokenRequests.length}`);
    }

    // (e) A rotation that lands in the file while the CLI runs is kept: the CLI reads the file again first.
    const published = await refresh(recorder, "e-published", {
      msLeft: 45 * 60_000,
      onLoaded: (home) => writeAuth(home, "PUBLISHED", 10 * DAY_MS),
    });
    check(published.tokenRequests.length === 0 && holds(published.home, "PUBLISHED") && published.outcome === "rotated",
      "(e) a credential published during the call is kept, and the CLI spends no grant",
      `outcome=${published.outcome} token requests=${published.tokenRequests.length} file=${markOf(readTokens(published.home).refresh_token)}`);

    // (f) A session's CLI refreshes by itself only inside its window, so the 45-minute lead comes first.
    const outside = await sessionTurn(recorder, "f-outside", SESSION_CLI_REFRESH_WINDOW_MS + 60_000);
    check(outside.exitCode === 0 && outside.order.some((request) => request.kind === "model"),
      "(f) the stand-in serves a session's model call", `exit=${outside.exitCode} requests=${outside.order.map((request) => request.kind).join(",")}`);
    check(outside.tokenRequests.length === 0,
      `(f) a session's CLI sends no token request with ${minutes(SESSION_CLI_REFRESH_WINDOW_MS + 60_000)} left`,
      "the CLI's refresh window is wider than the probe assumes; compare it with the refresher's SAFETY_MARGIN_MS");
    const inside = await sessionTurn(recorder, "f-inside", SESSION_CLI_REFRESH_WINDOW_MS - 60_000);
    check(inside.tokenRequests.length === 1 && inside.order[0]?.kind === "token" && holds(inside.home, "ROTATED"),
      `(f) a session's CLI refreshes before its model call with ${minutes(SESSION_CLI_REFRESH_WINDOW_MS - 60_000)} left`,
      `token requests=${inside.tokenRequests.length} first=${inside.order[0]?.kind}`);
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
