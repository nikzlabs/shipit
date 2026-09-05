/**
 * docs/262 — activate every plugin repository a session declares.
 *
 * The lifecycle half of `plugin-generations.ts`: reads the session's
 * `plugins:` block, brings each tracked repository to its declared version,
 * and remembers the outcome so the browser snapshot can report it without
 * re-running anything (a GET must never trigger activation).
 *
 * Called from the same two moments compose configuration is applied
 * (`service-manager-setup.ts`): session activation, and a `shipit.yaml` edit.
 * Both are fire-and-forget — a slow fetch must not delay a session opening
 * (req 13: the session opens regardless), and the tab reports the interim
 * state.
 *
 * It is also where a round's **per-import primitives** are brought up to date
 * (`plugin-state.ts`: the shared state directory and the validated settings
 * file, reqs 17, 18, 26). They hang off the end of every round — including a
 * round that fetched nothing, because a `repo: self` declaration has no
 * generation and would otherwise never get them.
 */

import {
  activateGeneration,
  readActiveGeneration,
  resolveLiveGenerations,
  retireSelfDeclaredGeneration,
  type ActivationOutcome,
  type BeginGenerationDeletion,
  type GenerationRecord,
  type ValidateStagedGeneration,
} from "../plugin-generations.js";
import { releaseSessionGenerationHolds } from "../plugin-leases.js";
import {
  createPluginImportResolver,
  preparePluginState,
  sessionRootForWorkspace,
} from "../plugin-state.js";
import { resolveShipitConfig, type ShipitConfig } from "../../shared/shipit-config.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import type { DeclaredHostsManifest } from "../../shared/plugin-hosts.js";
import type { DeclaredPluginRepo } from "../../shared/plugin-repos.js";
import { destinationKey, pluginCloneUrl } from "../../shared/plugin-repos.js";

/** What the tab shows for one tracked repository, beyond what's on disk. */
export interface PluginRepoActivationState {
  /** Activation is running right now — the tab shows a working state. */
  activating: boolean;
  /** The live generation, if any. */
  generation?: GenerationRecord;
  /**
   * Why the last attempt failed. Present WITH `generation` when a refresh
   * failed but the prior version is still active (req 15's degraded state).
   */
  error?: string;
  /** Advisory: a moved tag the durable pin overrode (req 8). */
  warning?: string;
  /** Selected exports the declared version lacks, when that is why it failed (phase 2). */
  missingSelectors?: string[];
  /**
   * req 24 — the hosts the version that FAILED declares, when the attempt got
   * far enough to read them. The card resolves these against the session's
   * egress allowlist beside whatever is live, so a plugin whose very first
   * install was denied still gets the Allow buttons its failure message points
   * at (`orchestrator/plugin-hosts.ts`).
   *
   * Transient like everything else here, and for the same reason: the version
   * this describes was never published, so nothing on disk remembers it.
   *
   * **`source` is what makes it safe to read by NAME**, and it is the rule
   * `GenerationRecord.source` exists for, applied to the transient half. Every
   * key here is `sessionId::repoName`, and a name can be re-pointed at a
   * different repository — or at `repo: self`, which this round does not visit
   * at all, so nothing would ever replace the entry. Without the check a host
   * the OLD repository declared would keep its Allow buttons on the NEW
   * declaration's card indefinitely, attributed to a plugin that never asked for
   * it (review finding).
   */
  declaredHosts?: { source: string; exports: DeclaredHostsManifest };
}

/**
 * Per-session activation state, keyed `sessionId::repoName`. In-memory on
 * purpose: the durable facts (which commit is live) are on disk in the
 * generation record, and this only carries the transient "what happened on the
 * last attempt" the UI needs.
 */
const activationState = new Map<string, PluginRepoActivationState>();

/**
 * Monotonic per session. Bumped by {@link clearActivationState}, so a
 * fire-and-forget activation that finishes AFTER its session was disposed
 * cannot repopulate the map (review finding 8) — its epoch is stale and every
 * write is dropped.
 */
const epochs = new Map<string, number>();

