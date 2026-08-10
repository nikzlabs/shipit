---
description: What "starting a Compose service works smoothly" has to mean, in observable terms.
issue: planning#43
---

# Compose resilience — requirements

Requirements for the gaps in [plan.md](plan.md). Numbered, observable, and
human-owned: they say what must be true for the user, never how it is built.

## Requirements

1. Starting a Compose service from the UI reaches a correct final state — it
   runs, or it reports a failure that names the cause. The user never has to
   stop and start it again to make it work.
2. A service is never reported as `starting` indefinitely. Either it is making
   progress the user can see, or it is reported as failed.
3. A service's reported status matches reality. ShipIt does not keep reporting
   `running` for a container that is gone, and does not route the preview at a
   container it has no evidence for.
4. The log panel keeps showing a service's output after that service restarts —
   a crash, an automatic retry, an OOM recovery — without the user restarting
   anything by hand.
5. Stopping a service while it is starting leaves it stopped. The user's last
   instruction is the one that holds.
6. When the session worker is permanently unreachable, ShipIt says so. It does
   not keep presenting the session as alive.

## Provenance

What the user said, on 2026-08-10, after PR #2121 made a silent `docker compose
up` visible: *"Let's just fix all the gaps, because I want it to work smoothly.
If we only show some logs, it's good, but ideally the service would just start.
It shouldn't be flaky."* Requirements 1–4 and 6 restate that goal against the
gaps already recorded in `plan.md` (D, E, F).

Requirement 5 is inferred, not stated. It comes from the user's own reported
workaround — stopping a slow start and starting it again — which today issues a
second `docker compose up` while the first is still running, with nothing
sequencing the two.

## Non-requirements

- A time limit on a legitimate build. An image build that takes ten minutes is
  allowed to take ten minutes (gap G made that window visible); requirement 2 is
  about a service that is *not* progressing, not about a slow one.
- A new status vocabulary or new health banners. Those are candidate mechanisms
  in `plan.md`'s older gap write-ups, not requirements — the simplest mechanism
  that satisfies the numbered statements above wins.

## Open questions

None.
