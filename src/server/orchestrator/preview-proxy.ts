/**
 * Preview Proxy — session-ID-based reverse proxy for preview traffic.
 *
 * Subdomain routing — {sessionId}--{port}.localhost routes ALL requests to
 * the container's bridge IP. Absolute paths (/src/main.tsx, /@vite/client)
 * resolve naturally against the subdomain origin without any HTML rewriting —
 * works with any dev server, not just Vite. This is the ONLY container-preview
 * routing mode: a path-based (/preview/:sessionId/:port/*) variant existed but
 * was removed (docs/175) — it couldn't render real apps because absolute asset
 * paths 404 without the prefix, and no HTML rewriting was done.
 *
 * Reachability is not probed. A request that arrives before the dev server
 * listens is retried here for a bounded window and, past it, answered with a
 * self-refreshing connecting page — so the iframe's one load can't be burned on
 * a 502 and the client needs no gate of its own (docs/286).
 *
 * Supports WebSocket upgrades for HMR.
 *
 * Registered when a SessionContainerManager is available (production mode).
 */

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

// ---------------------------------------------------------------------------
// Subdomain parsing
// ---------------------------------------------------------------------------

/**
 * Parse a preview subdomain from the Host header.
 * Pattern: {uuid}--{port}.anything[:serverPort]
 * Example: 98f05156-7e64-422d-81bc-ba677fda60e0--5173.localhost:3001
 */
export function parsePreviewSubdomain(
  host: string | undefined,
): { sessionId: string; port: number } | null {
  if (!host) return null;
  const hostname = host.split(":")[0]; // Strip server port
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})--(\d+)\./i.exec(hostname);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { sessionId: match[1], port };
}

// ---------------------------------------------------------------------------
// HMR WebSocket patch
// ---------------------------------------------------------------------------