/**
 * How many triggers are currently activating each repository, keyed
 * `sessionId::epoch::repoName`.
 *
 * `activating` has to mean "another result is coming", not "the trigger I
 * happened to watch has finished": two overlapping triggers would otherwise
 * have the first one clear the flag while the second is still queued, and a
 * browser polling in that window would stop early and show a stale card. Only
 * the last trigger out clears it.
 *
 * **The epoch is part of the key** (third-review finding): with a bare
 * `sessionId::repoName`, a stale activation from a disposed round could
 * decrement a *newer* round's counter after the session was recreated,
 * letting that round's first trigger clear `activating` while its second was
 * still queued. Keying by epoch makes a dead round's decrement land on its
 * own dead key, where nothing reads it.
 */
const inFlight = new Map<string, number>();

/**
 * Per-session prepare FAILURES from the last round, keyed `sessionId::repoName`
 * (reqs 17, 18, 26 — `plugin-state.ts`). Same shape and lifetime as the map
 * above, and here for the same reason: the durable facts are on disk, and this
 * carries only what nothing else can reconstruct — that an attempt to write a
 * plugin's primitives failed. Settings problems that follow from the
 * declaration are NOT here; the snapshot route recomputes those.
 */
const prepareFailures = new Map<string, string[]>();

/**
 * The CONTAINER half of prepare, same key and same lifetime (req 13, req 22).
 *
 * Prepare has two halves that fail independently: the orchestrator writes each
 * import's state directory and settings file (above), and the container links
 * `/plugins/<name>` and materializes each plugin's skills into every harness
 * discovery root. The second half used to end at a `console.warn` in
 * `ContainerSessionRunner.preparePlugins()`, so a plugin that shipped none of
 * the agent instructions it promised still rendered as a healthy card — a
 * degradation nobody can see is not "degrade, visibly".
 *
 * Kept in its OWN map rather than merged into the one above, because the two
 * are written by different actors at different moments and each replaces only
 * its own entries: a container prepare that reports nothing must not erase a
 * settings-write failure the orchestrator recorded microseconds earlier. They
 * are concatenated on read.
 */
const containerFailures = new Map<string, string[]>();

/**
 * Per-session SERVICE failures from the last round, keyed the same way (docs/262
 * reqs 3, 20 — `services/plugin-services.ts`).
 *
 * A third map for the same reason the second one exists: each is replaced by its
 * own writer, so a service round that reports nothing must not erase a settings
 * or container failure recorded microseconds earlier. What lands here is only
 * the half the snapshot route CANNOT re-derive — an invalid fragment and a
 * colliding service name it recomputes from the pure collector; a runtime layer
 * Docker would not give us is a fact about a round that ran, and a read-only GET
 * must not go and ask about it.
 */
const serviceFailures = new Map<string, string[]>();

const stateKey = (sessionId: string, repoName: string): string => `${sessionId}::${repoName}`;
const flightKey = (sessionId: string, epoch: number, repoName: string): string =>
  `${sessionId}::${epoch}::${repoName}`;

export function getActivationState(sessionId: string, repoName: string): PluginRepoActivationState | undefined {
  return activationState.get(stateKey(sessionId, repoName));
}

/**
 * Prepare failures from the last round for one repository — both halves
 * (`plugin-state.ts` orchestrator-side, `plugin-runtime.ts` container-side).
 *
 * One accessor on purpose: the snapshot route asks "what could this repository
 * not be given?", and which process failed to give it is an implementation
 * detail of the answer, not part of the question.
 */
export function getPluginPrepareFailures(sessionId: string, repoName: string): string[] {
  return [
    ...(prepareFailures.get(stateKey(sessionId, repoName)) ?? []),
    ...(containerFailures.get(stateKey(sessionId, repoName)) ?? []),
  ];
}

/** One thing the container could not make available, as its prepare reports it. */
export interface ContainerPrepareFailure {
  /** Declared repository name, in the declaration's own spelling. */
  repo: string;
  /**
   * `<alias>/<skill>`, the alias alone, or `(all)` — absent when the failure is
   * the repository's own `/plugins/<name>` link, which names no skill.
   */
  skill?: string;
  reason: string;
}

/**
 * Read a `/plugins/prepare` response into attributed failures, DISCARDING
 * anything that is not one.
 *
 * Validated rather than cast, because the worker on the other end is not
 * necessarily the one this orchestrator shipped with: containers survive an
 * orchestrator restart and are reconnected (`app-lifecycle.ts`), so a rolling
 * upgrade leaves a new orchestrator talking to a worker built before failures
 * carried a `repo`. Casting stored those under a key no card ever looks up
 * (`sessionId::undefined`) — invisible, and now also displacing whatever the
 * previous run recorded. Dropping them instead makes an old worker exactly as
 * silent as it was before this change, which is the honest answer: it is not
 * reporting less than it knows, it never knew.
 */
