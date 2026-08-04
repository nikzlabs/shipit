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
7. This complements paging (SHI-266) rather than replacing it: paging avoids
   transferring untouched history, this reduces the weight of the pages that do
   load.
8. The transcript itself must look exactly as it does today and must not
   introduce loading states of its own. A view the user opens by clicking may
   load data on demand, and may show a loading state while it does.
9. Images may render inline at reduced resolution, with the full-resolution
   image loaded when the user opens the full-size preview. Sending an image
   with the transcript rather than deferring it to a click is acceptable for
   images up to 256×256; requirement 1 does not apply to them.

## Open questions

- Requirement 9's 256×256 allowance is written as a bound on the image being
  sent, but the code sends whatever resolution was stored — the 96×96 inline
  thumbnail points at the same content-addressed URL as the full-size preview,
  so a 4000×3000 screenshot transfers in full on viewport entry. So either:
  (a) the allowance describes the inline **render** size and the transfer stays
  deliberately unbounded, in which case requirement 9's wording should say so
  and no code changes; or (b) it is a real bound on transferred pixels, in
  which case images above it must be downsampled server-side — which needs a
  new image-processing dependency, since the repo has none, and reads against
  "accept the gap". Recorded as an open question rather than guessed at,
  because the two readings differ by a whole subsystem. SHI-292.

## Resolved questions

- 2026-08-04 — Should inline image thumbnails be downsampled so requirement 1's
  "nothing transfers without a click" holds for images, or is transferring them
  with the transcript acceptable? Answer: acceptable — accept the gap, allow
  images up to 256×256 to be sent, they are infrequent anyway. Recorded in
  requirement 9. (Raised by the independent requirements review, which found
  that the 96×96 thumbnail loads full-resolution bytes on viewport entry rather
  than on click, making requirement 9's second clause unreachable. SHI-292.)

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
