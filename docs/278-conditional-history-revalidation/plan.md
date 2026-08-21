# Conditional chat-history revalidation (per-session transcript revision)

Implements `requirements.md` (reqs 1–5). Issue: planning#324.

## Starting point

planning#375 already made the refetch conditional on the wire: `GET /api/sessions/:id/history`
returns a strong ETag and the client revalidates with `If-None-Match`, reusing its
cached parse on a 304 (`src/client/utils/session-data.ts`). Two gaps remain, and
both are server-side:

1. **The 304 decision is not cheap.** The tag is `sha1(JSON.stringify(fullPayload))`
   (`api-routes-session-spawn.ts`), so every focus-triggered revalidation loads
   every message row, projects them for the wire, and stringifies megabytes —
   only to throw the result away. The planning#375 comment says so itself: "It
   saves the transfer and the client's parse, not the server-side build."
2. The issue's subtlety: any future validator that tries to be cheaper than the
   body hash by deriving from row ids/counts (`MAX(id) + COUNT(*)`) is fooled by
   in-place card patches (`updateBugReportCard`, `updatePermissionCard`,
   `updateEgressPromptCard`, `updateIssueWriteCard`, `upsertReleaseCard`, … all
   run `stmtUpdate` against the row's existing id).

## Design

A per-session **transcript revision counter**, bumped by every write path that
mutates the session's persisted transcript, used as the messages-half of the
history ETag so the 304 decision never touches the messages table.

### The counter

- New table `session_transcript_revisions(session_id TEXT PRIMARY KEY, revision INTEGER NOT NULL)`
  (append-only migration; replay-safe `CREATE TABLE IF NOT EXISTS`).
- `ChatHistoryManager` owns it: a private `bumpRevision(sessionId)` upsert
  (`…ON CONFLICT DO UPDATE SET revision = revision + 1`) called inside each
  mutating method's existing transaction where one exists, immediately after the
  write that needs it; a public `transcriptRevision(sessionId): number` read
  (0 when absent).
- Bump precision is biased toward false positives, never false negatives:
  - Methods with provable no-ops keep them no-ops (`updateBugReportCard` with no
    matching card does not bump; `truncate` to a larger count does not bump;
    `finalizeInProgress` bumps only when a row actually flipped).
  - Everything that writes rows bumps: `append`, `updateLastMessage`,
    `updateBugReportCard`, `consumeUnreportedBugOutcomes`, `upsertReleaseCard`
    (both branches — its append branch bumps via `append`),
    `updateEgressPromptCard`, `updatePermissionCard`,
    `retireBackgroundSubagentResult`, `updateSubAgentConsultCard`,
    `updateNonTurnFailureCard`, `updateIssueWriteCard`, `truncate`, `saveMessages`,
    `markRolledBackFromIndex`, `clearRolledBack`, `deleteMessageById`,
    `replaceInProgress`, `finalizeInProgress`, `clearInProgress`, `delete`.
- Verified at source: these are ALL the writers of the `messages` table.
  `rg "INSERT INTO messages|UPDATE messages|DELETE FROM messages"` hits only
  `chat-history.ts`, `DatabaseManager.clearAll()` (which also clears the new
  table), and legacy-column fixtures in `chat-history.test.ts`.
- Rewind snapshots are not transcript rows but do ride the response; they are
  covered by direct hashing below, not by the counter (their expiry is a
  time-based lazy delete inside `latestRewindSnapshot`, which no bump could
  capture).

### The validator

In the `/history` route, the ETag becomes `etagFor(JSON.stringify(validator))`
where `validator = { v, revision, commits, agentRunning, backgroundTasks,
rewindSnapshot, turnUsage, sessionUsage, cumulativeInputTokens,
cumulativeOutputTokens, presentations }`:

- Everything except `messages` is hashed directly — all of it is small, and this
  keeps planning#375's "a stamp that forgets one source serves a stale
  transcript" property for the six non-transcript sources.
- `revision` stands in for `messages`. It is sound because (a) the wire
  projection (`projectMessagesForWire`) is a pure function of row content on the
  history path — verified at `transcript-projection.ts` (`allRowsPersisted`
  defaults true; nothing external feeds it) — and (b) req 4's bump coverage is
  enforced by an enumeration test, not by convention.
- `v` is a wire-shape version constant. If the projection logic ever changes
  shape without a data change, bumping it invalidates every client in one move.
- Request flow: gather the small sources → compute the tag → `matchesIfNoneMatch`
  → 304 without calling `getChatHistory` at all. On a miss, load messages,
  assemble the payload, respond with the same tag. `commits` and
  `rewindSnapshot` are computed once and reused by both paths.

The client is untouched: the ETag stays an opaque validator over standard
`If-None-Match`/304 semantics (weak comparison per `http-etag.ts`).

## Key files

- `src/server/shared/database.ts` — migration + `clearAll()`.
- `src/server/orchestrator/chat-history.ts` — counter statements, `bumpRevision`,
  `transcriptRevision`, bumps in every mutating method.
- `src/server/orchestrator/api-routes-session-spawn.ts` — validator assembly +
  early 304.
- `src/server/orchestrator/chat-history.test.ts` — enumeration test: every
  mutating method moves the counter; no-op mutations don't.
- `src/server/orchestrator/integration_tests/http-phase3.test.ts` — 304 decided
  without loading messages; in-place card patch invalidates; full rewrite
  invalidates; other sessions' writes don't.

## Rejected alternatives

- **Keep the body hash, add a second fast path**: two validators, two contracts,
  and the fast path still has to fingerprint everything except messages to stay
  correct — which is most of this design anyway, plus dispatch complexity.
- **Hash only the revision** (drop the non-transcript sources): a commit, usage
  update, or presentation change with no transcript mutation would serve a stale
  304. Fails planning#375's seven-sources argument.
- **`MAX(id) + COUNT(*)`**: the issue's own counterexample — in-place card
  patches change neither.
- **Client-side skip ("already have history")**: forbidden by req 3; the DB is
  the only copy of completed turns' events.
