// eslint-disable-next-line no-restricted-imports -- useEffect: poll external preview server URL until ready with cancellation (external system sync)
import { useEffect } from "react";
import type { PreviewStatus } from "../components/PreviewFrame.js";
import type { IframeSlot } from "./useIframePool.js";

/**
 * Build a subdomain URL for container-mode previews.
 * Pattern: {sessionId}--{port}.{apiHostname}:{apiPort}
 */
type PreviewSubdomainMode = "auto" | "always";

function buildSubdomainUrl(
  sessionId: string,
  port: number,
  apiHost: string,
  mode: PreviewSubdomainMode = "auto",
): string | null {
  const [rawHostname, apiPort] = apiHost.includes(":") ? apiHost.split(":") as [string, string] : [apiHost, ""];
  const apiHostname = /^(127\.\d+\.\d+\.\d+|::1)$/.test(rawHostname) ? "localhost" : rawHostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(apiHostname) || apiHostname.includes(":")) return null;
  if (mode !== "always") {
    if (
      (apiHostname !== "localhost" && !apiHostname.includes(".")) ||
      apiHostname.endsWith(".ts.net") ||
      apiHostname.endsWith(".beta.tailscale.net")
    ) return null;
  }
  const portSuffix = apiPort ? `:${apiPort}` : "";
  return `${window.location.protocol}//${sessionId}--${port}.${apiHostname}${portSuffix}/`;
}

/**
 * Compute the preview URL for a given session/port/preview status.
 */
function computePreviewUrl(
  sessionId: string,
  port: number,
  preview: PreviewStatus,
  apiHost: string,
  mode: PreviewSubdomainMode = "auto",
): { url: string; containerMode: boolean } | null {
  if (!preview.running || !port) return null;
  const isContainer = preview.url?.startsWith("/preview/") ?? false;
  if (isContainer) {
    const subdomain = buildSubdomainUrl(sessionId, port, apiHost, mode);
    const url = subdomain ?? preview.url;
    return { url, containerMode: true };
  }
  return { url: `http://localhost:${port}`, containerMode: false };
}

export interface UsePreviewHealthPollerParams {
  activeSlotKey: string | null;
  activePort: number;
  sessionId: string | undefined;
  preview: PreviewStatus | null;
  pollUrl: string | null;
  isContainerMode: boolean;
  apiHost: string;
  previewSubdomainMode: PreviewSubdomainMode;
  /** Shared with `useIframePool` — tracks slots that have already been created. */
  createdSlotsRef: React.RefObject<Set<string>>;
  /** Shared with `useIframePool` — tracks slots currently being polled. */
  pollingRef: React.RefObject<Set<string>>;
  /** Promote the slot in the LRU pool. */
  promoteSlot: (key: string) => void;
  /** Add/update a slot in the iframe pool. */
  setSlot: (key: string, slot: IframeSlot) => void;
}

/**
 * Poll the preview server's health endpoint (container mode) or root URL
 * (local mode) and create an iframe slot once it responds. The hook is the
 * sole driver of new slot creation — if a slot already exists for the active
 * key, it's promoted in the LRU and no polling happens.
 *
 * Cancellation invariant: only the effect that "owns" a `pollingRef` entry
 * (the one that added it on mount) may remove it. The cleanup function is
 * that owner. The async `poll()` body must NEVER call `pollingRef.delete()`
 * on its own — if a re-render cancels poll #1 mid-loop, the cleanup removes
 * its key; poll #2 then adds the SAME key back; if poll #1 also called
 * `pollingRef.delete()` after the loop, it would remove poll #2's entry.
 * The next dep change would then see `pollingRef.has(key) === false` and
 * start poll #3 alongside the still-running poll #2 — a duplicate-poll
 * cascade that, in the worst case (a long-running poll like the dogfood
 * dev-container 15s timeout), can hold the spinner overlay open
 * indefinitely while the iframe slot is never actually created.
 */
export function usePreviewHealthPoller(params: UsePreviewHealthPollerParams): void {
  const {
    activeSlotKey,
    activePort,
    sessionId,
    preview,
    pollUrl,
    isContainerMode,
    apiHost,
    previewSubdomainMode,
    createdSlotsRef,
    pollingRef,
    promoteSlot,
    setSlot,
  } = params;

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    if (!activeSlotKey || !activePort || !preview?.running || !pollUrl) return;

    // If slot already exists (previously visited), just promote it
    if (createdSlotsRef.current.has(activeSlotKey)) {
      promoteSlot(activeSlotKey);
      return;
    }

    // Prevent duplicate polls for the same key
    if (pollingRef.current.has(activeSlotKey)) return;
    pollingRef.current.add(activeSlotKey);

    const state = { cancelled: false };
    const key = activeSlotKey;

    const poll = async () => {
      // Two bounds matter, and the loop must respect both:
      //   - per-fetch timeout (AbortSignal.timeout). Without this, a single
      //     hung `/api/preview-health` response strands the loop on
      //     `await fetch(...)` — `i < 60` never advances and the post-loop
      //     slot-creation never fires, so the "Connecting to dev server..."
      //     spinner stays up forever. Seen in dogfooding when the outer
      //     orchestrator is slow to respond to the health endpoint.
      //   - wall-clock deadline. Even with a per-fetch timeout, repeated
      //     slow fetches would compound: 60 × (2s + 250ms) ≈ 135s worst case
      //     without a wall-clock cap. The deadline keeps total polling at
      //     ~15s so the user never waits longer than that before the iframe
      //     gets created anyway.
      // The 250ms inter-iteration sleep keeps the loop reactive when the
      // dev server comes up fast (dogfood Vite "ready in 437ms").
      const deadline = Date.now() + 15_000;
      for (let i = 0; i < 60 && !state.cancelled; i++) {
        if (Date.now() >= deadline) break;
        try {
          if (isContainerMode) {
            const resp = await fetch(pollUrl, { signal: AbortSignal.timeout(2000) });
            const data = await resp.json() as { ready?: boolean };
            if (data.ready) break;
          } else {
            await fetch(pollUrl, { mode: "no-cors", signal: AbortSignal.timeout(2000) });
            break;
          }
        } catch {
          // Network error or fetch timeout — retry
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      if (state.cancelled) return;
      // Successful (non-cancelled) completion: clean up our own polling-ref
      // entry now that nobody else will (the cleanup function below only
      // fires on cancellation/unmount).
      pollingRef.current.delete(key);

      // Compute the URL and add the slot
      const result = computePreviewUrl(sessionId ?? "_", activePort, preview, apiHost, previewSubdomainMode);
      if (result) {
        createdSlotsRef.current.add(key);
        setSlot(key, { url: result.url, containerMode: result.containerMode });
        promoteSlot(key);
      }
    };
    void poll();
    return () => {
      state.cancelled = true;
      pollingRef.current.delete(key);
    };
  }, [activeSlotKey, activePort, sessionId, preview?.running, preview?.url, pollUrl, isContainerMode, apiHost, previewSubdomainMode, promoteSlot, setSlot, preview, createdSlotsRef, pollingRef]);
}

// Re-export internal helpers for the consuming component, which also needs
// `buildSubdomainUrl` for the auth-blocked detection logic.
export { buildSubdomainUrl, computePreviewUrl, type PreviewSubdomainMode };
