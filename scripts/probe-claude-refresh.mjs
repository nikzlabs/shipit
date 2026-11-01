// Checks the Claude CLI behaviors that the OAuth refresher depends on (docs/153, "Known limits").
// The refresher runs one command, a model call (REFRESH_PROBE_COMMAND); every run here uses it.
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
  REFRESH_PROBE_COMMAND,
  withDebugCapture,
} from "../src/server/orchestrator/agents/claude/oauth-refresher.ts";

const bin = process.env.CLAUDE_BIN ?? "claude";
const RUN_TIMEOUT_MS = 60_000;
// Longer than a real token host takes. A CLI that does not wait for the answer fails the check.
const SLOW_ANSWER_MS = 1_500;
const TOKEN_LIFETIME_S = 8 * 60 * 60;
const HOURS_LEFT_MS = 8 * 60 * 60 * 1000;
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

// A minimal streamed answer to the model call, so that a run can end without an error.
function answerMessages(res) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: "msg_probe", type: "message", role: "assistant", model: "claude-haiku-4-5-20251001", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
  send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  send("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } });
  send("content_block_stop", { index: 0 });
  send("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  send("message_stop", {});
  res.end();
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
  // tokenDelayMs holds a 200 back, as a real token host does. Every other request gets a 404.
  // With answerModel, the model call gets an answer. With rejectOriginal, it gets a 401 for the
  // original token and an answer for the new one.
  const recorder = {
    requests: [], tokenAnswer: "ok", tokenDelayMs: 0, port: 0, close: () => {},
    home: "", answerModel: false, rejectOriginal: false, on401: null, onTokenRequest: null,
  };

  const inner = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const isTokenRequest = (req.url ?? "").startsWith("/v1/oauth/token");
      // Not /v1/messages/count_tokens: only the model call is the request that a 401 ends.
      const isModelCall = (req.url ?? "").split("?")[0] === "/v1/messages" && req.method === "POST";
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* not JSON */ }
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      recorder.requests.push({
        host: req.headers.host, method: req.method, url: req.url, isTokenRequest, isModelCall, body: parsed,
        bearer: bearer === ORIGINAL.accessToken ? "original" : bearer === ROTATED.accessToken ? "rotated" : "other",
        copyRotated: recorder.home ? isRotated(recorder.home) : false,
      });
      res.setHeader("content-type", "application/json");
      if (isModelCall && (recorder.rejectOriginal || recorder.answerModel)) {
        if (recorder.answerModel || bearer !== ORIGINAL.accessToken) {
          answerMessages(res);
          return;
        }
        recorder.on401?.();
        res.writeHead(401);
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid authentication credentials" } }));
        return;
      }
      if (isTokenRequest) recorder.onTokenRequest?.();
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
      const answer = () => {
        if (res.destroyed) return;
        res.writeHead(200);
        res.end(JSON.stringify({
          token_type: "Bearer",
          access_token: ROTATED.accessToken,
          refresh_token: ROTATED.refreshToken,
          expires_in: TOKEN_LIFETIME_S,
          scope: typeof parsed.scope === "string" ? parsed.scope : "user:inference user:profile",
        }));
      };
      if (recorder.tokenDelayMs > 0) setTimeout(answer, recorder.tokenDelayMs).unref();
      else answer();
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

// As ShipIt's repush writes a session's file: by rename.
function pushCredentials(home, tokens, msLeft) {
  const file = path.join(home, ".claude", ".credentials.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(
    `${file}.tmp`,
    JSON.stringify({ ...current, claudeAiOauth: { ...current.claudeAiOauth, ...tokens, expiresAt: Date.now() + msLeft } }),
    { mode: 0o600 },
  );
  fs.renameSync(`${file}.tmp`, file);
}

// Returns what the refresher sees: the exit, the output, and the token requests the CLI made.
// `session(home)` returns the hooks of a run that stands for a session's CLI (see (f)).
function run(recorder, name, msLeft, tokenAnswer = "ok", { tokenDelayMs = 0, answerModel = false, session = null } = {}) {
  const home = makeHome(name, msLeft);
  const debugFile = path.join(home, "probe.debug.log");
  recorder.requests = [];
  recorder.tokenAnswer = tokenAnswer;
  recorder.tokenDelayMs = tokenDelayMs;
  recorder.answerModel = answerModel;
  recorder.home = home;
  Object.assign(recorder, { rejectOriginal: false, on401: null, onTokenRequest: null }, session ? session(home) : {});
  const proxyUrl = `http://127.0.0.1:${recorder.port}`;
  return new Promise((resolve) => {
    // Nothing of this process's environment, so that no real credential or config directory leaks in.
    const child = spawn(bin, withDebugCapture(REFRESH_PROBE_COMMAND, debugFile), {
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
        modelCalls: recorder.requests.filter((request) => request.isModelCall),
      });
    };
    child.on("exit", (code) => finish(code));
    child.on("error", (err) => { stderr += String(err); finish(null); });
  });
}