/**
 * Tiny script injected into HTML responses from the container's dev server.
 * Dev servers (Vite, Webpack, etc.) open HMR WebSocket connections to their own
 * listening address (e.g. localhost:5173). From the browser, that address doesn't
 * reach the container — it needs to go through our subdomain proxy instead.
 *
 * This script wraps the WebSocket constructor to rewrite localhost connections
 * to use the page's origin, which our proxy then forwards to the container.
 */
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
  // Notify parent that the preview loaded successfully (used to detect
  // auth-blocked iframes when behind a reverse proxy like Cloudflare Zero Trust)
  `if(window.parent!==window){` +
    `window.parent.postMessage({source:"shipit-preview",type:"loaded"},"*");` +
    // Back/forward must stay inside the iframe. `history.back()` traverses the
    // *joint* session history — this frame's entries nested inside the ShipIt
    // tab's — so a preview with no entry of its own walks the TOP-LEVEL page
    // back and drops the user out of their session. `history.length` can't
    // guard it either: in a frame it reports the joint length (verified in
    // Chromium: 1 own entry, length 9). The Navigation API's entry list is
    // scoped to this frame, so `canGoBack` answers the right question and
    // `back()` cannot move anything but us.
    // No `history.back()` fallback: there is no way to ask the legacy API
    // whether *this frame* can go back (its `history.length` is the joint
    // length), so on a browser without the Navigation API we refuse to
    // traverse and report `canGoBack:false`, which greys the button out. All
    // three engines ship the API (Chrome 102, Safari 18.2, Firefox 147), so
    // this costs a button nobody has rather than keeping the bug alive.
    `var nav=window.navigation;` +
    // Navigation API results reject (InvalidStateError, an aborted intercept)
    // and we never act on the outcome. Swallow both promises rather than
    // spilling an unhandled rejection into the previewed app's console.
    `var swallow=function(){};` +
    // A refusal below is a no-op the page can't see — it gets History's usual
    // `undefined` and no event, which reads as "the button is broken". Say why,
    // once, in the console the developer already has open. Deliberately a bare
    // `console.warn`: ShipIt's error panel only ingests what a page *posts* as
    // a `shipit-preview` console message, so this reaches devtools without
    // showing up as an app error or waking auto-fix.
    // The text is ASCII on purpose, like the rest of this script: it is
    // injected into whatever the app serves, and a page served without a
    // charset renders a UTF-8 em dash here as mojibake (seen in Chromium).
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
    // The previewed PAGE's own back button is the same leak as the toolbar's,
    // and the toolbar guard above does nothing for it: an app that calls
    // `history.back()` — a "< Back" control, a router's `goBack()`, a
    // `javascript:history.back()` link — traverses the joint session history
    // straight past the frame and walks the ShipIt tab back, switching the
    // user's active session. So the same frame-scoped traversal is installed
    // over the three History methods that traverse. This script is first in
    // <head>, so it wins over any app code that captures them later.
    // `go(0)` (and a missing/NaN delta) is a reload, not a traversal — that is
    // what the platform does, and it never leaves the frame.
    `var jump=function(d){` +
      // `|0` is exactly the Web IDL `long` conversion the real `go()` performs:
      // it truncates, folds NaN/undefined/a non-numeric string to 0, and wraps
      // modulo 2^32 (so `go(4294967295)` is `go(-1)`, as natively). It also
      // throws on a BigInt, which is what the native conversion does.
      `d=d|0;` +
      `if(!d){location.reload();return}` +
      `if(d===-1){travel("back");return}` +
      `if(d===1){travel("forward");return}` +
      // A delta past ±1 has no `canGoBack`-style predicate, so the entry list
      // itself is the guard: an index outside it is a step the frame cannot
      // take, and refusing is what keeps it off the top-level page.
      //
      // Counting the delta in the FRAME's entries is a deliberate departure
      // from `history.go`, which counts steps of the *joint* history — a nested
      // frame's navigation is a step there, so a native `go(-2)` from an app
      // that made two navigations of its own can land somewhere the app never
      // was, and past the frame's first entry it lands on the ShipIt page.
      // Frame-local is both containable and what a router asking for "two of my
      // entries back" means.
      `if(!nav||!nav.entries||!nav.traverseTo){refuse();return}` +
      `try{var es=nav.entries();var ce=nav.currentEntry;` +
        `if(!es||!ce){refuse();return}` +
        `var t=es[ce.index+d];if(!t){refuse();return}` +
        `var r=nav.traverseTo(t.key);` +
        `r.committed.catch(swallow);r.finished.catch(swallow)` +
      `}catch(e3){}` +
    `};` +
    // Patch the PROTOTYPE, not the instance. An own property on `history`
    // would leave `History.prototype.back.call(history)` as a live route to the
    // joint traversal, and would shadow — rather than compose with — a router
    // or instrumentation library that wraps the prototype method later. Falls
    // back to the instance where `History` isn't exposed, and an engine that
    // refuses the write must not take the rest of the script down.
    `try{var hp=(window.History&&window.History.prototype)||history;` +
      `hp.back=function(){travel("back")};` +
      `hp.forward=function(){travel("forward")};` +
      `hp.go=function(d){jump(d)};` +
      // `history.length` is the joint length in a frame (measured in Chromium:
      // one own entry, `length` 9), which is why nothing above can use it as a
      // guard — and why the `history.length>1` check an app puts in FRONT of
      // its back button is wrong here, sending it into a refusal. The
      // Navigation API knows the frame's own count, so report that instead and
      // the app's own guard starts telling it the truth.
      `if(nav&&nav.entries)Object.defineProperty(hp,"length",{configurable:true,` +
        `get:function(){try{return nav.entries().length}catch(e6){return 1}}})` +
    `}catch(e4){}` +
    // Dispatch an event the browser would have fired for a navigation it
    // performed itself. Guarded per call: an engine missing one of the
    // constructors must not take the rest of `go` down with it.
    `var fire=function(C,n,i){try{window.dispatchEvent(new C(n,i))}catch(e2){}};` +
    // Send the frame to an agent-authored pointer's destination (docs/258).
    // The parent could assign our `src` instead — cross-origin blocks reading
    // `location`, not navigating a frame — but that is always a document load,
    // so a pointer at a place *inside* the page the user is already on tore the
    // app down and rebuilt it. In here we can see where the page actually is,
    // so a destination on the page we are already showing becomes the
    // same-document navigation it really is (req 13).
    `var go=function(u){try{` +
      // A non-string resolves against our own origin ("/undefined") instead of
      // throwing, so it has to be rejected before the parser sees it.
      `if(typeof u!=="string")return;` +
      `var c=new URL(location.href);var t=new URL(u,c);` +
      // Same second check the parent makes. What follows is a navigation, and
      // this side is the one that can compare against the live location.
      `if(t.origin!==c.origin||t.href===c.href)return;` +
      // Same path = the page the user is already on, so every remaining
      // difference is that page's own state. The path is where the line sits:
      // a different one is plausibly a different document (an MPA's
      // /about.html), while a query on the same path is what a page uses to say
      // where it is within itself.
      `if(t.pathname===c.pathname){` +
        // Fragment alone: the platform's own same-document path. It fires
        // hashchange and scrolls, so nothing has to be synthesized.
        `if(t.search===c.search&&t.hash){location.hash=t.hash;return}` +
        // Anything else on this page has no browser-provided same-document
        // route — a fragment REMOVAL is not covered (the navigation algorithm
        // takes its fragment path only for a non-null destination fragment) and
        // a query change is cross-document by default. So rewrite the entry and
        // then fire what the browser would have. `pushState` is the wrapped one,
        // so the parent's path report follows.
        `history.pushState(history.state,"",t.href);` +
        // `popstate` is what every mainstream client-side router listens on, so
        // this is what re-renders the app in place. A page that reads
        // `location.search` once at load and never routes hears nothing and
        // keeps its old content under the new URL — the accepted cost of not
        // reloading (docs/258 requirements, 2026-08-10).
        `if(t.search!==c.search)fire(PopStateEvent,"popstate",{state:history.state});` +
        `if(t.hash!==c.hash)fire(HashChangeEvent,"hashchange",{oldURL:c.href,newURL:t.href});` +
        `return` +
      `}` +
      // A different path is left as a real navigation, and reloads — unless the
      // app runs its own router on the Navigation API, which gets to intercept
      // this and stay same-document.
      // A rejection here is swallowed rather than recovered from: the causes are
      // an interceptor deliberately aborting (an unsaved-changes guard) and a
      // superseding navigation, and forcing `location.assign` would override the
      // app in the first case and fight it in the second.
      `if(nav&&nav.navigate){var r=nav.navigate(t.href);` +
        `r.committed.catch(swallow);r.finished.catch(swallow);return}` +
      `location.assign(t.href)` +
    `}catch(e){}};` +
    // Let the preview toolbar drive the embedded browser's session history.
    // The iframe is cross-origin (preview subdomain / a different port), so the
    // parent can't touch `contentWindow.history` directly — it asks us to here.
    `window.addEventListener("message",function(e){` +
      `var d=e.data;if(!d||d.source!=="shipit-toolbar")return;` +
      // Only ShipIt drives these. The commands come from the window that embeds
      // us, so anything else posting them is not the toolbar.
      `if(e.source!==window.parent)return;` +
      `if(d.type==="back")travel("back");` +
      `else if(d.type==="forward")travel("forward");` +
      `else if(d.type==="navigate")go(d.url);` +
      // Refresh must reload whatever page the preview is currently on. The
      // parent can only re-assign the iframe's `src`, which is the slot's
      // original entry URL — that would throw away any client-side route the
      // user navigated to and drop them back on the front page.
      `else if(d.type==="reload")location.reload()` +
    `});` +
    // Report the current path (never the host) so the toolbar can show where
    // the preview is. The parent cannot read this itself — the iframe is
    // cross-origin — so the page has to push it out. `canGoBack` rides along
    // so the toolbar can disable Back when there is nothing behind us — false
    // without the Navigation API, matching `travel`'s refusal to traverse.
    `var rp=function(){try{window.parent.postMessage({source:"shipit-preview",` +
      `type:"path",path:location.pathname+location.search+location.hash,` +
      `canGoBack:nav?nav.canGoBack:false},"*")}catch(e){}};` +
    `rp();` +
    // A load-time read alone goes stale the instant a client-side router moves
    // without a navigation, so wrap the two History methods that do it. We patch
    // before any app code runs (this script is first in <head>), so a framework
    // that wraps history too ends up wrapping ours and `rp` still fires.
    `var wrap=function(n){var o=history[n];if(typeof o!=="function")return;` +
      `history[n]=function(){var r=o.apply(this,arguments);rp();return r}};` +
    `wrap("pushState");wrap("replaceState");` +
    `window.addEventListener("popstate",rp);` +
    `window.addEventListener("hashchange",rp);` +
    // An app that drives the Navigation API directly (`navigation.navigate()`,
    // or a router in navigation-API mode) changes the current entry without
    // touching the History methods we wrapped, so neither the path nor
    // `canGoBack` would ever update. `currententrychange` fires after any
    // same-document entry change and is the one signal that covers all of
    // them; duplicate reports are free, since the parent compares values.
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

