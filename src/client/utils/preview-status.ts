/**
 * Effective preview status: union of `preview_status` and `service_status`.
 *
 * The orchestrator emits both signals whenever a compose service changes
 * state, but the client otherwise only treats `preview_status` as the source
 * of truth for "is the preview running?" That works fine when the two
 * channels stay in sync, but in practice the `preview_status` update can lag
 * (or fail to propagate cleanly during reconnects) while `service_status`
 * updates are reflected in the UI's services list immediately.
 *
 * The most visible breakage is the dogfooding case: ShipIt-in-ShipIt declares
 * a single `dev` service with `x-shipit-preview: manual`. After the user
 * clicks Start, the services list shows "Running" but the preview pane stays
 * stuck on the "No preview running. Start a service to launch it." overlay
 * because `preview.running` never flipped to `true`.
 *
 * This helper closes the gap on the client side: when `preview_status`
 * doesn't reflect a running service but the services list does, derive a
 * synthetic preview status that matches what the orchestrator would have
 * emitted (`source: "detected"`, container-mode `/preview/{sessionId}/{port}/`
 * URL, full `detectedPorts` list). The PreviewFrame then renders the iframe
 * just as it would have if the message had arrived on time.
 */

import type { PreviewStatus } from "../components/PreviewFrame.js";
import type { ManagedServiceState } from "../stores/preview-store.js";

/**
 * Compute the effective preview status from the current `preview_status` and
 * the live services list. When `preview.running` is already `true`, the
 * input is returned unchanged. Otherwise, if at least one service is in
 * `running` state with a `port`, return a synthetic `running: true` status
 * pointing at that service.
 */
export function deriveEffectivePreviewStatus(
  preview: PreviewStatus | null,
  services: ManagedServiceState[],
  sessionId: string | null | undefined,
): PreviewStatus | null {
  if (preview?.running) return preview;
  const runningWithPort = services.filter((s) => s.status === "running" && s.port);
  if (runningWithPort.length === 0) return preview;
  const port = runningWithPort[0].port!;
  return {
    running: true,
    port,
    url: `/preview/${sessionId ?? ""}/${port}/`,
    source: "detected",
    detectedPorts: runningWithPort.map((s) => s.port!),
  };
}
