/**
 * Overlay dep store — session-lifecycle gating, scope, and GC source (docs/183).
 *
 * Reusable foundation shared by the (in-progress) dependency-directory overlay
 * design. It answers the design-agnostic lifecycle questions:
 *   - **Is this session overlay-backed?** (`isOverlayEligible`) — gated behind the
 *     `OVERLAY_DEP_STORE` feature flag (default OFF), so production is byte-for-byte
 *     unchanged until a deployment opts in. Repo-backed, non-ops sessions only.
 *   - **What `(repo, runtime)` scope does it belong to?** (`resolveOverlayScope`,
 *     `overlayRuntimeKey`) — the orchestrator-side runtime fingerprint.
 *   - **Which bases are live, for GC?** (`liveOverlayScopeHashes`).
 *
 * NOTE (docs/183 dep-dir pivot): the per-session mount-spec construction, the
 * worker snapshot pull, and the publish-after-install flow that previously lived
 * here were **whole-workspace-shaped** and have been removed — the dep-dir design
 * rebuilds them per declared dep dir (N mounts at `/workspace/<dep-dir>` subpaths,
 * a per-dep-dir snapshot, and a scope key extended by the dep-dir relpath). The
 * reused decision logic still lives in `overlay-base.ts` (the publish CAS) and the
 * reused mechanism in `overlay-volume.ts` (volume primitives). `liveOverlayScopeHashes`
 * here is the GC plumbing; its scope key gains the dep-dir relpath in that work.
 *
 * Everything here no-ops unless `isOverlayEnabled()` returns true, so importing it
 * is behavior-preserving.
 */

import type { SessionInfo } from "../shared/types.js";
import { overlayScopeHash } from "./overlay-volume.js";
import type { OverlayScope } from "./overlay-base.js";

// ---------------------------------------------------------------------------
// Feature flag + eligibility
// ---------------------------------------------------------------------------

/**
 * The overlay dep store is OFF by default. A deployment opts in by setting
 * `OVERLAY_DEP_STORE=1` (or `true`). Until then every branch in this module is
 * inert and sessions use the plain `agent.install` path unchanged. The flag
 * exists because the container-runtime paths (the daemon overlay mount, the
 * compose wiring) are only verifiable on real Docker overlay across the host
 * matrix — see docs/183 §0 / FINDINGS.md.
 */
export function isOverlayEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OVERLAY_DEP_STORE;
  return v === "1" || v === "true";
}

/**
 * A session is overlay-eligible iff the feature is on AND it is a repo-backed,
 * non-ops session. Ops sessions are excluded because they may be pinned to a
 * non-default inspected build commit (`--shipit-source`); they run their install
 * into their own upper but must never publish or even route through the shared
 * base routing (plan §3). A session with no `remoteUrl` is authored locally and
 * has no `(repo, runtime)` scope to share.
 */
export function isOverlayEligible(
  session: Pick<SessionInfo, "remoteUrl" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isOverlayEnabled(env)) return false;
  if (!session.remoteUrl) return false;
  if (session.kind === "ops") return false;
  return true;
}

/**
 * Orchestrator-side runtime fingerprint for the overlay base scope. Unlike
 * `install-runtime.ts:runtimeKey()` (which runs inside the worker and reads the
 * container's own libc/Node ABI), this must be computable BEFORE the container
 * exists, because the base scope picks the overlay `lowerdir` at create time.
 *
 * The session-worker image is fixed per deployment, and an image digest pins its
 * libc and Node ABI — so `<imageId>|<arch>` is an ABI-correct fingerprint without
 * needing the container's runtime introspection. A worker-image rebuild changes
 * `SESSION_WORKER_IMAGE_ID`/`IMAGE_DIGEST`, rotating the scope for free.
 */
export function overlayRuntimeKey(env: NodeJS.ProcessEnv = process.env): string {
  const imageId = env.SESSION_WORKER_IMAGE_ID ?? env.IMAGE_DIGEST ?? "unknown";
  return `${imageId}|${process.arch}`;
}

/** The `(repo, runtime)` scope for an eligible session, or null if ineligible. */
export function resolveOverlayScope(
  session: Pick<SessionInfo, "remoteUrl" | "kind">,
  env: NodeJS.ProcessEnv = process.env,
): OverlayScope | null {
  if (!isOverlayEligible(session, env)) return null;
  return { repoUrl: session.remoteUrl, runtimeKey: overlayRuntimeKey(env) };
}

// ---------------------------------------------------------------------------
// GC live source
// ---------------------------------------------------------------------------

/**
 * The set of overlay-base scope-hashes any *resumable* session could mount —
 * the authoritative liveness source the disk-janitor's `sweepOrphanedOverlayBases`
 * needs (plan §4: an mtime fallback alone could reap a base out from under a live
 * mount). A session is resumable unless it has been disk-evicted/archived; we
 * include every non-evicted repo-backed session (its base would be re-mounted on
 * resume) for the current runtime fingerprint. Returns an empty set when the
 * feature is off, so the janitor sweep stays inert until a deployment opts in.
 *
 * NOTE (dep-dir pivot): under the dep-dir design there are N bases per session
 * (one per declared dep dir), so the scope key — and therefore this enumeration —
 * gains the dep-dir relpath. Tracked in the "Disk cleanup retargeting" checklist
 * phase; until then this emits one scope-hash per session (correct for the
 * single-base model, an under-count once dep dirs land — must be fixed before the
 * flag is enabled).
 */
export function liveOverlayScopeHashes(
  sessions: SessionInfo[],
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const live = new Set<string>();
  if (!isOverlayEnabled(env)) return live;
  const runtimeKey = overlayRuntimeKey(env);
  for (const s of sessions) {
    if (!s.remoteUrl) continue;
    if (s.kind === "ops") continue;
    if (s.diskTier === "evicted") continue;
    live.add(overlayScopeHash(s.remoteUrl, runtimeKey));
  }
  return live;
}
