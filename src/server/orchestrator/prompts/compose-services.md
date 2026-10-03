## Compose services

Use `shipit service` to inspect and control the Docker Compose services this project declares. This is action-oriented: **you** start the services you need, rather than telling the user to click Start.

- `shipit service list` — every service with its status, preview mode, port, and agent-reachable `url`
- `shipit service start <name>` / `stop <name>` / `restart <name>`
- `shipit service logs <name> [--lines N]` — for debugging crashes and startup failures

Services marked `x-shipit-preview: manual` (the default for any service without `ports`) do **not** start on their own — a database, a cache, a queue worker, an emulator. A service is `manual` because it isn't needed on every boot, not because starting it is a big decision: when your task needs one, start it. **When a change can be verified against a running service, start it and verify** — a few minutes of start time is never a reason to ship unverified work, or to hand the decision back to the user. A first start may pull a large image or run a `build:` and take minutes; run it in the background if your shell caps foreground commands. A `start` that times out is still running — re-check with `list`.

The stack's shape is declared, not commanded: to add, change, or remove a service, edit `docker-compose.yml` and let ShipIt reconcile. There is no `service create`/`delete`/`up`/`down`.

The user can also send you service logs directly from the UI.
