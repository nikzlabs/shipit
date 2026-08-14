/**
 * docs/262 req 15 — the consumer lease over a live plugin generation.
 *
 * Publication is `stage → validate → publish → prune`, and the prune deletes the
 * superseded checkout and its writable layer immediately. Both plugin surfaces
 * reach a generation through the *same* `type=overlay` volume — the CLI
 * invocation container (`plugin-cli-run.ts`) and a plugin service
 * (`services/plugin-services.ts`) attach one volume per generation, which is why
 * `ensurePluginRuntimeOverlay` is an *ensure*: the kernel forbids one upperdir
 * backing two independently created overlay mounts. So the checkout under that
 * volume is a shared resource with two consumers, and prune had no idea either
 * existed. docs/183's own spike records what deleting a live lowerdir does:
 * merged `readdir` starts returning empty while path lookups still resolve, and
 * the running container is silently corrupted rather than failed. Req 15 says an
 * update either completes coherently or the prior complete version keeps
 * running; a half-deleted checkout under a live mount is neither.
 *
 * **One lease, two facts.** A generation may be deleted only when both say
 * nobody has it, and they cover different lifetimes on purpose:
 *
 *  - **The in-process hold** — {@link holdGeneration} for a CLI call,
 *    {@link holdGenerationsForOwner} for the service surface. It covers the
 *    window a volume cannot: from the moment a consumer RESOLVES `active` to the
 *    moment its container exists. In that window the volume is either not
 *    created yet or created and unattached, so the daemon would happily let it
 *    go — and Docker re-creates a missing named volume at container start as an
 *    empty local volume, which is how `/plugin` becomes silently empty instead
 *    of failing.
 *  - **The volume's own attachment** — the daemon refuses to remove a volume a
 *    container holds (409), which {@link createGenerationDeletionLease} reads
 *    through `removePluginOverlay`'s verified return. This is the half that
 *    survives an orchestrator restart, and the half that covers a plugin service
 *    container, which outlives the call that created it.
 *
 * **Nothing here leaks when the releasing side never runs**, which is the case
 * this had to be designed around — sessions are destroyed rather than paused,
 * and a container can die without unwinding anything:
 *
 *  - A CLI hold is released in a `finally` that wraps the whole invocation. If
 *    the process dies instead, the map dies with it; the orphaned container is
 *    removed by `reapOrphanPluginInstalls` at the next boot.
 *  - A service hold is replaced wholesale on the next round
 *    ({@link holdGenerationsForOwner} takes exactly the set it is given), and
 *    dropped for a disposed session by {@link releaseSessionGenerationHolds}.
 *  - A deletion claim is released in a `finally` around the `rm`.
 *  - The failure mode of a hold that is somehow never released is a generation
 *    directory that is not deleted — bounded disk inside a session state
 *    directory that is removed with the session, and reclaimed by the next
 *    prune. It is never corruption, and it is never a refusal to activate: a
 *    skipped prune does not fail the publish that triggered it.
 *
 * **The hold and the claim are synchronous, and that is what makes them
 * atomic.** A consumer resolves `active`, reads the record and takes its hold in
 * one synchronous block, so no deletion can start between the resolution and the
 * hold; a pruner claims before it awaits anything, so no hold can be taken
 * between its check and its `rm`. Making either of them async would open exactly
 * the race the module exists to close.
 */

import type Docker from "dockerode";
import type { BeginGenerationDeletion } from "./plugin-generations.js";
import { pluginOverlayVolumeName, removePluginOverlay } from "./plugin-overlay.js";

/** One generation, as both consumers and the pruner name it. */
export interface GenerationRef {
  sessionId: string;
  repoName: string;
  commit: string;
}

/** Idempotent — calling it twice releases once. */
export type ReleaseHold = () => void;

/**
 * Live holds, keyed per generation. The value is a set of opaque tokens rather
 * than a count so that a release survives {@link releaseSessionGenerationHolds}
 * dropping the key underneath it: a stale token finds nothing to remove instead
 * of decrementing a hold somebody else has since taken.
 */
const holds = new Map<string, Set<object>>();

/** Generations a pruner has claimed and is deleting right now. */
const deleting = new Set<string>();

/** Each owner's current hold set (the service surface — one owner per session). */
const owners = new Map<string, Map<string, ReleaseHold>>();

function generationKey(ref: GenerationRef): string {
  return `${ref.sessionId}::${ref.repoName}::${ref.commit}`;
}

/** The owner name the service surface holds its generations under. */
export function pluginServiceOwner(sessionId: string): string {
  return `services::${sessionId}`;
}

/**
 * Hold one generation for as long as the returned function is uncalled.
 *
 * `null` means the generation is being deleted right now — the caller resolved
 * a version that has already been superseded and pruned, and must refuse rather
 * than mount it. Call this in the SAME synchronous block that resolved `active`
 * and read the record; anything else reopens the window.
 */
