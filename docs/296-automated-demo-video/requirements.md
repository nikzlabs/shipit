---
issue: planning#524
title: Automated demo video
description: A repeatable, fully automated video that shows ShipIt's most important features, produced against a dedicated demo instance.
---

# 296 — Automated demo video: requirements

No design yet; `plan.md` follows once the open questions below are answered.

1. ShipIt has a demo video that shows its most important features.

2. The video is produced automatically, end to end — "everything automatic". No one records a screen by hand, edits a take, or steps through the product while a capture runs.

3. The video is repeatable. Producing it twice gives the same sequence with the same timings. A live model driving the session in real time is not acceptable, because its timings vary from run to run.

4. The video is recorded against a special, dedicated demo instance of ShipIt — not the dogfood inner instance, which cannot show previews. Previews are one of the headline features and must appear in the video.

5. The mechanism works purely from outside ShipIt — "essentially clicking buttons" the way a user would. ShipIt itself runs unmodified.

6. The demo session runs on the Claude Code harness. (Codex and OpenCode were considered; see the resolved question below.)

7. The pipeline supports multiple scenarios. A scenario is one storyboard that produces one video; adding a scenario does not change the pipeline.

8. The first scenario is a video that auto-plays on the ShipIt website. It is silent and it loops. The feature set and the length were delegated to the agent (see the resolved question below); the agent's proposal:
   - Length: 40 seconds or less, so a visitor sees the whole loop before scrolling on.
   - Beats, in order: (a) type a prompt that describes a small app and send it; (b) the agent works — files appear in the tree, the transcript shows activity — and the preview pane renders the app; (c) a follow-up prompt changes the app and the preview updates in place; (d) the pull-request card appears in the transcript, and the merge happens inside ShipIt.
   - The beats are the product principles in motion: chat is the input (§5), the preview and the PR are inline (§1, §2).

9. The video has no spoken narration. Any words on screen come from the product itself or from captions.

10. The video is produced on demand — someone triggers a run — not on every release.

11. The video shows a cursor with a click highlight, so a pane switch or a button click reads as a user action, not as a cut.

12. The final video cuts what is boring or slow. Loading and waiting are removed, and an action that should look instant — for example, opening a new session with its preview — is instant in the video, whatever it took in the recording. This is marketing footage, not a benchmark.

13. The pipeline is built in two phases. Phase 1 fleshes out the basics against the dogfood inner instance, which runs inside a ShipIt session with no preview. Phase 2, once everything works, sets up the dedicated demo service (req 4) for the real video.

## Open questions

- Where the dedicated demo service (phase 2) is hosted. Not needed for phase 1.

## Resolved questions

- 2026-09-08 — Should the video be recorded against the dogfood inner instance? Chosen: no — a dedicated demo instance, because the inner instance does not show previews and previews are a headline feature. Requirement 4.
- 2026-09-08 — Should a live model drive the demo in real time? Chosen: no — timings would be inconsistent; the run must be repeatable. Requirement 3.
- 2026-09-08 — Does producing the video require changes to ShipIt's server? Chosen: no — the mechanism lives entirely outside ShipIt and drives it as a user would. Requirement 5. (The agent's design answer — record the model's responses once and replay them at the API boundary — is a candidate mechanism for `plan.md`, not a requirement.)
- 2026-09-08 — Which agent harness? Nik asked whether Codex or OpenCode would be more flexible. A probe (recorded on planning#524) measured the opposite: Claude Code 2.1.252 takes an API redirect from a two-line `.claude/settings.json` in the demo repo; Codex 0.153.2 rejects a project-local redirect; OpenCode 1.18.25 accepts one standalone but is shadowed inside a ShipIt session. Nik chose Claude Code. Requirement 6.
- 2026-09-08 — Which features, in what order, and how long? Nik: "We need to support multiple scenarios. First use case: auto-playing video on the website. Come up with feature set and length." The multi-scenario rule is requirement 7; the first scenario is requirement 8, with the feature set and length delegated to the agent and recorded there as the agent's proposal.
- 2026-09-08 — Narration and cadence? Nik chose no narration, produced on demand. Requirements 9 and 10.
- 2026-09-08 — Cursor / click-highlight overlay? Nik: yes, as the agent suggested — a small overlay injected into the page by the driver. Requirement 11.
- 2026-09-08 — Nik added, unprompted: the final video may need cuts — boring loading, and anything that should look instant but is not (his example: opening a new session with its preview). Requirement 12.
- 2026-09-08 — Where does the demo instance run? Nik: "Let's start with the dogfood version. So we flesh out the basics, and once everything works, we'll set up a demo service." Phase 1 is the dogfood inner instance; the host for phase 2 stays open. Requirement 13.
