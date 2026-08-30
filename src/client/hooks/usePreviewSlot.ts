// eslint-disable-next-line no-restricted-imports -- useEffect: mirror the active (session, port) into the iframe pool, an external DOM-backed store
import { useEffect } from "react";
import { usePreviewStore } from "../stores/preview-store.js";
import type { PreviewStatus } from "../components/PreviewFrame.js";
import type { IframeSlot } from "./useIframePool.js";

/**
 * Build a subdomain URL for container-mode previews.
 * Pattern: {sessionId}--{port}.{apiHostname}:{apiPort}
 *
 * Returns `null` when the host ShipIt is reached on cannot carry a wildcard
 * subdomain — a raw IPv4/IPv6 literal (you can't make `{id}--{port}.1.2.3.4`
 * resolve). The caller treats `null` as "no working preview URL for this host"
 * and surfaces an empty-state rather than a broken iframe. Every other host
 * (localhost, a dotted domain, a Tailscale name) gets a subdomain URL; whether
 * it actually resolves is the deployment's wildcard-DNS responsibility.
 */
function buildSubdomainUrl(
  sessionId: string,
  port: number,
  apiHost: string,
  // Protocol for the preview origin. Defaults to the page's protocol, but the
  // Tailscale sslip override (docs/216) passes "http:" explicitly because the
  // sslip host has no TLS cert. Must not blindly inherit window.location.protocol
  // or an HTTPS app would emit an https://…sslip… URL with no cert.
  protocol: string = window.location.protocol,
): string | null {
  // IPv6 literal hosts arrive bracketed from `window.location.host`
  // ("[::1]:3000", "[2001:db8::1]:8080"). Handle them before the ":"-split
  // below, which would otherwise shred the literal into a garbage hostname
  // (e.g. "[") and emit a non-null but unresolvable subdomain URL — defeating
  // the empty-state. Loopback (`::1`) normalizes to `localhost` like 127.x;
  // any other IPv6 literal can't carry a wildcard subdomain, so return null.
  const v6 = /^\[([0-9a-fA-F:]+)\](?::(\d+))?$/.exec(apiHost);
  if (v6) {
    if (v6[1] === "::1") {
      const portSuffix = v6[2] ? `:${v6[2]}` : "";
      return `${protocol}//${sessionId}--${port}.localhost${portSuffix}/`;
    }
    return null;
  }
  const [rawHostname, apiPort] = apiHost.includes(":") ? apiHost.split(":") as [string, string] : [apiHost, ""];
  const apiHostname = /^(127\.\d+\.\d+\.\d+|::1)$/.test(rawHostname) ? "localhost" : rawHostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(apiHostname) || apiHostname.includes(":")) return null;
  const portSuffix = apiPort ? `:${apiPort}` : "";
  return `${protocol}//${sessionId}--${port}.${apiHostname}${portSuffix}/`;
}

/**
 * Compute the preview URL for a given session/port/preview status.
 *
 * For container previews this is always the subdomain URL — there is no
 * path-based fallback (it can't render real apps: absolute asset paths 404
 * without the `/preview/{id}/{port}` prefix). When no subdomain can be built
 * (raw-IP host), returns `null` so PreviewFrame shows the empty-state.
 *
 * `path` is the slot's remembered location (`previewPaths` in the preview
 * store). Creating a slot is what happens after every event that drops an
 * iframe — LRU eviction, a `PreviewFrame` unmount, a page reload — and
 * entering at the origin root would silently send the user back to the app's
 * front page each time. It is sanitized at the store boundary, and resolved
 * against the origin here so a value that somehow isn't same-origin cannot
 * point the iframe at another host.
 */
function computePreviewUrl(
  sessionId: string,
  port: number,
  preview: PreviewStatus,
  apiHost: string,
  apiProtocol: string = window.location.protocol,
  path?: string | null,
): { url: string; containerMode: boolean } | null {
  if (!preview.running || !port) return null;
  const isContainer = preview.url?.startsWith("/preview/") ?? false;
  const base = isContainer
    ? buildSubdomainUrl(sessionId, port, apiHost, apiProtocol)
    : `http://localhost:${port}`;
  if (!base) return null;
  return { url: withPath(base, path), containerMode: isContainer };
}

/** Resolve `path` against `base`, keeping the result on `base`'s origin. */
function withPath(base: string, path?: string | null): string {
  if (!path) return base;
  try {
    const resolved = new URL(path, base);
    if (resolved.origin !== new URL(base).origin) return base;
    return resolved.href;
  } catch {
    return base;
  }
}

/**
 * Where a freshly created slot should enter: a live agent-authored destination
 * for this slot if there is one, otherwise the path the page last reported about
 * itself. Read from the store at slot-creation time, never through a dep.
 */
export function desiredPathFor(slotKey: string, sessionId: string | undefined): string | undefined {
  const state = usePreviewStore.getState();
  const intent = state.previewLinkIntent;
  if (intent?.slotKey === slotKey && intent.sessionId === sessionId) return intent.targetPath;
  return state.previewPaths[slotKey];
}

