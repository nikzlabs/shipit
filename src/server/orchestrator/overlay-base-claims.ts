/**
 * In-flight claims on overlay base generations (planning#440).
 *
 * ## The window this closes
 *
 * `sweepStaleBaseGenerations` (`steady-state-reclaim.ts`) reaps a superseded
 * `overlay-base/<hash>/g<N>` the moment nothing pins it, with no age delay. Its
 * two protections are the base pointer's *current* generation and the
 * generations **running** containers name — and a container being created is
 * neither. The spec that decides which generation a session will mount is built
 * during activation (`prepareOverlaySpecs` → `DepDirOverlaySpec.generation`),
 * the overlay volume is written with `lowerdir=…/g<N>` after that, and only
 * `container.start()` finally makes the mount visible to `docker ps -q`. A
 * same-scope publish anywhere in that window advances the pointer, and `g<N>`
 * becomes "neither current nor mounted" while a container is on its way to
 * mounting it. The starting container then mounts a lowerdir that no longer
 * exists — or loses it out from under a mount the daemon has already made.
 *
 * A claim states the thing the sweep cannot otherwise observe: *this generation
 * is about to be mounted*. It is the same shape plugin bases already use
 * (`plugin-dep-store.ts` `inFlightScopes` / `liveInFlightScopes`), at generation
 * rather than scope granularity so it unions straight into the sweep's
 * `<hash>/g<N>` live-key set.
 *
 * ## Why it expires rather than being released
 *
 * Releasing at "the container is running" reads like the precise answer and is
 * not: the sweep's `docker ps` snapshot is taken at an arbitrary moment, so a
 * pass that read `ps` *before* the container started and deletes *after* the
 * release sees neither the claim nor the mount. An explicit release would
 * therefore re-open a narrower copy of exactly this race, and would have to be
 * paired with a hold that outlives it anyway. A time-bounded claim needs no such
 * pairing, and it fails in the right direction in the two cases that matter:
 *
 *  - **A create that dies** — a throw, an OOM, an orchestrator restart — drops
 *    the claim by expiry (or by process death, which is the same answer sooner).
 *    That is correct: a container that never started never mounted the
 *    generation, so nothing is under-protected, and the cost is one undeleted
 *    directory until the window lapses. Note the restart case needs no special
 *    handling: on the far side either the container is running (and `docker ps`
 *    protects it) or it is not (and the create is being retried, which re-claims).
 *  - **A create that succeeds** — `docker ps` takes over long before the claim
 *    lapses, so the overlap is deliberate, not slack to be trimmed.
 *
 * ## Fail-closed
 *
 * The claim set is **strictly additive**: the sweep unions it into its live set
 * and nothing else consults it. An empty registry is byte-for-byte today's
 * behaviour, so "nothing is claimed" can never widen what a pass deletes — the
 * failure mode planning#439 established this sweep must not acquire (an
 * incomplete reading already skips the pass entirely).
 */

/**
 * How long a claim protects a generation. Sized off the window it spans — spec
 * build → volume create (serialized per host, and it may evict and recreate a
 * volume's Compose holders first) → container create → `start()` — with room for
 * a loaded host, because over-running costs one directory kept until the next
 * pass while under-running costs a live lowerdir. Matches
 * `plugin-dep-store.ts`'s `IN_FLIGHT_CLAIM_MS`, which bounds a comparable
 * publish-side window for the same reason.
 */
export const OVERLAY_BASE_CLAIM_MS = 10 * 60_000;

/** `<scopeHash>/g<N>` → expiry epoch ms. */
const claims = new Map<string, number>();

/** The sweep's live-key form, so a claim unions into `liveGenKeys` unchanged. */
export function overlayBaseGenKey(scopeHash: string, generation: number): string {
  return `${scopeHash}/g${generation}`;
}

/**
 * Claim the base generation a container about to be created will mount. Called
 * once per dep-dir spec, on every creation attempt — a retry re-claims, which
 * refreshes the window for free.
 */
export function claimOverlayBaseGeneration(scopeHash: string, generation: number): void {
  claims.set(overlayBaseGenKey(scopeHash, generation), Date.now() + OVERLAY_BASE_CLAIM_MS);
}

/**
 * Unexpired claims as `<hash>/g<N>` keys, pruning as it goes so the map cannot
 * grow with the process.
 */
export function liveOverlayBaseClaims(): string[] {
  const now = Date.now();
  for (const [key, expiry] of claims) {
    if (expiry <= now) claims.delete(key);
  }
  return [...claims.keys()];
}

/**
 * Drop every claim. For tests, which share this module across cases the way the
 * process shares it across sessions — the same reason `clearPluginBaseClaims`
 * exists.
 */
export function clearOverlayBaseClaims(): void {
  claims.clear();
}
