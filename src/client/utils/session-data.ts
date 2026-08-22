import type { ChatMessage } from "../components/MessageList.js";
import type { GitCommit } from "../components/GitHistory.js";
import type { FileTreeNode } from "../../server/shared/types.js";
import type { SessionInfo, RepoInfo, TurnUsage, SessionUsage, RuntimeMode, CredentialRoute } from "../../server/shared/types.js";
import { turnContextTokens } from "../../server/shared/types.js";
import { getContextWindowForModel } from "../../server/shared/model-windows.js";
import type { ReviewerSlotView, RoleView } from "../../server/shared/types/agent-types.js";
import type { AgentOption } from "../agent-types.js";
import type { TemplateInfo } from "./template-info.js";
import { useSessionStore } from "../stores/session-store.js";
import { useGitStore } from "../stores/git-store.js";
import { useFileStore } from "../stores/file-store.js";
import { usePreviewStore } from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";
import { useSettingsStore } from "../stores/settings-store.js";
import { useRepoStore } from "../stores/repo-store.js";
import { useBugReportStore, type BugReportCardState } from "../stores/bug-report-store.js";
import { useEgressPromptStore, type EgressPromptCardState } from "../stores/egress-prompt-store.js";
import { usePermissionStore, type PermissionCardState } from "../stores/permission-store.js";
import { useIssueWriteStore } from "../stores/issue-write-store.js";
import { usePresentStore } from "../stores/present-store.js";
import { backgroundTaskLabel } from "../hooks/message-handlers/background-tasks.js";
import type { IssueWriteCard } from "../../server/shared/types.js";

interface PreviewStatusResponse {
  known: boolean;
  running: boolean;
  port: number;
  url: string;
  source: "vite" | "managed" | "detected";
  detectedPorts?: number[];
}

interface HistoryResponse {
  messages: {
    role: string;
    text: string;
    toolUse?: unknown[];
    toolResults?: { toolUseId: string; content: string; isError?: boolean; durationMs?: number }[];
    images?: unknown[];
    files?: unknown[];
    isError?: boolean;
    inProgress?: boolean;
    subagentEvents?: unknown[];
  }[];
  commits: GitCommit[];
  agentRunning?: boolean;
  /**
   * docs/235 — descriptions of the outstanding agent-initiated background tasks.
   * A session can be between turns (`agentRunning: false`) and still be waiting
   * on work; this is the authoritative snapshot of that state at load time.
   */
  backgroundTasks?: string[];
  /**
   * Per-turn usage series for this session — sourced from `usage_turns` so
   * the ContextDial popover sees a complete history (not just turns observed
   * during the current WS connection).
   */
  turnUsage?: TurnUsage[];
  /** Cumulative session totals — seeds the cost surface on reload. */
  sessionUsage?: SessionUsage | null;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  rewindSnapshot?: {
    sessionId: string;
    action: "chat" | "code" | "both" | "fork";
    expiresAt: number;
  } | null;
  /**
   * docs/093 — durable Present-tab metadata. Rehydrates the present-store on
   * session load so the Present tab survives a reload / session switch / a
   * container restart (the artifact's bytes fetch lazily as today). Metadata
   * only — no `content`.
   */
  presentations?: {
    presentId: string;
    mimeType: string;
    title?: string;
    filePath: string;
    createdAt: string;
  }[];
}

interface BootstrapResponse {
  sessions: SessionInfo[];
  repos?: RepoInfo[];
  agents: AgentOption[];
  templates: TemplateInfo[];
  githubStatus: { authenticated: boolean; username?: string; avatarUrl?: string };
  settings: {
    /** docs/257 req 8 — server-computed "this install can run a turn". */
    canRunTurns?: boolean;
    /** docs/257 req 9 — when harness onboarding was first completed (ISO). */
    harnessOnboardingCompletedAt?: string;
    gitIdentity: { name: string; email: string };
    systemPrompt: string;
    maxIdleContainers?: number | null;
    agentSystemInstructionsEnabled?: boolean;
    agentSystemInstructions?: string;
    autoCreatePr?: boolean;
    liveSteering?: boolean;
    autoResolveConflicts?: boolean;
    autoFixCi?: boolean;
    autoResetMergedBranch?: boolean;
    enableSubAgents?: boolean;
    providerAccounts?: CredentialRoute[];
    credentialRoutes?: CredentialRoute[];
    /** docs/252 phase 7 (req 9) — the pinned non-turn model, absent for "follow the install". */
    nonTurnModel?: { serviceId: string; billingMode: "sub" | "key"; modelId: string };
    /** docs/252 phase 7 (req 9) — what non-turn work resolves to now, harness included. */
    nonTurnModelResolved?: {
      serviceId: string;
      billingMode: "sub" | "key";
      modelId: string;
      serviceName: string;
      label: string;
      harnessId: string;
      source: "pinned" | "default";
    };
    /** docs/261 phase 3 (req 8) — both reviewer slots, pinned or auto-configured. */
    reviewers?: ReviewerSlotView[];
    /** docs/264 phase 2 — every agent role, each resolved by the server. */
    roles?: RoleView[];
    /** docs/150-multiple-provider-subscriptions reqs 4-6 — per-provider proactive failover cutoffs, keyed by agent id. */
    failoverCutoffs?: Record<string, { session: number; weekly: number }>;
    accountSelectionMode?: Record<string, "strict" | "balanced">;
  };
  /** Orchestrator runtime mode (feature 118). Defaults to "containerized". */
  runtimeMode?: RuntimeMode;
  /**
   * Tailscale sslip preview host (docs/216). Present only on a Tailscale VPS
   * deploy; routes preview iframes through sslip.io while the app/WS stay on the
   * native MagicDNS host.
   */
  tailnetPreviewHost?: string;
}

