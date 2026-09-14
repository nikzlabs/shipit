# Agent access to ShipIt settings — checklist

This branch is design only, and the design is done. **The implementation plan
lives on planning#537**, because it spans several pull requests and a checklist
is scoped to its own PR (CLAUDE.md). Review history lives there too.

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Every open question answered, each with a dated receipt
- [x] `plan.md` written against the numbered requirements, citing them
- [x] Scope inventory verified control by control against both dialogs
- [x] `mockup.html` — the card's pending and eight terminal states, both themes
- [x] Independent design reviews, each cold, each with a removal brief, with
      every finding verified against the code before being acted on
- [x] `plan.md` reduced by half once the reviews were done, with every citation
      diffed to prove no constraint was dropped

## Phase 2, slice 1 — the shared apply layer

No agent-facing surface; the proposal card is the next slice.

- [x] Four outcomes (`applied` / `partial` / `failed` / `uncertain`), with
      `failed` reserved for a writer that can prove nothing changed
- [x] `CredentialStore.save()` rolls a failed disk write back and reports it
- [x] `writeGlobalSystemPrompt` reports a refused `unlink` instead of swallowing
      it, so "cleared" cannot be false
- [x] `setGitIdentity` reports `partial` when the name lands and the email does
      not, and says which half
- [x] `services/settings-apply.ts` — one operation per settings write, each doing
      the whole act the route did
- [x] Every named writer routed through it, including the egress prompt card's
      global add and merge-revoke's cancellation
- [x] `services/settings-conflict-domain.ts` — the per-stored-object lock
- [x] A `settings_changed` broadcast, and a client refetch on both that event and
      the global SSE connection's recovery
- [x] An untouched instructions box adopts a value that moved; an edited one
      keeps its draft and says so
- [x] `services/settings-baseline.ts` — the per-declaration revision over the
      whole stored value, tested directly
- [x] Every new guard proven red on its own, with the defect restored

## Phase 2, slice 2 — propose, and the decision handler

- [x] `shipit settings propose <key>=<value> [--item] --reason` and
      `--add`/`--remove` for one list entry; posts, returns, never waits
- [x] The server takes the snapshot — the displayed `from` and the private
      baseline in one read, never carried from the agent's earlier `get`
- [x] Validated at propose time and again inside the lock at apply time
- [x] `services/settings-operations.ts` — what an Apply button runs, per declared
      operation, ending in the shared apply layer
- [x] `ws-handlers/settings-proposal-handlers.ts` — transport only; the session
      is the connection's and never the message's
- [x] Dismiss as its own short path: one atomic `pending → dismissed`
- [x] Apply: claim atomically, then the conflict domains held across the
      baseline re-read, the revalidation and the write
- [x] `unknown` — boot recovery converts an interrupted apply before any
      decision is accepted, and never retries it
- [x] Settlement with no runner at all
- [x] `lastProposal` in `shipit settings get`, per target and per instance, from
      any session; a pending card does not block a second proposal
- [x] `shipit-docs/settings.md` — propose, the one-change rule, the phase table
- [x] Every new guard proven red on its own: two decisions produce one apply, a
      turn snapshot does not restore `pending`, and a projection-dropped field
      resolves `stale` where comparing `from` would not

Not in this slice, and named in `plan.md` → *What a card can apply today*: the
collection operations that create and delete entries, and the credential and
provider-account labels.

## Conformance against reqs 2, 3 and 7

An independent review of the shipped read surface against the numbered
requirements; each finding verified at the code before being acted on.

- [x] req 2 — a name the user typed is emitted only when it is shaped like a
      name, so a secret or role called `https://user:token@host/?token=…` is
      named by nothing in the index, in an item address, in text or in `--json`
- [x] req 2 — the four collections an item's address is projected through carry
      one rule between them, and a `derived` projection emitting the user's own
      words says so with a reason review reads
- [x] req 2 — the reflected-input echo decided: not stored credential material,
      so flattened and capped as presentation hygiene, and justified in `plan.md`
- [x] req 3 — `no-sidecar` separated from `disabled`: the containment setting is
      what refuses the container's start, and the read names it instead of
      calling it irrelevant
- [x] req 7 — `BESPOKE_READERS` and `OWN_ROUTE_READERS` keyed by a type derived
      from the catalogue, so a missing reader is a compile error and the two
      runtime guards are gone
- [x] req 7 — a stored MCP field with no declaration is a compile error
      (`MCP_SERVER_FIELD_SETTINGS`), which is what the DOM walk cannot see
- [x] The field that guard found — MCP `setup`, stored since docs/088 and read by
      nothing — removed rather than declared, so every stored field is a
      declaration and the map carries no exemption
- [x] req 7 — the MCP form and the credential-routing band render the
      declaration's description, and their hand-written copy moved into it
- [x] Every new guard proven red on its own, with the defect restored
- [x] A second independent review of the fixes themselves, its six findings each
      verified at the code: the refusal made a suffix on every branch rather than
      a branch of its own; the `live` detail carried through both CLI renderers,
      not only `--json`; the MCP map's value keyed to the field's own name; the
      routing description trimmed to what the band renders; and the name gate's
      claim narrowed to what it does — it removes a URL, it is not a credential
      scanner, and the design rejected scanners

## Phase 2, slice 3 — the outcome notice (req 8)

- [x] `agent_notified` on the private proposal row, with
      `listUnnotifiedResolved` / `markAgentNotified` as two separate calls —
      reading is never a consume
- [x] `services/settings-outcome-notice.ts` — the notice, joining the same
      `agentPrefix` chain as the bug-report notice, batching every outcome
      resolved since the last turn into one and starting no turn of its own
- [x] `NoticeDelivery` in `turn-settlement.ts`, acknowledged from ONE place in
      `turn-executor.ts` — the `agent_result` handler, after the `exhausted`
      check and the failover decision, and never for an error result
- [x] At-least-once proven on all four shapes review found: every account
      refusing for quota; a refusal on a route that cannot fail over, which
      settles the turn `completed`; a refusal arriving as successful-looking
      assistant text; and an error result. Each carries the outcome to the next
      runnable turn
- [x] A resident streaming turn, which calls `finishTurn` never and whose
      listeners the next reuse discards, acknowledges on its result
- [x] A card resolved with no runner alive still notifies on the next turn
- [x] `shipit-docs/settings.md` — what the notice is, that `lastProposal` is the
      authority, and that it can arrive twice
- [x] Every new guard proven red on its own: marking at prompt assembly (the
      bug-report copy) fails the quota tests; acknowledging at settlement on a
      `completed` outcome fails all three of the refusal and resident-streaming
      tests; dropping either clause of the result check fails its own test;
      un-flattening any one interpolated field fails the flattening test
