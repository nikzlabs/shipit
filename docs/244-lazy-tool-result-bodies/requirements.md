# Lazy-load heavy chat-history row bodies

1. Loading a session's transcript must not transfer row bodies that the
   conversation does not display inline.
2. A body that is not transferred up front must be fetchable on demand, at the
   point the user opens the view that displays it.
3. Every tool result must keep the following available without a fetch: its
   tool-use id, whether a result exists, whether it errored, its duration, and
   a flag stating whether the full body can be fetched.
4. These must continue to work unchanged: `AskUserQuestion` rendering the
   chosen answer from result content, `ExitPlanMode` keying off result
   existence, Present extracting its artifact id from the result, and subagent
   final reports sourced from the parent tool's output.
5. The fields in scope are tool results, tool inputs, subagent transcripts, and
   images.
6. The bound applies to live turns and reconnects as well as history loads and
   session switches.
7. This complements paging (SHI-266) rather than replacing it: paging avoids
   transferring untouched history, this reduces the weight of the pages that do
   load.

## Open questions

- Is "the transcript looks and behaves exactly as it does today" a hard
  requirement, or is a brief loading state acceptable in the places where the
  body is already behind a click (the diff modal, the full-size image preview,
  the "Show all N lines" expansion)? The design currently assumes the strict
  reading, which is what rules out several cheaper options.
- Are screenshots and pasted images allowed to display at reduced resolution
  until the user clicks them, or must the inline rendering always come from the
  full-resolution image? (Today the UI draws them at 96×96 from full-resolution
  data.)
- When a body can no longer be fetched — the row was removed by a rewind — what
  should the user see in its place?
- Is there a target the transferred size should meet, or is "materially smaller
  than today" sufficient to call this done?

## Resolved questions

- 2026-08-01 — Should the byte bound apply to the live WebSocket path or only
  to history loads? Answer: both. Recorded as requirement 6.
