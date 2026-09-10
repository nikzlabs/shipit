import http from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { SessionContainerManager } from "./session-container.js";
import type { ServiceManager } from "./service-manager.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import {
  AGENT_INTERFACE_SDK_MARKER,
  AGENT_INTERFACE_SDK_SCRIPT,
} from "../shared/agent-interface-sdk/bootstrap.js";
import type { LogSource } from "../shared/types.js";
import { appendAgentLog } from "./log-emit.js";
import { markPreviewReachable } from "./preview-timing.js";

export function parsePreviewSubdomain(
  host: string | undefined,
): { sessionId: string; port: number } | null {
  if (!host) return null;
  const hostname = host.split(":")[0];
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})--(\d+)\./i.exec(hostname);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { sessionId: match[1], port };
}

// Request separate renderers to avoid shared WebGL limits. Browsers may decline.
// Include on the first document (even a connecting page), on a trustworthy origin.
const ORIGIN_AGENT_CLUSTER = "origin-agent-cluster";

export function withOriginIsolation(
  headers: http.OutgoingHttpHeaders,
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  // Duplicate header values invalidate the isolation request.
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== ORIGIN_AGENT_CLUSTER) out[k] = v;
  }
  out[ORIGIN_AGENT_CLUSTER] = "?1";
  return out;
}

// Route loopback HMR URLs through the preview origin to reach the container.
const HMR_WS_PATCH = `<script>(function(){` +
  `var O=WebSocket;` +
  `window.WebSocket=function(u,p){` +
    `try{var a=new URL(u);` +
    `if((a.hostname==="localhost"||a.hostname==="127.0.0.1")&&a.port!==location.port){` +
      `a.hostname=location.hostname;a.port=location.port;u=a.toString()` +
    `}}catch(e){}` +
    `return new O(u,p)};` +
  `window.WebSocket.prototype=O.prototype;` +
  `window.WebSocket.CONNECTING=0;window.WebSocket.OPEN=1;` +
  `window.WebSocket.CLOSING=2;window.WebSocket.CLOSED=3;` +
  // The parent uses this signal to detect auth-blocked frames.
  `if(window.parent!==window){` +
    `window.parent.postMessage({source:"shipit-preview",type:"loaded"},"*");` +
    // Legacy history traverses the joint tab history. Never fall back to it:
    // Navigation API entries keep traversal inside this frame.
    `var nav=window.navigation;` +
    `var swallow=function(){};` +
    // Warn once in devtools, without posting an app error that could trigger auto-fix.
    // Keep injected text ASCII for pages without a charset.
    `var warned=false;` +
    `var refuse=function(){if(warned)return;warned=true;try{console.warn(` +
      `"[ShipIt preview] Ignored a history traversal this preview cannot make on its own. "+` +
      `"The frame has no entry of its own to move to, so the platform would have traversed "+` +
      `"the ShipIt page instead, switching the user out of their session.")}catch(e5){}};` +
    `var travel=function(dir){` +
      `if(!nav){refuse();return}` +
      `if(dir==="back"?!nav.canGoBack:!nav.canGoForward){refuse();return}` +
      `var r=nav[dir]();` +
      `r.committed.catch(swallow);r.finished.catch(swallow)` +
    `};` +
    `var jump=function(d){` +
      // Match History.go's Web IDL long conversion, including overflow and BigInt rejection.
      `d=d|0;` +
      `if(!d){location.reload();return}` +
      `if(d===-1){travel("back");return}` +
      `if(d===1){travel("forward");return}` +
      // Count frame-local entries, not joint-history steps that include nested frames.
      `if(!nav||!nav.entries||!nav.traverseTo){refuse();return}` +
      `try{var es=nav.entries();var ce=nav.currentEntry;` +
        `if(!es||!ce){refuse();return}` +
        `var t=es[ce.index+d];if(!t){refuse();return}` +
        `var r=nav.traverseTo(t.key);` +
        `r.committed.catch(swallow);r.finished.catch(swallow)` +
      `}catch(e3){}` +
    `};` +
    // Patch the prototype to cover direct prototype calls and later router wrappers.
    `try{var hp=(window.History&&window.History.prototype)||history;` +
      `hp.back=function(){travel("back")};` +
      `hp.forward=function(){travel("forward")};` +
      `hp.go=function(d){jump(d)};` +
      // App back-button guards also need the frame-local length.
      `if(nav&&nav.entries)Object.defineProperty(hp,"length",{configurable:true,` +
        `get:function(){try{return nav.entries().length}catch(e6){return 1}}})` +
    `}catch(e4){}` +
    `var fire=function(C,n,i){try{window.dispatchEvent(new C(n,i))}catch(e2){}};` +
    // Same-path pointers update page state without reloading the app.
    `var go=function(u){try{` +
      `if(typeof u!=="string")return;` +
      `var c=new URL(location.href);var t=new URL(u,c);` +
      `if(t.origin!==c.origin||t.href===c.href)return;` +
      `if(t.pathname===c.pathname){` +
        `if(t.search===c.search&&t.hash){location.hash=t.hash;return}` +
        `history.pushState(history.state,"",t.href);` +
        // Query changes notify routers; pages that read the query only at load will not update.
        `if(t.search!==c.search)fire(PopStateEvent,"popstate",{state:history.state});` +
        `if(t.hash!==c.hash)fire(HashChangeEvent,"hashchange",{oldURL:c.href,newURL:t.href});` +
        `return` +
      `}` +
      // Do not fall back after rejection: the app may have cancelled navigation.
      `if(nav&&nav.navigate){var r=nav.navigate(t.href);` +
        `r.committed.catch(swallow);r.finished.catch(swallow);return}` +
      `location.assign(t.href)` +
    `}catch(e){}};` +
    `window.addEventListener("message",function(e){` +
      `var d=e.data;if(!d||d.source!=="shipit-toolbar")return;` +
      `if(e.source!==window.parent)return;` +
      `if(d.type==="back")travel("back");` +
      `else if(d.type==="forward")travel("forward");` +
      `else if(d.type==="navigate")go(d.url);` +
      // Reassigning the iframe src would lose its current client-side route.
      `else if(d.type==="reload")location.reload()` +
    `});` +
    `var rp=function(){try{window.parent.postMessage({source:"shipit-preview",` +
      `type:"path",path:location.pathname+location.search+location.hash,` +
      `canGoBack:nav?nav.canGoBack:false},"*")}catch(e){}};` +
    `rp();` +
    `var wrap=function(n){var o=history[n];if(typeof o!=="function")return;` +
      `history[n]=function(){var r=o.apply(this,arguments);rp();return r}};` +
    `wrap("pushState");wrap("replaceState");` +
    `window.addEventListener("popstate",rp);` +
    `window.addEventListener("hashchange",rp);` +
    // Direct Navigation API calls bypass the History wrappers.
    `if(nav)nav.addEventListener("currententrychange",rp)` +
  `}` +
  `})()</script>`;

