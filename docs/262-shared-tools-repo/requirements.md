---
issue: planning#355
title: Shared tools repository for multi-repo projects
description: A repo declares a common tools repository; its sessions get the tools' files and live services with no deploy step.
---

# Shared tools repository — requirements

Human-owned. Numbered statements are what the feature must do, in the user's
terms — observable outcomes, never mechanism. Gaps the agent had to fill live
under **Open questions** until a human answers them.

## Context, in the user's words

The user builds multiple projects with ShipIt. Every project lives in its own
repository — that part is convenient and stays. A couple of tools — for
requirements management, for image generation, and so on — live in one common
repository. ShipIt gives no convenient way to access that repository and the
services inside it from a project session.

Hosting the tools behind deployed endpoints (e.g. as remote MCP servers) was
considered and rejected by the user: a tool change would mean edit in the tools
repo → test with fake data → deploy somewhere with proper authentication. The
user wants the integration that same-repo services already have: the services
run in the session, the agent can send data to the preview, and the agent
receives data when someone clicks buttons in the previewed pages.

## Requirements

1. Projects each stay in their own repository. The common tools stay in their
   own repository. The feature must not require merging them or copying tool
   code into project repos.
2. A project repository declares a common tools repository once. After that,
   every session on that project repository has the tools repository's files
   available in its workspace.
3. The tool services from the common repository run live inside the project
   session, as first-class services: they appear in the session's service list,
   they can be previewed, the agent can interact with them (send data, call
   them), and interactions in their pages (e.g. a click in the previewed UI)
   reach the agent — the same integration same-repo services have today.
4. A change to a tool is testable against the real project, in the project
   session, with no publish step, no deploy step, and no separate
   authentication setup. (Per req 7, the change itself is made in a session on
   the tools repository; the project session receives it through reqs 8
   and 12.)
5. Wiring the tools into a new project costs one declaration. No per-project
   copies of service definitions or install boilerplate that must be kept in
   sync across project repos. The tools repository owns the service
   definitions and install setup its services need; a project declaration
   identifies the repository and ref (and may select services by stable
   names) — it never repeats their commands, ports, or compose definitions.
6. This works when the repositories are private.
7. The tools checkout in a project session is **read-only**. Tool changes are
   made in sessions on the tools repository itself; a project session never
   pushes to the tools repository. Tools files are visible to the agent but
   never appear as project-repository changes and never enter the project's
   commits. Tool services may write disposable runtime and build data; the
   tool source itself stays unmodified.
8. By default, a project session's tools checkout tracks a named branch of the
   tools repository. A project repository can pin a tag or SHA instead when it
   needs stability; a pinned project stays at that exact revision until its
   declaration changes.
9. Tool services run **per-session**: each project session gets its own
   instances, like its own compose services today.
10. The feature works under both credential modes: host-wide PAT and per-repo
    GitHub App tokens. Private tools repositories stay reachable either way.
    Authorization is one-time per installation — the PAT or App installation
    must grant access to the declared repositories; after that, receiving and
    testing later tool changes needs no additional authentication setup and no
    project-local secret.
11. The declaration lives **per project repository, in `shipit.yaml`** (like
    `issues.trackers`). A repo is self-describing: it works the same on every
    ShipIt install that is authorized for the declared repositories.
12. A session resolves the tracked branch at session start. Mid-session, the
    user or the agent can request a tools refresh: the read-only checkout
    updates to the branch tip and the affected tool services reload, within
    seconds, without recreating the session and with no publish, deploy, or
    authentication step. This is the edit-a-tool-and-test-it loop: push from a
    tools-repo session, refresh in the project session, test.
13. When a tools repository, its selected ref, or a tool service definition
    cannot be loaded, the project session still opens and stays usable for
    project work. It clearly reports that shared tools are unavailable or
    stale, and why. It never silently runs a partial or unknown tools version.
14. A project may declare **multiple** tools repositories, each with its own
    independently selected branch or pin.
15. The session shows which tools ref and exact commit are in use. The files
    the agent sees and the running tool services correspond to that same
    commit: an update either completes coherently or leaves the prior version
    active with a visible failure.
16. Tool services follow the same start, health, preview, stop, and
    session-disposal behavior as equivalent same-repo services. Only services
    the tools repository marks for automatic startup run automatically; the
    rest start on demand.

## Out of scope (v1)

- MCP-style tool declarations (the tools repository shipping an MCP server the
  agent gets automatically in project sessions). Deferred; revisit for v2.

## Requirement provenance

Requirements 1–4 restate what the user said directly (voice messages,
2026-08-11), generalized from their concrete multi-project setup to any
projects at the user's request. Requirement 5 generalizes the user's stated
friction ("ShipIt doesn't provide a convenient way") to the many-projects case;
the "one declaration" bar is the agent's proposal. Requirement 6 is inferred
from the repositories being private today. Requirements 7–11 are the user's
answers to the structured questions of 2026-08-11. Requirements 12–16 and the
amendments to reqs 5, 7, 10, and 11 come from the independent requirements
review of 2026-08-11 (brokered reviewer; coverage and contradiction brief),
whose findings the user resolved the same day — see Resolved questions.

## Open questions

(None.)

## Resolved questions

- **2026-08-11 — Writable or read-only tools checkout?** Answer: **read-only**
  (the agent recommended writable; the user chose read-only). Tool changes are
  made in tools-repo sessions and reach project sessions via the tracked
  branch. → req 7; req 4 rephrased to match.
- **2026-08-11 — Freshness.** Answer: **track a named branch by default, pin a
  tag/SHA optionally per project repo.** → req 8.
- **2026-08-11 — Service instances.** Answer: **per-session.** → req 9.
- **2026-08-11 — Credential modes.** Answer: **GitHub App support is in scope
  for v1**, alongside PAT. → req 10.
- **2026-08-11 — MCP scope.** Answer: **out of scope for v1** (not selected in
  the v1-scope question). → Out of scope section.
- **2026-08-11 — Where does the declaration live?** Answer: **per project
  repository, in `shipit.yaml`** (agent recommendation accepted). → req 11.
- **2026-08-11 — Refresh of a running session** (review finding 1). Answer:
  **on demand plus at session start** — an explicit refresh updates the
  checkout and reloads affected services without recreating the session.
  → req 12.
- **2026-08-11 — Failure behavior** (review finding 6). Answer: **degrade,
  visibly** — the session opens and reports the tools as unavailable or
  stale. → req 13.
- **2026-08-11 — Number of tools repositories** (review finding 9). Answer:
  **multiple** (the agent recommended exactly one for v1; the user chose
  multiple). → req 14.
- **2026-08-11 — Review clarifications** (review findings 3, 4, 5, 7, 8).
  Answer: **apply all five** — service-definition ownership (→ req 5),
  commit/workspace boundary (→ req 7), one-time authorization (→ reqs 10,
  11), version observability and coherence (→ req 15), service lifecycle
  parity (→ req 16).
