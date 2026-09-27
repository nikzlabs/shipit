# 317 — Compose services can mount the session's /persist: requirements

The design that implements these requirements is in [`plan.md`](./plan.md).

Source: a feature request from the verseshot project (a music-video tool that runs as a Compose service in ShipIt sessions), 2026-09-27. Its API service stores generated images and videos that cost money to make, so it needs a writable data directory that ShipIt keeps.

1. A project's Compose service can mount the session's `/persist` directory, or a subdirectory of it.
2. Data written through the mount survives container restarts and checkout re-clones. It has the same lifecycle as `/persist`.
3. The mount is declared in the project's `docker-compose.yml`.
4. The mount always maps to the session's **own** `/persist`, never to another session's.
5. The mount is writable by the session's UID and group, like the workspace. The service and the agent can both read and write the same files.
6. Security stays the same: no arbitrary host paths, and a subpath cannot leave `/persist` — no `..`, and no symlink escape.
7. Plugin fragments cannot use the mount. Plugins keep `/plugin-state` for their state. (The request asked for this decision to be stated, and recommended "probably not, because they have `/plugin-state`".)
8. The agent-facing documentation states what happens to `/persist`, and to these mounts, on each of these events: container restart, idle reclaim, checkout reclaim, archive and restore, delete, and full reset.
9. The plugin documentation states which sessions share a plugin's `/plugin-state`.

## Open questions

(none)

The request left the declaration syntax to ShipIt's design ("a reserved source such as `- persist:/data`, a subpath form such as `- persist/verseshot:/data`, or an `x-shipit-*` extension"), so the syntax is a design choice in `plan.md`, not a requirement.
