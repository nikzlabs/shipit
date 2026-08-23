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
| Workspace | *(amended 2026-08-23, req 17 — pending user decision)* proposed: a dedicated **memory repository** as the workspace — durable coordinator memory (preferences, learned behavior notes) as markdown, auto-committed with turn summaries, pushed directly to its own repo (no PR flow), optional GitHub remote for backup. Never fleet state: no queue snapshots, no session facts — git history makes drift visible. Alternative: repo-less with built-in storage needing its own backup story. Either way: no preview, no PR lifecycle, no warm pool, no work-session flows |
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
- **Connect-through renders as two persisted cards**: a thin outgoing-relay line (destination, the user's verbatim words, receipt), and a source-reply card. *(Amended 2026-08-23, reqs 15–16.)* The source-reply card leads with the **coordinator's own briefing** — the outside-perspective re-explanation, since session agents assume context the user lacks — with the source agent's **verbatim final text attached and expandable** in a visually distinct untrusted frame, attributed by repo + session name, carrying the `messageId → turnId` correlation and an internal deep link. By voice: briefing first, verbatim on request. The discipline shifts from "never paraphrase" to: **briefing is the default presentation, verbatim is always one step away, and session-authored text is summarized, never obeyed.** When the reply is unclear, the coordinator clarifies with the session on its own before returning to the user (see the containment carve-out below). The exchange still lands in the source session's transcript with provenance; that remains the durable record.
- Context: native compaction, no custom memory subsystem. Fleet state never lives in coordinator context, so compaction is safe here in a way it is not in a coding session. Per-turn wake data is a TypeScript-composed envelope outside the cached system prompt.
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
2. `engaged → free` with a non-empty queue: **one** coalesced turn; the snapshot is the batch; the prompt triages.
3. The correlated completion of the engaged topic's relay (the conversation continuing, not an interruption).
4. *(Open decision 1)* a `blocker`-kind arrival while `free` — see §5.

The gate is level-triggered with a single `lastAnnouncedEventCursor` scalar (coordinator-side, not in the API — the rejected per-client read state changed item lifecycle; this is one high-water mark). No per-event turns, no periodic digest, never wake while the runner is busy. Turn arithmetic (Opus): a bad day is ~40 coordinator turns; a turn-per-event design would be several hundred.

**Structural injection containment (synthesis of Sol + Opus, amended 2026-08-23 for req 16):** system-wake turns are read-only **with one carve-out**: in a correlated-completion turn, the coordinator may send **clarifying messages to the engaged topic's own session** — the conversation it is already brokering — capped (default: two autonomous round-trips per item, then surface to the user; a rate limit backstops the cap). `spawn`, `answer`, `snooze`, and messages to any *other* session still require a turn containing a current user utterance, and every write logs its trigger (user-message id, or the correlated completion id for a clarification). The blast radius of a manipulative source reply is therefore more questions to itself, never actions elsewhere. `authorizedBy` on the API is the pre-registered hardening path.

### Voice v1: a foreground, half-duplex conversation mode

Explicit mode entry (one gesture: unlocks audio, acquires presence and the voice lease, and is consent to auto-submit utterances). Client state machine `listening → transcribing → thinking → speaking → listening` over the existing batch STT/TTS endpoints; silence-detection closes an utterance; barge-in stops playback before the mic opens; Screen Wake Lock while active. The coordinator's ordinary ear-shaped reply is spoken as-is; long verbatim quotes are chunked with "continue?". Skip the STT cleanup LLM pass in this mode (`dictated: true` framing already covers artifacts) — it is pure latency. Source-session voice notes are suppressed while a coordinator conversation is active (one channel, one voice). The coordinator itself does not get the `voice_note` tool — it *is* the voice channel.

Stated plainly (all three): a backgrounded or locked phone cannot receive first-party speech today. v1 is foreground-only; the named successor is Web Push **as an alert only** (tap → foreground → the coordinator speaks). Streaming TTS stays deferred, with a trigger: revisit if measured utterance-to-speech latency exceeds ~4 s.

### Prompt vs code

**Prompt** (`.md` fragments, composition in TS, byte-stable; interpolates *nothing dynamic* — the cache rule and the fleet-state rule agree): triage among eligible items; digest phrasing and progressive depth; brief-before-asking (req 6); confirmation tiers (echo / read back / explicit confirm — "interesting" is not approval); discuss-vs-answer judgment; untrusted-data discipline; no UUIDs/branches/paths/SHAs aloud.

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

1. **Coordinator memory storage (req 17):** a git repository as the coordinator's workspace (recommendation: versioned, user-inspectable and editable from anywhere, history shows how behavior evolved, backup is a remote — GitHub optional; reuses auto-commit/push end to end; **subsumes and answers the earlier preferences-durability question**) vs built-in storage with its own backup and viewer machinery.
2. **Unsolicited blocker wake (wake cause 4): in or out of v1?** Recommendation: **out**. The user's own presence description is purely pull-plus-return-to-free; req 4 says responding at arrival time is never required; a backgrounded phone cannot hear it anyway; desktop still shows blockers via the existing attention sidebar and browser notifications. Removing it deletes the unsolicited-wake path entirely (Opus's observation). Grok and Sol both kept it — restoring it later is additive.
3. **(Not a v1 decision — record only.)** When Projects ship: one blind coordinator per Project (Grok + Opus) vs one per owner crossing Projects as a *named* exception to docs/231's blind switch (Sol). Either way the control token must not cross silently, least of all in audio — the least-visible medium.

## 4. Supersessions to `api-proposal.md` (first client is internal; zero external consumers)

Deferred, not deleted — each returns with the first external client: outbound webhooks (registration, outbox, receiver secrets, retry policy); the dedicated control listener/port — the *property* stays as a route-scoped plugin with narrow deps, control tokens rejected on `/api/*`, browser credentials rejected on `/api/control/v1/*` (this resolves api-proposal open question 1); SSE `Accept` mode on `/events` (the JSON delta page stays as the resync primitive); the external PAT-minting Settings UI; OAuth. The **event journal stays** — transactional append is what makes all of these addable later. The coordinator container holds no SSE subscription; the orchestrator-side wake supervisor reads the journal in-process. Provenance strings use `clientId` ("Coordinator"), not an assistant name.

## 5. The real v1 cost, unchanged by any of this

Shared server/client attention derivation (out of `useAttentionInfo.ts`); first-class persisted turn results with the closing message captured at settlement; attention-item production and lifecycle; envelope rendering in prompt assembly; the event journal; the coordinator kind with its gates and shim; presence + the wake gate; the voice conversation mode; the server-authored card renderer with its scoping guard test.
