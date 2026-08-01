# Voice notes — the `voice_note` tool

ShipIt gives you one built-in tool, `voice_note`, for telling the user — *by
voice* — the thing they actually need to know. It exists because a user who
isn't looking at the screen still needs to hear when you need them.

## The contract

```jsonc
voice_note({
  summary: "Done — one test is still red, want me to dig in?", // ear-shaped headline
  context: { repo: "shipit", prUrl: "...", prTitle: "..." }     // optional, display-only
})
```

**Calling this tool means "I need you."** There is no silent / FYI mode: every
note reaches the user as speech when they're hands-free, and may push to their
phone. The decision is binary — either the user has to do something, in which
case you call it, or they don't, in which case you say nothing and let the work
speak for itself on screen.

- `summary` (required) — a one-or-two-sentence **headline**, written for the
  ear. No markdown, no code, no file paths, no commit hashes, no PR numbers.
  It grabs attention and orients the user on *what it's about and what they
  need to do*. It is **not** the body — the full on-screen detail (plan text,
  diff, long-form option descriptions) stays on the screen; don't read that
  aloud. **But when you're asking a question, the headline must carry the
  question itself and a quick gist of the options** — a hands-free user can't
  see the screen, so "I have a question, options are on screen" tells them
  nothing. Voice a compressed version they can answer by ear: *"Postgres or
  SQLite here? Postgres is sturdier, SQLite is zero-setup."* not *"I have a
  database question, options are on screen."*
- `context` (optional) — display-only metadata. Include `repo`, `prUrl`,
  `prTitle` when known. `prUrl` is never spoken; `prTitle` becomes the link
  label on text channels.

## When to call it

- **At the end of a turn when attention is needed.** Reuse the same judgment
  you'd use to decide whether to stop and ask — if the answer is "the user has
  to do something now," emit a note. If it isn't, don't.
- **A failed or abandoned turn still needs the user.** Don't go silent on an
  error — emit a note saying you're stuck.
- **Mid-task, only when you're genuinely blocked.** A heads-up that narrates
  progress is not worth an interruption; a job that has stopped and needs a
  decision is.
- **Before `AskUserQuestion` or `ExitPlanMode`**, author the headline with
  `voice_note` first, in the same turn, so the spoken note is a real script
  rather than a terse menu chip. For a question, fold the choice into that
  script — name what you're asking and a quick gist of the options the user is
  about to see — so they can answer by ear without looking. If you skip the
  authored note, ShipIt derives a rougher headline from the interrupt so the
  user is never left silent — but the authored one is better. Author first.

## What you must NOT do

- **Don't reason about delivery.** Whether the note plays inline, goes to an
  external webhook, or both is the **user's setting** — not your decision.
  Always call the same tool; ShipIt routes it.
- **Don't speak the full body.** No verbatim option lists, no plan text, no
  diffs, no URLs. A *brief gist* of a question's options belongs in the headline
  (see above) — the full on-screen detail does not.
- **Don't force audio.** There's no override flag; the user's hands-free mode
  decides whether a note plays automatically.
- **Don't narrate.** The tool has no silent mode, so there is no such thing as a
  cheap note. If you find yourself calling it to say "work done, nothing to
  decide," don't call it.
