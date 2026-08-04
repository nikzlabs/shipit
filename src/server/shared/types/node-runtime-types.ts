/**
 * docs/248 — the outcome of resolving a repo's Node version pin inside a
 * session container.
 *
 * Produced by `session/node-runtime.ts`, read by the orchestrator's diagnostics
 * service and rendered by `SessionDiagnosticsPanel`. It lives in `shared/types`
 * because both layers need it and neither may import from the other.
 */

export type NodeRuntimeState =
  /** Boot-time provisioning is still running. */
  | "pending"
  /** The repo pins nothing — nothing to do, and nothing to report. */
  | "no-pin"
  /** A pin exists and the Node already running satisfies it. */
  | "satisfied"
  /** A pinned Node was installed and is now first on PATH. */
  | "provisioned"
  /** The pin exists but is written in a form the resolver doesn't implement. */
  | "unsupported"
  /** The pin resolves below the minimum major the container can run. */
  | "below-floor"
  /** Resolution, download, or extraction failed. Running on the image's Node. */
  | "failed";

/** Where a Node pin was read from. `.nvmrc` takes precedence (requirement 3). */
export type NodePinSource = ".nvmrc" | "engines.node";

export interface NodeRuntimeStatus {
  state: NodeRuntimeState;
  /** Which file the pin came from, or null when there is no pin. */
  pinSource: NodePinSource | null;
  /** The pin exactly as the repo wrote it, for display. */
  pinRaw: string | null;
  /** The concrete version chosen for the pin, when one was resolved. */
  resolvedVersion: string | null;
  /** The Node version the session's shells and agent actually run (no `v`). */
  activeVersion: string;
  /** The Node version baked into the session-worker image. */
  imageVersion: string;
  /** Why the pin isn't being honored, for the non-happy states. */
  reason: string | null;
  /** True when a pin exists and the active Node does not satisfy it. */
  mismatch: boolean;
}