/** Permit only ShipIt's two exact injected scripts in an upstream CSP. */
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

// ---------------------------------------------------------------------------
// Forwarded headers
// ---------------------------------------------------------------------------

/**
 * Build the request headers for an upstream proxy hop.
 *
 * Two things happen here, and they pull in opposite directions:
 *
 *  1. We rewrite `Host` to `localhost:<targetPort>`. Some dev servers do
 *     DNS-rebinding host checks (Vite's `allowedHosts`, etc.) and only trust
 *     their own loopback host, so the upstream must see a loopback Host.
 *
 *  2. But frameworks that compute a *public* root URL for their frontend —
 *     Gradio is the canonical case — derive it from `X-Forwarded-Host` /
 *     `X-Forwarded-Proto`, falling back to `Host`. Without the forwarded
 *     headers, Gradio reflects the rewritten `localhost:<port>` Host and its
 *     frontend ends up calling `localhost:<port>/gradio_api/...`. In a
 *     browser-hosted ShipIt session `localhost` is the *user's* machine, not
 *     the container, so every API call fails with ERR_CONNECTION_REFUSED.
 *
 * So we preserve the browser-facing host/proto in the forwarded headers while
 * still handing the upstream a loopback Host. Existing forwarded headers (set
 * by an upstream ShipIt ingress that may also terminate TLS) win — we only
 * fill in what's missing, so a real `https` origin isn't downgraded to `http`.
 *
 * Exported for unit testing.
 */