export function readPrepareFailures(body: unknown, sessionId: string): ContainerPrepareFailure[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const failures: ContainerPrepareFailure[] = [];
  let dropped = 0;

  const take = (list: unknown, withSkill: boolean): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : null;
      const repo = item?.repo;
      const reason = item?.reason;
      const skill = item?.skill;
      if (typeof repo !== "string" || !repo || typeof reason !== "string") {
        dropped += 1;
        continue;
      }
      failures.push({
        repo,
        reason,
        ...(withSkill && typeof skill === "string" ? { skill } : {}),
      });
    }
  };
  take(record.skillsFailed, true);
  take(record.linkFailed, false);
  // docs/262 req 20 — a companion CLI ShipIt refused to surface. Most refusals
  // are also recomputed by the snapshot (`plugin-commands.ts`), but the
  // PATH-shadow half is knowable only inside the container, so this is its only
  // route to the card. Each reason is a complete sentence naming the command.
  take(record.commandsRefused, false);
  take(record.commandsFailed, false);

  if (dropped > 0) {
    console.warn(
      `[plugins:${sessionId}] dropped ${dropped} prepare failure(s) this container did not attribute `
      + "to a declared repository — it is probably older than this orchestrator",
    );
  }
  return failures;
}

/**
 * Record a container prepare's outcome, once it has one.
 *
 * Called BEFORE the request goes out and invoked with the result, so the epoch
 * is captured at the same moment the container is asked — the pattern the
 * activation round already uses. A prepare that returns after its session was
 * disposed (or reactivated) writes nothing: `clearActivationState` has moved
 * the epoch on, and repopulating the map would leave a dead session's failures
 * attached to a live one's cards.
 *
 * **Only a prepare that actually RAN may call the returned recorder.** The
 * record is replaced wholesale, which is what makes a fixed problem disappear
 * on the next round (a refresh re-runs prepare over the whole declaration, so
 * one pass always describes every repository). The corollary is that a prepare
 * which could not run — an unreachable worker, a timeout — must leave the
 * previous record alone rather than clear it: nothing reached the container's
 * filesystem, so the last successful run is still the truth about what is
 * materialized there, and clearing it would report health that was never
 * observed.
 *
 * Returns whether the session's recorded set actually changed, so the caller
 * can tell the browser to refetch only when there is something new to see.
 */
export function beginContainerPrepare(
  sessionId: string,
): (failures: readonly ContainerPrepareFailure[]) => boolean {
  const epoch = epochs.get(sessionId) ?? 0;
  return (failures) => {
    if ((epochs.get(sessionId) ?? 0) !== epoch) return false;

    const next = new Map<string, string[]>();
    for (const failure of failures) {
      const key = stateKey(sessionId, failure.repo);
      next.set(key, [...(next.get(key) ?? []), formatContainerFailure(failure)]);
    }

    let changed = false;
    for (const key of [...containerFailures.keys()]) {
      if (!key.startsWith(`${sessionId}::`) || next.has(key)) continue;
      containerFailures.delete(key);
      changed = true;
    }
    for (const [key, messages] of next) {
      const before = containerFailures.get(key);
      if (before?.length !== messages.length || before.some((m, i) => m !== messages[i])) changed = true;
      containerFailures.set(key, messages);
    }
    return changed;
  };
}

/**
 * How a container-side failure reads on a plugin card. Two of the three shapes
 * name no skill and so print no identifier rather than a placeholder: `(all)`
 * is the whole import set failing at once, and an absent `skill` is the
 * repository's own link.
 */
function formatContainerFailure(failure: ContainerPrepareFailure): string {
  if (failure.skill === undefined) return failure.reason;
  return failure.skill === "(all)"
    ? `Skills: ${failure.reason}`
    : `Skill \`${failure.skill}\`: ${failure.reason}`;
}

/** Service failures from the last round for one repository (`plugin-services.ts`). */
export function getPluginServiceFailures(sessionId: string, repoName: string): string[] {
  return serviceFailures.get(stateKey(sessionId, repoName)) ?? [];
}

