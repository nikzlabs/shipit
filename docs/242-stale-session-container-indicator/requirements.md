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

## Resolved questions

- 2026-08-02 — The user clarified that “containers that are not running” meant
  a running container whose agent process is stopped. The desired behavior is
  automatic restart after an orchestrator update, without requiring the manual
  restart-container click. This is recorded as requirement 6.

## Provenance boundary

No implementation mechanism, UI placement, stale-detection rule, restart behavior,
or additional product requirement is asserted here. Those are design decisions and
are kept in `plan.md`.
