---
issue: planning#696
title: A /persist subdirectory mount on Docker Desktop
description: Requirements for letting a Compose service mount one subdirectory of /persist on Docker Desktop, which needs /persist in a Docker volume of its own.
---

# 331 — A /persist subdirectory mount on Docker Desktop

## Source

- `docs/317-compose-persist-mount` req 1: a Compose service can mount the
  session's `/persist`, or a subdirectory of it. On Docker Desktop the
  subdirectory form is refused since PR #3208, because no confined form exists
  with the current storage layout (`docs/317-compose-persist-mount/plan.md`,
  section "Docker Desktop").
- The Ops brief of 2026-10-14 for that fix: "Keep docs/317's guarantee that a
  `persist/<sub>` mount cannot escape the session's /persist through a planted
  symlink", and "Don't regress native Linux Docker."
- 2026-10-14: the user approved writing requirements for keeping `/persist` in a
  Docker volume of its own for each session. That direction is the agent's
  proposal from the docs/317 plan; it is not yet a decision to build it
  (planning#618).

## Requirements

1. On a Docker Desktop host, a project's Compose service can mount a
   subdirectory of the session's `/persist` (`persist/<sub>:/target`), as it can
   on a native Linux host.
2. The mount reaches only this session's own `/persist`. A symlink that the
   agent or a service makes inside `/persist` cannot make the mount reach
   anything outside it.
3. Every mount form that works on a native Linux host today still works there.

## Requirements of other features that this one touches

These are not new. A change of where `/persist` is kept must keep them true.

- `docs/317-compose-persist-mount` req 2 and req 8: data written through a
  `persist` mount has the lifecycle of `/persist`, and the agent docs state that
  lifecycle for each event (restart, idle reclaim, checkout reclaim, archive and
  restore, full reset).
- `docs/317-compose-persist-mount` req 5: the agent and the services can read
  and write the same files, as the session's UID and group.
- `docs/323-archived-session-data-retention` reqs 1–13: ShipIt measures and
  deletes the `/persist` files of an archived or done session after the
  retention period, keeps a session with 100 MB or more for a shorter period,
  and says on restore which files it deleted.

## What the design must handle

Not requirements, and not questions for the user: the requirements above and of
docs/317 and docs/323 already decide what must stay true. `plan.md` must show
how each item below keeps working, including each docs/323 requirement. Today
ShipIt reads or writes the scratch directory (`sessions/<id>/scratch` in the
workspace volume) directly in these places, and a Docker volume of its own is
not visible to the orchestrator in the same way:

- `container-lifecycle.ts`: the agent container's `/persist` mount.
- `compose-persist.ts` and `service-manager.ts`: the preparation of `/persist`
  and of each mounted subdirectory, as the session's UID.
- `compose-helper.ts`: the confined Compose run, which can read a project file
  from `/persist`.
- `services/replay-detail.ts`: files that the orchestrator writes to
  `/persist/replay` for the agent.
- `data-retention-sweep.ts`: the size measure and the deletion of docs/323.

## Open questions

- Should ShipIt build this at all, and on which hosts? Keep `/persist` in its
  own Docker volume on every host, only on Docker Desktop hosts, or keep the
  refusal of PR #3208 and build nothing?
- What happens to the `/persist` files of sessions that exist before the change:
  copy them into the new volume at the session's next start, keep the old layout
  for those sessions, or something else?
- A whole-install backup today copies two Docker volumes
  (`src/server/shipit-docs/wiki/installing-and-updating.md`). With this change a
  backup also needs one volume for each session. Is that acceptable?
- Must workspace subdirectory mounts (`./sub:/app`, and a self plugin's
  subdirectory) get the same fix, or does this feature cover `/persist` only?

## Resolved questions

(none)
