---
issue: planning#708
title: Secondary session hosts
description: One ShipIt runs sessions on its main host and on secondary machines, such as a GPU workstation, from one UI.
---

# Secondary session hosts — requirements

There is no design yet. The investigation of 2026-10-28 and its proposed shape are in planning#708.

The requirements are for any user who adds hosts to their ShipIt. One example, and the first use: a user makes 3D models, with rendering in Blender and in a web game. Sessions that need a GPU run on a workstation, and the other sessions run on a remote main host.

1. One ShipIt has one main host and can have several secondary hosts.

2. A session on any host can start child sessions on any host: the main host or a secondary host.

3. Sessions on a secondary host are regular ShipIt sessions.

4. A session that the user starts without choosing a host runs on the main host.

5. The user's instructions and the other settings are kept in one place.

6. The user works from one UI.

7. All hosts are in one private network, such as a tailnet. This version adds no authentication between hosts.

8. A secondary host is not always on. A session that is created for a host that is not available is created on the main host.

9. A session never moves between hosts.

10. The user chooses the host on the new-session screen. A role can name the host.

11. A message for a session whose host is off is refused.

12. GPU access is a setting for each host. This replaces the single switch for the whole install in docs/325-session-gpu-access req 5.

13. The main server cannot get root access to a secondary host.

14. Docker inside sessions (a session that runs Docker itself) is a setting for each host. The user can allow it on some hosts and refuse it on others.

15. Priority 2 (good to have, not important): server updates are done in one place.

16. When no host is named for a child session, a placement strategy chooses its host. ShipIt can have more than one strategy.

17. The first version has a strategy under which a session that requests a GPU runs on a host that has one, and every other session runs on the main host.

18. A parent agent requests a GPU for a child session with a flag on `shipit session create`, such as `--request-gpu`.

## Later versions

- More placement strategies (req 16), for example: a child runs on its parent's host; a child runs on the main host.
- Authentication between hosts, so that hosts do not have to share one private network (req 7).
- A `--host` flag on `shipit session create` that names a host.

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
- 2026-10-28 — Review of this document: can only sessions on the main host start child sessions on a secondary host? Nik: "Ideally sessions anywhere could start sessions anywhere else." Req 2 now covers every host. This opened the question about a child's default host.
- 2026-10-28 — Review of this document: are the requirements for Nik's use case only? Nik: "This is my use-case but we need to target a broader audience." Req 3, 4 and 14 no longer name his setup. His use case is now an example in the introduction. This opened the question about req 7.
- 2026-10-28 — Where does a child session run when no host is named for it: on its parent's host, or on the main host? Nik: "I guess we can have some strategies later on. For my use-case all non-GPU sessions should be on the main host, this needs to work as a strategy. Your options a and b could also be strategies." Req 16 and 17 added; the two options are listed under Later versions. This opened the question about how ShipIt knows that a session needs a GPU.
- 2026-10-28 — May the design require all hosts to be in one private network, such as a tailnet? Nik: "yes, let's not solve auth yet". Req 7 changed; authentication between hosts is listed under Later versions.
- 2026-10-28 — How does ShipIt know that a session needs a GPU? Nik: "If I explictly pick a host in the UI, or if a parent specifies the `--request_gpu` flag or similar on the CLI. We could also add "--host" to the CLI, not sure if it is a good idea though." Req 10 and 17 changed, and req 18 added. The agent's flag on `shipit session create` now requests a GPU instead of naming a host; this replaces that part of the earlier answer on req 10. This opened the question about `--host`.
- 2026-10-28 — Does `shipit session create` also get a `--host` flag that names a host? Nik: "let's not add it for now. But the UI should allow this for manual start". No flag in this version; it is listed under Later versions. Req 10 already lets the user choose the host on the new-session screen.
