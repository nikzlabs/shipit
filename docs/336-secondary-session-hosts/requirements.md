---
issue: planning#708
title: Secondary session hosts
description: One ShipIt runs sessions on its main host and on secondary machines, such as a GPU workstation, from one UI.
---

# Secondary session hosts — requirements

There is no design yet. The investigation of 2026-10-28 and its proposed shape are in planning#708.

The requirements are for any user who adds hosts to their ShipIt. One example, and the first use: a user makes 3D models, with rendering in Blender and in a web game. Sessions that need a GPU run on a workstation, and the other sessions run on a remote main host.

Requirements of other features that hold for every session hold for sessions on a secondary host too. For example, docs/319-api-reach-through-host req 1: a request from a session's container gets no more access than that session's containers have today, whatever path it takes.

1. One ShipIt has one main host and can have several secondary hosts.

2. A session on any host can start child sessions on any host: the main host or a secondary host. In this version, a child reaches the main host, or a host that has a GPU through a GPU request (req 16 to 18).

3. Sessions on a secondary host are regular ShipIt sessions.

4. A session that the user starts without choosing a host runs on the main host.

5. The user's instructions and the other settings are kept in one place.

6. The user works from one UI.

7. All hosts are in one private network, such as a tailnet. This version adds no authentication between hosts.

8. A secondary host is not always on. On the new-session screen, a host that is off is grayed out, and the user cannot choose it.

9. A session never moves between hosts.

10. The user chooses the host on the new-session screen. A role does not name a host: a role defines how the agent behaves, and the host is not part of that.

11. A message for a session whose host is off is refused.

12. GPU access is a setting for each host. This replaces the single switch for the whole install in docs/325-session-gpu-access req 5.

13. The main server cannot get root access to a secondary host. The one exception is Docker access that the user allows on that host (req 14).

14. Docker access for sessions is a setting for each host. An example is the Docker socket that a repository's Compose services get with `compose.docker-socket`; a session with that access controls its host. The user can allow it on some hosts and refuse it on others.

15. Priority 2 (good to have, not important): server updates are done in one place. ShipIt's own code on a secondary host is updated on that host, because an update from the main server could give the main server root access there (req 13).

16. When no host is named for a child session, a placement strategy chooses its host. ShipIt can have more than one strategy.

17. The first version has a strategy under which a session that requests a GPU runs on a host that has one, and every other session runs on the main host.

18. A parent agent requests a GPU for a child session with a flag on `shipit session create`, such as `--request-gpu`.

19. When no host that has a GPU is on, ShipIt refuses a request for a GPU (req 18). It does not start the session without a GPU.

20. An ops session can run on any host. On a secondary host it has the same read-only limits as on the main host.

21. Every host has its own memory budget (docs/284-idle-preview-survives-agent-stop req 3 and 4).

22. A session that requested a GPU (req 18) is refused when it goes to a host where Docker cannot give the GPU. For such a session this replaces docs/325-session-gpu-access req 6, which starts a session without the GPU. Req 6 still holds for the other sessions on that host.

23. After ShipIt refuses a GPU request (req 19, 22), the agent can request the session again without a GPU, if the user insists.

## Later versions

- More placement strategies (req 16), for example: a child runs on its parent's host; a child runs on the main host.
- Authentication between hosts, so that hosts do not have to share one private network (req 7).
- A `--host` flag on `shipit session create` that names a host, so that a child can also reach a secondary host that has no GPU (req 2).

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
- 2026-10-28 — Consistency review of this document against ShipIt, by an independent reviewer. Changes, each from an earlier answer of Nik's: (1) Req 13 and 14: a Compose service with the Docker socket controls its host (`src/server/shipit-docs/compose.md`, "What not to do"). So req 13 now names the exception that Nik gave: "I wouldn't allow root on my workstation, but it is ok on other servers I may connect in the future." (2) Req 15: when Nik confirmed req 13, he accepted the condition that ShipIt's code on a secondary host is updated on that host. (3) Req 2: in this version, a session reaches a named host through a role (req 10). That was the option of the `--host` question that Nik chose. (4) The introduction now says that other features' requirements for every session hold on secondary hosts too. The review also opened four questions. One of them corrects the agent: it had offered "no ops session on a secondary" as a condition of req 13, on the wrong claim that an ops session has root on its host. An ops session has read-only Docker (`src/server/shipit-docs/ops-session.md`).
- 2026-10-28 — When no host with a GPU is on, is a GPU request started on the main host without a GPU, or refused? And does ShipIt say why when it creates a session on the main host because its host is off? Nik chose to refuse the GPU request: "If a session that needs 3d modelling starts without a gpu, software rendering easily eats 10 CPU cores." The option he chose also kept the fallback of req 8, with a notice. Req 19 added and req 8 changed. This opened the question about a chosen GPU host that is off.
- 2026-10-28 — May an ops session run on a secondary host? Nik: "well yes, do you think issues don't happen on secondaries? :) If anything, I expect more issues". Req 20 added.
- 2026-10-28 — Is the memory budget of docs/284-idle-preview-survives-agent-stop one budget for each host, or one for the whole install? Nik: "Every host has its own budget". Req 21 added.
- 2026-10-28 — Should a role be able to name a host (req 10)? Nik: "I misunderstood it, I thought you meant a CLI flag. Roles define the agent behavior. Host is not related to agent behavior." and "no". Req 10 changed: a role names no host. This replaces the role part of the earlier answer on req 10, and point (3) of the consistency-review record. Req 2 now says how a child reaches a host in this version; the `--host` item under Later versions says what it would add.
- 2026-10-28 — The user chooses a host with a GPU on the new-session screen, and that host is off: start the session on the main host (req 8), or refuse? Nik: "this option should be grayed out in the UI". Req 8 changed: a host that is off cannot be chosen. The fallback to the main host had no case left — a GPU request with no GPU host on is refused (req 19), and every other session runs on the main host anyway (req 4, 17) — so it was removed, with its notice. A session whose host goes off after the session is created stays on that host (req 9), and its messages are refused (req 11).
- 2026-10-28 — A session that requested a GPU goes to a host where Docker cannot give the GPU: start it without the GPU (docs/325-session-gpu-access req 6), or refuse it? Nik: "yes let's try B. The agent may re-issue the session request withou the GPU flag, if the user insists." Req 22 and 23 added. Req 23 also covers the refusal of req 19, because it is the same refusal of a GPU request.
