# Composer quote rendering — follow-up

Investigation **closed: keep the status quo** (plain editable text, no richer
rendering). Outcome is **no code change**, so there is no build work.

- [x] Investigate quoting representations and trade-offs (plain / rich editor /
      reply chip / hybrid) → recorded in `plan.md`.
- [x] Make the call → **keep plain editable text**; reject rich editor and
      quote-as-chip; defer the decoration-only left rail.
- [x] Decoration-only left rail (D1): **declined** for now — no feasibility
      spike scheduled. Kept on file as possible future polish only.
- [x] Confirm action-cards (SHI-153) build on plain editable text — documented
      as the assumption; no dependency on this doc.

Deferred / explicitly out of scope (separate enhancement if ever wanted, not
tracked here):

- Reply-context chip (option C) scoped **only** to pure reply-reference flows
  (chat quote-reply, doc replies), where the quote is never edited. Not coupled
  to action-cards.