export function injectPreviewBootstrap(html: string): string {
  const scripts = html.includes(AGENT_INTERFACE_SDK_MARKER)
    ? HMR_WS_PATCH
    : HMR_WS_PATCH + AGENT_INTERFACE_SDK_SCRIPT;
  const headIdx = html.search(/<head[^>]*>/i);
  if (headIdx === -1) return scripts + html;
  const insertAt = html.indexOf(">", headIdx) + 1;
  return html.slice(0, insertAt) + scripts + html.slice(insertAt);
}

function scriptBody(script: string): string {
  return script.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
}

const INJECTED_SCRIPT_HASHES = [HMR_WS_PATCH, AGENT_INTERFACE_SDK_SCRIPT].map((script) =>
  `'sha256-${createHash("sha256").update(scriptBody(script)).digest("base64")}'`);

export function allowPreviewBootstrapInCsp(csp: string): string {
  return csp.split(",").map((policy) => {
    const directives = policy.split(";").map((part) => part.trim()).filter(Boolean);
    const index = directives.findIndex((part) => part === "script-src" || part.startsWith("script-src "));
    if (index === -1) {
      directives.push(`script-src ${INJECTED_SCRIPT_HASHES.join(" ")}`);
    } else {
      const tokens = directives[index].split(/\s+/).filter((token) => token !== "'none'");
      for (const hash of INJECTED_SCRIPT_HASHES) if (!tokens.includes(hash)) tokens.push(hash);
      directives[index] = tokens.join(" ");
    }
    return directives.join("; ");
  }).join(", ");
}

/** Loopback Host passes dev-server checks; forwarded headers retain the public URL. */
export function buildUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  targetPort: number,
): http.IncomingHttpHeaders {
  const browserHost = headers["x-forwarded-host"] ?? headers.host;
  const proto = headers["x-forwarded-proto"] ?? "http";

  const out: http.IncomingHttpHeaders = {
    ...headers,
    host: `localhost:${targetPort}`,
    "x-forwarded-proto": proto,
  };
  if (browserHost !== undefined) {
    out["x-forwarded-host"] = browserHost;
  }
  return out;
}

