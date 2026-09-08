#!/usr/bin/env node
// Record/replay proxy at the Anthropic API boundary — docs/296 plan §2.
//
// The Claude CLI inside the demo session reaches this server through the demo
// repo's `.claude/settings.json` (ANTHROPIC_BASE_URL + a dummy key). Two modes:
//
//   --record <cassette-dir>   forward POST /v1/messages* to the upstream and
//                             save every response, byte for byte, per lane
//   --replay <cassette-dir>   answer lane request n with <lane>/NNN.sse,
//                             pacing text deltas so the transcript types at a
//                             human rate
//
// A lane is the auth header kind: `x-api-key` (the settings file's dummy key,
// swapped for DEMO_PROXY_ANTHROPIC_API_KEY on the way out) or `bearer`
// (anything else, forwarded untouched). Requests race across lanes, so "the
// nth request" is counted per lane.
//
// No dependencies: this runs on the demo host with nothing but node.
//
// Usage:
//   node proxy.mjs --record DIR [--upstream URL] [--port N] [--host H]
//   node proxy.mjs --replay DIR [--pace-chars-per-second N] [--port N] [--host H]
//
// Prints the bound port on stdout once listening; everything else goes to
// stderr, one line per request: mode, lane, n, path, status, ms.

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_UPSTREAM = "https://api.anthropic.com";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_CPS = 120;
/** Tool-input JSON deltas pace faster than prose: the user reads code, not types it. */
const TOOL_INPUT_SPEED_FACTOR = 4;
const FINGERPRINTS_FILE = "fingerprints.jsonl";
const LANE_API_KEY = "x-api-key";
const LANE_BEARER = "bearer";
/** Hop-by-hop and framing headers that must not be forwarded or replayed. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    mode: null,
    cassetteDir: null,
    upstream: DEFAULT_UPSTREAM,
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    charsPerSecond: DEFAULT_CPS,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--record":
        opts.mode = "record";
        opts.cassetteDir = path.resolve(next());
        break;
      case "--replay":
        opts.mode = "replay";
        opts.cassetteDir = path.resolve(next());
        break;
      case "--upstream":
        opts.upstream = next();
        break;
      case "--port":
        opts.port = Number(next());
        break;
      case "--host":
        opts.host = next();
        break;
      case "--pace-chars-per-second":
        opts.charsPerSecond = Number(next());
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.mode) throw new Error("one of --record <dir> or --replay <dir> is required");
  if (!Number.isFinite(opts.port) || opts.port < 0) throw new Error("--port must be a non-negative number");
  if (!Number.isFinite(opts.charsPerSecond) || opts.charsPerSecond <= 0) {
    throw new Error("--pace-chars-per-second must be a positive number");
  }
  return opts;
}

// ── Shared helpers ───────────────────────────────────────────────────────────

const pad3 = (n) => String(n).padStart(3, "0");

function log(line) {
  process.stderr.write(`[demo-proxy] ${line}\n`);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** The lane is the auth header kind — a fact of the request, not configuration. */
export function laneOf(headers) {
  return headers["x-api-key"] ? LANE_API_KEY : LANE_BEARER;
}

