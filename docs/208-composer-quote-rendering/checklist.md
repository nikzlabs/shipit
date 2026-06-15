# Composer quote rendering — follow-up

This is a design investigation. The default recommendation (keep plain editable
text, no rich editor) requires **no build work** — it's the status quo. The only
optional follow-up is the decoration-only left-rail (D1), gated on a spike.

- [ ] **Feasibility spike (D1):** prototype the mirrored-backdrop left-rail
      highlight behind the existing `<textarea>` in `MessageInput.tsx`. Verify it
      survives `field-sizing: content`, the `max-h-[40vh]` scroll, proportional
      fonts, and wrapping. Time-box it.
- [ ] If the spike is robust → ship D1 (decoration only; do not touch the text
      model, send payload, or any autocomplete/voice/draft path).
- [ ] If the spike is fragile → close as "status quo plain text is the answer";
      no code change.
- [ ] Confirm action-cards (SHI-153) build on plain editable text — no
      dependency on this doc. (Documentation-only; verify when SHI-153 lands.)

Deferred / out of scope (separate enhancement if ever wanted):

- [ ] Reply-context chip (option C) scoped **only** to pure reply-reference
      flows (chat quote-reply, doc replies), where the quote is never edited.
      Explicitly not coupled to action-cards.
