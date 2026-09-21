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
  // Anchored on the FIRST label, with the proxy's own uuid--port grammar
  // (`parsePreviewSubdomain`). A looser `.*--(\d+)\.` matches greedily, so a
  // deployment host that itself contains `--<digits>.` would have *its* label
  // rewritten instead of the preview port — and the origin check could not
  // catch it, because it compares against that same wrongly built origin.
  const hostParts =
    /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}--)(\d+)(\..*)$/i
      .exec(location.host);

  // Sets, not object literals: a service may legitimately be named
  // `constructor`, and an inherited property reads as "already requested".
  const warned = new Set<string>();
  const startRequested = new Set<string>();

  const warn = (message: string): void => {
    if (warned.has(message)) return;
    warned.add(message);
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
   * Drop ShipIt's own presentation knob wherever it appears. It selects how a
   * *pointer* looks and means nothing in an embed, so leaving it in would hand
   * the framed page a parameter that is not the author's
   * (docs/258-agent-authored-links req 11) - which that feature's parser reads
   * on either side of the `#` for the same reason.
   *
   * Only the `?` that introduced the parameter goes with it. A fragment's own
   * query is otherwise left byte-for-byte, because `#/items?focus=7` is a hash
   * router's URL and belongs to the page.
   */
  const stripRenderParam = (section: string): string => {
    const queryAt = section.indexOf("?");
    if (queryAt < 0) return section;
    const kept: string[] = [];
    for (const segment of section.slice(queryAt + 1).split("&")) {
      const eq = segment.indexOf("=");
      const key = eq < 0 ? segment : segment.slice(0, eq);
      if (decodePart(key) !== renderParam) kept.push(segment);
    }
    const rebuilt = kept.length ? `?${kept.join("&")}` : "";
    return `${section.slice(0, queryAt)}${rebuilt}`;
  };

  /**
   * Split on the FIRST `#`, then strip the parameter from each side. Splitting
   * is what makes the two sides behave alike: reading `indexOf("?")` across the
   * whole address finds the fragment's `?` when there is no query before it, so
   * the same address was stripped or kept depending on what stood beside it.
   */
  const stripRender = (target: string): string => {
    const hashAt = target.indexOf("#");
    if (hashAt < 0) return stripRenderParam(target);
    const head = stripRenderParam(target.slice(0, hashAt));
    const fragment = stripRenderParam(target.slice(hashAt + 1));
    return fragment === "" ? head : `${head}#${fragment}`;
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
    // A network-path reference carries its own authority, so it can hold
    // credentials that survive the origin check. `shipit-link.ts` refuses a
    // path beginning with two slashes and so does this.
    if (target.startsWith("//")) {
      warn("An embed path must begin with a single /");
      return null;
    }
    target = stripRender(target);

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
    if (startRequested.has(service)) return;
    startRequested.add(service);
    try {
      parent.postMessage({ source, type: "embed_start_service", name: service }, "*");
    } catch {
      // A closed or cross-origin-restricted parent is not an error here.
    }
  };

  /**
   * Wait until the embed is actually scrolled into view, so a page listing many
   * services boots the ones the reader reaches rather than all of them on open.
   *
   * At most one pending observer per element, and it is dropped when that
   * element is pointed somewhere else: an offscreen iframe retargeted from one
   * service to another would otherwise keep the first observer alive and start
   * a service that was never on screen under any address.
   */
  const pending = new WeakMap<Element, IntersectionObserver>();

  const cancelPending = (element: Element): void => {
    const observer = pending.get(element);
    if (!observer) return;
    observer.disconnect();
    pending.delete(element);
  };

  const startWhenVisible = (element: Element, service: string): void => {
    cancelPending(element);
    if (parent === window) return;
    if (startRequested.has(service)) return;
    if (typeof IntersectionObserver !== "function") {
      requestStart(service);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        cancelPending(element);
        // The element may have been pointed elsewhere while it waited.
        if (element.getAttribute("data-shipit-service") === service) requestStart(service);
        return;
      }
    });
    pending.set(element, observer);
    observer.observe(element);
  };

  const isIframe = (element: Element): boolean =>
    element.tagName?.toLowerCase() === "iframe";

  /**
   * The iframe test lives HERE and not only in `scan`, because the attribute
   * branch of the mutation observer reaches any element whose `src` changed -
   * an image given a shipit-preview src after insertion would otherwise be
   * rewritten and would request a service start.
   */
  const rewrite = (element: Element): void => {
    if (!isIframe(element)) return;
    const href = element.getAttribute("src");
    if (!href || !looksLikeScheme(href)) return;
    const resolved = resolve(href);
    if (!resolved) {
      cancelPending(element);
      return;
    }
    element.setAttribute("data-shipit-service", resolved.service);
    element.setAttribute("src", resolved.url);
    startWhenVisible(element, resolved.service);
  };

  // Open shadow roots are walked and observed too: a web component that renders
  // an embed is exactly the "an iframe your framework creates later" case, and
  // neither a descendant query nor an observer on the host crosses that
  // boundary. This catches a root attached by the time its host is scanned,
  // which is where a custom element normally attaches one; a root attached
  // later, and a closed one, stay out of reach.
  const observed = new WeakSet<Node>();

  const observeRoot = (target: Node): void => {
    if (typeof MutationObserver !== "function") return;
    if (observed.has(target)) return;
    observed.add(target);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target.nodeType === 1) rewrite(record.target as Element);
          continue;
        }
        for (const added of Array.from(record.addedNodes)) scan(added);
      }
    }).observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  };

  const scanShadow = (element: Element): void => {
    const shadow = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (!shadow) return;
    observeRoot(shadow);
    for (const child of Array.from(shadow.children)) scan(child);
  };

  const scan = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    rewrite(element);
    scanShadow(element);
    for (const nested of Array.from(element.getElementsByTagName("*"))) {
      if (isIframe(nested)) rewrite(nested);
      scanShadow(nested);
    }
  };

  const root = document.documentElement;
  if (root) {
    scan(root);
    observeRoot(root);
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