/**
 * Replace this session's recorded service failures with the latest round's.
 *
 * Replace, not merge: unlike a prepare failure — which is per import and
 * accumulates within one round — this is the whole answer for the session, and a
 * repository that recovered must stop reporting the failure it recovered from.
 */
export function recordPluginServiceFailures(
  sessionId: string,
  byRepo: ReadonlyMap<string, string[]>,
): void {
  for (const key of [...serviceFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) serviceFailures.delete(key);
  }
  for (const [repoName, issues] of byRepo) {
    if (issues.length > 0) serviceFailures.set(stateKey(sessionId, repoName), issues);
  }
}

export function clearActivationState(sessionId: string): void {
  epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  // req 15 — a session that is gone holds nothing. Its plugin containers are
  // being torn down with it, so the only thing a surviving hold could do is stop
  // a later prune from reclaiming disk that nothing is using.
  releaseSessionGenerationHolds(sessionId);
  for (const key of [...activationState.keys()]) {
    if (key.startsWith(`${sessionId}::`)) activationState.delete(key);
  }
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(`${sessionId}::`)) inFlight.delete(key);
  }
  for (const key of [...prepareFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) prepareFailures.delete(key);
  }
  for (const key of [...containerFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) containerFailures.delete(key);
  }
  for (const key of [...serviceFailures.keys()]) {
    if (key.startsWith(`${sessionId}::`)) serviceFailures.delete(key);
  }
}

/** Notified when a session's activation round settles, so the UI can refetch. */
export type ActivationSettledHook = (sessionId: string) => void;

export interface PluginActivationDeps {
  /** Bare cache directory for a plugin repository's clone URL. */
  getBareCacheDir: (repoUrl: string) => string;
  /** Orchestrator-wide durable pin store (req 8 — project-scoped, not per session). */
  pinStorePath: string;
  /** Create/refresh the bare cache. Orchestrator-side, so fetch credentials never leave it (req 19). */
  ensureCache: (cacheDir: string, repoUrl: string) => Promise<void>;
  /**
   * Called once per session when every repository in this round has settled.
   * Activation is fire-and-forget, so without a push the browser can only
   * poll — and a poll that gives up leaves the card stuck (review finding).
   */
  onSettled?: ActivationSettledHook;
  /**
   * Run the selected plugins' `install` against a STAGED generation, before
   * anything is published (plan §1b). Injected all the way from
   * `bootstrap-managers`, because the implementation needs Docker — install
   * runs in a container of its own, and neither this module nor
   * `plugin-generations.ts` executes plugin-authored code (req 19).
   *
   * Omitted where there is no Docker (local mode, tests): the step is skipped
   * and activation is exactly what it was before.
   */
  runInstall?: PluginInstallHook;
  /**
   * docs/262 req 15 — the consumer lease a prune takes before it deletes a
   * superseded generation (`plugin-leases.ts`). Injected from
   * `bootstrap-managers` for the same reason `runInstall` is: half of it is a
   * question only Docker can answer.
   *
   * Omitted where there is no Docker (local mode, tests), where nothing can be
   * holding a generation because there are no plugin containers at all.
   */
  beginGenerationDeletion?: BeginGenerationDeletion;
  /**
   * docs/262 plan §1a phase 3 — the pre-publish gate
   * (`services/plugin-preflight.ts`): a candidate whose compose fragment cannot
   * be used, or whose service name is already claimed, is refused before it is
   * published, so the prior complete version keeps running (req 15).
   *
   * Injected all the way from `bootstrap-managers` for the same reason
   * `runInstall` is: the generation engine must not grow a dependency on the
   * service layer. Omitted → the step is skipped and activation behaves exactly
   * as it did before.
   */
  validateStaged?: ValidateStagedGeneration;
}

/** The install hook's shape, taken from the generation engine that calls it. */
export type PluginInstallHook = NonNullable<Parameters<typeof activateGeneration>[1]["runInstall"]>;

/**
 * Activate every tracked repository the session declares. `self` entries are
 * skipped: they run the live working tree and have no generation (req 27).
 *
 * `onlyRepo` narrows the round to one declared repository, which is what an
 * explicit `shipit plugin refresh <name>` asks for: re-fetching every other
 * repository because the agent named one would be a surprise, and a slow one.
 * Everything else — the per-repo queue, the in-flight counter, the epoch, the
 * settled hook — is unchanged, so a narrowed round is an ordinary round.
 *
 * Never throws — each repository fails independently (req 14).
 */