export function buildUpstreamHeaders(
  headers: http.IncomingHttpHeaders,
  targetPort: number,
): http.IncomingHttpHeaders {
  // The browser-facing host: an upstream-provided X-Forwarded-Host wins,
  // otherwise the inbound Host (which, for our subdomain routing, is the
  // origin the browser actually used). Capture it before we overwrite Host.
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

// ---------------------------------------------------------------------------
// Shared proxy helpers
// ---------------------------------------------------------------------------

/**
 * Callback invoked when a preview-proxy request fails to reach the upstream
 * container. Lets the registration site emit a `preview_error` WS message
 * and a Logs entry so the user gets observable feedback instead of just a
 * blank iframe / raw 502 JSON.
 *
 * `report.success(sessionId, port)` is the companion signal: the proxy calls
 * it whenever a request to that container *does* reach the upstream, which
 * cancels a pending (not-yet-surfaced) error streak. That's how a transient
 * `EHOSTUNREACH` during container/network bring-up stays silent — the next
 * successful request clears it before the grace window elapses.
 *
 * See docs/124-session-rescue-and-diagnostics §1.5.
 */
interface PreviewErrorReporter {
  (sessionId: string, port: number, message: string, upgrade: boolean): void;
  /** Mark a (sessionId, port) as reachable — clears any pending error streak. */
  success(sessionId: string, port: number): void;
}

/**
 * One attempt at proxying a preview request to the container.
 *
 * The attempt takes ownership of the response only once the upstream answers.
 * A failure to *reach* the upstream writes nothing and calls `onUnreachable`
 * instead, so the caller can try again — see `proxyPreviewRequest`, which is
 * what stops an iframe's single load from being spent on a 502 (docs/286).
 *
 * `hasBody` decides how the request is forwarded. A bodyless request is ended
 * directly rather than piped, which is what makes it replayable: `rawReq` can
 * be consumed once, so a piped request has nothing left for a second attempt.
 */
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
  // Strip accept-encoding so the upstream sends uncompressed content — allows
  // us to inject the HMR WebSocket patch into HTML responses.
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
      // Reached the upstream — clears any pending transient-error streak.
      if (onSuccess) onSuccess();
      const ct = proxyRes.headers["content-type"] || "";
      const isHtml = method === "GET" && ct.includes("text/html");

      if (isHtml) {
        // Buffer HTML response, inject HMR WebSocket patch, then send.
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
          rawRes.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          rawRes.end(html);
        });
      } else {
        rawRes.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(rawRes);
      }
    },
  );

  // Bound the connect, and only the connect — see PREVIEW_CONNECT_TIMEOUT_MS.
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
    // Past the response head the upstream already answered and the body is
    // being streamed — there is nothing to retry and no way to restate the
    // status, so close what we have.
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