/** The fields the probe's fake-api.mjs already logged; enough to spot a drifted take. */
export function fingerprintOf(raw) {
  let body = {};
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  } catch {
    body = {};
  }
  return {
    model: typeof body.model === "string" ? body.model : null,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    bodyBytes: raw.length,
    stream: body.stream === true,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function isMessagesRequest(req) {
  return req.method === "POST" && req.url.split("?")[0].startsWith("/v1/messages");
}

// ── Cassette file format ─────────────────────────────────────────────────────
//
// One file per response, shaped like a captured HTTP message so it can be read
// with `less` and diffed: a status line, the response headers, a blank line,
// then the body bytes verbatim (the SSE stream as the upstream sent it).

export function serializeResponse(status, headers, body) {
  const lines = [`HTTP/1.1 ${status}`];
  for (const [name, value] of Object.entries(headers)) {
    if (DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
  }
  return Buffer.concat([Buffer.from(lines.join("\r\n") + "\r\n\r\n", "utf8"), body]);
}

export function parseResponseFile(buf) {
  const sep = buf.indexOf("\r\n\r\n");
  if (sep < 0) throw new Error("cassette file has no header/body separator");
  const head = buf.subarray(0, sep).toString("utf8").split("\r\n");
  const status = Number(head[0].split(" ")[1]);
  /** @type {Record<string, string | string[]>} */
  const headers = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (DROPPED_RESPONSE_HEADERS.has(name)) continue;
    headers[name] = name in headers ? [].concat(headers[name], value) : value;
  }
  return { status, headers, body: buf.subarray(sep + 4) };
}

// ── SSE pacing ───────────────────────────────────────────────────────────────

/**
 * Split an SSE byte stream into event frames, each including its delimiter, so
 * writing the frames in order reproduces the bytes exactly. A trailing partial
 * frame (no delimiter) comes back as the last element.
 */
export function splitSseFrames(body) {
  const frames = [];
  let from = 0;
  while (from < body.length) {
    const lf = body.indexOf("\n\n", from);
    const crlf = body.indexOf("\r\n\r\n", from);
    let end;
    if (lf < 0 && crlf < 0) {
      end = body.length;
    } else if (lf < 0 || (crlf >= 0 && crlf < lf)) {
      end = crlf + 4;
    } else {
      end = lf + 2;
    }
    frames.push(body.subarray(from, end));
    from = end;
  }
  return frames;
}

/** Milliseconds this frame should take to "type": text deltas at cps, tool JSON at 4x, else 0. */
export function frameDelayMs(frame, charsPerSecond) {
  const dataLines = frame
    .toString("utf8")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  if (dataLines.length === 0) return 0;
  let event;
  try {
    event = JSON.parse(dataLines.join("\n"));
  } catch {
    return 0;
  }
  if (event?.type !== "content_block_delta") return 0;
  const delta = event.delta ?? {};
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    return (delta.text.length / charsPerSecond) * 1000;
  }
  if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
    return (delta.partial_json.length / (charsPerSecond * TOOL_INPUT_SPEED_FACTOR)) * 1000;
  }
  return 0;
}

/**
 * Stream `body` to `res` frame by frame with pacing. Stops — and clears its
 * pending timer — as soon as the client goes away. Resolves with how far it
 * got, so the request's log line can say the take was abandoned.
 */
function streamPaced(res, body, charsPerSecond) {
  return new Promise((resolve) => {
    const frames = splitSseFrames(body);
    let i = 0;
    let timer = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      resolve({ sent: i, total: frames.length, disconnected: true });
    };
    res.on("close", stop);
    const next = () => {
      if (stopped) return;
      if (i >= frames.length) {
        stopped = true;
        res.end();
        resolve({ sent: i, total: frames.length, disconnected: false });
        return;
      }
      const frame = frames[i++];
      const delay = frameDelayMs(frame, charsPerSecond);
      const write = () => {
        timer = null;
        if (stopped) return;
        res.write(frame);
        next();
      };
      if (delay > 0) timer = setTimeout(write, delay);
      else write();
    };
    next();
  });
}

function isEventStream(headers) {
  const ct = headers["content-type"];
  return typeof ct === "string" && ct.toLowerCase().includes("text/event-stream");
}

// ── Modes ────────────────────────────────────────────────────────────────────

