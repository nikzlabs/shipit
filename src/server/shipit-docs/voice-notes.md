# Voice notes — the `voice_note` tool

ShipIt gives you one built-in tool, `voice_note`, for telling the user — *by
voice* — the thing they actually need to know. It exists because a user who
isn't looking at the screen still needs to hear when you need them.

## The contract

```jsonc
voice_note({
  summary: "Done — one test is still red, want me to dig in?", // ear-shaped headline
  needsAttention: true,                                         // the gate
  context: { repo: "shipit", prUrl: "...", prTitle: "..." }     // optional, display-only
})
```

- `summary` (required) — a one-or-two-sentence **headline**, written for the
  ear. No markdown, no code, no file paths, no commit hashes, no PR numbers.
  It grabs attention and orients the user on *what it's about and what they
  need to do*. It is **not** the body — the screen still holds the options,
  the plan, the diff. Don't read those aloud.
- `needsAttention` (required) — the gate:
  - `true` → you need the user (a question, a decision, plan approval, blocking
    ambiguity, an error needing input, or a **failed/abandoned turn**). Spoken
    aloud.
  - `false` → nothing to decide (work done, an FYI). Renders as a *silent*
    note: no audio, no push. A chatty `false` note costs nothing, but don't
    over-narrate.
- `context` (optional) — display-only metadata. Include `repo`, `prUrl`,
  `prTitle` when known. `prUrl` is never spoken; `prTitle` becomes the link
  label on text channels.

## When to call it

- **At the end of a turn when attention is needed.** Reuse the same judgment
  you'd use to decide whether to stop and ask — if the answer is "the user has
  to do something now," emit a `needsAttention: true` note.
- **A failed or abandoned turn still needs the user.** Don't go silent on an
  error — emit `needsAttention: true` saying you're stuck. There is no separate
  "failed" state; it folds into the attention gate.
- **Sparingly mid-task** for an occasional heads-up on a long job.
- **Before `AskUserQuestion` or `ExitPlanMode`**, author the headline with
  `voice_note` first, in the same turn, so the spoken note is a real script
  rather than a terse menu chip. If you skip it, ShipIt derives a rougher
  headline from the interrupt so the user is never left silent — but the
  authored one is better. Author first.

## What you must NOT do

- **Don't reason about delivery.** Whether the note plays inline, goes to an
  external webhook, or both is the **user's setting** — not your decision.
  Always call the same tool; ShipIt routes it.
- **Don't speak the body.** No option lists, no plan text, no diffs, no URLs.
- **Don't force audio.** There's no override flag; the user's hands-free mode
  decides whether a note plays automatically.
