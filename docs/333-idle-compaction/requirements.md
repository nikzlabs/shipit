---
issue: planning#699
title: Compact an idle session before its prompt cache expires
description: ShipIt compacts a large, idle session's context shortly before its prompt cache expires — on Claude, Codex and every harness that can compact — because the Claude CLI's own idle compaction never runs under ShipIt.
---

# 333 — Idle compaction (requirements)

Builds on the compaction that already ships:
[docs/178 — Context Compaction](../178-context-compaction/plan.md) (`/compact`
and the "Context compacted" card),
[docs/276 — Headless compaction triggers](../276-headless-compaction-triggers/plan.md),
[docs/295 — Compact the context when a merged session continues](../295-compact-context-on-merge/requirements.md)
(a compaction that ShipIt starts by itself) and
[docs/324 — Agent-requested context compaction](../324-agent-requested-compaction/requirements.md).

## Background

Claude Code 2.1.299 (2026-10-14) added idle compaction "in the terminal": a
conversation of 200K tokens or more that is left idle for about 54 minutes is
compacted before its one-hour prompt cache expires, so the next message does
not re-read all of it at cache-write price. `"idleCompaction": false` turns it
off, and `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` changes the 200K minimum (the
CLI raises any value below 100K to 100K).

**It never runs under ShipIt, even when the container stays alive.** Read in
the bundle of CLI 2.1.300, the version ShipIt pins: the idle timer arms only
when the CLI is interactive, or when its entrypoint is on a list of
first-party hosts (`claude-vscode`, `claude-desktop`, `remote` and others).
ShipIt runs Claude with `--print --input-format stream-json`
(`src/server/session/agents/claude/process.ts`), which makes the entrypoint
`sdk-cli`. A server-side feature flag also sets the mode, and the mode is off
when the flag gives no value.

**A timer inside the container would not be enough either.** ShipIt can stop
an idle session's container before the hour ends:
`src/server/orchestrator/idle-enforcer.ts` stops idle agent containers when
ShipIt is over its memory budget (sessions with no viewer, the one whose last
viewer left first goes first), stops a done session after 10 minutes
([docs/316](../316-done-sessions-return-memory/requirements.md)), and a ShipIt
update replaces containers.

### OpenAI's cache lifetime (Codex)

From OpenAI's [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching),
read on 2026-10-19:

- **GPT-5.6 and later** — the Codex models in ShipIt's catalogue today
  (`gpt-5.6*`, `gpt-6*`). Caching is on by default, and "a cached prefix
  remains eligible for reuse for 30 minutes after its most recent write or
  reuse"; OpenAI may keep it longer. `prompt_cache_options.ttl` accepts only
  `30m`, which is also the default. A cache write costs 1.25× the uncached
  input rate and a read 0.1× (0.05× on GPT-6.1 Sol) — the same shape as
  Anthropic's 5-minute cache.
- **GPT-5.5 and earlier.** `prompt_cache_retention: "in_memory"` keeps a
  prefix for about 5 to 10 minutes of inactivity, up to one hour; `"24h"`
  typically keeps it about 30 minutes, up to 24 hours. Organizations without
  Zero Data Retention default to `24h`, and GPT-5.5 accepts only `24h`. There
  is no cache-write surcharge.
- **Codex CLI 0.160.1**, the version ShipIt pins, sends `prompt_cache_key` and
  sets neither `prompt_cache_retention` nor `prompt_cache_options` (the two
  names appear in its binary only inside bundled documentation), so the
  defaults above apply.
- **Not verified on a subscription.** A Codex session on a ChatGPT
  subscription reaches OpenAI through `chatgpt.com/backend-api/codex`, not the
  public API, and OpenAI documents no cache lifetime for that path. The
  30-minute figure is the API's, assumed to hold there too.

### Prior art: t3code