function createRecorder(opts) {
  const key = process.env.DEMO_PROXY_ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "record mode needs DEMO_PROXY_ANTHROPIC_API_KEY: the CLI's x-api-key is the dummy from " +
        "the demo repo's .claude/settings.json and must be swapped for a real one on the way out",
    );
  }
  fs.mkdirSync(opts.cassetteDir, { recursive: true });
  for (const lane of [LANE_API_KEY, LANE_BEARER]) {
    if (fs.existsSync(path.join(opts.cassetteDir, lane, "001.sse"))) {
      throw new Error(`cassette dir already holds a ${lane} take: ${opts.cassetteDir} — delete it or record elsewhere`);
    }
  }
  const upstream = new URL(opts.upstream);
  const transport = upstream.protocol === "https:" ? https : http;
  const counters = { [LANE_API_KEY]: 0, [LANE_BEARER]: 0 };

  return async function record(req, res, raw) {
    const lane = laneOf(req.headers);
    const n = ++counters[lane];
    const startedAt = Date.now();
    const fp = fingerprintOf(raw);
    fs.appendFileSync(path.join(opts.cassetteDir, FINGERPRINTS_FILE), JSON.stringify({ lane, n, ...fp }) + "\n");

    // Headers verbatim except: the dummy key becomes the proxy's own; hop-by-hop
    // and host are the transport's; accept-encoding is forced to identity so the
    // saved stream is plain SSE the replay can pace (a gzipped body has no frames).
    const headers = { ...req.headers };
    delete headers.host;
    delete headers.connection;
    delete headers["accept-encoding"];
    headers["accept-encoding"] = "identity";
    headers["content-length"] = String(raw.length);
    if (lane === LANE_API_KEY) headers["x-api-key"] = key;

    await new Promise((resolve) => {
      const up = transport.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || undefined,
          method: req.method,
          path: req.url,
          headers,
        },
        (upRes) => {
          const chunks = [];
          const status = upRes.statusCode ?? 502;
          const replayHeaders = {};
          for (const [name, value] of Object.entries(upRes.headers)) {
            if (!DROPPED_RESPONSE_HEADERS.has(name)) replayHeaders[name] = value;
          }
          if (!res.destroyed) res.writeHead(status, replayHeaders);
          upRes.on("data", (c) => {
            chunks.push(c);
            if (!res.destroyed) res.write(c);
          });
          upRes.on("end", () => {
            const body = Buffer.concat(chunks);
            const laneDir = path.join(opts.cassetteDir, lane);
            fs.mkdirSync(laneDir, { recursive: true });
            fs.writeFileSync(path.join(laneDir, `${pad3(n)}.sse`), serializeResponse(status, upRes.headers, body));
            if (!res.destroyed) res.end();
            log(`record lane=${lane} n=${n} ${req.method} ${req.url} ${status} ${Date.now() - startedAt}ms`);
            resolve();
          });
          upRes.on("error", (err) => {
            log(`record lane=${lane} n=${n} upstream stream error: ${err.message}`);
            if (!res.destroyed) res.destroy();
            resolve();
          });
        },
      );
      up.on("error", (err) => {
        log(`record lane=${lane} n=${n} ${req.method} ${req.url} upstream error: ${err.message}`);
        if (!res.headersSent && !res.destroyed) json(res, 502, { error: { type: "upstream_error", message: err.message } });
        else if (!res.destroyed) res.destroy();
        resolve();
      });
      up.end(raw);
    });
  };
}

function loadFingerprints(cassetteDir) {
  const file = path.join(cassetteDir, FINGERPRINTS_FILE);
  const byKey = new Map();
  if (!fs.existsSync(file)) return byKey;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const fp = JSON.parse(line);
      byKey.set(`${fp.lane}/${fp.n}`, fp);
    } catch {
      // A torn line is the author's problem to notice in the log, not a reason to refuse the cassette.
      log(`ignoring unparsable fingerprint line: ${line}`);
    }
  }
  return byKey;
}

/** Fields whose drift means the take is not the one the cassette was cut from. */
const DRIFT_FIELDS = ["model", "messages", "tools", "stream"];

export function describeDrift(recorded, actual) {
  const drift = DRIFT_FIELDS.filter((f) => recorded[f] !== actual[f]).map(
    (f) => `${f}: recorded=${JSON.stringify(recorded[f])} got=${JSON.stringify(actual[f])}`,
  );
  return drift.length ? drift.join(", ") : null;
}

