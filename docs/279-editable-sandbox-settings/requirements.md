---
title: Editable sandbox session settings
description: A sandbox session's capability grants can be changed after creation, not only at creation time.
---

# Editable sandbox session settings

Today a sandbox session's capabilities (`docs/211-sandbox-sessions`, `docs/224-sandbox-merge-capability`)
are chosen in the creation dialog and are immutable for the life of the session.
The only way to change your mind is to make a new sandbox and start over.

1. The settings of an existing sandbox session can be changed after it is
   created. This covers every grant the creation dialog offers: **GitHub
   access**, **Allow merging PRs**, **Docker access**, and **Network access**.
2. The user makes the change from ShipIt's own UI, on the session it applies to.
   No new tab, no restart of the session, no new session.
3. The grants stay server-authoritative. The agent in the container cannot
   change its own capabilities and cannot cause them to be changed — a change
   comes only from a user action in the UI.
4. After a change, what the session can actually do matches the new settings.
   Removing a grant removes the access; adding a grant supplies it.
5. The user can see the current grants of a sandbox session, and can see when a
   change they made is not in effect yet.
6. Changing settings does not destroy the session's work. `/workspace` and the
   chat transcript survive the change.

## Open questions

- Docker access is wired into the container when the container starts, so a
  change to that one grant needs a new container. What must ShipIt do when the
  user changes it — restart the container, and if so, when?

## Resolved questions

- (none yet)