[pingdotgg/t3code#21682](https://github.com/pingdotgg/t3code/pull/21682)
("compact idle threads before the prompt cache expires", open on 2026-10-19)
does the same from its server: a sweep every minute and at each run's end
sends a system-authored `/compact` in the last 10% of the cache lifetime (at
least 2 minutes), never after the cache is cold. It is off by default and
uses a 200K-token floor, as requirements 5 and 6 do, and it covers other
providers with an assumed 30-minute lifetime, as requirements 9 and 10 do. It
also compacts on a 5-minute cache (an API key), which requirement 11 rules
out. It has no case for a stopped process, because t3code runs on the
user's machine; requirement 2 exists because ShipIt stops containers. Its
review found that settling a thread can interrupt a running idle compaction —
a hazard a ShipIt design must also answer.

## Requirements

1. When a session's agent context is large and the session has been idle for
   most of its prompt-cache lifetime, ShipIt compacts the context
   before the cache expires. The user's next message then does not re-read the
   whole earlier context.

2. A session gets the benefit of requirement 1 even when ShipIt stops the
   session's container while the session is idle.

3. The user can see in the chat transcript that an idle compaction ran. This
   is the same card that a `/compact` gives today (docs/178).

4. If an idle compaction fails, no work and no message is lost, and the
   transcript says that the context was not compacted.

5. Idle compaction is off by default. One global setting in Settings →
   Advanced turns it on.

6. An idle compaction runs only when the agent's context is 200K tokens or
   more.

7. A done session (docs/316) gets no idle compaction.

8. When ShipIt is over its memory budget, it stops other idle sessions before
   it stops a session that waits for its idle compaction. When it must still
   stop such a session, it compacts that session first and then stops it.

9. Requirement 1 covers every harness that can compact its context, not only
   Claude. Codex is included.

10. Where ShipIt does not know a provider's cache lifetime, it assumes 30
    minutes.

11. An idle compaction runs only on a cache that lives 30 minutes or more. A
    shorter cache — for example Claude's 5-minute cache on an API key — gets
    no idle compaction.

12. An idle compaction also runs while the agent waits for the user's answer
    to a question or a plan. This is an exception to docs/322 req 1, and the
    idle compaction does not count as the user's response: the question stays
    open, and automatic work that waits behind it still waits.

13. A session whose container a ShipIt update destroyed gets no idle
    compaction. This is an exception to requirement 2: a new agent process
    writes the whole conversation to the cache again, so a compaction there
    would cost what the user's next turn costs and save nothing.

## Requirement provenance

Requirements 1 and 2 come from what the user asked for: the user wants ShipIt
users to get the benefit of the CLI's compaction before the cache expires,
even though ShipIt can stop a container before that time. Requirements 5 to
13 come from the user's answers and instructions on 2026-10-19 (below).
Requirements 3 and 4 were
not asked for: each keeps a guarantee that already ships from becoming weaker —
docs/178 for how a compaction appears, and docs/295 req 9 and docs/324 req 6
for a failed compaction. They are kept apart so that the difference stays
visible.

## Open questions

- Does OpenCode stay in requirement 9's scope? A probe on 2026-10-19
  (plan.md, "Verify first") found every OpenCode turn in ShipIt reads its
  conversation cold, because ShipIt gives OpenCode a new instruction-file path
  on every turn and OpenCode puts that path into the prompt. An idle
  compaction on OpenCode saves nothing until that is fixed. Codex was warm
  across processes.
- Does Grok stay in requirement 9's scope without a probe? No configured role
  runs Grok, so whether a new Grok process reads the previous one's cache is
  unknown.

## Resolved questions

- 2026-10-19 — Is idle compaction on by default, or off until the user turns
  it on? Offered "on, with an off switch in Settings → Advanced"
  (recommended, as the CLI does in the terminal) or "off, opt-in in Settings →
  Advanced". The user chose off, opt-in. Recorded as requirement 5.
- 2026-10-19 — What is the minimum context size? Offered 200K tokens (the CLI
  default, recommended), 100K (the lowest the CLI allows) or a number the user
  can change. The user chose 200K. Recorded as requirement 6.
- 2026-10-19 — Does a done session get an idle compaction? ShipIt stops a done
  session's container after 10 minutes, so it would have to compact before
  that stop, and most done sessions get no next message. The user chose to
  skip done sessions. Recorded as requirement 7. A merged session that
  continues still compacts under docs/295.
- 2026-10-19 — Requirement 2 conflicts with the memory budget: what happens
  when ShipIt must stop a session that waits for its idle compaction? Offered
  "stop other idle sessions first, then compact and stop" (recommended), "stop
  at once and lose the benefit", or "compact first, in today's stop order". The
  user chose the first. Recorded as requirement 8. Its consequence: when
  ShipIt must stop a waiting session, the memory comes back after the
  compaction, not at once.
- 2026-10-19 — Requirement 1 covered only the one-hour cache, while t3code
  also compacts other providers with an assumed 30-minute lifetime. The user:
  "let's also do that, especially for codex. Research the OpenAI input cache
  lifetime." Requirement 1 no longer names the one-hour cache; requirements 9
  and 10 added. The research is under Background. It found that OpenAI
  documents 30 minutes for the current Codex models, so the assumption of
  requirement 10 matters for providers and paths with no documented lifetime,
  such as the ChatGPT subscription backend.
- 2026-10-19 — Does an idle compaction also run on a short cache (Claude's
  5-minute cache on an API key; an older OpenAI model on `in_memory`
  retention, about 5 to 10 minutes)? A 200K session would then compact after
  about 4 to 5 minutes idle, while the user may still read the reply. Offered
  "no, only caches of 30 minutes or more" (recommended) or "yes, every cache,
  as t3code does". The user chose no. Recorded as requirement 11.
- 2026-10-19 — Does an idle compaction run while a question waits for the
  user? docs/322 req 1–2 starts no automatic turn — any turn the user did not
  start — until the user responds, and holding the compaction until the reply
  is useless because the cache is cold by then. Offered "yes, as an exception
  to docs/322" (recommended: it does no work and asks nothing, and a user who
  steps away from a question is a common case, but the agent reads the answer
  against a summary) or "no, skip those sessions". The user chose the
  exception. Recorded as requirement 12, and as an exception in docs/322 req 2.
  That the compaction is not the user's response follows from docs/322 req 3:
  only a turn the user starts is one.
- 2026-10-19 — A probe (plan.md, "Verify first") showed that a Claude CLI
  resumed in a new process does not read the original process's cache: it
  writes the whole conversation again. Does a session whose container a ShipIt
  update destroyed still get an idle compaction, as requirement 2 says?
  Offered "skip it, as an exception to req 2" (recommended), "keep the old
  container until its compaction runs" (the old worker build must still work
  with the new orchestrator), or "compact anyway in a new container" (a full
  cache write now, no saving). The user chose to skip it. Recorded as
  requirement 13.