export async function activateDeclaredPlugins(
  sessionId: string,
  workspaceDir: string,
  deps: PluginActivationDeps,
  consumerKey?: string,
  onlyRepo?: string,
  /**
   * docs/266-plugin-install-diagnosability reqs 5, 6 — re-stage and re-install the version that is already
   * live. Only ever set together with `onlyRepo`: `shipit plugin refresh
   * --force` refuses without a repository name, and this signature keeps that
   * pairing visible at the one call site that can set it.
   */
  force?: boolean,
): Promise<Map<string, ActivationOutcome>> {
  /**
   * THIS call's own outcome per repository.
   *
   * Deliberately separate from the shared state map below, which is the UI's
   * "latest attempt" and is overwritten by whichever round finishes last. An
   * awaited caller (`shipit plugin refresh`) needs the result of the round IT
   * ran: with two rounds in flight, the shared map can already say
   * `activating: true` for the next one by the time this one formats its
   * answer, so a failed refresh read back as `unchanged` and exited 0 (review
   * finding). The counter still governs the shared flag; it cannot stand in
   * for a per-caller result.
   */
  const outcomes = new Map<string, ActivationOutcome>();
  let config: ShipitConfig;
  let repos: DeclaredPluginRepo[];
  let selectedByRepo: Map<string, string[]>;
  let stateDir: string;
  try {
    config = resolveShipitConfig(workspaceDir);
  } catch {
    // A malformed document is already reported by the config warning path and
    // by the snapshot route; there is nothing to activate from it.
    return outcomes;
  }

  const epoch = epochs.get(sessionId) ?? 0;
  const isCancelled = (): boolean => (epochs.get(sessionId) ?? 0) !== epoch;

  /**
   * End of round: refresh the per-import primitives, then tell the world.
   *
   * The state directories and settings files (reqs 17, 18, 26) are refreshed
   * here rather than beside the generation work because they belong to the
   * *declaration*, not to a fetch: a `repo: self` import has no generation at
   * all, and a round narrowed to one repository (`shipit plugin refresh
   * <name>`) must still leave every other import's settings current. Running it
   * AFTER activation is what makes a refresh reach them — the new commit's
   * manifest is what the settings are validated against.
   */
  const settleRound = (): void => {
    if (isCancelled()) return;
    syncPluginState(sessionId, workspaceDir);
    deps.onSettled?.(sessionId);
  };

  try {
    // Still settle: a declaration emptied of repos must reach the container, or
    // links for repos that are no longer declared stay addressable until the
    // container is recreated (review finding).
    if (!config.plugins.declared) {
      settleRound();
      return outcomes;
    }
    repos = config.plugins.repos.filter((r) => r.source.kind === "github");
    if (onlyRepo) {
      repos = repos.filter((r) => r.name.toLowerCase() === onlyRepo.toLowerCase());
    }
    // Phase-2 input: which exports this consumer actually selected from each
    // repository. A selected name the fetched manifest lacks invalidates that
    // repository's generation (plan §1a).
    selectedByRepo = new Map();
    for (const use of config.plugins.uses) {
      const key = use.from.toLowerCase();
      selectedByRepo.set(key, [...(selectedByRepo.get(key) ?? []), use.plugin]);
    }
    // Resolved HERE, not beside the config read: an unrecognized session layout
    // throws (planning#288), and that must not cost a project which declares
    // nothing the settled hook it used to get — that hook is also what removes
    // container links for repos the declaration dropped.
    stateDir = sessionStateDirForWorkspace(workspaceDir);
  } catch {
    return outcomes;
  }
  // req 27 — the `repo: self` half of the generation-identity guard, and the
  // only place it can run. A self declaration activates nothing, so no round of
  // the tracked path below will ever reconcile what sits on disk under its name;
  // a `repos:` entry re-pointed from `owner/repo` to `self` would otherwise
  // leave the previous repository's checkout published under this name for the
  // session's whole life, readable through the read-only store mount. Every
  // reader already REFUSES it (a self declaration resolves no generation at
  // all) — this is what stops it lying around, and it is the same retirement,
  // with the same lease, that `activateOnce` runs before its fetch.
  //
  // A narrowed round is left alone: it speaks for the one repository the agent
  // named, and `shipit plugin refresh` refuses a self name outright.
  if (!onlyRepo) {
    await retireSelfDeclaredGenerations(config.plugins.repos, workspaceDir, stateDir, deps, isCancelled);
  }

  if (repos.length === 0) {
    // Nothing to fetch — but a `repo: self` declaration lives entirely in this
    // branch, and it gets the same state directory and settings file a tracked
    // import does (req 27's consumer-path parity).
    settleRound();
    return outcomes;
  }

  /** Drop any write whose session was disposed (or re-activated) meanwhile. */
  const setState = (repoName: string, state: PluginRepoActivationState): void => {
    if (isCancelled()) return;
    activationState.set(stateKey(sessionId, repoName), state);
  };

  await Promise.all(
    repos.map(async (repo) => {
      const key = flightKey(sessionId, epoch, repo.name);
      inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
      const existing = readActiveGeneration(stateDir, repo.name, destinationKey(repo.source)) ?? undefined;
      setState(repo.name, { activating: true, ...(existing ? { generation: existing } : {}) });

      const repoUrl = cloneUrl(repo);
      let outcome: Awaited<ReturnType<typeof activateGeneration>>;
      try {
        outcome = await activateGeneration(repo, {
          stateDir,
          bareCacheDir: deps.getBareCacheDir(repoUrl),
          repoUrl,
          // A project with no remote is identified by its session: two sessions
          // of an unremoted project are separate projects for pinning purposes.
          consumerKey: consumerKey ?? `session:${sessionId}`,
          pinStorePath: deps.pinStorePath,
          selectedExports: selectedByRepo.get(repo.name.toLowerCase()) ?? [],
          ensureCache: deps.ensureCache,
          isCancelled,
          ...(deps.runInstall ? { runInstall: deps.runInstall } : {}),
          ...(deps.validateStaged ? { validateStaged: deps.validateStaged } : {}),
          ...(deps.beginGenerationDeletion
            ? { beginGenerationDeletion: deps.beginGenerationDeletion }
            : {}),
          // Guarded by `onlyRepo` as well as by the caller: a force that
          // reached a round over every declared repository would discard each
          // one's writable layer, and this is the last place that pairing can
          // be enforced rather than trusted.
          ...(force && onlyRepo ? { force: true } : {}),
        });
      } catch (err) {
        // `activateGeneration` is documented never to throw, but the counter
        // must not strand `activating: true` forever if that ever changes.
        outcome = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      }
      // Recorded BEFORE the counter check below, which returns early when
      // another trigger is queued — that early return is about the shared UI
      // flag, and must not cost this caller its own answer.
      outcomes.set(repo.name, outcome);

      // Another trigger is still queued for this repository, so the round is
      // not over: leave `activating` set and let the last one out report.
      const remaining = (inFlight.get(key) ?? 1) - 1;
      if (remaining > 0) {
        inFlight.set(key, remaining);
        return;
      }
      inFlight.delete(key);

      if (outcome.status === "failed") {
        setState(repo.name, {
          activating: false,
          error: outcome.reason,
          ...(outcome.previous ? { generation: outcome.previous } : {}),
          ...(outcome.warning ? { warning: outcome.warning } : {}),
          ...(outcome.missingSelectors?.length ? { missingSelectors: outcome.missingSelectors } : {}),
          ...(outcome.declaredHosts?.length
            ? {
                declaredHosts: {
                  source: destinationKey(repo.source),
                  exports: outcome.declaredHosts,
                },
              }
            : {}),
        });
        console.warn(`[plugins:${sessionId}] ${repo.name}: ${outcome.reason}`);
        return;
      }
      setState(repo.name, {
        activating: false,
        generation: outcome.generation,
        // req 8 — a moved tag that the durable pin overrode is advisory, and
        // it must reach the user on the SUCCESS path too.
        ...(outcome.warning ? { warning: outcome.warning } : {}),
      });
    }),
  );

  // Refresh the per-import primitives against whatever is now live, then tell
  // the browser the round settled so it refetches instead of polling until its
  // budget runs out. The container's prepare step hangs off the same hook: it
  // is what REMOVES links for repos the declaration no longer names, which is
  // why even a round with nothing to activate settles.
  settleRound();
  return outcomes;
}