// ---------------------------------------------------------------------------
// Connect retry
// ---------------------------------------------------------------------------

/**
 * How long the proxy keeps trying to reach a dev server that isn't listening
 * yet, before it answers with the connecting page.
 *
 * The window is not the whole wait a user can experience: the connecting page
 * reloads itself, and each reload opens a fresh window, so a dev server that
 * takes a minute still resolves. All this bounds is how long ONE request may
 * hold its response back — and that has a hard ceiling from the client.
 * `PreviewFrame`'s auth detector reloads the iframe when no `loaded` message
 * arrives within `MAX_AUTH_TIMEOUT_MS` (5 s) and, after two such reloads,
 * reports "Preview authentication required" — so a held first load past that
 * timer produces exactly the false claim req 6 forbids.
 *
 * The tighter bound is the pane, though. Nothing is rendered while the request
 * is held, so this window is also how long the preview can look blank instead
 * of saying "connecting" (req 4). A second of it is ordinary navigation
 * latency; more would be a stare. So: just long enough to swallow the common
 * short boot (Vite's "ready in 437 ms") with no connecting page at all, and
 * everything longer belongs to the page, which says what it is doing.
 */
const PREVIEW_CONNECT_RETRY_MS = 1_000;

/**
 * Bound on the CONNECT phase of one attempt.
 *
 * Without it a target that accepts nothing and answers nothing — a container
 * whose address is stale, so the SYN is dropped rather than refused — parks the
 * request on `await`-forever: the retry deadline is only consulted from an error
 * callback, so no error means no deadline check and no connecting page.
 *
 * Deliberately bounds the connect and NOT the response. A dev server compiling
 * a route on demand accepts at once and answers a minute later; that is a
 * working preview, and a response timeout would kill it.
 */
const PREVIEW_CONNECT_TIMEOUT_MS = 3_000;

/** Spacing between connect attempts inside {@link PREVIEW_CONNECT_RETRY_MS}. */
const PREVIEW_CONNECT_RETRY_STEP_MS = 250;