/**
 * Monotonic id of the most recently *issued* history load. A response may only
 * be applied if no later load has been issued since — "last request wins",
 * not "last response wins".
 *
 * Without this, more than one load can be in flight at once and the responses
 * can land out of order, because nothing cancels a load when the connection it
 * was issued for is replaced. A window reactivation is the common way in:
 * `useWebSocket` force-reconnects on foreground, so a load issued for the
 * outgoing socket is still in flight when the incoming socket opens and issues
 * its own. When the stale one lands last it does two destructive things:
 *
 *   1. `setMessages` rewinds the transcript to the DB snapshot it read. For a
 *      running turn the DB only holds rows up to the last tool-result boundary,
 *      so everything the turn produced since — text, tool calls, cards — is
 *      wiped. Live events only append after that, so the hole never heals; a
 *      reload repairs it because the DB itself was fine. That is the reported
 *      "messages disappeared on reactivation, reload brought them back".
 *   2. `setHistoryLoaded(true)` fires mid-reconnect, which breaks the ordering
 *      invariant `turn_snapshot` depends on (`useMessageHandler` queues the
 *      snapshot only while history is *not* loaded, so it lands on top of the
 *      baseline). A snapshot dispatched immediately instead applies its
 *      replace-filter against whatever the transcript happens to hold.
 *
 * Scoping by session id alone doesn't catch either — both loads are for the
 * same session.
 */
let historyLoadSeq = 0;

/**
 * The load `historyLoadSeq` currently names, so issuing a newer one can CANCEL
 * it rather than merely discard its answer (planning#375).
 *
 * `historyLoadSeq` alone makes a superseded response harmless, not free: the
 * body is still streamed to the browser and still `JSON.parse`d before the
 * guard above drops it. A DevTools trace of a foreground reconnect caught the
 * cost — two `/history` requests 480 ms apart, **2.67 MB each**, one of them
 * downloaded and parsed purely to be thrown away, on a main thread that was
 * already the bottleneck.
 *
 * Aborting, rather than having the new caller AWAIT the in-flight one: the
 * whole reason a second load exists is that the socket the first was issued for
 * is gone (see the `closed`/`connecting` branch of `useConnectionSync`, which
 * deliberately frees the next open to issue its own). Chaining the fresh load
 * onto a request whose connection is dead would hang the transcript behind a
 * fetch that may never settle — the failure the seq guard was written to avoid,
 * re-introduced from the other side.
 *
 * The seq guard stays regardless: `abort()` races a response that is already
 * being applied, and it is the guard — not the cancellation — that makes
 * out-of-order application impossible.
 */
let inFlightHistoryLoad: { seq: number; controller: AbortController } | null = null;

/**
 * Parsed `/history` responses, keyed by session, with the ETag they arrived
 * under (planning#375).
 *
 * The user moves between sessions constantly and each move re-downloaded the
 * whole conversation — 2.67 MB in the traced session. With this, a switch back
 * sends `If-None-Match`, gets a `304`, and reuses the parsed object: no
 * transfer, no `JSON.parse`, no re-materialising thousands of message objects.
 *
 * Correctness is the server's, not ours: a `304` is a positive statement that
 * nothing changed, and we never decide for ourselves that a cached transcript is
 * still good. The tag is no longer a hash of the body (planning#324 — the server
 * cannot afford to build megabytes to discover it has nothing to send); it is
 * composed from the session's transcript revision, the other payload sources,
 * and a wire-shape version. Same guarantee, arrived at without the build.
 *
 * Bounded because a transcript is megabytes and a long day touches many
 * sessions. `Map` iterates in insertion order, so the oldest entry is the first
 * key — re-inserting on every hit keeps the bound honest (LRU, not FIFO).
 */
