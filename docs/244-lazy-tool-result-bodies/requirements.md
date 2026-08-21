# Lazy-load heavy chat-history row bodies

1. Loading a session's transcript must not transfer information that is not
   visible without a click. This is also the completion criterion: there is no
   separate transferred-size target to hit.
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
7. This complements paging (planning#268) rather than replacing it: paging avoids
   transferring untouched history, this reduces the weight of the pages that do
   load.
8. The transcript itself must look exactly as it does today and must not
   introduce loading states of its own. A view the user opens by clicking may
   load data on demand, and may show a loading state while it does.
9. Images are not resized — not at ingest, and not when served. They are
   stored and served at whatever resolution they arrived at. Inline they render
   at reduced *display* size only, and their bytes transfer with the transcript
   rather than waiting for a click, so requirement 1 does not apply to them.
   This is the accepted position for now, not a permanent one: planning#302 revisits
   image handling end to end.

## Open questions

None.

## Resolved questions

- 2026-08-04 — Does requirement 9's "images up to 256×256 may be sent" bound
  the *transferred* pixels, or describe the inline *render* size? Answer:
  neither — drop the bound. We do not resize images at ingest or when serving,
  at the moment. Recorded in requirement 9, superseding the same-day receipt
  below, and planning#302 opened to revisit image handling as a whole. The 256×256
  wording was written on the assumption that downsampling happened somewhere;
  it does not — there is no image processing anywhere in the repo, so no bound
  on transferred pixels was ever achievable without new machinery.
- 2026-08-04 — Should inline image thumbnails be downsampled so requirement 1's
  "nothing transfers without a click" holds for images, or is transferring them
  with the transcript acceptable? Answer: acceptable — accept the gap, they are
  infrequent anyway. (Raised by the independent requirements review, which found
  that the 96×96 thumbnail loads full-resolution bytes on viewport entry rather
  than on click, making requirement 9's second clause unreachable. planning#294.) The
  "up to 256×256" qualifier this originally carried is superseded by the
  receipt above.
- 2026-08-01 — Should the byte bound apply to the live WebSocket path or only
  to history loads? Answer: both. Recorded as requirement 6.
- 2026-08-01 — Is "the transcript looks and behaves exactly as today" a hard
  requirement, or is a brief loading state acceptable where the body is already
  behind a click? Answer: the transcript must look like today and must not have
  loading states itself; clicks may load more data. Recorded as requirement 8.
- 2026-08-01 — Are images allowed to display at reduced resolution until the
  user clicks them? Answer: yes. Recorded as requirement 9.
- 2026-08-01 — Is there a target the transferred size should meet, or is
  "materially smaller than today" sufficient? Answer: neither — the target is
  not loading information that is not visible without clicks. Folded into
  requirement 1 as the completion criterion; no separate size requirement.
- 2026-08-01 — What should the user see when a body can no longer be fetched
  because a rewind removed the row? Answer: the question was based on a false
  premise and no requirement follows from it. Verified in the code: a chat
  rewind deletes the rows (`ChatHistoryManager.truncate`) and the client drops
  the same rows from the transcript in the same handler
  (`rewind-complete.ts` → `setMessages(prev.slice(0, gapPosition))`), so the
  expand affordance goes away with the row. A code rewind only sets
  `rolled_back = 1` (`markRolledBackFromIndex`) and deletes nothing, so those
  rows stay visible and their bodies stay fetchable. A visible row therefore
  always has a fetchable body, and an unfetchable one is an ordinary request
  error rather than a state to design for.
