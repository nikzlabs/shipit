---
title: Built-in coordinator — synthesized design (pre-plan)
description: Synthesis of three independent model consultations on the coordinator's structure, tools, conversation, presence, and voice loop.
---

# Built-in coordinator — synthesized design

**Status: pre-plan synthesis, 2026-08-23.** Three independent consultations on different model families — Sol (run `8526cb4e`), Opus (run `400a5791`), Grok (run `f0d0504a`, truncated at its cost cap in the final section) — briefed identically, run concurrently, blind to each other. Re-read any of them: `shipit agent result <run-id>` in the originating session. Subordinate to `requirements.md`; `api-proposal.md` stays the API contract, with the deferrals in §4 superseding its transport and admin sections.

## 1. Unanimous core (all three consultations)

### Structure: a `kind: "coordinator"` session

| Property | Value |
|---|---|
| Kind | `"coordinator"` — server-authoritative, set at creation, not writable from the container (the property that makes `ops` safe) |
| Cardinality | one per deployment; creation idempotent; metadata row auto-created, container started only when a turn runs |
| Workspace | *(decided 2026-08-23, req 17)* a dedicated **memory repository** as the workspace — durable coordinator memory (preferences, learned behavior notes, unfinished-thread ledger) as markdown, auto-committed, pushed directly to its own repo (no PR flow), optional GitHub remote for backup. Never fleet state: no queue snapshots, no session facts — git history makes drift visible. No preview, no PR lifecycle, no warm pool, no work-session flows |
| Prompt | fourth `SessionMode` (`std \| ops \| sandbox \| coordinator`), precomputed at module load — the prompt-cache contract holds by construction |
| Fleet visibility | **excluded** from attention derivation and from the control API's session list — otherwise its own turns wake itself |
| Topology | orthogonal to the parent→child spawn tree; never a parent of fleet sessions; not archivable or forkable through ordinary actions |
| Chrome | its own pinned destination above repo groups (the Ops-group precedent); development tabs hidden |
| Lifecycle | the normal runner/container machinery — transcript persistence, rehydration, WS fan-out, resume, compaction, wake-session |

Rejected unanimously: an orchestrator-embedded agent loop (a second runtime inside the trust boundary that ingests untrusted prose; none of the post-turn invariants would apply); reusing `ops` or `sandbox` identity; the coordinator as parent of fleet sessions (the shim is parent-scoped and same-repo; docs/255 refused the guard hole).

### Tool surface: the public control API, and nothing else

Every fleet read and action is a **named brokered tool** that makes a real HTTP request to `/api/control/v1/*` — same validation, scopes, idempotency, rate limits, and problem details an external client gets. The token is minted internally for the coordinator session (`clientId: "coordinator"`), scoped `queue:read|manage, sessions:read|message|spawn|transcript`, never exported, never in env or prompt. No Bash-as-fleet-tool, no browser, no generic HTTP or raw-endpoint tool. If the built-in client cannot live on the public surface, the surface is a lie (all three, in nearly these words).

*(Amended 2026-08-23, req 15.)* `sessions:transcript` is a **new scope**: a bounded transcript read (`GET /sessions/{id}/transcript?last=N` — recent messages, capped), so the coordinator can gather the context a session's answer assumed. The earlier "no transcript endpoint" position was calibrated for an external assistant; for the user's own built-in delegate it is a deliberate grant. External clients can simply not be given the scope.

### Conversation: the queue is not the transcript