const HISTORY_CACHE_LIMIT = 6;

interface HistoryCacheEntry {
  etag: string;
  data: HistoryResponse;
  /**
   * The `ChatMessage[]` this payload was last materialized into, memoized —
   * see `materializeTranscript`. Absent until the first install; dropped with
   * the entry when a fresh body replaces it, because a new payload can never
   * reuse the old payload's rows.
   */
  materialized?: ChatMessage[];
}

const historyCache = new Map<string, HistoryCacheEntry>();
const treeCache = new Map<string, { etag: string; data: FileTreeNode[] }>();

function remember<T, E extends { etag: string; data: T }>(cache: Map<string, E>, key: string, etag: string, data: T): E {
  cache.delete(key);
  const entry = { etag, data } as E;
  cache.set(key, entry);
  while (cache.size > HISTORY_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return entry;
}

/**
 * Mark an entry as most-recently-used. Called on a 304 as well as on a fresh
 * body — without it the map is FIFO despite the LRU intent, and the session the
 * user keeps returning to (which answers 304 every time, and so never gets
 * re-inserted) would age out and be re-downloaded in full.
 */
function touch(cache: Map<string, { etag: string; data: unknown }>, key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cache.delete(key);
  cache.set(key, entry);
}

/** Testing seam — a fresh tab starts with an empty cache, so tests should too. */
export function __resetHistoryCache(): void {
  historyCache.clear();
  treeCache.clear();
}

/**
 * Conditional GET for the workspace file tree (planning#375).
 *
 * Fetched HERE rather than through `useFileStore.fetchTree`, and awaited inside
 * the same `isStillActiveSession()` guard as everything else this function
 * writes. A fire-and-forget `fetchTree` was the first attempt and it was wrong
 * twice over: the store's setter has no session check, so a slow response for
 * the OUTGOING session lands after the switch and overwrites the incoming
 * session's tree; and the tree arriving strictly after the transcript makes the
 * Files panel say "No files yet" for the gap. Both disappear when the tree rides
 * the load it belongs to.
 */
async function fetchFileTree(sessionId: string, signal: AbortSignal): Promise<FileTreeNode[] | null> {
  const cached = treeCache.get(sessionId);
  const res = await fetch(`/api/sessions/${sessionId}/files`, {
    signal,
    cache: "no-store",
    ...(cached ? { headers: { "If-None-Match": cached.etag } } : {}),
  });
  if (res.status === 304 && cached) {
    touch(treeCache, sessionId);
    return cached.data;
  }
  if (!res.ok) return null;
  const { tree } = await res.json() as { tree: FileTreeNode[] };
  const etag = res.headers?.get("etag");
  if (etag) remember(treeCache, sessionId, etag, tree);
  return tree;
}

/**
 * Turn the payload's rows into the transcript's `ChatMessage[]`, reusing the
 * previous materialization of the SAME cached payload (planning#467).
 *
 * The install itself is unconditional and stays that way — see
 * `loadSessionHistory`. What this removes is its *cost*, which was the whole of
 * the complaint: `data.messages.map(...)` allocated a fresh `ChatMessage` for
 * every row on every load, and `TranscriptRow` takes its message as the `anchor`
 * prop — "the row's catch-all change signal". A fresh object per row is a memo
 * miss per row, so every history load re-rendered the entire transcript: the
 * measured **92 ms at ~2,000 rows** that planning#375's memo work exists to
 * avoid (`transcript-row-memo.test.tsx`, `visual-elements.ts:reuseUnchanged`).
 * A foreground reconnect pays it on every alt-tab, and planning#324's cheap
 * validator made those reconnects *more* frequent, not fewer.
 *
 * On a `304` the payload object is the one already in the cache, so the rows it
 * produces are a pure function of an object we have already mapped. Memoizing
 * that map returns the identical array of identical rows, which means:
 * `useSessionStore`'s `messages` selector sees an `Object.is`-equal value and
 * does not re-render at all, and where it must (a switch-back, which cleared the
 * array) every row still bails out of its memo.
 *
 * Doing it this way rather than skipping the install keeps every guarantee the
 * install carries — the switch-back baseline restore, wiping client-only rows
 * such as `useConnectionSync`'s "connection lost" notice — and adds no state
 * whose validity depends on every future `setMessages` caller behaving.
 *
 * The one thing it does assume is what the client already does everywhere: rows
 * are treated as immutable (every handler rebuilds with `{...m}`). A row mutated
 * in place would now persist into the next install instead of being discarded by
 * a re-map.
 */
function materializeTranscript(data: HistoryResponse, entry: HistoryCacheEntry | undefined): ChatMessage[] {
  if (entry?.materialized) return entry.materialized;
  // `inProgress` rides through to the ChatMessage: it marks the rows that
  // belong to a still-running turn, which is exactly the set an attach-time
  // `turn_snapshot` replaces (see `turn-snapshot.ts`). `streaming` stays the
  // narrower "this bubble is being written to" flag the renderer uses.
  const rows = data.messages.map((m) => ({
    ...m,
    streaming: m.inProgress ?? false,
  } as unknown as ChatMessage));
  if (entry) entry.materialized = rows;
  return rows;
}

/**
 * Rehydrate the four authoritative card stores from the persisted rows
 * (docs/164 bug-report, docs/193 permission, docs/172 egress-prompt,
 * docs/177 issue-write).
 *
 * This runs on EVERY completed load, a `200` and a `304` alike, and must never
 * be conditioned on the transcript having changed (planning#467). The seeds are
 * not a consequence of installing the transcript; they are the correction for a
 * *different* channel. On every attach the orchestrator replays the turn-event
 * buffer, and that replay deliberately skips only `agent_event`, `turn_snapshot`,
 * `log_append`, the terminal messages and `background_tasks`
 * (`route-registry.ts:1112`) — card messages go through. A replayed card lands
 * via its store's non-clobbering `upsertCard`, i.e. as a fresh draft/pending
 * entry, and only this authoritative seed restores the persisted phase.
 *
 * So "the transcript is unchanged" says nothing about what the replay just wrote
 * into the card stores. Skipping the seed because the body was cached is exactly
 * what made a filed bug report render as an editable draft and a resolved
 * permission re-offer Approve/Deny — the closed PR #2536's failure mode, and the
 * one thing planning#467 rules out by name.
 *
 * The reverse order converges too: a replay landing *after* the seed is a no-op
 * against an existing entry, which is why `upsertCard` never overwrites.
 *
 * Guard test: "re-seeds the card stores on a 304 over a replay-created draft".
 */
function seedCardStoresFromHistory(messages: HistoryResponse["messages"]): void {
  // docs/164 — so each `BugReportCard` renders with its correct phase (a filed
  // card comes back "filed" with its issue link; a failed one as an editable
  // draft).
  const persistedCards = messages
    .map((m) => (m as { bugReport?: BugReportCardState }).bugReport)
    .filter((b): b is BugReportCardState => !!b && typeof b.cardId === "string" && !!b.phase);
  if (persistedCards.length > 0) {
    useBugReportStore.getState().seedCards(persistedCards);
  }

  // docs/193 / planning#114 — so each `PermissionRequestCard` renders with its
  // correct phase (an approved/denied/expired card comes back resolved, not
  // re-offering Approve/Deny). A still-pending card comes back actionable — the
  // worker holds the request, so the user can answer it after a reload.
  const persistedPermissions = messages
    .map((m) => (m as { permissionPrompt?: PermissionCardState }).permissionPrompt)
    .filter((p): p is PermissionCardState => !!p && typeof p.requestId === "string" && !!p.phase);
  if (persistedPermissions.length > 0) {
    usePermissionStore.getState().seedCards(persistedPermissions);
  }

  // docs/172 / planning#92 — so each `EgressPromptCard` renders with its correct
  // phase (a resolved card comes back resolved, not re-offering the buttons).
  const persistedEgress = messages
    .map((m) => (m as { egressPrompt?: EgressPromptCardState }).egressPrompt)
    .filter((e): e is EgressPromptCardState => !!e && typeof e.cardId === "string" && !!e.phase);
  if (persistedEgress.length > 0) {
    useEgressPromptStore.getState().seedCards(persistedEgress);
  }

  // docs/177 — so each `IssueWriteCard` renders with its correct undo state (an
  // undone card comes back "undone", not re-offering Undo).
  const persistedWrites = messages
    .map((m) => (m as { issueWrite?: IssueWriteCard }).issueWrite)
    .filter((w): w is IssueWriteCard => !!w && typeof w.cardId === "string" && !!w.undoState);
  if (persistedWrites.length > 0) {
    useIssueWriteStore.getState().seedCards(persistedWrites);
  }
}

/**
 * Fetch session history via HTTP and populate stores.
 * Shared between useConnectionSync (WS reconnect) and session-actions (session resume).
 */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const seq = ++historyLoadSeq;
  // Supersede the previous load — including one for a different session, since
  // `historyLoadSeq` is global and "last request wins" is too.
  inFlightHistoryLoad?.controller.abort();
  const controller = new AbortController();
  inFlightHistoryLoad = { seq, controller };
  let data: HistoryResponse;
<<<<<<< HEAD
  /**
   * The cache entry `data` came from, when there is one. Carried out of the
   * fetch so the install can memoize its materialization into it — see
   * `materializeTranscript`. Absent only when the response had no ETag (an
   * older server, a proxy that strips it, a test double), which degrades to
   * exactly the old behaviour: a fresh map, every load.
   */
  let cacheEntry: HistoryCacheEntry | undefined;
=======
  let etag: string | undefined;
  let fromCache = false;
>>>>>>> bc6f3c4d (The transcript survived every reconnect intact — the primes answer is streaming to completion, and no 304 truncated anyt)
  // In parallel with the transcript, not after it — two independent conditional
  // GETs on one round trip's worth of latency. Failure is tolerated (`null`):
  // an unreachable file tree must never cost the user their transcript.
  const treePromise = fetchFileTree(sessionId, controller.signal).catch(() => null);
  try {
    const cached = historyCache.get(sessionId);
    const res = await fetch(`/api/sessions/${sessionId}/history`, {
      signal: controller.signal,
      // Our own conditional request, so the 304 is visible HERE. Left to the
      // browser's HTTP cache the revalidation would still happen, but `fetch`
      // would hand back a 200 with the cached body and we would re-parse the
      // megabytes we are trying to avoid.
      cache: "no-store",
      ...(cached ? { headers: { "If-None-Match": cached.etag } } : {}),
    });
    if (res.status === 304 && cached) {
      // The cached payload is installed exactly as a fresh body would be —
      // deliberately, on both paths (planning#467). A 304 is a positive
      // statement that every payload source is unchanged: the validator is
      // composed from the transcript revision AND the whole non-transcript rest
      // (`api-routes-session-spawn.ts`), so the cached object cannot be staler
      // than a 200 in any field.
      //
      // Making the install conditional here was considered and rejected. It
      // breaks the session switch-back, where `resumeSessionInternal` cleared
      // `messages` and this install IS the incoming session's baseline restore;
      // recovering that needs a marker saying whether the array is still the
      // payload's materialization, and the marker's validity then rests on every
      // present and future `setMessages` caller. The cost it was reaching for is
      // removed instead, by `materializeTranscript`, which the install below
      // shares — a 304 re-installs the identical array of identical rows, which
      // no subscriber re-renders for.
      data = cached.data;
<<<<<<< HEAD
      cacheEntry = cached;
=======
      etag = cached.etag;
      fromCache = true;
>>>>>>> bc6f3c4d (The transcript survived every reconnect intact — the primes answer is streaming to completion, and no 304 truncated anyt)
      touch(historyCache, sessionId);
    } else {
      data = await res.json() as HistoryResponse;
      // Optional: a response with no ETag simply is not cached, which is the
      // correct degradation (an older server, a proxy that strips it, a test
      // double). Never cache without a tag — the tag is the only thing that
      // makes a later reuse safe.
<<<<<<< HEAD
      const etag = res.headers?.get("etag");
      if (etag) cacheEntry = remember(historyCache, sessionId, etag, data);
=======
      etag = res.headers?.get("etag") ?? undefined;
      if (etag) remember(historyCache, sessionId, etag, data);
>>>>>>> bc6f3c4d (The transcript survived every reconnect intact — the primes answer is streaming to completion, and no 304 truncated anyt)
    }
  } catch (err) {
    // A load we cancelled ourselves is not a failure. Return rather than throw,
    // matching what a superseded load has always done — `useConnectionSync`
    // relies on that (it logs a throw as "Failed to load session history" and
    // suppresses its retry nudge).
    if (controller.signal.aborted) return;
    throw err;
  } finally {
    if (inFlightHistoryLoad?.seq === seq) inFlightHistoryLoad = null;
  }
  // Still the newest load for this session? A superseded response must not
  // write anything — see `historyLoadSeq`.
  const isStillActiveSession = () =>
    historyLoadSeq === seq && useSessionStore.getState().sessionId === sessionId;
  if (!isStillActiveSession()) {
    return;
  }
  const session = useSessionStore.getState();
<<<<<<< HEAD
  /**
   * Install the persisted transcript, unconditionally (planning#467).
   *
   * It is a wholesale replace, and during a running turn the payload is a
   * SUBSET of what is on screen: the in-memory array also holds everything the
   * turn has streamed since its last persist boundary. That gap is closed by
   * construction, not by luck. `historyLoaded` is false for the whole of this
   * load — `useConnectionSync` lowers it on the `closed`/`connecting`
   * transition, `resumeSessionInternal` lowers it on a switch — and
   * `useMessageHandler` queues `turn_snapshot` (with `agent_event` and
   * `sub_agent_spawn`) for exactly as long as it stays false. The attach sends
   * a fresh snapshot whenever the runner is running
   * (`route-registry.ts:attachToRunner`), `setHistoryLoaded(true)` below is
   * strictly after this line, and the queue drains on that flag — so the
   * snapshot always lands ON TOP of this baseline and its replace-filter
   * (`turn-snapshot.ts`) restores the live tail whichever order the two
   * arrived in on the wire.
   *
   * So there is no truncation window here, and none specific to the `304`.
   * Guards: `useMessageHandler.test.ts`, `useConnectionSync.session-switch.test.tsx`,
   * and the ordering test in this file's suite.
   */
  session.setMessages(materializeTranscript(data, cacheEntry));
=======
  // `inProgress` rides through to the ChatMessage: it marks the rows that
  // belong to a still-running turn, which is exactly the set an attach-time
  // `turn_snapshot` replaces (see `turn-snapshot.ts`). `streaming` stays the
  // narrower "this bubble is being written to" flag the renderer uses.
  //
  // docs/280 — the install is conditional on the 304 path. A 304 just had the
  // server certify the cached payload as the session's current transcript, so
  // re-installing it wholesale is only needed when the in-memory array is no
  // longer that payload's materialization (a switch, rewind or reset replaced
  // or cleared it — `setMessages` detaches the baseline marker on such a
  // replace). When the array still IS it, plus any live rows a running turn
  // streamed since, the install would wipe those rows for a render until the
  // attach-time `turn_snapshot` restores them — redundant work, and visibly
  // disruptive. The card seeds below deliberately do NOT share this
  // condition: they must run on every load, because the buffer replay that
  // re-delivers card events happens on every attach regardless of the 304.
  const baseline = session.historyBaseline;
  const transcriptAlreadyInstalled =
    fromCache &&
    baseline !== null &&
    baseline.sessionId === sessionId &&
    baseline.etag === etag;
  if (!transcriptAlreadyInstalled) {
    session.setMessages(
      data.messages.map((m) => ({
        ...m,
        streaming: m.inProgress ?? false,
      } as unknown as ChatMessage)),
    );
    session.setHistoryBaseline({ sessionId, etag });
  }
>>>>>>> bc6f3c4d (The transcript survived every reconnect intact — the primes answer is streaming to completion, and no 304 truncated anyt)

  // Rehydrate the four card stores from the persisted rows. Runs on every
  // completed load, `304` included, and deliberately does NOT share the
  // transcript's condition — see `seedCardStoresFromHistory`.
  seedCardStoresFromHistory(data.messages);

  // docs/093 — rehydrate the Present tab from durable metadata so it survives a
  // reload / session switch / container restart. `hydrate` replaces the list
  // without bumping the unseen badge or auto-switching the panel (silent sync),
  // is idempotent by presentId, and preserves any already-fetched bytes — so it
  // and the WS `present_state` replay can't double-render. Always called (even
  // empty) so a now-cleared session drops a stale tab.
  usePresentStore.getState().hydrate(data.presentations ?? []);

  // docs/235 — reconcile the standing background-task marker from the payload
  // before deciding the chat status line. This load is authoritative for THIS
  // session (and only this session): it carries the descriptions the SSE
  // `session_attention` snapshot has no room for, so switching in upgrades the
  // unnamed fallback label to the named one.
  const backgroundTasks = data.backgroundTasks ?? [];
  session.setBackgroundTaskSessions((prev) => {
    const next = new Map(prev);
    if (backgroundTasks.length > 0) { next.set(sessionId, backgroundTasks); } else { next.delete(sessionId); }
    return next;
  });

  if (data.agentRunning) {
    session.setIsLoading(true);
  } else if (backgroundTasks.length > 0) {
    // Between turns with work outstanding the session is not idle, it is
    // waiting — clearing the bar here reads as "finished". This is the same
    // rule `handleSessionStatus` applies at turn end; without it, hydration
    // raced the live/replayed `background_tasks` message and wiped the status
    // line a moment after the switch. `tool` is deliberately left unset — no
    // tool call is running, so the tool spinner would be a lie.
    session.setIsLoading(true);
    session.setActivity({ label: backgroundTaskLabel(backgroundTasks) });
  } else {
    session.setIsLoading(false);
    session.setActivity(undefined);
  }
  session.setHistoryLoaded(true);
  if (data.rewindSnapshot) {
    session.setRewindRecovery(data.rewindSnapshot);
  }
  useGitStore.getState().setCommits(data.commits);
  // planning#375 — the tree came from its own conditional GET, started in
  // parallel above. Applied HERE, inside the active-session guard, so a response
  // for a session the user has already left cannot overwrite the current one.
  const tree = await treePromise;
  if (tree && isStillActiveSession()) useFileStore.getState().setTree(tree);

  // Seed cost surfaces from the authoritative usage store on reload, so the
  // ContextDial doesn't have to wait for a fresh `usage_update` to know what
  // the session has cost so far.
  const ui = useUiStore.getState();
  if (data.turnUsage) {
    session.setTurnUsageForSession(sessionId, data.turnUsage);
    if (data.turnUsage.length > 0) {
      // Real context occupancy = uncached input + cache reads + cache writes;
      // `inputTokens` alone undercounts massively under prompt caching.
      ui.setContextTokens(turnContextTokens(data.turnUsage[data.turnUsage.length - 1]));
    }
    // Seed `modelInfo` from the most recent turn that recorded a model. The
    // server only emits `model_info` over WS on `agent_init`, so a session
    // loaded from history (page reload, session switch) where the agent isn't
    // actively running has no other way to know which model was last used.
    // Without this seeding the context dial — the surface that also shows the
    // running session cost — would hide entirely until the next turn fires.
    const lastWithModel = [...data.turnUsage].reverse().find((t) => t.model);
    if (lastWithModel?.model) {
      ui.setModelInfo({
        model: lastWithModel.model,
        contextWindowTokens: getContextWindowForModel(lastWithModel.model),
      });
    }
  }
  if (data.sessionUsage) {
    ui.setCurrentSessionUsage(data.sessionUsage);
  } else {
    ui.setCurrentSessionUsage(null);
  }
  ui.setCumulativeTokens(
    data.cumulativeInputTokens ?? 0,
    data.cumulativeOutputTokens ?? 0,
  );

  // Fetch preview status via HTTP — reliable fallback in case the WS
  // preview_status message is lost during the initial connection burst.
  try {
    const previewRes = await fetch(`/api/sessions/${sessionId}/preview-status`);
    if (!isStillActiveSession()) return;
    if (previewRes.ok) {
      const ps = await previewRes.json() as PreviewStatusResponse;
      if (!isStillActiveSession()) return;
      // Only apply if the store still has no status (WS message may have arrived first)
      if (ps.known && !usePreviewStore.getState().status) {
        usePreviewStore.getState().setStatus({
          running: ps.running,
          port: ps.port,
          url: ps.url,
          source: ps.source,
          detectedPorts: ps.detectedPorts,
        });
      }
      // If preview state is not yet known (runner SSE still connecting),
      // retry once after a delay. By then the runner should have received
      // state from the worker and the HTTP endpoint will return known: true.
      if (!ps.known) {
        setTimeout(async () => {
          if (!isStillActiveSession()) return;
          if (usePreviewStore.getState().status) return; // WS delivered it in the meantime
          try {
            const retryRes = await fetch(`/api/sessions/${sessionId}/preview-status`);
            if (!isStillActiveSession()) return;
            if (retryRes.ok) {
              const retry = await retryRes.json() as PreviewStatusResponse;
              if (!isStillActiveSession()) return;
              if (retry.known && !usePreviewStore.getState().status) {
                usePreviewStore.getState().setStatus({
                  running: retry.running,
                  port: retry.port,
                  url: retry.url,
                  source: retry.source,
                  detectedPorts: retry.detectedPorts,
                });
              }
            }
          } catch { /* non-critical */ }
        }, 3000);
      }
    }
  } catch {
    // Non-critical — WS will deliver the status eventually
  }
}

