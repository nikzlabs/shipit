# Agent access to ShipIt settings — checklist

This branch is design only. These are its items; when they are all checked the
design work is done. **The implementation plan lives on planning#537**, because
it spans several pull requests and this checklist is scoped to this one
(CLAUDE.md — a checklist holds "the branch's implementation to-do … checked off
in the *same PR*").

- [x] `requirements.md` written from the user's words, open questions raised
- [x] Every open question answered, each with a dated receipt
- [x] `plan.md` written against the numbered requirements, citing them
- [x] Scope resolved: both dialogs, global Settings and per-repo Project Settings
- [x] Requirement 7 — a declared setting reaches the agent automatically
- [x] Requirement 8 — the agent is told on its next turn when a card is resolved
- [x] Local-mode limitation put to the user and recorded
- [x] `mockup.html` — the card's pending and terminal states, both themes
- [x] Four independent design reviews, each cold, each with a removal brief
- [x] Review findings verified against the code before being acted on
- [x] Scope inventory re-verified control by control against both dialogs. Four
      errors found in total: three rows for controls that do not exist
      (installed harnesses, the Skills tab, egress enforcement state) and
      auto-create-PR filed under the wrong tab. Actions — check for updates,
      update now, playback test, save — are named as exclusions rather than
      omitted
- [ ] Agent-facing doc outline agreed: what `shipit-docs/settings.md` must say
      about reading before proposing, and about saved versus effective