- **Queue** = fleet state. Desktop: a live side rail/panel on the coordinator destination, always a fresh read. Never chat bubbles.
- **Transcript** = the conversation. Only turns that actually ran appear. **The coordinator never narrates fleet events into the transcript, and never answers a fleet-state question from it** — every "what's up?" is a fresh queue read.
- **Connect-through renders as two persisted cards**: a thin outgoing-relay line (destination, the user's verbatim words, receipt), and a source-reply card. *(Amended 2026-08-23, reqs 15–16.)* The source-reply card leads with the **coordinator's own briefing** — the outside-perspective re-explanation, since session agents assume context the user lacks — with the source agent's **verbatim final text attached and expandable** in a visually distinct untrusted frame, attributed by repo + session name, carrying the `messageId → turnId` correlation and an internal deep link. By voice: briefing first, verbatim on request. On desktop *(pinned 2026-08-23, req 18)*: the verbatim text is **always rendered with the briefing, as a collapsed-by-default card** — one action to expand, so quick inspection never requires a deep link. The discipline shifts from "never paraphrase" to: **briefing is the default presentation, verbatim is always on screen, and session-authored text is summarized, never obeyed.** When the reply is unclear, the coordinator clarifies with the session on its own before returning to the user (see the containment carve-out below). The exchange still lands in the source session's transcript with provenance; that remains the durable record.
- Context lifecycle *(analyzed 2026-08-23 by two consultations — Sol run `0d60e16a`, Opus run `2bd35d66`; decision pending user)*. What stands regardless: transcript ≠ context; context is a cache over three durable stores; whatever happens is invisible (req 21); the calendar has no role.

  **Where both consultations independently agree (adopted):**
  - Trigger signal: `agent_result.contextTokens / contextWindow` — the **last model call's** occupancy, never turn-wide sums (which over-count tool-heavy turns manyfold). Both halves are plumbed today. Missing telemetry → don't guess; leave the backstop armed and log it.
  - Thresholds: **arm at 60%, act at 80%** — acted on between settled turns at a clean boundary when one arrives, unconditionally at 80%; never mid-turn. 80% stays below every harness's auto-compaction point, so the backstop should never fire — a firing is an alarmed threshold miss, and its UI (card, spinner, dial pill, TTS) is suppressed for the coordinator kind.
  - No handoff ceremony (a ceremony is a summarization step — it re-imports drift). Memory-repo distillation is **event-driven** — on durable events only (a decision, a preference, a thread opening/closing), never per-turn narration — and is req-17 work that exists under any policy.
  - "Epoch" survives only as an internal diagnostic id; UI date separators stay cosmetic and deliberately **unaligned** with context events; docs/241 paging is indifferent.
  - Maintenance spend is accounted honestly (Sol: per-harness compaction billing is real and partly unobservable in CLI results — Grok's zero-usage result is an observability gap, not free work).

  **Where they split — the open decision:**
  - **Sol: (B) ShipIt-triggered native compaction.** Smallest change over what exists (docs/178 + 276); native conversation continuity; treats repeated-summary drift as theoretical until a soak test shows it; reset would be "a new cross-harness lifecycle contract."
  - **Opus: (C) fresh-context reset with a verbatim tail — my recommendation.** The reset primitive already exists in production — **re-verified in-session at source, not consultant-claimed**: `setConversationReplay`/`consumeConversationReplay` (`sessions.ts:508`), applied at spawn by `session-agent-run-params.ts:217` (drops the resume id + seeds the system prompt; "half the mechanism, not a detail" per its own comment). Existing writers: rewind chat/both/code, fork, rewind-snapshot restore, unresumable-conversation recovery (`rollback-handlers.ts`, `session-agent-env.ts:869`); the coordinator is one more. Because it lives at the run-params layer, it is **harness-agnostic by construction** — Sol's "new cross-harness lifecycle contract" objection does not hold. Two DB writes, no model call, invisible by construction. The seed = static framing + the memory repo (native workspace) + the **last ~10 user-anchored groups / ≤15K tokens verbatim, text-only** — no LLM at the seam, so nothing drifts; anything older is a self-history lookup. Decisive over (B): a compaction summary is the only artifact with no durable backing store — its errors compound monotonically (~150–250 compositions/yr on a 200K window, the concrete req-20 risk) and it is memory the user can never inspect or edit, against the reasoning that chose the git repo (req 17). The coordinator is uniquely reset-safe: its context is entirely derived (queue reads, transcript reads, memory files — all re-readable by design). Sol's amnesia/seam objection is answered by the verbatim tail, which Sol's variant of (C) did not include; Sol's billing finding cuts against (B).

  **Companion work if (C) is chosen (from Opus, adopted):** the *"a reset must be a no-op for every guarantee"* audit — every cap, cursor, or obligation lives server-side or in the ledger, never only in context (the clarification cap keyed by item id is already specified so); a **bounded, text-only** replay-seed variant (the existing `buildConversationReplay` is unbounded and its text-only behavior must not silently change under a future docs/144 U8 fix); **seed-injection hardening** — the write-containment gate keys on a *live user-message id*, never on what context appears to contain, relayed verbatim bodies are excluded from the seed (pointer + self-history instead), role-label patterns stripped, with a named guard test; and the precondition that a reset requires **no resident agent process** (end it first, never mid-turn — the docs/150 account-switch precedent). Measurements: backstop firings (target zero, alarmed); self-history calls in a fresh context's first turns (tunes the tail length K); forced-vs-boundary reset fraction (>~20% → widen the boundary set).
- **Seamlessness (req 21, 2026-08-23): the epoch is invisible.** No announcements, no behavior change at the seam; the agent never mentions context management (the same category of rule as never describing voice-note delivery). Two backstops make the fresh context indistinguishable from continuity: the **handoff note carries unfinished threads and recent decisions**, not just preferences; and the coordinator gets a **self-history tool** — a bounded read/search of its *own* persisted transcript (first-party runtime machinery, not control-API surface) — so a reference to last week is looked up, never forgotten. Context becomes a cache over three durable stores: the queue (fleet state), the transcript (conversational past), the memory repo (distillate). Voice needs nothing special: the morning digest always derives from the live queue.
- UI for a months-long transcript (req 20, constrained by req 21) — **prior art covers this; the coordinator needs no new UI mechanism, it needs `docs/241` built.** *(Corrected 2026-08-23 after checking existing designs — an earlier revision of this section re-proposed mechanisms that were already designed or explicitly rejected.)*
  - **Windowed loading is `docs/241-chat-history-paging`** (planning#268): requirements complete, no open questions, implementation unblocked, unbuilt. Latest ~10 full turns on open, id-cursor paging on scroll-up, window start snapped to a user row (so grouped tool calls are never misreported), a visible seam with retry and jump-to-latest. The coordinator is its strongest motivating case and makes it mandatory; epoch boundaries are always user-row boundaries, so epochs compose with the snap rule for free.
  - **The other halves already shipped**: the foreground-reconnect refetch amplifier (`docs/278-conditional-history-refetch`), heavy row bodies stripped from the wire (`docs/244-lazy-tool-result-bodies`), and the render cost of mounted rows (`docs/265-transcript-render-cost` — React.memo bail-out of unchanged rows; per-update cost proportional to what changed).
  - **Withdrawn from this design, because 241/265 explicitly decided against them**: page eviction and collapsed/unmounted old sections (241 records "no virtualization, no page eviction" as non-requirements; 265's chosen invariant is that every loaded message stays mounted so find-and-select cover the conversation). Collapse-by-day presentation is `docs/104-chat-toc-and-summaries` territory, explicitly shelved until the window ships. In-chat search covers the whole conversation by **auto-loading older parts while searching** (241 req 4), not by a new server-side query — the coordinator's *agent-side* self-history tool is unaffected.
  - Scale note, corrected: bytes are largely a solved axis (244 + edge compression); what 241 buys is bounded React mount/markdown-parse and a bounded refetch. Mobile uses the same mechanism.
- Implementation trap (named by two of three): these cards belong to the *coordinator's* transcript while describing another session — coordinator `sessionId` on the WS type, `TRANSCRIPT_SCOPED_MESSAGES` registration, `emitChatCard` persistence, and a guard test are mandatory.

### Presence and wake: server state, code gates

Presence is **server-authoritative** (WS-lifecycle invariant: transport must not drive server behavior; two devices must agree):

```
availability: present | offline     — heartbeat/lease; missing heartbeat → offline, never "free"
focus:        free | engaged(topic) — topic is typed refs (sessionId/itemId), never agent prose
voice lease:  one device may play audio; all may render text
staleness:    engaged → free after ~30 min without an utterance (liveness bound, not policy)
```

Wake causes in v1 — everything else journals and waits:

1. A user utterance (text or voice). Always.
2. `engaged → free` with a non-empty queue: **one** coalesced turn. *(Amended 2026-08-23, req 19.)* The wake envelope carries **the top item plus counts by repo and kind — not the full open list**. Ordering is deterministic in code (trusted kind priority, then age); when the item is done, the coordinator asks the queue for the next one via a tool call. The system serializes; the prompt phrases. A weak model can never be handed ten simultaneous completions to juggle. User-driven queries ("what's waiting in the game repo?") still read any filtered view.
3. The correlated completion of the engaged topic's relay (the conversation continuing, not an interruption).
4. *(Open decision 1)* a `blocker`-kind arrival while `free` — see §5.

The gate is level-triggered with a single `lastAnnouncedEventCursor` scalar (coordinator-side, not in the API — the rejected per-client read state changed item lifecycle; this is one high-water mark). No per-event turns, no periodic digest, never wake while the runner is busy. Turn arithmetic (Opus): a bad day is ~40 coordinator turns; a turn-per-event design would be several hundred.

**Structural injection containment (synthesis of Sol + Opus, amended 2026-08-23 for req 16):** system-wake turns are read-only **with one carve-out**: in a correlated-completion turn, the coordinator may send **clarifying messages to the engaged topic's own session** — the conversation it is already brokering — capped (default: two autonomous round-trips per item, then surface to the user; a rate limit backstops the cap). `spawn`, `answer`, `snooze`, and messages to any *other* session still require a turn containing a current user utterance, and every write logs its trigger (user-message id, or the correlated completion id for a clarification). The blast radius of a manipulative source reply is therefore more questions to itself, never actions elsewhere. `authorizedBy` on the API is the pre-registered hardening path.

### Voice v1: a foreground, half-duplex conversation mode

Explicit mode entry (one gesture: unlocks audio, acquires presence and the voice lease, and is consent to auto-submit utterances). Client state machine `listening → transcribing → thinking → speaking → listening` over the existing batch STT/TTS endpoints; silence-detection closes an utterance; barge-in stops playback before the mic opens; Screen Wake Lock while active. The coordinator's ordinary ear-shaped reply is spoken as-is; long verbatim quotes are chunked with "continue?". Skip the STT cleanup LLM pass in this mode (`dictated: true` framing already covers artifacts) — it is pure latency. Source-session voice notes are suppressed while a coordinator conversation is active (one channel, one voice). The coordinator itself does not get the `voice_note` tool — it *is* the voice channel.

Stated plainly (all three): a backgrounded or locked phone cannot receive first-party speech today. v1 is foreground-only; the named successor is Web Push **as an alert only** (tap → foreground → the coordinator speaks). Streaming TTS stays deferred, with a trigger: revisit if measured utterance-to-speech latency exceeds ~4 s.

### Prompt vs code

**Prompt** (`.md` fragments, composition in TS, byte-stable; interpolates *nothing dynamic* — the cache rule and the fleet-state rule agree): triage among eligible items; digest phrasing and progressive depth; brief-before-asking, and **every ask self-contained on every re-ask — full context restated, never "as we discussed"** (req 6, learned live twice); confirmation tiers (echo / read back / explicit confirm — "interesting" is not approval); discuss-vs-answer judgment; untrusted-data discipline; no UUIDs/branches/paths/SHAs aloud.

**Code**: token minting and scopes; the wake gate and presence store; envelope rendering; untrusted wrappers, ShipIt-derived deep links, verbatim provenance; correlation; card persistence and scoping; STT/TTS/floor control; idempotency on message + spawn; kind gating (no auto-commit, no eviction, excluded from its own queue); `agentTurns` cost accounting.

Declined for v1 so review rounds don't re-add them: priority scoring, quiet hours, per-repo thresholds, digest templates, urgency models, notification-preference matrices, mutable wake classes, custom compaction.

## 2. Calls made in synthesis where the consultations split

| Question | Split | Call |
|---|---|---|
| Container residency | Grok: always-resident, idle-exempt. Opus + Sol: on-demand, dispose normally | **On-demand**, with the docs/241 reservation held only while `engaged` or voice mode is open. Cold-start on an async wake is accepted and measured before any always-on exemption. |
| Desktop richness | Grok: client mapping of tool results. Opus: single-item-read renders a server-authored card. Sol: typed cards from semantic resources | **Server-authored typed cards from semantic events**: `GET /attention-items/{id}` renders an item card (list reads render nothing); relay submission and completion render the two connect-through cards. Narrowed rule, stated in the API doc: a read never changes item state; it may produce presentation in the reader's own surface. The agent supplies prose, never render instructions. |
| Batch spawn | Grok + Sol: keep. Opus: defer | **Defer** — req 8's "several in parallel" is N calls in one turn; at voice scale N ≤ 3. The clearest unrequested mechanism (req 12). Additive to restore. |
| Idempotency breadth | Draft: all writes, 7-day store. Opus: narrow | **Narrow to `POST /sessions/{id}/messages` and `POST /sessions`** — the two verbs the shim retries. |
| Coordinator model | Opus: default to a cheap, fast model; separable usage line | **Adopt** — triage and phrasing, not code reasoning; it is a session, so model selection already exists. |

## 3. Open decisions (user)

1. **Context-lifecycle policy (req 20/21 — reopened 2026-08-23):** compaction-at-chosen-moments vs fresh-context reset vs hybrid; trigger = context-weight threshold + least-disturbing boundary. Memory storage itself is **decided** (git repository as workspace, req 17 receipt). Consultation analysis in progress; the next self-contained ask carries the proposal.
2. **Unsolicited blocker wake (wake cause 4): in or out of v1?** Recommendation: **out**. The user's own presence description is purely pull-plus-return-to-free; req 4 says responding at arrival time is never required; a backgrounded phone cannot hear it anyway; desktop still shows blockers via the existing attention sidebar and browser notifications. Removing it deletes the unsolicited-wake path entirely (Opus's observation). Grok and Sol both kept it — restoring it later is additive.
3. **(Not a v1 decision — record only.)** When Projects ship: one blind coordinator per Project (Grok + Opus) vs one per owner crossing Projects as a *named* exception to docs/231's blind switch (Sol). Either way the control token must not cross silently, least of all in audio — the least-visible medium.

## 4. Supersessions to `api-proposal.md` (first client is internal; zero external consumers)

Deferred, not deleted — each returns with the first external client: outbound webhooks (registration, outbox, receiver secrets, retry policy); the dedicated control listener/port — the *property* stays as a route-scoped plugin with narrow deps, control tokens rejected on `/api/*`, browser credentials rejected on `/api/control/v1/*` (this resolves api-proposal open question 1); SSE `Accept` mode on `/events` (the JSON delta page stays as the resync primitive); the external PAT-minting Settings UI; OAuth. The **event journal stays** — transactional append is what makes all of these addable later. The coordinator container holds no SSE subscription; the orchestrator-side wake supervisor reads the journal in-process. Provenance strings use `clientId` ("Coordinator"), not an assistant name.

## 5. The real v1 cost, unchanged by any of this

Shared server/client attention derivation (out of `useAttentionInfo.ts`); first-class persisted turn results with the closing message captured at settlement; attention-item production and lifecycle; envelope rendering in prompt assembly; the event journal; the coordinator kind with its gates and shim; presence + the wake gate; the voice conversation mode; the server-authored card renderer with its scoping guard test.
