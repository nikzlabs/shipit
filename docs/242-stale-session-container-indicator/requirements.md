# Requirements

## Source

User request, 2026-07-31:

> now that the containers are not killed on shipit update, needs some indication that a container a stale, with a suggestion to restart it. Create a design doc with requirements.md file next to it, requirements only sourced from me

## User-sourced requirements

1. Now that ShipIt updates do not kill existing containers, ShipIt must indicate when a container is stale.
2. The stale-container indication must suggest restarting the container.
3. The feature must have a design document.
4. A `requirements.md` file must live next to the design document.
5. This requirements file must contain only requirements sourced from the user.
6. On an orchestrator update, a running stale agent container whose agent is
   stopped must be restarted automatically, so the user does not have to click
   the manual restart-container action.
7. On a ShipIt update, idle session containers must be **killed**, so that the
   update actually frees the RAM they were holding.
8. After such an update, the user must stop meeting the stale-container banner
   on the sessions they open afterwards.

## Resolved questions

- 2026-08-02 — The user clarified that “containers that are not running” meant
  a running container whose agent process is stopped. The desired behavior is
  automatic restart after an orchestrator update, without requiring the manual
  restart-container click. This is recorded as requirement 6.
- 2026-09-02 — After a production update freed no memory at all (35 rediscovered
  containers, 4 rotated, 31 untouched, 25.3 GiB held), the user restated the goal
  for an update: kill the idle containers, so RAM is freed and the banner stops
  appearing. Recorded as requirements 7 and 8. This supersedes requirement 6's
  *mechanism* — a reclaim is no longer a restart, because recreating the
  container spends the freed memory straight back — while keeping its outcome:
  the user still never has to click "Restart agent" for an idle session.

## Provenance boundary

No implementation mechanism, UI placement, stale-detection rule, restart behavior,
or additional product requirement is asserted here. Those are design decisions and
are kept in `plan.md`.
