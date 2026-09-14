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