const minutes = (ms) => `${(ms / 60_000).toFixed(1)} min`;
function isRotated(home) {
  try {
    const oauth = readCredentials(home).claudeAiOauth;
    return oauth.accessToken === ROTATED.accessToken && oauth.refreshToken === ROTATED.refreshToken;
  } catch {
    return false;
  }
}

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
  const outside = CLI_REFRESH_WINDOW_MS + 30_000;
  const inside = CLI_REFRESH_WINDOW_MS - 30_000;

  try {
    // (a) The refresher's command line is accepted.
    const healthy = await run(recorder, "a-healthy", 45 * 60_000, "ok", { answerModel: true });
    check(
      healthy.exitCode === 0 && healthy.modelCalls.length > 0 && healthy.debug.length > 0,
      "(a) the command runs with the debug flags, makes its model call and writes the debug file",
      `exit=${healthy.exitCode} model calls=${healthy.modelCalls.length} stderr=${healthy.stderr.trim().slice(0, 120)}`,
    );

    // (b) A refresh is requested only when the file says the window's length or less is left.
    // A forced probe keeps the real expiry: it must not spend the grant of a healthy token.
    check(healthy.tokenRequests.length === 0, "(b) no token request with 45.0 min left");
    const justOutside = await run(recorder, "b-outside", outside);
    check(
      justOutside.tokenRequests.length === 0,
      `(b) no token request with ${minutes(outside)} left`,
      "the CLI's refresh window is wider than CLI_REFRESH_WINDOW_MS",
    );
    const justInside = await run(recorder, "b-inside", inside);
    const grant = justInside.tokenRequests[0]?.body ?? {};
    check(
      justInside.tokenRequests.length > 0 && grant.grant_type === "refresh_token" && grant.refresh_token === ORIGINAL.refreshToken,
      `(b) an ordinary refresh_token grant with ${minutes(inside)} left`,
      `token requests=${justInside.tokenRequests.length} grant_type=${grant.grant_type}`,
    );
    check(!("expires_in" in grant), "(b) the grant asks for no lifetime of its own", `expires_in=${grant.expires_in}`);

    // (c) The copy's claimed life makes the CLI refresh, and the result lands in the file it read.
    const claimed = await run(recorder, "c-claimed", PROBE_REMAINING_MS);
    const after = readCredentials(claimed.home);
    const lifetimeMs = after.claudeAiOauth.expiresAt - Date.now();
    check(
      isRotated(claimed.home) && Math.abs(lifetimeMs - TOKEN_LIFETIME_S * 1000) < 2 * 60_000,
      `(c) with ${minutes(PROBE_REMAINING_MS)} claimed, the new tokens and expiry are written to the copy`,
      `token requests=${claimed.tokenRequests.length} rotated=${isRotated(claimed.home)} lifetime=${minutes(lifetimeMs)}`,
    );
    check(after.mcpOAuth?.["probe-server"]?.marker === "kept", "(c) the file's other keys are kept");
    // The refresher installs the rotation while the CLI runs, before the CLI's model call ends.
    check(
      claimed.modelCalls.length > 0 && claimed.modelCalls.every((call) => call.copyRotated && call.bearer === "rotated"),
      "(c) the rotation is in the copy before the CLI makes its model call",
      `model calls=${claimed.modelCalls.map((call) => `${call.bearer}/copyRotated=${call.copyRotated}`).join(",")}`,
    );

    // (e) A real token host does not answer at once. The CLI must wait for the answer: a grant
    // that was sent and not written is spent, and its successor is lost.
    const slow = await run(recorder, "e-slow", PROBE_REMAINING_MS, "ok", { tokenDelayMs: SLOW_ANSWER_MS });
    check(
      slow.tokenRequests.length === 1 && isRotated(slow.home),
      `(e) the CLI waits for a token host that answers after ${SLOW_ANSWER_MS} ms, and sends the grant once`,
      `token requests=${slow.tokenRequests.length} rotated=${isRotated(slow.home)}`,
    );

    // (d) invalid_grant blanks the file the CLI ran against; a failure that can pass does not.
    for (const [answer, status] of [["rate_limited", 429], ["server_error", 500]]) {
      const transient = await run(recorder, `d-${answer}`, PROBE_REMAINING_MS, answer);
      const kept = readCredentials(transient.home).claudeAiOauth;
      check(
        transient.tokenRequests.length > 0 && kept.accessToken === ORIGINAL.accessToken && kept.refreshToken === ORIGINAL.refreshToken,
        `(d) an HTTP ${status} from the token host leaves the credentials file as it was`,
        `token requests=${transient.tokenRequests.length} accessToken=${kept.accessToken ? "kept" : "empty"}`,
      );
    }
    const rejected = await run(recorder, "d-rejected", PROBE_REMAINING_MS, "invalid_grant");
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

    // (f) A session's CLI whose token stops working takes the one that ShipIt pushes to its file. The
    // early install depends on it: the push must reach the session before the CLI gives up.
    const retriedWith = (result, bearer) =>
      result.modelCalls[0]?.bearer === "original" && result.modelCalls.slice(1).some((call) => call.bearer === bearer);
    const pushedBefore = await run(recorder, "f-pushed", HOURS_LEFT_MS, "invalid_grant", {
      session: (home) => ({ rejectOriginal: true, on401: () => pushCredentials(home, ROTATED, HOURS_LEFT_MS) }),
    });
    check(
      pushedBefore.exitCode === 0 && pushedBefore.tokenRequests.length === 0 && retriedWith(pushedBefore, "rotated"),
      "(f) after a 401, the CLI repeats the model call with a token that reached its file, and requests no refresh",
      `exit=${pushedBefore.exitCode} token requests=${pushedBefore.tokenRequests.length}`
        + ` model calls=${pushedBefore.modelCalls.map((call) => call.bearer).join(",")}`,
    );
    const pushedDuring = await run(recorder, "f-during-refresh", HOURS_LEFT_MS, "invalid_grant", {
      session: (home) => ({ rejectOriginal: true, onTokenRequest: () => pushCredentials(home, ROTATED, HOURS_LEFT_MS) }),
    });
    check(
      pushedDuring.exitCode === 0 && pushedDuring.tokenRequests.length === 1 && isRotated(pushedDuring.home)
        && retriedWith(pushedDuring, "rotated"),
      "(f) after its refresh is rejected, the CLI takes a token that reached its file meanwhile, and does not blank it",
      `exit=${pushedDuring.exitCode} rotated=${isRotated(pushedDuring.home)}`
        + ` model calls=${pushedDuring.modelCalls.map((call) => call.bearer).join(",")}`,
    );
    // How long after a 401 a pushed token is still taken without a refresh (docs/153: about 0.5 s).
    for (const lagMs of [300, 1_000]) {
      let push = null;
      const lagged = await run(recorder, `f-lag-${lagMs}`, HOURS_LEFT_MS, "invalid_grant", {
        session: (home) => ({
          rejectOriginal: true,
          on401: () => { push ??= setTimeout(() => pushCredentials(home, ROTATED, HOURS_LEFT_MS), lagMs); },
        }),
      });
      clearTimeout(push);
      console.log(
        `info  a token pushed ${lagMs} ms after the 401 was ${lagged.tokenRequests.length === 0 ? "taken" : "too late"}`
          + ` (token requests=${lagged.tokenRequests.length} exit=${lagged.exitCode})`,
      );
    }

    // (g) A forced probe of a token with hours left: when the API rejects that token and no newer one
    // reaches the copy, the CLI spends the grant, and the refresher gets the rotation from the copy.
    const forced = await run(recorder, "g-forced", HOURS_LEFT_MS, "ok", { session: () => ({ rejectOriginal: true }) });
    check(
      forced.exitCode === 0 && forced.tokenRequests.length === 1 && isRotated(forced.home) && retriedWith(forced, "rotated"),
      "(g) after a 401 with no newer token in its file, the CLI refreshes once and writes the rotation",
      `exit=${forced.exitCode} token requests=${forced.tokenRequests.length} rotated=${isRotated(forced.home)}`
        + ` model calls=${forced.modelCalls.map((call) => call.bearer).join(",")}`,
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
