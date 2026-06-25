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
 * The fingerprint is composed from the *actual* ABI inputs, NOT the full
 * worker-image id (SHI-194): the image digest changed on every rebuild —
 * app-code layers, npm tooling, cache busts — none of which move the
 * native-addon ABI, so each deploy minted a fresh ~500 MB overlay base and
 * forced a cold reinstall. The four axes below capture the ABI surface
 * precisely:
 *   - **base-image digest** (`BASE_IMAGE_DIGEST`, injected at build time from the
 *     worker Dockerfile's digest-pinned `FROM`) — the system C/C++ runtime and
 *     crypto ABI the addon links against. Only a deliberate base bump moves it.
 *   - **arch** (`process.arch`) and **libc** (`detectLibc()`) — the platform ABI.
 *   - **Node ABI** (`process.versions.modules`, i.e. `NODE_MODULE_VERSION`) — the
 *     exact addon ABI number, stricter than the old node-major proxy.
 *
 * `SESSION_WORKER_IMAGE_ID`/`IMAGE_DIGEST` remain as a fallback so a worker
 * image built before `BASE_IMAGE_DIGEST` existed degrades to the previous
 * (correct-but-churny) behavior rather than collapsing to `"unknown"`.
 *
 * Narrowing biases toward *reuse*, so the failure mode it must never hit is
 * reusing a tree built against an incompatible ABI. That can't happen: every
 * real ABI input is in the key, and a base bump is guaranteed to change
 * `BASE_IMAGE_DIGEST` (it is the `FROM` content sha). The worker-side install
 * marker (`install-marker.ts:markerMatches`) compares this key and forces a
 * reinstall on any mismatch — the load-bearing corruption gate.
 */
export function runtimeKey(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.BASE_IMAGE_DIGEST ?? env.SESSION_WORKER_IMAGE_ID ?? env.IMAGE_DIGEST ?? "unknown";
  const libc = detectLibc();
  const abi = process.versions.modules;
  return `${base}|${process.arch}|${libc}|abi${abi}`;
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