export function holdGeneration(ref: GenerationRef): ReleaseHold | null {
  const key = generationKey(ref);
  if (deleting.has(key)) return null;
  const token = {};
  const set = holds.get(key) ?? new Set<object>();
  set.add(token);
  holds.set(key, set);
  return () => {
    const current = holds.get(key);
    if (!current?.delete(token)) return;
    if (current.size === 0) holds.delete(key);
  };
}

/**
 * Replace one owner's holds with exactly `refs`, and report which it got.
 *
 * Replace rather than add, because this is how a long-lived consumer's lease
 * follows a refresh with no release call of its own: the service surface
 * re-resolves every declared repository on each round, so handing that whole set
 * over is both "hold the new generations" and "let go of the ones this session
 * no longer runs". A repository that stops declaring services, or is dropped
 * from the declaration entirely, disappears from `refs` and is released by the
 * same call — there is no separate teardown to forget.
 *
 * A ref that is being deleted is left out of the result; the caller treats that
 * repository as having no usable tree this round, which is what it is.
 */
export function holdGenerationsForOwner(
  owner: string,
  refs: readonly GenerationRef[],
): GenerationRef[] {
  const previous = owners.get(owner) ?? new Map<string, ReleaseHold>();
  const next = new Map<string, ReleaseHold>();
  const held: GenerationRef[] = [];

  for (const ref of refs) {
    const key = generationKey(ref);
    if (next.has(key)) continue; // the same generation named twice is one hold
    // Taken BEFORE the previous set is released, so a generation carried across
    // rounds never drops to zero holds — not because anything could interleave
    // here, but because a future async step in this function would then be a
    // silent regression.
    const release = holdGeneration(ref);
    if (!release) continue;
    next.set(key, release);
    held.push(ref);
  }

  // Every previous hold goes, including one carried over: `next` has already
  // taken its own hold on that generation, so the count never reaches zero.
  for (const release of previous.values()) release();

  if (next.size === 0) owners.delete(owner);
  else owners.set(owner, next);
  return held;
}

/**
 * Drop everything a session holds. Called when its runner is disposed, so a
 * session that is gone cannot keep a generation alive — including one held by a
 * CLI call whose `finally` will run later against a token that no longer exists.
 */
export function releaseSessionGenerationHolds(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const [owner, held] of [...owners]) {
    for (const [key, release] of [...held]) {
      if (!key.startsWith(prefix)) continue;
      release();
      held.delete(key);
    }
    if (held.size === 0) owners.delete(owner);
  }
  for (const key of [...holds.keys()]) {
    if (key.startsWith(prefix)) holds.delete(key);
  }
  // `deleting` is deliberately untouched: a prune in flight owns its claim and
  // releases it in its own `finally`, and clearing it here would let a second
  // pruner delete the same tree concurrently.
}

/** How many holds a generation has — introspection for tests and logging. */
export function generationHoldCount(ref: GenerationRef): number {
  return holds.get(generationKey(ref))?.size ?? 0;
}

/**
 * Claim a generation for deletion, blocking every hold until the returned
 * function is called. `null` when a consumer holds it, or when another pruner
 * has already claimed it.
 *
 * Synchronous, and it must stay that way: the claim is what closes the window
 * between "no holds" and "the directory is gone".
 */
export function claimGenerationDeletion(ref: GenerationRef): ReleaseHold | null {
  const key = generationKey(ref);
  if (deleting.has(key) || holds.has(key)) return null;
  deleting.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    deleting.delete(key);
  };
}

/**
 * The hook `activateGeneration` calls before it deletes a superseded
 * generation — the two facts, in order: the in-process claim first (cheap,
 * synchronous, and it must be taken before anything is awaited), then the
 * volume, which is the only durable evidence that a container this process did
 * not start is still using the tree.
 *
 * Removing the volume is part of taking the lease, not a side effect: the
 * directories under it are about to go, so a volume left pointing at them would
 * be a mount description of nothing — and until this existed, a generation's
 * volume was only ever removed on the service path, so a session that refreshed
 * without services accumulated one per refresh.
 *
 * Built per session because the volume name is keyed by session, repository and
 * commit. Absent where there is no Docker (local/dogfood mode, tests): there are
 * no plugin containers there, so nothing can be holding a generation.
 */
export function createGenerationDeletionLease(deps: {
  docker: Docker;
  sessionId: string;
}): BeginGenerationDeletion {
  return async ({ repoName, commit }) => {
    const claim = claimGenerationDeletion({ sessionId: deps.sessionId, repoName, commit });
    if (!claim) return null;
    const volume = pluginOverlayVolumeName(deps.sessionId, repoName, commit);
    let released: boolean;
    try {
      released = await removePluginOverlay(deps.docker, volume);
    } catch {
      // The daemon could not answer, so we cannot prove the tree is unused.
      released = false;
    }
    if (!released) {
      claim();
      return null;
    }
    return claim;
  };
}