interface PreviewErrorReporter {
  (sessionId: string, port: number, message: string, upgrade: boolean): void;
  success(sessionId: string, port: number): void;
}

/** Leave the response untouched on connect failure so the caller can retry. */
function proxyHttpAttempt(
  containerIp: string,
  targetPort: number,
  targetPath: string,
  method: string,
  headers: http.IncomingHttpHeaders,
  rawReq: http.IncomingMessage,
  rawRes: http.ServerResponse,
  hasBody: boolean,
  onUnreachable: (err: NodeJS.ErrnoException) => void,
  onSuccess?: () => void,
): http.ClientRequest {
  // Bootstrap injection needs uncompressed HTML.
  const fwdHeaders = buildUpstreamHeaders(headers, targetPort);
  delete fwdHeaders["accept-encoding"];

  const proxyReq = http.request(
    {
      hostname: containerIp,
      port: targetPort,
      path: targetPath,
      method,
      headers: fwdHeaders,
    },
    (proxyRes) => {
      if (onSuccess) onSuccess();
      const ct = proxyRes.headers["content-type"] || "";
      const isHtml = method === "GET" && ct.includes("text/html");

      if (isHtml) {
        const chunks: Buffer[] = [];
        proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on("end", () => {
          const html = injectPreviewBootstrap(Buffer.concat(chunks).toString("utf-8"));
          const outHeaders = { ...proxyRes.headers };
          const csp = outHeaders["content-security-policy"];
          if (typeof csp === "string") {
            outHeaders["content-security-policy"] = allowPreviewBootstrapInCsp(csp);
          } else if (Array.isArray(csp)) {
            outHeaders["content-security-policy"] = csp.map(allowPreviewBootstrapInCsp);
          }
          delete outHeaders["content-length"];
          delete outHeaders["content-encoding"];
          delete outHeaders["transfer-encoding"];
          outHeaders["content-length"] = String(Buffer.byteLength(html));
          rawRes.writeHead(proxyRes.statusCode ?? 200, withOriginIsolation(outHeaders));
          rawRes.end(html);
        });
      } else {
        rawRes.writeHead(proxyRes.statusCode ?? 502, withOriginIsolation(proxyRes.headers));
        proxyRes.pipe(rawRes);
      }
    },
  );

  proxyReq.on("socket", (socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => {
      socket.destroy(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }));
    }, PREVIEW_CONNECT_TIMEOUT_MS);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    socket.once("connect", clear);
    socket.once("close", clear);
    socket.once("error", clear);
  });

  proxyReq.on("error", (err: NodeJS.ErrnoException) => {
    if (rawRes.headersSent) {
      rawRes.end();
      return;
    }
    onUnreachable(err);
  });

  if (hasBody) rawReq.pipe(proxyReq);
  else proxyReq.end();
  return proxyReq;
}

// Keep the initial blank wait below the frame's 5s auth timeout; longer boots use the page.
const PREVIEW_CONNECT_RETRY_MS = 1_000;

// Bound dropped SYNs, not slow responses from a dev server compiling a route.
const PREVIEW_CONNECT_TIMEOUT_MS = 3_000;

const PREVIEW_CONNECT_RETRY_STEP_MS = 250;

const CONNECTING_PAGE_POLL_MS = 1_000;

const CONNECTING_PAGE_DETAIL_MS = 30_000;

const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

// A streamed body is consumed on the first attempt and cannot be replayed.
export function isRetryablePreviewRequest(
  method: string,
  headers: http.IncomingHttpHeaders,
): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  return headers["content-length"] === undefined && headers["transfer-encoding"] === undefined;
}

export function wantsHtmlDocument(
  method: string,
  headers: http.IncomingHttpHeaders,
): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const accept = headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

function toScriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Poll before reloading to avoid flashing the page throughout a slow boot.
export function buildConnectingPage(port: number, lastError: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connecting to the dev server</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
         background: Canvas; color: CanvasText; }
  .box { text-align: center; max-width: 30rem; padding: 1.5rem; }
  .spinner { width: 20px; height: 20px; margin: 0 auto 0.9rem; border-radius: 50%;
             border: 2px solid currentColor; border-right-color: transparent;
             opacity: 0.5; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
  .detail { margin-top: 0.75rem; font-size: 12px; opacity: 0.65; word-break: break-word; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
</head>
<body>
<div class="box">
  <div class="spinner"></div>
  <p>Connecting to the dev server on port <code>${port}</code>&hellip;</p>
  <p class="detail" id="shipit-connect-detail" hidden></p>
</div>
<script>
(function () {
  var started = Date.now();
  var detail = document.getElementById("shipit-connect-detail");
  function schedule() {
    if (Date.now() - started > ${CONNECTING_PAGE_DETAIL_MS} && detail.hidden) {
      detail.textContent = "The dev server has not answered yet. Last error: " + ${toScriptLiteral(lastError)};
      detail.hidden = false;
    }
    setTimeout(tick, ${CONNECTING_PAGE_POLL_MS});
  }
  function tick() {
    fetch(location.href, { cache: "no-store", headers: { accept: "text/html" } })
      .then(function (res) {
        // 503 is this page again — still unreachable. Anything else is the app.
        if (res.status !== 503) { location.reload(); return; }
        schedule();
      })
      .catch(schedule);
  }
  schedule();
})();
</script>
</body>
</html>
`;
}

function proxyWebSocket(
  containerIp: string,
  targetPort: number,
  targetPath: string,
  headers: http.IncomingHttpHeaders,
  socket: Duplex,
  onError?: (message: string) => void,
  onSuccess?: () => void,
): void {
  const proxyReq = http.request({
    hostname: containerIp,
    port: targetPort,
    path: targetPath,
    method: "GET",
    headers: buildUpstreamHeaders(headers, targetPort),
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    if (onSuccess) onSuccess();
    // Preserve the handshake's accept header and negotiated subprotocols.
    let head = `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    const raw = proxyRes.rawHeaders;
    for (let i = 0; i < raw.length; i += 2) {
      head += `${raw[i]}: ${raw[i + 1]}\r\n`;
    }
    head += "\r\n";
    socket.write(head);
    if (proxyHead.length > 0) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    proxySocket.on("close", () => socket.destroy());
    socket.on("close", () => proxySocket.destroy());
  });

  proxyReq.on("error", (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (onError) onError(msg);
    socket.destroy();
  });

  proxyReq.end();
}

const PREVIEW_ERROR_THROTTLE_MS = 5_000;

const PREVIEW_ERROR_GRACE_MS = 2_000;

/** HTTP and HMR share a streak key; successful HTTP can hide failed HMR. */
export function createPreviewErrorReporter(
  runnerRegistry: SessionRunnerRegistry | undefined,
  opts: {
    now?: () => number;
    throttleMs?: number;
    graceMs?: number;
    /** Required in production to retain logs across reloads. */
    broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  } = {},
): PreviewErrorReporter {
  const lastEmitAt = new Map<string, number>();
  const streakStartAt = new Map<string, number>();
  const now = opts.now ?? (() => Date.now());
  const throttleMs = opts.throttleMs ?? PREVIEW_ERROR_THROTTLE_MS;
  const graceMs = opts.graceMs ?? PREVIEW_ERROR_GRACE_MS;
  const broadcastLog = opts.broadcastLog;

  const report = ((sessionId, port, message, upgrade) => {
    if (!runnerRegistry) return;
    const runner = runnerRegistry.get(sessionId);
    if (!runner) return;
    const key = `${sessionId}:${port}`;
    const t = now();

    const streakStart = streakStartAt.get(key);
    if (streakStart === undefined) {
      streakStartAt.set(key, t);
      return;
    }
    if (t - streakStart < graceMs) return;

    const last = lastEmitAt.get(key) ?? 0;
    if (t - last < throttleMs) return;
    lastEmitAt.set(key, t);
    const human = upgrade
      ? `Preview HMR unreachable on port ${port} (${message})`
      : `Preview unreachable on port ${port} (${message})`;
    appendAgentLog(broadcastLog, sessionId, runner, "preview", human);
  }) as PreviewErrorReporter;

  report.success = (sessionId, port) => {
    streakStartAt.delete(`${sessionId}:${port}`);
    markPreviewReachable(sessionId, port);
  };

  return report;
}

