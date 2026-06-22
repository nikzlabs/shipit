/**
 * Disk-janitor facade — re-exports the public entry points after the P5 split
 * (`docs/201-large-file-refactor`). The implementation lives in sibling modules
 * with distinct timing, deps, and failure modes:
 *
 *   - `startup-janitor.ts`       — boot-only **crash-recovery** sweeps
 *     (`runDiskJanitor`: orphan volumes/networks/workspaces/nm-store/credentials/
 *     logs/branches — leftovers a failed teardown stranded), plus
 *     `pruneSessionVolumes`.
 *   - `steady-state-reclaim.ts`  — **steady-growth** sweeps that grow with the
 *     clock (`runSteadyStateReclaim`: repo/dep caches, `repo-memory/`, obsolete
 *     overlay bases, stale pnpm stores). Rides the periodic escalation pass, not
 *     boot (SHI-196).
 *   - `tier-escalation.ts`       — steady-state disk-tier escalation state machine
 *     (`escalateDiskTiers`, hot → light → evicted; docs/161).
 *   - `disk-utils.ts`            — shared helpers (statfs free/total bytes, watermark
 *     resolution, pacing/throttle/sleep, docker spawner).
 *
 * Callers (e.g. `index.ts`) import from here so the public surface is unchanged.
 */

export {
  runDiskJanitor,
  pruneSessionVolumes,
  type DiskJanitorDeps,
  type DiskJanitorResult,
} from "./startup-janitor.js";

export {
  runSteadyStateReclaim,
  type SteadyStateReclaimDeps,
  type SteadyStateReclaimResult,
} from "./steady-state-reclaim.js";

export {
  escalateDiskTiers,
  type TierEscalationDeps,
  type TierEscalationResult,
} from "./tier-escalation.js";

export {
  statfsFreeBytes,
  statfsTotalBytes,
  resolveDiskWatermarks,
} from "./disk-utils.js";