/** How often the connecting page asks whether the dev server is up yet. */
const CONNECTING_PAGE_POLL_MS = 1_000;

/** How long the connecting page waits before it shows the connect error. */
const CONNECTING_PAGE_DETAIL_MS = 30_000;

/**
 * Errors that mean "nothing is listening there yet" rather than "the app is
 * broken". Everything else is reported on the first failure, as before.
 */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

/**
 * Whether a request can be attempted more than once.
 *
 * Only a bodyless GET/HEAD qualifies: a retry re-sends the request, and a body
 * has already been consumed by the first attempt. In practice this costs
 * nothing — the request that meets a cold dev server is the iframe's own
 * navigation, and assets follow an HTML response that already proved the
 * server is up.
 */
export function isRetryablePreviewRequest(
  method: string,
  headers: http.IncomingHttpHeaders,
): boolean {
  const m = method.toUpperCase();
  if (m !== "GET" && m !== "HEAD") return false;
  return headers["content-length"] === undefined && headers["transfer-encoding"] === undefined;
}

/** Whether this request is a document navigation that should get the connecting page. */
export function wantsHtmlDocument(
  method: string,
  headers: http.IncomingHttpHeaders,
): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const accept = headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

/** Embed a value in an inline script without letting it close the script element. */
function toScriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The document served when the retry window runs out on a navigation.
 *
 * It is the "connecting" state itself (docs/286 req 4). It **polls and then
 * reloads**, rather than reloading on a timer: a blind reload every couple of
 * seconds makes the pane flash for the whole of a slow boot, and this page is
 * what the user looks at for that entire time. Polling lets one rendered
 * document sit still — spinner included — until the dev server actually
 * answers, and the reload then lands on a server that is ready.
 *
 * The poll asks for this very URL, so it is answered by the same retry path
 * that produced this page; the 503 it returns while still unreachable is the
 * signal to keep waiting. Anything else means the app is up.
 */
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
    // HMR socket connected — clears any pending transient-error streak.
    if (onSuccess) onSuccess();
    // Forward the upstream's 101 response verbatim — includes the required
    // Sec-WebSocket-Accept header and any negotiated subprotocols.
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Throttle window for repeated preview-proxy errors per `(sessionId,port)`
 * — a flapping dev server emits a connect-error per HTTP/HMR request and
 * we don't want to spam the Logs panel.
 */
const PREVIEW_ERROR_THROTTLE_MS = 5_000;

/**
 * Grace window before a preview-proxy failure surfaces. A lone connect error
 * — overwhelmingly a transient `EHOSTUNREACH`/`ECONNREFUSED` while a Compose
 * service container is still being wired into the Docker network — is held
 * back this long. If a later request to the same `(sessionId, port)` reaches
 * the upstream within the window (`report.success`), the streak is cleared and
 * nothing is shown. Only a failure that persists past the window (a genuinely
 * unreachable preview) reaches the banner/Logs. See SHI bug: false "Preview
 * unreachable" while the preview is in fact working.
 */
const PREVIEW_ERROR_GRACE_MS = 2_000;

/**
 * Build a `PreviewErrorReporter` that routes preview-proxy connection
 * failures to (a) a `preview_error` WS message for the in-frame banner
 * and (b) a per-session `log_entry` with `source: "preview"`. Throttles
 * per `(sessionId,port)` to avoid log spam.
 *
 * Exported so the integration test in
 * `integration_tests/preview-error.test.ts` can verify the wiring without
 * spinning up the whole proxy.
 *
 * See docs/124-session-rescue-and-diagnostics §1.5.
 */