export interface UsePreviewSlotParams {
  activeSlotKey: string | null;
  activePort: number;
  sessionId: string | undefined;
  preview: PreviewStatus | null;
  apiHost: string;
  /** Protocol for preview origins — `http:` for the Tailscale sslip override (docs/216), else the page protocol. */
  apiProtocol: string;
  /** Shared with `useIframePool` — tracks slots that have already been created. */
  createdSlotsRef: React.RefObject<Set<string>>;
  /** Promote the slot in the LRU pool. */
  promoteSlot: (key: string) => void;
  /** Add/update a slot in the iframe pool. */
  setSlot: (key: string, slot: IframeSlot) => void;
  /** Read a slot from the pool (stable identity — not the reactive `slots`). */
  getSlot: (key: string) => IframeSlot | undefined;
  /** Drop a slot whose port changed owner (the pool's one non-LRU drop). */
  dropSlot: (key: string) => void;
  /**
   * The Compose service that currently owns `activePort`, or `undefined`
   * when none is known. Compared with the owner recorded on a retained slot
   * (planning#394): a port that moved to a different service must not keep
   * serving the previous owner's already-loaded document.
   */
  activeService: string | undefined;
  /**
   * True while the pane is parked on a service that is not running
   * (planning#478). Creating a slot then would put a document behind the
   * waiting overlay and keep it there, because a created slot is only ever
   * promoted afterwards, never reloaded.
   */
  waitingForService: boolean;
}

/**
 * Create the iframe slot for the active `(session, port)`. The hook is the sole
 * driver of new slot creation — if a slot already exists for the active key,
 * it's promoted in the LRU instead. The one exception: a slot whose port has
 * been taken over by a different service (both owners known, differing) is
 * dropped and recreated, so the new iframe loads the new owner's app instead of
 * showing the previous owner's document (planning#394).
 *
 * The slot is created straight away, with no reachability check first. Waiting
 * used to be necessary because a request that arrived before the dev server
 * listened got a 502 that the iframe then kept forever; the proxy now retries
 * the connect itself and serves a self-refreshing connecting page past its
 * window, so the browser's own request is the only test of reachability there
 * is, and the wait belongs to the document rather than to this pane (docs/286).
 */
export function usePreviewSlot(params: UsePreviewSlotParams): void {
  const {
    activeSlotKey,
    activePort,
    sessionId,
    preview,
    apiHost,
    apiProtocol,
    createdSlotsRef,
    promoteSlot,
    setSlot,
    getSlot,
    dropSlot,
    activeService,
    waitingForService,
  } = params;

  // eslint-disable-next-line no-restricted-syntax -- external system sync: the iframe pool is DOM-backed state outside React's tree, and the slot must exist before the iframe it owns is rendered
  useEffect(() => {
    if (!activeSlotKey || !activePort || !preview?.running) return;
    // Wait. When the service comes back this effect re-runs and either promotes
    // the retained slot (which `PreviewFrame` reloads) or creates a new one.
    if (waitingForService) return;

    // If slot already exists (previously visited), just promote it — unless
    // the port has been taken over by a different service since the slot was
    // created. The key is `${sessionId}:${port}`, so a port that moves to a
    // new owner reuses the key, and the retained iframe would keep serving
    // the previous owner's document under the new owner's row (planning#394).
    // Dropping falls through to the creation below, which recreates the slot
    // with the new owner's app.
    //
    // Both owners must be known: `undefined` on either side is a transient
    // service-list state (or a preview with no service rows at all), and
    // evicting on it would drop slots during ordinary list updates.
    const existing = getSlot(activeSlotKey);
    if (
      existing?.service !== undefined &&
      activeService !== undefined &&
      existing.service !== activeService
    ) {
      dropSlot(activeSlotKey);
    } else if (createdSlotsRef.current.has(activeSlotKey)) {
      promoteSlot(activeSlotKey);
      return;
    }

    const key = activeSlotKey;

    // Compute the URL and add the slot. The remembered path is read here rather
    // than through a dep, so this effect doesn't re-run on every navigation
    // inside an already-created slot.
    //
    // An agent-authored pointer waiting on this slot wins over the remembered
    // path (docs/258): it is where the user just asked to go, and the
    // remembered path is only where the previous page happened to be. Entering
    // at the destination is also what makes a pointer to a stopped service
    // work — the slot is created after the boot, already at the right place.
    const result = computePreviewUrl(
      sessionId ?? "_",
      activePort,
      preview,
      apiHost,
      apiProtocol,
      desiredPathFor(key, sessionId),
    );
    if (result) {
      createdSlotsRef.current.add(key);
      // The owner recorded at creation is this effect's `activeService`: if
      // it changes, the effect re-runs and the promote branch above decides
      // whether a retained slot's recorded owner still matches the port's.
      setSlot(key, { url: result.url, containerMode: result.containerMode, service: activeService });
      promoteSlot(key);
    }
  }, [activeSlotKey, activePort, sessionId, preview?.running, preview?.url, apiHost, apiProtocol, promoteSlot, setSlot, getSlot, dropSlot, activeService, waitingForService, preview, createdSlotsRef]);
}

// Re-export internal helpers for the consuming component, which also needs
// `buildSubdomainUrl` for the auth-blocked detection logic.
export { buildSubdomainUrl, computePreviewUrl };