function createReplayer(opts) {
  if (!fs.existsSync(opts.cassetteDir)) throw new Error(`cassette dir not found: ${opts.cassetteDir}`);
  const fingerprints = loadFingerprints(opts.cassetteDir);
  const counters = { [LANE_API_KEY]: 0, [LANE_BEARER]: 0 };

  return async function replay(req, res, raw) {
    const lane = laneOf(req.headers);
    const n = ++counters[lane];
    const startedAt = Date.now();
    const actual = fingerprintOf(raw);
    const recorded = fingerprints.get(`${lane}/${n}`);
    if (recorded) {
      const drift = describeDrift(recorded, actual);
      if (drift) {
        log(`cassette drift lane=${lane} n=${n}: ${drift} (bodyBytes recorded=${recorded.bodyBytes} got=${actual.bodyBytes})`);
      }
    }

    const file = path.join(opts.cassetteDir, lane, `${pad3(n)}.sse`);
    const finish = (status, suffix = "") =>
      log(`replay lane=${lane} n=${n} ${req.method} ${req.url} ${status} ${Date.now() - startedAt}ms${suffix}`);
    if (!fs.existsSync(file)) {
      if (lane !== LANE_API_KEY && !fs.existsSync(path.join(opts.cassetteDir, lane))) {
        // Plan §2: a lane the cassette never recorded is refused, not exhausted.
        json(res, 401, { error: { type: "authentication_error", message: `demo-proxy: no ${lane} lane in this cassette` } });
        finish(401);
        return;
      }
      json(res, 500, {
        error: { type: "api_error", message: `demo-proxy: cassette exhausted (${lane} lane has no request ${n})` },
      });
      finish(500);
      return;
    }

    const { status, headers, body } = parseResponseFile(fs.readFileSync(file));
    res.writeHead(status, headers);
    if (isEventStream(headers)) {
      const { sent, total, disconnected } = await streamPaced(res, body, opts.charsPerSecond);
      finish(status, disconnected ? ` client disconnected after ${sent}/${total} frames` : "");
    } else {
      res.end(body);
      finish(status);
    }
  };
}

// ── Server ───────────────────────────────────────────────────────────────────

export function createServer(opts) {
  const handleMessages = opts.mode === "record" ? createRecorder(opts) : createReplayer(opts);

  const server = http.createServer((req, res) => {
    res.on("error", () => {
      // The client went away mid-write; the close handler has already stopped the stream.
    });
    const startedAt = Date.now();
    if (req.method === "HEAD" && req.url.split("?")[0] === "/api/hello") {
      res.writeHead(200);
      res.end();
      log(`${opts.mode} lane=- n=- HEAD ${req.url} 200 ${Date.now() - startedAt}ms`);
      return;
    }
    if (!isMessagesRequest(req)) {
      readBody(req)
        .catch(() => Buffer.alloc(0))
        .then(() => {
          json(res, 404, { error: { type: "not_found", message: `demo-proxy: no handler for ${req.method} ${req.url}` } });
          log(`${opts.mode} lane=- n=- ${req.method} ${req.url} 404 ${Date.now() - startedAt}ms`);
        });
      return;
    }
    readBody(req)
      .then((raw) => handleMessages(req, res, raw))
      .catch((err) => {
        log(`${req.method} ${req.url} failed: ${err.stack ?? err.message}`);
        if (!res.headersSent && !res.destroyed) json(res, 500, { error: { type: "api_error", message: String(err.message) } });
        else if (!res.destroyed) res.destroy();
      });
  });
  return server;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    log(`error: ${err.message}`);
    log("usage: proxy.mjs (--record DIR [--upstream URL] | --replay DIR [--pace-chars-per-second N]) [--port N] [--host H]");
    process.exit(2);
  }
  let server;
  try {
    server = createServer(opts);
  } catch (err) {
    log(`error: ${err.message}`);
    process.exit(2);
  }
  server.listen(opts.port, opts.host, () => {
    const { port } = server.address();
    log(
      `${opts.mode} listening on http://${opts.host}:${port} cassette=${opts.cassetteDir}` +
        (opts.mode === "record" ? ` upstream=${opts.upstream}` : ` pace=${opts.charsPerSecond}cps`),
    );
    process.stdout.write(`${port}\n`);
  });
  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