/**
 * Fetch bootstrap data via HTTP and populate stores.
 */
export async function loadBootstrapData(): Promise<void> {
  const res = await fetch("/api/bootstrap");
  if (!res.ok) throw new Error(`Bootstrap failed: ${res.status}`);
  const data = await res.json() as BootstrapResponse;
  useSessionStore.getState().setSessions(data.sessions);
  if (data.repos) useRepoStore.getState().setRepos(data.repos);
  useUiStore.getState().setAgentList(data.agents);
  useUiStore.getState().setTemplates(data.templates);
  useSettingsStore.getState().setGithubStatus({
    authenticated: data.githubStatus.authenticated,
    username: data.githubStatus.username,
    avatarUrl: data.githubStatus.avatarUrl,
  });
  useGitStore.getState().setIdentity(data.settings.gitIdentity);
  if (!data.settings.gitIdentity.name && !data.settings.gitIdentity.email) {
    useGitStore.getState().setIdentityNeeded(true);
  }
  // docs/257 req 8 — the readers here copy named fields rather than spreading
  // `settings`, so a new one has to be wired by hand or it silently never
  // arrives.
  //
  // `?? false` deliberately, and deliberately UNLIKE the `agent_list` SSE
  // handler, which ignores an absent field instead. This is the authoritative
  // full snapshot: a field missing from it means "the server did not say", and
  // "cannot run" is the safe reading. The SSE event is an incremental push,
  // where a missing field means "no news" and clobbering a good value with
  // `false` would disable a runnable install. (Both are belt-and-braces — the
  // SPA is served by the same orchestrator that answers this request, so a
  // server old enough to omit the field cannot serve a client new enough to
  // read it.)
  useSettingsStore.getState().setCanRunTurns(data.settings.canRunTurns ?? false);
  // docs/257 req 9 — `?? null` for the same reason as `?? false` above: this is
  // the authoritative full snapshot, so an absent field means "never completed"
  // rather than "no news". The SSE handler, an incremental push, ignores an
  // absent field instead.
  useSettingsStore.getState()
    .setHarnessOnboardingCompletedAt(data.settings.harnessOnboardingCompletedAt ?? null);
  useSettingsStore.getState().setHasSystemPrompt(data.settings.systemPrompt.length > 0);
  useSettingsStore.getState().setSystemPromptContent(data.settings.systemPrompt);
  if (data.settings.maxIdleContainers !== null && data.settings.maxIdleContainers !== undefined) useSettingsStore.getState().setMaxIdleContainers(data.settings.maxIdleContainers);
  if (data.settings.agentSystemInstructionsEnabled !== undefined) useSettingsStore.getState().setAgentSystemInstructionsEnabled(data.settings.agentSystemInstructionsEnabled);
  if (data.settings.agentSystemInstructions) useSettingsStore.getState().setAgentSystemInstructions(data.settings.agentSystemInstructions);
  if (data.settings.autoCreatePr !== undefined) useSettingsStore.getState().setAutoCreatePr(data.settings.autoCreatePr);
  if (data.settings.liveSteering !== undefined) useSettingsStore.getState().setLiveSteering(data.settings.liveSteering);
  if (data.settings.autoResolveConflicts !== undefined) useSettingsStore.getState().setAutoResolveConflicts(data.settings.autoResolveConflicts);
  if (data.settings.autoFixCi !== undefined) useSettingsStore.getState().setAutoFixCi(data.settings.autoFixCi);
  if (data.settings.autoResetMergedBranch !== undefined) useSettingsStore.getState().setAutoResetMergedBranch(data.settings.autoResetMergedBranch);
  if (data.settings.enableSubAgents !== undefined) useSettingsStore.getState().setEnableSubAgents(data.settings.enableSubAgents);
  if (data.settings.providerAccounts) useSettingsStore.getState().setProviderAccounts(data.settings.providerAccounts);
  if (data.settings.credentialRoutes) useSettingsStore.getState().setCredentialRoutes(data.settings.credentialRoutes);
  // docs/252 phase 7 (req 9) — the pin AND the resolved answer, always applied
  // (never guarded on presence): absent means "no pin" / "nothing runnable",
  // which are real states the panel has to render, not a reason to keep a stale
  // value from a previous read.
  useSettingsStore.getState().setNonTurnModel(
    data.settings.nonTurnModel ?? null,
    data.settings.nonTurnModelResolved ?? null,
  );
  // docs/261 phase 3 (req 8) — guarded on presence, unlike the non-turn pair
  // above, because the two cases differ: an absent `nonTurnModel` is the real
  // state "no pin", while an absent `reviewers` only ever means an older server.
  // Clearing the array would empty the Reviewer tab rather than say anything.
  if (data.settings.reviewers) useSettingsStore.getState().setReviewers(data.settings.reviewers);
  // docs/264 phase 2 — the roles, guarded on presence for the same reason.
  if (data.settings.roles) useSettingsStore.getState().setRoles(data.settings.roles);
  useUiStore.getState().setRuntimeMode(data.runtimeMode ?? "containerized");
  useUiStore.getState().setTailnetPreviewHost(data.tailnetPreviewHost ?? null);
  useUiStore.getState().setBootstrapLoaded(true);
}
