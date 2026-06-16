/**
 * Disk-janitor facade — re-exports the public entry points after the P5 split
 * (`docs/201-large-file-refactor`). The implementation lives in three sibling
 * modules with distinct timing, deps, and failure modes:
 *
 *   - `startup-janitor.ts`  — one-time startup orphan sweeps (`runDiskJanitor`
 *     and all `sweep*` / orphan-recovery functions, plus `pruneSessionVolumes`).
 *   - `tier-escalation.ts`  — steady-state disk-tier escalation state machine
 *     (`escalateDiskTiers`, hot → light → evicted; docs/161).
 *   - `disk-utils.ts`       — shared helpers (statfs free/total bytes, watermark
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
  escalateDiskTiers,
  type TierEscalationDeps,
  type TierEscalationResult,
} from "./tier-escalation.js";

export {
  statfsFreeBytes,
  statfsTotalBytes,
  resolveDiskWatermarks,
} from "./disk-utils.js";
