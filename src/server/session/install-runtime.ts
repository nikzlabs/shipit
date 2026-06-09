/**
 * Install-path helpers retained from the removed `nm-store` fast path
 * (docs/183 Phase 1 — "Delete the nm-store fast path"). The lockfile-keyed
 * copy store is gone; these two concerns outlive it:
 *
 *  - **Runtime fingerprint** (`runtimeKey` / `detectLibc`) — describes the
 *    ABI-compatibility boundary (image digest, arch, libc, Node major) of the
 *    container the install runs in. The overlay rolling base (docs/183 §2)
 *    reuses this as the per-`(repo, runtime fingerprint)` scope so a base with
 *    compiled native addons/wheels is never reused across incompatible
 *    runtimes.
 *  - **Install-command tuning** (`tuneNpmInstall`) — injects
 *    `--prefer-offline --no-audit --no-fund` into a bare `npm install|ci|i`, a
 *    pure-overhead trim that helps the plain install land fast on a warm
 *    download cache (`/dep-cache`, docs/075).
 *
 * These must execute inside the session container's worker — `runtimeKey`
 * reads the container's own `process.versions.node`, `process.arch`, and
 * libc, not the orchestrator's.
 */

/**
 * Compute a runtime fingerprint describing the ABI-compatibility boundary of
 * the container the install runs in. Native addons (`.node` binaries from
 * `node-gyp`/`prebuild-install`) are compiled against the specific Node ABI,
 * arch, and libc — reusing an x64/glibc tree in an arm64/musl container would
 * load-fail at agent startup. Erring on the side of more invalidations (a
 * spurious miss is one slow install) is the safe direction.
 *
 * `IMAGE_DIGEST`/`SESSION_WORKER_IMAGE_ID` is consulted first so a deploy
 * that rebuilds the worker image gets a fresh fingerprint for free.
 */
export function runtimeKey(env: NodeJS.ProcessEnv = process.env): string {
  const imageId = env.SESSION_WORKER_IMAGE_ID ?? env.IMAGE_DIGEST ?? "unknown";
  const libc = detectLibc();
  // `process.versions.node` carries the patch version too, but the ABI
  // we care about is the major. A node 22.x → 22.y bump is compatible;
  // 22 → 24 is not.
  const nodeMajor = process.versions.node.split(".")[0];
  return `${imageId}|${process.arch}|${libc}|node${nodeMajor}`;
}

export function detectLibc(): string {
  // Node's `process.report.getReport()` exposes `header.glibcVersionRuntime`
  // on glibc systems; alpine/musl returns no such field. Resort to "musl"
  // when the field is absent — good enough for the fingerprint, since the
  // alternative is keying everything to "unknown" and losing all reuse.
  try {
    const report = (process.report as { getReport?: () => unknown }).getReport?.();
    const header = (report as { header?: { glibcVersionRuntime?: string } } | undefined)?.header;
    if (header?.glibcVersionRuntime) return `glibc-${header.glibcVersionRuntime}`;
    return "musl";
  } catch {
    return "unknown";
  }
}

/**
 * Inject `--prefer-offline --no-audit --no-fund` into a bare `npm
 * install|ci|i` invocation. Audit + fund metadata round-trips are pure
 * overhead in our setting and easily shave seconds. Only the exact bare form
 * is tuned, so a user who deliberately wrote `npm install --audit` is
 * untouched; any non-`npm` command is returned unchanged.
 */
export function tuneNpmInstall(command: string): string {
  const trimmed = command.trim();
  const tokens = trimmed.split(/\s+/);
  if (tokens[0] !== "npm") return trimmed;
  if (!(tokens[1] === "install" || tokens[1] === "i" || tokens[1] === "ci")) return trimmed;
  if (tokens.length !== 2) return trimmed; // only the bare form qualifies
  return `${trimmed} --prefer-offline --no-audit --no-fund`;
}
