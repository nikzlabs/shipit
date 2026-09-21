/**
 * Embedding a Compose service by name (docs/313-embedded-preview-services).
 *
 * `shipit-preview://<service>/<path>` works as a link because ShipIt's own code
 * resolves it on a click it observed. As an `<iframe src>` it is resolved by the
 * **browser**, inside a document ShipIt did not author, at parse time — and a
 * browser cannot resolve an unregistered scheme in `src` at all. So the address
 * has to become a real URL before the browser is asked to load it, and the only
 * code that runs in a previewed document is what the proxy injects there.
 *
 * This script is that injection. It rewrites the **live DOM**, never the page's
 * markup bytes: an iframe a framework creates later is rewritten exactly as a
 * literal tag in the source is (req 9), and ShipIt never parses or re-serialises
 * a document it does not own.
 *
 * Keep it dependency-free — the serialized body runs outside the ShipIt bundle.
 */
function installShipItEmbedResolver(): void {
  const scheme = "shipit-preview:";
  const source = "shipit-preview";
  const renderParam = "shipit-render";
  const maxHrefLength = 2048;

  const current = document.currentScript;
  let ports: Record<string, unknown> = {};
  try {
    const raw = current ? current.getAttribute("data-shipit-services") : null;
    if (raw) ports = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    ports = {};
  }

  // A previewed page is served at `{sessionId}--{port}.{host}`, so a sibling
  // service's origin is this one with the port segment replaced. Deriving it
  // from our own address is why the session id never has to be injected, and
  // why an embed can address nothing outside its own session.
  const hostParts = /^(.*--)(\d+)(\..*)$/.exec(location.host);

  const warned: Record<string, boolean> = {};
  const startRequested: Record<string, boolean> = {};

  const warn = (message: string): void => {
    if (warned[message]) return;
    warned[message] = true;
    try {
      console.warn(`[ShipIt preview] ${message}`);
    } catch {
      // A page that replaced console is not worth failing the rewrite over.
    }
  };

  const looksLikeScheme = (value: string): boolean =>
    value.trim().toLowerCase().startsWith(scheme);

  const decodePart = (raw: string): string => {
    try {
      return decodeURIComponent(raw.replace(/\+/g, " "));
    } catch {
      return raw;
    }
  };

  /**
   * Drop ShipIt's own presentation knob. It selects how a *pointer* looks and
   * means nothing in an embed, so leaving it in would hand the framed page a
   * parameter that is not the author's (docs/258-agent-authored-links req 11).
   * Only the query position is read: an embed address is authored fresh, not
   * copied off a rendered chat pointer, which is where the after-the-fragment
   * spelling comes from.
   */
  const stripRenderParam = (target: string): string => {
    const queryAt = target.indexOf("?");
    if (queryAt < 0) return target;
    const hashAt = target.indexOf("#", queryAt);
    const query = hashAt < 0 ? target.slice(queryAt + 1) : target.slice(queryAt + 1, hashAt);
    const tail = hashAt < 0 ? "" : target.slice(hashAt);
    const kept: string[] = [];
    for (const segment of query.split("&")) {
      const eq = segment.indexOf("=");
      const key = eq < 0 ? segment : segment.slice(0, eq);
      if (decodePart(key) !== renderParam) kept.push(segment);
    }
    const rebuilt = kept.length ? `?${kept.join("&")}` : "";
    return `${target.slice(0, queryAt)}${rebuilt}${tail}`;
  };

  const resolve = (href: string): { url: string; service: string } | null => {
    const raw = href.trim();
    if (!looksLikeScheme(raw)) return null;
    if (raw.length > maxHrefLength) {
      warn("Ignored an embed address that is too long.");
      return null;
    }
    // URL parsing folds `\` into `/` and strips tab/CR/LF anywhere in the
    // input, so these must be refused before resolution, never after.
    if (/[\\\t\n\r]/.test(raw)) {
      warn("Ignored an embed address that is not valid.");
      return null;
    }
    const rest = raw.slice(scheme.length);
    if (!rest.startsWith("//")) {
      warn("An embed address needs a service name, as shipit-preview://<service>/<path>");
      return null;
    }
    const afterAuthority = rest.slice(2);
    const end = afterAuthority.search(/[/?#]/);
    const service = end < 0 ? afterAuthority : afterAuthority.slice(0, end);
    if (!service) {
      warn("Ignored an embed address that names no service.");
      return null;
    }

    // Exact match against the declared services, never a prefix or a fuzzy one.
    const port = Object.prototype.hasOwnProperty.call(ports, service) ? ports[service] : undefined;
    if (typeof port !== "number") {
      warn(`This project declares no service named "${service}" with a port to preview.`);
      return null;
    }
    if (!hostParts) {
      warn("Embedding a service needs a preview subdomain, which this host does not have.");
      return null;
    }

    let target = end < 0 ? "/" : afterAuthority.slice(end);
    if (!target.startsWith("/")) target = `/${target}`;
    target = stripRenderParam(target);

    const origin = `${location.protocol}//${hostParts[1]}${port}${hostParts[3]}`;
    let resolved: URL;
    try {
      resolved = new URL(target, origin);
    } catch {
      warn("Ignored an embed address that is not valid.");
      return null;
    }
    // The guard that actually holds the boundary: whatever the path did, the
    // result must still be the sibling service's own origin.
    if (resolved.origin !== new URL(origin).origin) {
      warn("Ignored an embed address that points outside the preview.");
      return null;
    }
    return { url: resolved.href, service };
  };

  /**
   * Ask ShipIt to start the service this embed names (req 5). The page never
   * decides: it says what it wants, and ShipIt applies the status check, the
   * active-and-visible gate and the cooldown. An embed nested inside another
   * embed posts to the embedding page rather than to ShipIt, so nothing starts —
   * which is the intended dead end.
   */
  const requestStart = (service: string): void => {
    if (startRequested[service]) return;
    startRequested[service] = true;
    try {
      parent.postMessage({ source, type: "embed_start_service", name: service }, "*");
    } catch {
      // A closed or cross-origin-restricted parent is not an error here.
    }
  };

  // Once the embed is actually scrolled into view, so a page listing many
  // services boots the ones the reader reaches rather than all of them on open.
  const startWhenVisible = (element: Element, service: string): void => {
    if (parent === window) return;
    if (startRequested[service]) return;
    if (typeof IntersectionObserver !== "function") {
      requestStart(service);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.disconnect();
        requestStart(service);
        return;
      }
    });
    observer.observe(element);
  };

  const rewrite = (element: Element): void => {
    const href = element.getAttribute("src");
    if (!href || !looksLikeScheme(href)) return;
    const resolved = resolve(href);
    if (!resolved) return;
    element.setAttribute("data-shipit-service", resolved.service);
    element.setAttribute("src", resolved.url);
    startWhenVisible(element, resolved.service);
  };

  const scan = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.tagName?.toLowerCase() === "iframe") rewrite(element);
    for (const nested of Array.from(element.getElementsByTagName("iframe"))) rewrite(nested);
  };

  const root = document.documentElement;
  if (root) scan(root);

  if (typeof MutationObserver === "function" && root) {
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target.nodeType === 1) rewrite(record.target as Element);
          continue;
        }
        for (const added of Array.from(record.addedNodes)) scan(added);
      }
    }).observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    if (document.documentElement) scan(document.documentElement);
  });
}

export const EMBED_RESOLVER_MARKER = "data-shipit-services";

// tsx keepNames inserts __name calls, but toString omits the module-level helper.
export const EMBED_RESOLVER_SOURCE =
  `(function(){var __name=function(value){return value};(${installShipItEmbedResolver.toString()})()})();`;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/**
 * The service→port map rides as an **attribute**, not as a value baked into the
 * script body, and that is load-bearing: `allowPreviewBootstrapInCsp` permits
 * ShipIt's injected scripts under a page's own CSP by `sha256` of the script's
 * *content*, computed once at module load. A per-session map in the body would
 * vary the content per response and so the hash with it. A CSP hash does not
 * cover attributes, so this keeps the body constant and the hash list correct.
 */
export function buildEmbedResolverScript(ports: Record<string, number>): string {
  const attribute = escapeAttribute(JSON.stringify(ports));
  return `<script ${EMBED_RESOLVER_MARKER}="${attribute}">${EMBED_RESOLVER_SOURCE}</script>`;
}
