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
provider-account labels. The notice that tells the agent about a resolved card at
the start of its next turn (req 8's second half) is the remaining work; the read
carries the outcome today.
