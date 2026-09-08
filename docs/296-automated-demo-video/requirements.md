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

6. The demo may use whichever agent harness (Claude CLI, Codex, OpenCode, or another) is most flexible for this purpose; the video is not tied to the Claude CLI.

## Open questions

- Which features the video shows, and in what order (the storyboard). Previews are in; the rest of the list is undecided.
- Target length of the video.
- Where the dedicated demo instance is hosted.
- Whether the video has narration, and if so which voice and provider.
- Whether the video is produced on every release or on demand.
- Whether a cursor / click-highlight overlay is wanted.
- Which agent harness the demo uses — Claude CLI, Codex, or OpenCode. A probe is in progress to find which one is easiest to point at a replay proxy from a file in the demo repository.

## Resolved questions

- 2026-09-08 — Should the video be recorded against the dogfood inner instance? Chosen: no — a dedicated demo instance, because the inner instance does not show previews and previews are a headline feature. Requirement 4.
- 2026-09-08 — Should a live model drive the demo in real time? Chosen: no — timings would be inconsistent; the run must be repeatable. Requirement 3.
- 2026-09-08 — Does producing the video require changes to ShipIt's server? Chosen: no — the mechanism lives entirely outside ShipIt and drives it as a user would. Requirement 5. (The agent's design answer — record the model's responses once and replay them at the API boundary — is a candidate mechanism for `plan.md`, not a requirement.)