export function registerPreviewProxy(
  app: FastifyInstance,
  opts: {
    containerManager: SessionContainerManager;
    serviceManagers: Map<string, ServiceManager>;
    runnerRegistry?: SessionRunnerRegistry;
    connectRetryMs?: number;
    broadcastLog?: (sessionId: string, source: LogSource, text: string) => void;
  },
): void {
  const { containerManager, serviceManagers, runnerRegistry } = opts;
  const connectRetryMs = opts.connectRetryMs ?? PREVIEW_CONNECT_RETRY_MS;

  const reportError = createPreviewErrorReporter(runnerRegistry, {
    ...(opts.broadcastLog ? { broadcastLog: opts.broadcastLog } : {}),
  });

  function resolveTarget(sessionId: string, port: number): { ip: string; port: number } | null {
    const mgr = serviceManagers.get(sessionId);
    const target = mgr?.resolvePreviewTarget(port);
    if (target) return { ip: target.containerIp, port: target.port };
    const sc = containerManager.get(sessionId);
    return sc?.containerIp ? { ip: sc.containerIp, port } : null;
  }

  function proxyPreviewRequest(
    sessionId: string,
    originPort: number,
    rawReq: http.IncomingMessage,
    rawRes: http.ServerResponse,
    url: string,
    method: string,
    headers: http.IncomingHttpHeaders,
  ): void {
    const canRetry = isRetryablePreviewRequest(method, headers);
    const deadline = Date.now() + connectRetryMs;
    let abandoned = false;
    let inFlight: http.ClientRequest | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    rawRes.on("close", () => {
      abandoned = true;
      if (retryTimer) clearTimeout(retryTimer);
      // Normal completion also closes the response; destroy only on abandonment.
      if (!rawRes.writableEnded && inFlight && !inFlight.destroyed) inFlight.destroy();
    });

    function attempt(): void {
      if (abandoned) return;
      // The container address may change between attempts.
      const target = resolveTarget(sessionId, originPort);
      if (!target) {
        giveUpOrRetry("Session container not found", true);
        return;
      }
      inFlight = proxyHttpAttempt(
        target.ip,
        target.port,
        url,
        method,
        headers,
        rawReq,
        rawRes,
        !canRetry,
        (err) => giveUpOrRetry(err.message, CONNECT_ERROR_CODES.has(err.code ?? "")),
        () => reportError.success(sessionId, originPort),
      );
    }

    function giveUpOrRetry(message: string, transient: boolean): void {
      if (abandoned) return;
      if (canRetry && transient && Date.now() < deadline) {
        retryTimer = setTimeout(attempt, PREVIEW_CONNECT_RETRY_STEP_MS);
        retryTimer.unref?.();
        return;
      }
      if (rawRes.headersSent) {
        rawRes.end();
        return;
      }
      // Report only exhausted requests, using the browser-facing port.
      reportError(sessionId, originPort, message, false);
      if (wantsHtmlDocument(method, headers)) {
        const body = injectPreviewBootstrap(buildConnectingPage(originPort, message));
        rawRes.writeHead(503, withOriginIsolation({
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": String(Buffer.byteLength(body)),
        }));
        rawRes.end(body);
        return;
      }
      rawRes.writeHead(502, withOriginIsolation({ "Content-Type": "application/json" }));
      rawRes.end(JSON.stringify({ error: "Container preview unreachable" }));
    }

    attempt();
  }

  app.addHook("onRequest", (request, reply, done) => {
    const parsed = parsePreviewSubdomain(request.headers.host);
    if (!parsed) {
      done();
      return;
    }

    const { sessionId, port: originPort } = parsed;
    reply.hijack();
    proxyPreviewRequest(
      sessionId,
      originPort,
      request.raw,
      reply.raw,
      request.url,
      request.method,
      request.headers,
    );
    done();
  });

  // Intercept upgrades before Fastify destroys unmatched preview sockets.
  const originalUpgradeListeners = [
    ...app.server.listeners("upgrade"),
  ] as ((...args: unknown[]) => void)[];
  app.server.removeAllListeners("upgrade");

  app.server.on(
    "upgrade",
    (
      req: http.IncomingMessage,
      socket: Duplex,
      head: Buffer,
    ) => {
      const subdomainParsed = parsePreviewSubdomain(req.headers.host);
      if (subdomainParsed) {
        const { sessionId, port: originPort } = subdomainParsed;
        const target = resolveTarget(sessionId, originPort);
        if (!target) {
          reportError(sessionId, originPort, "Container not found for HMR upgrade", true);
          socket.destroy();
          return;
        }
        proxyWebSocket(
          target.ip,
          target.port,
          req.url || "/",
          req.headers,
          socket,
          (msg) => reportError(sessionId, originPort, msg, true),
          () => reportError.success(sessionId, originPort),
        );
        return;
      }

      for (const listener of originalUpgradeListeners) {
        listener.call(app.server, req, socket, head);
      }
    },
  );
}
