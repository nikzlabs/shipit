---
issue: planning#708
title: Secondary session hosts
description: One ShipIt runs sessions on its main host and on secondary machines, such as a GPU workstation, from one UI.
---

# Secondary session hosts — requirements

There is no design yet. The investigation of 2026-10-28 and its proposed shape are in planning#708.

1. One ShipIt has one main host and can have several secondary hosts.

2. Sessions on the main host can start child sessions on a secondary host, for example a host that has a GPU.

3. Sessions on a secondary host are regular ShipIt sessions. The first use is making 3D models, with rendering in Blender and in a web game, on a GPU workstation.

4. Most sessions run on the main host, which is a remote server. Sessions that need a GPU run on the GPU workstation.

5. The user's instructions and the other settings are kept in one place.

6. The user works from one UI.

7. All hosts can be in one tailnet.

8. A secondary host is not always on. A session that is created for a host that is not available is created on the main host.

9. A session never moves between hosts.

10. The user chooses the host on the new-session screen. An agent chooses it with a flag on `shipit session create`. A role can name the host.

11. A message for a session whose host is off is refused.

12. GPU access is a setting for each host. This replaces the single switch for the whole install in docs/325-session-gpu-access req 5.

13. The main server cannot get root access to a secondary host.

14. Docker inside sessions (a session that runs Docker itself) is a setting for each host. It is not allowed on the workstation. It is allowed on other servers that the user may connect later.

15. Priority 2 (good to have, not important): server updates are done in one place.

## Open questions

## Resolved questions

- 2026-10-28 — What is the goal: one UI for several separate servers, more capacity for one ShipIt, or a hosted product? Nik: more sessions than one machine can hold, in particular sessions that need a GPU. Those run on his workstation; the rest usually run on the remote server, the "main" ShipIt (req 4).
- 2026-10-28 — What do the GPU sessions do? Nik: they are regular ShipIt sessions. The main use is creating 3D models, which involves rendering in Blender and/or in a web game (req 3).
- 2026-10-28 — Is a server switcher, or two installs with one UI, enough? Nik: sessions on the main server must be able to start children on a host with a GPU, server updates must be done in one place, and his user instructions must be kept in one place (req 2, 5, 15). Two installs cannot give this, so the shape is one ShipIt with more hosts.
- 2026-10-28 — Is the workstation always on? Nik: no. If it is not available, sessions are scheduled on the main host. He tries not to turn it off while sessions are working (req 8).
- 2026-10-28 — Are server updates in one place required? Nik: priority 2; good if we have it, but not that important (req 15).
- 2026-10-28 — May the workstation move from Docker Desktop to Docker Engine inside WSL2? Nik: it must first be checked that GPU access works that way. Today GPU access works with Docker Desktop. No requirement changed.
- 2026-10-28 — One secondary host, or more? Nik: make it more generic while we can: one host with multiple secondaries (req 1).
- 2026-10-28 — When the workstation is on again, does a session that moved to the main host go back to it? Nik: no. Sessions never move between hosts. He expects problems with volumes; for example, sessions on the same host share the dependency cache (req 9).
- 2026-10-28 — How does a session ask for its host? Nik chose both offered ways: a choice on the new-session screen plus a flag on `shipit session create`, and a role that names the host (req 10).
- 2026-10-28 — Does the 2026-10-10 rejection of "a pool of remote Docker hosts" (planning#204) cover the user's own machines? That rejection was for a hosted product with strangers' sessions. Nik: hosted ShipIt is not a priority now, mainly due to Claude Code licensing. So the rejection does not block this feature.
- 2026-10-28 — Can the main server be kept from getting root access to a secondary? Nik asked for it, then confirmed it as a requirement (req 13).
- 2026-10-28 — What happens to a message for a session whose host is off? Nik: it is refused (req 11).
- 2026-10-28 — Does the GPU switch become a setting for each host? Nik: yes, for each host (req 12).
- 2026-10-28 — Is Docker inside sessions refused or allowed on secondary hosts? Nik: it is a setting for each host. He does not allow root on his workstation, but it is OK on other servers he may connect in the future (req 14).
