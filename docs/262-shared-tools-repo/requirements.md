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
   definitions, the companion-CLI setup, and the install setup its tools
   need, under stable service and command names; a project declaration
   identifies the repository and ref (and may select tools by those stable
   names) — it never repeats their commands, ports, or compose definitions.
6. This works when the repositories are private.
7. The tools checkout in a project session is **read-only**. Tool changes are
   made in sessions on the tools repository itself; a project session never
   pushes to the tools repository. Tools files are visible to the agent but
   never appear as project-repository changes and never enter the project's
   commits. Tool services may write disposable runtime and build data; the
   tool source itself stays unmodified. Read-only means the tool source is
   never modified and never pushed — dependency installation and build output
   always have a writable location, which is neither tool source nor project
   data.
8. By default, a project session's tools checkout tracks a named branch of the
   tools repository. A project repository can pin a tag or SHA instead when it
   needs stability; a pinned project stays at that exact revision until its
   declaration changes. Two kinds of tool are the case pinning exists for: a
   tool that holds the integrity of project data (e.g. one that validates
   records it wrote earlier), and a tool whose version participates in a
   cache key that gates expensive regeneration (a tracked-branch commit would
   silently invalidate every consumer's cache).
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
    updates to the branch tip and the affected tool services and companion
    CLIs update, within seconds, without recreating the session and with no
    publish, deploy, or authentication step. This is the edit-a-tool-and-test-it loop: push from a
    tools-repo session, refresh in the project session, test.
13. When a tools repository, its selected ref, or a tool service definition
    cannot be loaded, the project session still opens and stays usable for
    project work. It clearly reports that shared tools are unavailable or
    stale, and why. It never silently runs a partial or unknown tools version.
14. A project may declare **multiple** tools repositories, each with its own
    independently selected branch or pin. The declaration, freshness,
    refresh, failure, and coherence requirements (reqs 5, 8, 10, 12, 13, 15)
    apply to each declared repository independently: one repository can be
    refreshed on its own, and its failure leaves the project's own services
    and the other tools repositories unaffected. "Partial version" in req 13
    means an incoherent version within one repository, not the absence of
    another, independently failing one.
15. The session shows, per tools repository, which ref and exact commit are
    in use. The files the agent sees, the companion CLIs, and the running
    tool services of that repository all correspond to that same commit: an
    update either completes coherently or leaves the prior complete version
    active with a visible failure. The running commit is also readable by the
    tool itself, so a tool can decide whether a version change invalidates
    caches it keeps, instead of assuming it does.
16. Tool services follow the same start, health, preview, stop, and
    session-disposal behavior as equivalent same-repo services. Only services
    the tools repository marks for automatic startup run automatically; the
    rest start on demand.
17. A tool is not necessarily a web preview only — it may ship a **companion
    CLI**. The agent can run that CLI inside the project session to modify
    things programmatically. The CLI and the tool's UI work on the same live
    state: the user observes the result of a CLI change in the UI, and the
    user can also make changes through the UI.
18. A tool's **durable output** — the data it manages for the project, such
    as requirements it maintains or images it generates — is written into the
    project's workspace as ordinary project changes: versioned, committed,
    and kept like any other project file. Everything else a tool holds is
    session-scoped runtime state: it survives page reloads, tool-service
    restarts, tools refreshes (req 12), and routine container restarts, and
    is discarded only when the session itself is reset or deleted. Neither
    kind of data is ever stored by modifying the read-only tools checkout.
    The preview origin is stable for the session's whole life, so
    origin-keyed browser storage counts as session-scoped state.
19. A checked-in tools declaration is a **standing grant** to fetch and
    execute that repository's declared setup, services, and companion CLIs at
    the selected revision — including each new commit on a tracked branch,
    which runs without a further approval. ShipIt visibly identifies the
    repository, ref, and exact commit being executed (req 15). Credentials
    used to fetch repositories are never exposed to tool code; credentials a
    tool declares for its own job (req 23) are delivered to it. Both halves
    hold at once.
20. Every surfaced tool service and companion CLI command has an unambiguous
    identity across the project and all declared tools repositories. When two
    would collide — with each other or with the project's own services —
    ShipIt reports the collision before running the ambiguous one, and the
    collision is resolvable in the declaration without copying service,
    command, port, or compose definitions.
21. A tool service and a companion CLI can address the **consuming project's
    workspace** through a stable, ShipIt-supplied handle that is the same in
    every project, and that a tools repository can name in its own service
    definition without knowing the project. (A tool that operates on the
    project — reading its docs, writing its assets — cannot satisfy req 18
    without this.)
22. A tools repository may ship **agent instructions** (e.g. skills) that a
    project session picks up, under the same standing grant as req 19. The
    instructions travel with the tool; projects never keep copies that must
    be kept in sync.
23. A tools repository declares the **credential names** its services and
    CLIs require for their own job (e.g. a third-party API key). Values
    resolve from a store associated with the tools repository, so one key
    serves every consuming project and rotation happens in one place; a
    project may override a value for itself. A project session shows which
    declared credentials a tool requires and whether they are satisfied.
    Onboarding a project therefore stays one declaration (req 5) — never
    declaration plus copying keys into each project.

## Out of scope (v1)

- MCP-style tool declarations (the tools repository shipping an MCP server the
  agent gets automatically in project sessions). Deferred; revisit for v2.
- A declared **data-format version** (a tools repository stating which version
  of its on-disk project data it reads and writes, with a pre-run mismatch
  report). Deferred; pinning (req 8) is the v1 mitigation.
- **Metered-spend handling** (a tools repository declaring that a tool
  consumes metered external resources, per-session spend visibility, and
  project-set caps). Deferred entirely; pinning (req 8) and the owner
  controlling both repositories are the v1 mitigation.

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
Requirement 17 restates the user's follow-up (voice message, 2026-08-11):
tools may also be companion CLIs the agent drives, with the user observing and
acting through the UI. Requirements 18–20 and the amendments to reqs 5, 12,
14, and 15 come from the second independent review of 2026-08-11 (same
brokered-reviewer setup; CLI coverage, multi-repo semantics, and trust
boundary), whose findings the user resolved the same day — see Resolved
questions. Requirements 21–22 and the amendments to reqs 7, 8, and 18 come
from a fit review by a candidate consumer — the user's requirements tool,
reviewed by the agent in that tool's own repository and forwarded by the user
(2026-08-11); the user resolved its findings the same day. Requirement 23,
the second half of req 19, the second pinning case in req 8, the
tool-readable commit in req 15, and the deferred metered-spend item come from
a second candidate-consumer fit review — the user's image asset pipeline
(`nicolasalt/design-docs`), posted as a PR comment (2026-08-11) and resolved
by the user the same day.

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
- **2026-08-11 — Where does tool data live?** (second review, finding 1).
  Answer: **durable output in project files as ordinary project changes;
  everything else is session-scoped runtime state** that survives reloads,
  restarts, and refreshes and dies only with the session. → req 18.
- **2026-08-11 — Trust boundary** (second review, finding 3). Answer: **the
  checked-in declaration is a standing grant** — new commits on a tracked
  branch execute without re-approval; the running repo/ref/commit stays
  visible; fetch credentials are never exposed to tool code. → req 19.
- **2026-08-11 — Second-review clarifications** (second review, findings 2,
  4, 5). Answer: **apply all three** — CLI parity in onboarding, refresh, and
  coherence (→ reqs 5, 12, 15), per-repository independence (→ req 14),
  collision reporting and resolution (→ req 20).
- **2026-08-11 — Workspace handle** (fit review, finding 1 — blocking).
  Answer: **add it** — tools can address the consuming project's workspace
  through a stable, ShipIt-supplied handle. → req 21.
- **2026-08-11 — Agent instructions** (fit review, finding 2). Answer:
  **carry them** — a tools repo may ship skills that project sessions pick
  up, under the req 19 standing grant; no per-project copies. → req 22.
- **2026-08-11 — Data-format compatibility** (fit review, finding 3).
  Answer: **pin note now, defer versioning to v2** — req 8 amended with the
  pinning guidance; the version declaration is recorded under Out of scope.
- **2026-08-11 — Fit-review wording amendments** (fit review, findings 4, 5).
  Answer: **apply both** — writable location for installs and build output
  (→ req 7); stable preview origin per session, verified in the ShipIt code
  (subdomain routing `{sessionId}--{port}`), so origin-keyed browser storage
  is session-scoped (→ req 18).
- **2026-08-11 — Tool credentials** (image-pipeline fit review, finding 1).
  Answer: **tools-repo store with per-project override** — the tools repo
  declares credential names; one key serves every consumer and rotates in one
  place; sessions show satisfaction. → req 23; req 19 gains its second half.
- **2026-08-11 — Metered spend** (image-pipeline fit review, finding 2).
  Answer: **defer entirely to v2** (the agent recommended per-session spend
  visibility in v1; the user chose full deferral — pinning and single-owner
  repos are the v1 mitigation). → Out of scope.
- **2026-08-11 — Cache-driven pinning and tool-readable commit**
  (image-pipeline fit review, finding 3). Answer: **apply both** — second
  pinning case named (→ req 8); the running commit readable by the tool
  itself (→ req 15).