/**
 * Bring every imported plugin's state directory and settings file up to date
 * (reqs 17, 18, 26 — `plugin-state.ts`).
 *
 * Never throws and never fails a round: these are primitives the plugin's own
 * surfaces read, so a failure to prepare one degrades that plugin, not the
 * session (req 13). The issues it reports reach the Plugins card through the
 * snapshot route, which recomputes them from the same pure resolver.
 */
function syncPluginState(sessionId: string, workspaceDir: string): void {
  try {
    // The declaration is re-read HERE rather than reused from the start of the
    // round, and that ordering is load-bearing (review finding). A round holds
    // its config for as long as its slowest repository takes to fetch, so a
    // second round triggered by an edit in that window could write the new
    // settings and then have the first round's settlement put the OLD ones
    // back. Settings are derived config, not a fetch decision: the right answer
    // is always the current file, so whichever settlement runs last converges
    // on it instead of resurrecting a superseded declaration.
    const config = resolveShipitConfig(workspaceDir);
    const entries = preparePluginState({
      // The session ROOT, not its state dir: these primitives are durable and
      // the state dir is reclaimable (see `plugin-state.ts`). Both paths are
      // resolved here rather than passed in, so a session layout this repo no
      // longer serves degrades to a logged warning instead of costing the round
      // its settled hook.
      sessionDir: sessionRootForWorkspace(workspaceDir),
      uses: config.plugins.uses,
      resolver: createPluginImportResolver(
        config.plugins,
        config.pluginExports,
        // One resolution per repository for this whole settlement, so every
        // import's settings are validated against the same generation the one
        // beside it was (docs/262 resolve-once).
        resolveLiveGenerations(sessionStateDirForWorkspace(workspaceDir), config.plugins.repos),
      ),
    });

    // Resolution issues are recomputed by the snapshot route from the same pure
    // resolver, so only the FAILURES are remembered — nothing else can
    // reconstruct "the write did not happen", and a plugin whose settings are
    // stale must not look healthy (review finding).
    for (const key of [...prepareFailures.keys()]) {
      if (key.startsWith(`${sessionId}::`)) prepareFailures.delete(key);
    }
    for (const entry of entries) {
      for (const issue of entry.issues) console.warn(`[plugins:${sessionId}] ${issue}`);
      if (!entry.failure) continue;
      console.warn(`[plugins:${sessionId}] ${entry.failure}`);
      const key = stateKey(sessionId, entry.repo ?? entry.alias);
      prepareFailures.set(key, [...(prepareFailures.get(key) ?? []), entry.failure]);
    }
  } catch (err) {
    console.warn(
      `[plugins:${sessionId}] could not prepare plugin state:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Retire whatever a previous declaration left published under a name the
 * project now declares as `repo: self` (req 27).
 *
 * Never throws and never fails a round: this is housekeeping behind a guard that
 * already holds — every reader refuses a generation under a self-declared name,
 * so a retirement that cannot complete costs disk, not correctness (req 13).
 */
async function retireSelfDeclaredGenerations(
  repos: readonly DeclaredPluginRepo[],
  workspaceDir: string,
  stateDir: string,
  deps: PluginActivationDeps,
  isCancelled: () => boolean,
): Promise<void> {
  for (const repo of repos) {
    if (repo.source.kind !== "self" || isCancelled()) continue;
    try {
      await retireSelfDeclaredGeneration(
        stateDir,
        repo.name,
        deps.beginGenerationDeletion,
        // Re-read at the moment the queued work runs, never the round's own
        // captured copy: rounds overlap, and a round that started while this
        // name said `self` must not delete a generation a later round has since
        // published for a tracked declaration of it (review finding).
        () => isSelfDeclared(workspaceDir, repo.name) && !isCancelled(),
      );
    } catch (err) {
      console.warn(
        `[plugins] ${repo.name}: could not retire a version left under a \`repo: self\` name:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Does the project declare this name as `repo: self` RIGHT NOW?
 *
 * Fails closed: an unreadable or changed declaration answers `false`, so the
 * retirement it guards does nothing rather than acting on a guess.
 */
function isSelfDeclared(workspaceDir: string, repoName: string): boolean {
  try {
    return resolveShipitConfig(workspaceDir).plugins.repos.some(
      (r) => r.source.kind === "self" && r.name.toLowerCase() === repoName.toLowerCase(),
    );
  } catch {
    return false;
  }
}

/** The clone URL for a declared repo. GitHub-only in v1 (plan §1a). */
function cloneUrl(repo: DeclaredPluginRepo): string {
  return pluginCloneUrl(repo.source);
}
