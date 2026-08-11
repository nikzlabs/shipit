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
2. A project repository declares the common tools repository once. After that,
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
   the tools repository; the project session receives it through req 8.)
5. Wiring the tools into a new project costs one declaration. No per-project
   copies of service definitions or install boilerplate that must be kept in
   sync across project repos.
6. This works when the repositories are private.
7. The tools checkout in a project session is **read-only**. Tool changes are
   made in sessions on the tools repository itself; a project session never
   pushes to the tools repository.
8. By default, a project session's tools checkout tracks a named branch of the
   tools repository. A project repository can pin a tag or SHA instead when it
   needs stability.
9. Tool services run **per-session**: each project session gets its own
   instances, like its own compose services today.
10. The feature works under both credential modes: host-wide PAT and per-repo
    GitHub App tokens. Private tools repositories stay reachable either way.

## Out of scope (v1)

- MCP-style tool declarations (the tools repository shipping an MCP server the
  agent gets automatically in project sessions). Deferred; revisit for v2.

## Requirement provenance

Requirements 1–4 restate what the user said directly (voice messages,
2026-08-11), generalized from their concrete multi-project setup to any
projects at the user's request. Requirement 5 generalizes the user's stated
friction ("ShipIt doesn't provide a convenient way") to the many-projects case;
the "one declaration" bar is the agent's proposal. Requirement 6 is inferred
from the repositories being private today. Requirements 7–10 and the v1 scope
are the user's answers to the structured questions of 2026-08-11 (see Resolved
questions).

## Open questions

- **Where does the declaration live?** Per project repo in `shipit.yaml` (like
  `issues.trackers`), or once at account/project-group level so all repos get
  it?

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