export function createPreviewErrorReporter(
  runnerRegistry: SessionRunnerRegistry | undefined,
  opts: { now?: () => number; throttleMs?: number; graceMs?: number } = {},
): PreviewErrorReporter {
  const lastEmitAt = new Map<string, number>();
  /** Start time of the current unresolved failure streak, per (sessionId, port). */
  const streakStartAt = new Map<string, number>();
  const now = opts.now ?? (() => Date.now());
  const throttleMs = opts.throttleMs ?? PREVIEW_ERROR_THROTTLE_MS;
  const graceMs = opts.graceMs ?? PREVIEW_ERROR_GRACE_MS;

  const report = ((sessionId, port, message, upgrade) => {
    if (!runnerRegistry) return;
    const runner = runnerRegistry.get(sessionId);
    if (!runner) return;
    const key = `${sessionId}:${port}`;
    const t = now();

    // Hold a failure back until it proves sustained. The first error in a
    // streak only starts the clock; a transient bring-up error recovers on the
    // next successful request (report.success), which clears the streak before
    // the grace window elapses, so it never surfaces.
    const streakStart = streakStartAt.get(key);
    if (streakStart === undefined) {
      streakStartAt.set(key, t);
      return;
    }
    if (t - streakStart < graceMs) return;

    // Sustained past the grace window — surface it, throttled to avoid spam
    // from a flapping dev server emitting an error per HTTP/HMR request.
    const last = lastEmitAt.get(key) ?? 0;
    if (t - last < throttleMs) return;
    lastEmitAt.set(key, t);
    const human = upgrade
      ? `Preview HMR unreachable on port ${port} (${message})`
      : `Preview unreachable on port ${port} (${message})`;
    runner.emitMessage({
      type: "preview_error",
      sessionId,
      port,
      message,
      upgrade,
    });
    runner.emitMessage({
      type: "log_append",
      channel: "agent",
      records: [{ ts: new Date(t).toISOString(), source: "preview", text: human }],
    });
  }) as PreviewErrorReporter;

  // A request reached the upstream — the preview is alive, so abandon any
  // pending error streak for this (sessionId, port).
  report.success = (sessionId, port) => {
    streakStartAt.delete(`${sessionId}:${port}`);
  };

  return report;
}

