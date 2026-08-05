# Requirements — subagent final report

Feature 109 (subagent transparency) predates requirements discipline. This
document covers the **final-report surface only** — the part reworked in
2026-08-04 — and is written in the human's terms. Everything else about the
feature (the header, the prompt disclosure, the work timeline) is described in
`plan.md` and is not restated here.

Design: [`plan.md`](./plan.md). Visual reference:
[`mockup-final-report.html`](./mockup-final-report.html).

## Requirements

1. A subagent that was launched to run **in the background** must not display a
   final report, because it has not produced one. What the tool returns in that
   case is machinery addressed to the agent, not to the reader, and none of it
   belongs in the transcript.
2. While such a subagent is still running, the card must say so rather than
   claiming it finished.
3. A final report must be visually distinguishable from the parent agent's own
   prose. The reader must be able to tell, at a glance, that they are looking at
   output quoted from another agent.
4. A report's own formatting must not out-shout the conversation it is nested
   in — a heading inside a subagent's report must not render larger than the
   transcript around it.
5. The CLI's accounting footer (tokens, tool calls, duration) must read as
   compact metadata, not as raw `key: value` text at the bottom of the report.
   The internal agent id must not be shown to the reader at all.
6. A long report must not bury the conversation. Inline, the transcript shows a
   clamped portion of it.
7. The full report must be reachable from the card in **one click**, and it
   opens in a modal rather than expanding inline.
8. Because the full report is only ever visible after that click, only the
   clamped portion needs to be sent to the browser with the transcript by
   default. The rest must still be retrievable on demand, and nothing may be
   permanently lost by not sending it.
9. A failed subagent's error must stay visually distinct from a successful
   report and must remain readable as the machine output it is.
10. Once a subagent that was launched in the background **finishes**, its card
    must stop presenting it as still running. This holds for every way it can
    finish — completing, failing, or being stopped — and it must hold after a
    reload, not only for the reader who happened to be watching.
11. The card promises the reader that the report "will appear here when it
    finishes", so when the subagent finishes and produced a report, the card
    must show it, in the same form as any other final report. When it finished
    without one, the card must say plainly what happened instead of leaving the
    promise outstanding.

## Open questions

None.

## Resolved questions

* **2026-08-04 — Which of the proposed changes to build?** Nik was shown a
  four-part proposal (background-launch fix, report panel + header chips,
  typography pass, clamping) as an action card and selected **all four**. Those
  became requirements 1–6 and 9. Recorded here because the proposal's wording
  was the agent's, not the human's: what the human supplied was the selection
  and the original complaint ("the agent final report needs to be formatted
  better", with a screenshot of the backgrounded-agent case).
* **2026-08-04 — Inline expansion or a modal for a long report?** Nik: *"'show
  full report' should open a modal instead, so we could send only the clamped
  version of the report to the conversation by default."* This replaced the
  proposed inline expand-in-place, and added the payload half explicitly —
  requirements 7 and 8. The second clause is why 8 exists as a requirement
  rather than as an implementation detail: sending less is part of what was
  asked for, not merely a consequence of the modal.
* **2026-08-04 — What should a finished background subagent's card show?** Raised
  from production by an Ops session: a `run_in_background` Task's card stayed on
  "Running in the background — its report will appear here when it finishes."
  forever, including across reloads, long after the subagent had finished and the
  parent agent had acted on its output. The incident packet stated the goal in
  the reader's terms — "the reader is told a subagent is still working when it
  finished minutes ago, and the promised report never appears" — and named
  marking the card finished as the *minimum* acceptable outcome. Requirement 10
  is that minimum; requirement 11 is the promise the existing copy already makes,
  which is why showing the report is a requirement here rather than an inference.
  Nothing about the intended behaviour was ambiguous, so no question was opened.