export function registerPreviewProxy(
  app: FastifyInstance,
  opts: {
    containerManager: SessionContainerManager;
    serviceManagers: Map<string, ServiceManager>;
    /**
     * Optional runner registry. When provided, proxy errors emit a
     * `preview_error` runner event so connected viewers see an inline
     * "Preview unreachable on port N" overlay, and a `log_entry` so the
     * Logs panel records the failure. Without this, proxy errors are
     * iframe-only — the orchestrator side has no record. See
     * docs/124-session-rescue-and-diagnostics §1.5.
     */
    runnerRegistry?: SessionRunnerRegistry;
    /**
     * How long to keep retrying a connect before answering with the connecting
     * page. Defaults to {@link PREVIEW_CONNECT_RETRY_MS}; tests set it to 0 to
     * reach the exhaustion path without waiting out the real window.
     */
    connectRetryMs?: number;
  },
): void {
  const { containerManager, serviceManagers, runnerRegistry } = opts;
  const connectRetryMs = opts.connectRetryMs ?? PREVIEW_CONNECT_RETRY_MS;

  const reportError = createPreviewErrorReporter(runnerRegistry);

  /**
   * Resolve the container address behind a preview subdomain's port.
   *
   * Compose services first, then the agent container. The returned port is
   * always the one in the subdomain: every service — the project's own and a
   * plugin's alike — serves on one number that is both its container port and
   * its preview origin (docs/266-plugin-service-ports req 10). A plugin service used to carry a
   * second, pinned number here; the port is now the consuming project's to
   * write, so nothing can move it behind a session's back and the indirection
   * is gone.
   */
  function resolveTarget(sessionId: string, port: number): { ip: string; port: number } | null {
    const mgr = serviceManagers.get(sessionId);
    const target = mgr?.resolvePreviewTarget(port);
    if (target) return { ip: target.containerIp, port: target.port };
    // Fall back to the agent container
    const sc = containerManager.get(sessionId);
    return sc?.containerIp ? { ip: sc.containerIp, port } : null;
  }

  /**
   * Proxy one preview request, retrying the connect while the dev server is
   * still coming up (docs/286).
   *
   * Two failures mean the same thing to a user opening a preview too early, so
   * both are retried on the one loop: no target yet (the Compose service has no
   * container and the agent container isn't registered — previously a hard 404)
   * and a target that refuses the connection. The target is re-resolved on every
   * attempt, so a container that changes address is picked up.
   *
   * The failure is reported once, when the window is exhausted, rather than per
   * attempt — `createPreviewErrorReporter` then sees a request that genuinely
   * failed instead of a transient bring-up error (req 5).
   */
  function proxyPreviewRequest(
    sessionId: string,
    originPort: number,
    rawReq: http.IncomingMessage,
    rawRes: http.ServerResponse,
    url: string,
    method: string,
    headers: http.IncomingHttpHeaders,
  ): void {
    // The same test answers both questions: a request we can replay is exactly
    // one with no body to forward.
    const canRetry = isRetryablePreviewRequest(method, headers);
    const deadline = Date.now() + connectRetryMs;
    // A viewer that navigates away, switches session, or closes the tab must
    // not leave a retry timer running, nor an upstream socket connecting, for a
    // response nobody is reading. One listener for the whole request, not one
    // per attempt: the window allows ~40 of those.
    let abandoned = false;
    let inFlight: http.ClientRequest | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    rawRes.on("close", () => {
      abandoned = true;
      if (retryTimer) clearTimeout(retryTimer);
      // A finished response closes too. Only an unfinished one is an abandon,
      // and only there is destroying the upstream right.
      if (!rawRes.writableEnded && inFlight && !inFlight.destroyed) inFlight.destroy();
    });

    function attempt(): void {
      if (abandoned) return;
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
      // Reported against the ORIGIN's port, which is what the user's address
      // bar uses. Only here, at exhaustion — never per attempt — so a boot that
      // resolves inside the window says nothing at all, and
      // `createPreviewErrorReporter`'s own grace window then holds even this
      // back until a second request fails (req 5). `preview_error` paints the
      // pane's banner and writes a Logs line; it does not reach auto-fix, which
      // watches the captured-console errors (`useAutoFix`).
      reportError(sessionId, originPort, message, false);
      if (wantsHtmlDocument(method, headers)) {
        const body = injectPreviewBootstrap(buildConnectingPage(originPort, message));
        rawRes.writeHead(503, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Length": String(Buffer.byteLength(body)),
        });
        rawRes.end(body);
        return;
      }
      // Not a navigation — an asset or an XHR must not be handed HTML.
      rawRes.writeHead(502, { "Content-Type": "application/json" });
      rawRes.end(JSON.stringify({ error: "Container preview unreachable" }));
    }

    attempt();
  }

  // --- Subdomain-based proxy (intercepts before Fastify routing) ----------
  //
  // When Host matches {uuid}--{port}.*, proxy the entire request to the
  // container. This lets the dev server's absolute paths (/src/main.tsx)
  // resolve naturally — no HTML rewriting needed.

  app.addHook("onRequest", (request, reply, done) => {
    const parsed = parsePreviewSubdomain(request.headers.host);
    if (!parsed) {
      done(); // Not a preview subdomain — continue normal routing
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

  // --- WebSocket upgrade proxy (subdomain) -------------------------------
  //
  // @fastify/websocket registers its own `upgrade` listener (for /ws).
  // Both listeners fire for every upgrade request. For preview WebSockets,
  // Fastify's handler finds no matching route and destroys the socket before
  // our proxy can use it. Fix: take over the upgrade event — handle preview
  // WebSockets ourselves, delegate everything else to the original handlers.

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
      // Try subdomain-based first
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

      // Not a preview WebSocket — forward to original handlers (Fastify /ws)
      for (const listener of originalUpgradeListeners) {
        listener.call(app.server, req, socket, head);
      }
    },
  );
}
