---
issue: planning#355
title: Plugin repositories for multi-repo projects
description: A repo declares a plugin repository; its sessions get the plugins' files, live services, and CLIs with no deploy step.
---

# Plugin repositories — requirements

Human-owned. Numbered statements are what the feature must do, in the user's
terms — observable outcomes, never mechanism. Gaps the agent had to fill live
under **Open questions** until a human answers them.

## Context, in the user's words

The user builds multiple projects with ShipIt. Every project lives in its own
repository — that part is convenient and stays. The shared tools — for
requirements management, for image generation, and so on — live in their own
repositories, separate from the projects and not necessarily all in one.
ShipIt gives no convenient way to access those repositories and the services
inside them from a project session.

Hosting the tools behind deployed endpoints (e.g. as remote MCP servers) was
considered and rejected by the user. The original argument — a tool change
would mean edit in the tools repo, test with fake data, then deploy somewhere
with proper authentication — lost most of its force once req 7 settled on a
read-only checkout: changes are made in the plugin repository either way, and
reach projects through refresh (req 12), not through a deploy. The argument
that stands (user, 2026-08-12): **a deployed MCP server cannot present a web
UI.** The user wants the integration that same-repo services already have —
the services run in the session, the agent can send data to the preview, and
the agent receives data when someone clicks buttons in the previewed pages
(req 3).

## Naming

The shared units are called **plugins**, and the repository that ships them is
a **plugin repository** (user decision, 2026-08-11 — see Resolved questions).
The name follows the declared unit: what ShipIt consumes is a package of
host-integration — declaration, services, CLI exposure, skills, credentials —
which cannot exist outside ShipIt. Doctrine that keeps the engineering honest:
**a plugin packages a tool; the tool's core COULD stay host-agnostic and
runnable outside ShipIt — that choice belongs to the tool author** (the
user's requirements tool, whose CLI needs only a filesystem, made it; nothing
in this spec requires it). The context section above and the historical
receipts below keep the original "tools" vocabulary of the early rounds.

## Requirements

1. Projects each stay in their own repository. The shared tools stay in their
   own repository — a plugin repository. The feature must not require merging
   them or copying plugin code into project repos.
2. A project repository declares a plugin repository once. After that, every
   session on that project repository has the plugin repository's files
   available in its workspace.
3. Plugin services run live inside the project session, as first-class
   services: they appear in the session's service list, they can be
   previewed, the agent can interact with them (send data, call them), and
   interactions in their pages (e.g. a click in the previewed UI) reach the
   agent — the same integration same-repo services have today.
4. A change to a plugin is testable against the real project, in the project
   session, with no publish step, no deploy step, and no separate
   authentication setup. (Per req 7, the change itself is made in a session
   on the plugin repository; the project session receives it through reqs 8
   and 12.)
5. Wiring a plugin into a new project costs one declaration. No per-project
   copies of service definitions or install boilerplate that must be kept in
   sync across project repos. The plugin repository owns the service
   definitions, the companion-CLI setup, and the install setup its plugins
   need, under stable service and command names; a project declaration
   identifies the repository and ref (and may select plugins by those stable
   names) — it never repeats their commands, ports, or compose definitions.
6. This works when the repositories are private.
7. The plugin checkout in a project session is **read-only**. Plugin changes
   are made in sessions on the plugin repository itself; a project session
   never pushes to the plugin repository. Plugin files are visible to the
   agent but never appear as project-repository changes and never enter the
   project's commits. Plugin services may write disposable runtime and build
   data; the plugin source itself stays unmodified. Read-only means the
   plugin source is never modified and never pushed — dependency installation
   and build output always have a writable location, which is neither plugin
   source nor project data.
8. By default, a project session's plugin checkout tracks a named branch of
   the plugin repository. A project repository can pin a tag or SHA instead
   when it needs stability; a pinned project stays at that exact revision
   until its declaration changes. Two kinds of plugin are the case pinning
   exists for: one that holds the integrity of project data (e.g. it
   validates records it wrote earlier), and one whose version participates in
   a cache key that gates expensive regeneration (a tracked-branch commit
   would silently invalidate every consumer's cache).
9. Plugin services run **per-session**: each project session gets its own
   instances, like its own compose services today.
10. The feature works under both credential modes: host-wide PAT and per-repo
    GitHub App tokens. Private plugin repositories stay reachable either way.
    Authorization is one-time per installation — the PAT or App installation
    must grant access to the declared repositories; after that, receiving and
    testing later plugin changes needs no additional authentication setup and
    no project-local secret.
11. The declaration lives **per project repository, in `shipit.yaml`** (like
    `issues.trackers`). A repo is self-describing: it works the same on every
    ShipIt install that is authorized for the declared repositories.
12. A session resolves the tracked branch at session start. Mid-session, the
    user or the agent can request a plugin refresh: the read-only checkout
    updates to the branch tip and the affected plugin services and companion
    CLIs update, within seconds, without recreating the session and with no
    publish, deploy, or authentication step. This is the
    edit-a-plugin-and-test-it loop: push from a plugin-repo session, refresh
    in the project session, test.
13. When a plugin repository, its selected ref, or a plugin's service
    definition cannot be loaded, the project session still opens and stays
    usable for project work. It clearly reports that plugins are unavailable
    or stale, and why. It never silently runs a partial or unknown plugin
    version.
14. A project may declare **multiple** plugin repositories, each with its own
    independently selected branch or pin. The declaration, freshness,
    refresh, failure, and coherence requirements (reqs 5, 8, 10, 12, 13, 15)
    apply to each declared repository independently: one repository can be
    refreshed on its own, and its failure leaves the project's own services
    and the other plugin repositories unaffected. "Partial version" in req 13
    means an incoherent version within one repository, not the absence of
    another, independently failing one.
15. The session shows, per plugin repository, which ref and exact commit are
    in use. The files the agent sees, the companion CLIs, and the running
    plugin services of that repository all correspond to that same commit: an
    update either completes coherently or leaves the prior complete version
    active with a visible failure. The running commit is also readable by the
    plugin itself, so a plugin can decide whether a version change
    invalidates caches it keeps, instead of assuming it does. These
    guarantees apply to tracked, read-only checkouts; a repository the
    session self-declares (req 27) is deliberately **live** — its editable
    working tree replaces the exact-commit correspondence, which is the
    point of developing there.
16. Plugin services follow the same start, health, preview, stop, and
    session-disposal behavior as equivalent same-repo services. A plugin
    declares whether its services start automatically; services not marked
    automatic start on demand. The consuming project's declaration can
    override that choice per service — starting a manual service
    automatically, or keeping an automatic one manual.
17. A plugin is not necessarily a web preview only — it may ship a
    **companion CLI**. The agent can run that CLI inside the project session
    to modify things programmatically. The CLI and the plugin's UI work on
    the same live state: the user observes the result of a CLI change in the
    UI, and the user can also make changes through the UI.
18. A plugin's **durable output** — the data it manages for the project, such
    as requirements it maintains or images it generates — is written into the
    project's workspace as ordinary project changes: versioned, committed,
    and kept like any other project file. Everything else a plugin holds is
    session-scoped runtime state: it survives page reloads, plugin-service
    restarts, plugin refreshes (req 12), and routine container restarts, and
    is discarded only when the session itself is reset or deleted. Neither
    kind of data is ever stored by modifying the read-only plugin checkout.
    The preview origin is stable for the session's whole life, so
    origin-keyed browser storage counts as session-scoped state.
19. A checked-in plugin declaration is a **standing grant** to fetch and
    execute that repository's declared setup, services, and companion CLIs at
    the selected revision — including each new commit on a tracked branch,
    which runs without a further approval. ShipIt visibly identifies the
    repository, ref, and exact commit being executed (req 15). Credentials
    used to fetch repositories are never exposed to plugin code; credentials
    a plugin declares for its own job (req 23) are delivered to it. Both
    halves hold at once.
20. Every surfaced plugin service and companion CLI command has an
    unambiguous identity across the project and all declared plugin
    repositories. When two would collide — with each other or with the
    project's own services — ShipIt reports the collision before running the
    ambiguous one, and the collision is resolvable in the declaration without
    copying service, command, port, or compose definitions.
21. A plugin service and a companion CLI can address the **consuming
    project's workspace** through a stable, ShipIt-supplied handle that is
    the same in every project, and that a plugin repository can name in its
    own service definition without knowing the project. (A plugin that
    operates on the project — reading its docs, writing its assets — cannot
    satisfy req 18 without this.)
22. A plugin repository may ship **agent instructions** (e.g. skills) that a
    project session picks up, under the same standing grant as req 19. The
    instructions travel with the plugin; projects never keep copies that must
    be kept in sync. The instructions reach the agent the same way the
    project's own skills do, **whichever agent backend runs the session**
    (Claude, Codex, or a later one) — a plugin's skills are never tied to one
    backend.
23. A plugin repository declares the **credential names** its services and
    CLIs require for their own job (e.g. a third-party API key). Values come
    from the **consuming project's own secret store**, per repository — the
    model that exists today, kept deliberately for v1 scope. It covers every
    case, suboptimally: a key used by three projects is entered three times
    and rotated in three places (the inherited plugin-repo store is deferred
    — see Out of scope). A project session shows which declared credentials a
    plugin requires and whether they are satisfied, so a missing key is a
    visible, named gap, never an opaque failure. Whatever store feeds a
    plugin holds only values the user placed there for plugins; it can never
    resolve ShipIt's own platform credentials — the user's GitHub identity,
    tracker tokens, or agent tokens.
24. Plugin code gets no network access of its own. A plugin **declares** the
    external hosts its services and CLIs need — so the user never has to
    reverse-engineer them from failing calls — but the declaration grants
    nothing: services and companion CLIs reach exactly what equivalent
    same-repo code could reach under the session's user-managed egress
    configuration, and a plugin declaration never widens a session's network
    reach by itself. A project session shows which declared hosts are not
    yet allowed (the same visibility req 23 gives credentials), and ShipIt
    offers an affordance to add the declared hosts to the user's egress
    allowlist — for the session or for the whole ShipIt instance — as a
    deliberate user act. Wiring a plugin that calls external APIs stays a
    known, guided onboarding step rather than a surprise or a guessing
    game.
25. The agent (or the user) in a project session can report feedback on a
    plugin — a bug, a limitation, a feature request — as an **issue on the
    plugin's own repository**, from within the session. Declaring the plugin
    is what grants the channel, and it is brokered the way declared issue
    trackers are: no tracker credential enters the session container. The
    report can carry the session's context — the running plugin commit
    (req 15), a reproduction, and a proposed fix as a diff in the issue
    body. This does not relax req 7: a project session still never pushes to
    the plugin repository.
26. A plugin can declare named **settings** that a consuming project sets in
    its `shipit.yaml` declaration — for example, the root directory inside
    the project workspace where the plugin reads and writes its durable
    output (reqs 18, 21). The plugin's declared defaults apply when a project
    sets nothing. Like the startup override (req 16), settings are
    per-project configuration, not copied definitions — they do not weaken
    req 5.
27. A plugin works as a plugin **inside its own repository too**: a session
    on the plugin repository can activate its exported plugins for testing —
    the same services, commands, skills, settings, and needs a consumer
    gets. There, the plugin is **editable**: the "checkout" is the session's
    own working tree, so edits apply live and editing stays smooth — the
    read-only rule (req 7) binds only consuming projects. Nothing, compose
    configuration included, is duplicated to make self-use work: the
    exported definitions are the single source (req 5 applied to the plugin
    repository itself). Activation there uses the same mechanism consumers
    use — the repository declares itself as a consumer — so dogfooding
    exercises exactly the path real consumers run.

## Out of scope (v1)

- MCP-style plugin declarations (the plugin repository shipping an MCP server
  the agent gets automatically in project sessions). Deferred; revisit for
  v2. The tracker-as-tool boundary exercise (planning#355, 2026-08-11) is the
  motivating example: platform-shaped integrations need capability upcalls,
  not delivered credentials. Whatever v2 decides, one boundary is permanent
  (user, 2026-08-12): an MCP server cannot present a web UI, so MCP can only
  ever complement the preview integration of req 3, never replace it.
- A declared **data-format version** (a plugin repository stating which
  version of its on-disk project data it reads and writes, with a pre-run
  mismatch report). Deferred; pinning (req 8) is the v1 mitigation.
- **Metered-spend handling** (a plugin repository declaring that a plugin
  consumes metered external resources, per-session spend visibility, and
  project-set caps). Deferred entirely; pinning (req 8) and the owner
  controlling both repositories are the v1 mitigation.
- An **inherited plugin-repo credential store** (set a shared key once on the
  plugin's own repository; consuming projects inherit it, with per-project
  override). Deferred to v2. The user's analysis (2026-08-12): both homes
  are eventually right — a shared image-generation key wants one rotation
  point, while a key to a per-project database is inherently per-project —
  so v2 likely supports both. V1 sticks to per-project copies (req 23),
  which cover all cases, suboptimally.

## Requirement provenance

Requirements 1–4 restate what the user said directly (voice messages,
2026-08-11), generalized from their concrete multi-project setup to any
projects at the user's request. Requirement 5 generalizes the user's stated
friction ("ShipIt doesn't provide a convenient way") to the many-projects case;
the "one declaration" bar is the agent's proposal. Requirement 6 is inferred
from the repositories being private today. Requirements 7–11 are the user's
answers to the structured questions of 2026-08-11. Requirements 12–16 and the
amendments to reqs 5, 7, 10, and 11 come from the first independent review of
2026-08-11 (brokered reviewer; coverage and contradiction brief). Requirement
17 restates the user's follow-up: plugins may also be companion CLIs the agent
drives. Requirements 18–20 and the amendments to reqs 5, 12, 14, and 15 come
from the second independent review of 2026-08-11 (CLI coverage, multi-repo
semantics, trust boundary). Requirements 21–22 and the amendments to reqs 7,
8, and 18 come from a fit review by the first candidate consumer — the user's
requirements tool (`nicolasalt/reward-tag`), whose claims were verified at the
source. Requirement 23, the second half of req 19, the second pinning case in
req 8, the tool-readable commit in req 15, and the deferred metered-spend item
come from the second candidate-consumer fit review — the user's image asset
pipeline (`nicolasalt/design-docs`), posted as a PR comment. Requirement 24
and req 23's platform-credential sentence come from a boundary exercise — a
child session testing whether ShipIt's own issue-tracker support could have
been built as a shared tool (analysis on planning#355). All findings were
resolved by the user on 2026-08-11 — see Resolved questions. The **plugin**
naming was decided by the user on 2026-08-11; earlier rounds used "tools",
and quoted historical material below keeps that vocabulary. The req 16
startup override and requirement 25 (feedback channel) come from the user's
doc review of 2026-08-12, as do req 22's backend-independence sentence and
requirement 26 (plugin settings) from its third round, the req 23 credential
scope reduction from its fourth, and req 24's informational host declaration
from its fifth. Requirement 27 (self-use for plugin development) restates the
user's follow-up of 2026-08-12 during the design phase.

## Open questions

(None.)

## Resolved questions

- **2026-08-13 — Where does a plugin's `install` run, and how strictly is req 19
  met?** Raised by an implementation review, which found that a first attempt at
  the container wiring let plugin `install` obtain a GitHub token: the worker's
  loopback credential broker (`/agent-ops/*`) needs no token and is reachable
  from anywhere in the session container. The same attempt also gave the
  read-only checkout a writable alias so install could write into it, and the
  agent argued in `plan.md` that req 7's read-only was "a workflow guarantee,
  not a containment boundary". Answer: **install runs in its own throwaway
  container** — reqs 7 and 19 hold **by construction**, not by convention, and
  the reinterpretation of req 7 is withdrawn. The agent offered a cheaper
  environment-scrubbing option in the shared container; the user chose the
  stronger boundary. → no requirement text changed; reqs 7 and 19 stand as
  written, and `plan.md` §1b/§2 now describe a mechanism that meets them.
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
- **2026-08-11 — Refresh of a running session** (first review, finding 1).
  Answer: **on demand plus at session start** — an explicit refresh updates
  the checkout and reloads affected services without recreating the session.
  → req 12.
- **2026-08-11 — Failure behavior** (first review, finding 6). Answer:
  **degrade, visibly** — the session opens and reports the tools as
  unavailable or stale. → req 13.
- **2026-08-11 — Number of tools repositories** (first review, finding 9).
  Answer: **multiple** (the agent recommended exactly one for v1; the user
  chose multiple). → req 14.
- **2026-08-11 — First-review clarifications** (first review, findings 3, 4,
  5, 7, 8). Answer: **apply all five** — service-definition ownership
  (→ req 5), commit/workspace boundary (→ req 7), one-time authorization
  (→ reqs 10, 11), version observability and coherence (→ req 15), service
  lifecycle parity (→ req 16).
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
- **2026-08-11 — Workspace handle** (fit review 1, finding 1 — blocking).
  Answer: **add it** — tools can address the consuming project's workspace
  through a stable, ShipIt-supplied handle. → req 21.
- **2026-08-11 — Agent instructions** (fit review 1, finding 2). Answer:
  **carry them** — a tools repo may ship skills that project sessions pick
  up, under the req 19 standing grant; no per-project copies. → req 22.
- **2026-08-11 — Data-format compatibility** (fit review 1, finding 3).
  Answer: **pin note now, defer versioning to v2** — req 8 amended with the
  pinning guidance; the version declaration is recorded under Out of scope.
- **2026-08-11 — Fit-review-1 wording amendments** (fit review 1, findings 4,
  5). Answer: **apply both** — writable location for installs and build
  output (→ req 7); stable preview origin per session, verified in the ShipIt
  code (subdomain routing `{sessionId}--{port}`), so origin-keyed browser
  storage is session-scoped (→ req 18).
- **2026-08-11 — Tool credentials** (fit review 2, finding 1). Answer:
  **tools-repo store with per-project override** — the tools repo declares
  credential names; one key serves every consumer and rotates in one place;
  sessions show satisfaction. → req 23; req 19 gains its second half.
  *(Credential home superseded 2026-08-12 — see below; the declared-names
  half stands.)*
- **2026-08-11 — Metered spend** (fit review 2, finding 2). Answer: **defer
  entirely to v2** (the agent recommended per-session spend visibility in v1;
  the user chose full deferral — pinning and single-owner repos are the v1
  mitigation). → Out of scope.
- **2026-08-11 — Cache-driven pinning and tool-readable commit** (fit review
  2, finding 3). Answer: **apply both** — second pinning case named
  (→ req 8); the running commit readable by the tool itself (→ req 15).
- **2026-08-11 — Tool network access** (tracker-as-tool boundary exercise,
  suggestion 1). Answer: **rides the session's user-managed egress
  allowlist, stated** (the agent recommended tools-declared hosts under the
  standing grant; the user chose the session allowlist). A tools declaration
  never widens network reach. → req 24.
- **2026-08-11 — Platform credentials out of the tool store**
  (tracker-as-tool boundary exercise, suggestion 2). Answer: **add it** —
  the tools-repo credential store can never resolve ShipIt's own platform
  credentials. → req 23 amended.
- **2026-08-11 — Naming: tools or plugins?** Answer: **plugins** (agent
  recommendation accepted after discussion). The name follows the declared
  unit — a package of host-integration that cannot exist outside ShipIt —
  with the recorded doctrine that a plugin packages a host-agnostic tool.
  → Naming section; vocabulary swept through all requirements; earlier
  receipts keep their historical wording.
- **2026-08-12 — Doc-review feedback** (user review of the full doc). Three
  edits: (a) the shared tools live in **separate repositories, not
  necessarily one** — context updated to match req 14's plurality; (b) the
  anti-MCP rationale corrected — the "test with fake data, then deploy"
  argument weakened once req 7 chose the read-only checkout (changes happen
  in the plugin repository either way); the standing argument, now written
  down, is that **an MCP server cannot present a web UI** — context and the
  Out-of-scope MCP bullet updated; (c) the naming doctrine softened — a
  tool's core **could** stay host-agnostic; that choice belongs to the tool
  author, and nothing in the spec requires it.
- **2026-08-12 — Service startup override** (doc review). Answer, stated
  directly by the user: a plugin declares whether its services start
  automatically, and the consuming repository can override it. → req 16
  amended.
- **2026-08-12 — Plugin feedback channel** (doc review; brainstormed).
  Answer: **an issue on the plugin's own repository**, filed from within the
  project session over the same brokered path as declared issue trackers,
  optionally carrying a repro and a proposed diff in the body. Proposal PRs
  from project sessions were considered and rejected for v1 (they would
  relax req 7). → req 25.
- **2026-08-12 — Plugin skills across agent backends** (doc review, round
  3). The user raised that plugin-shipped skills must be reachable by
  Claude, Codex, and other backends. Transcribed as the backend-independence
  sentence: plugin skills reach the agent the same way project skills do,
  whichever backend runs the session. → req 22 amended.
- **2026-08-12 — Plugin settings in shipit.yaml** (doc review, round 3).
  Stated directly by the user: plugins need per-project settings written in
  the project's `shipit.yaml` — the example given is the root directory
  where a plugin reads and writes files. → req 26.
- **2026-08-12 — Credential home revisited** (doc review, round 4). The user
  questioned the inherited plugin-repo store adopted on 2026-08-11 and chose
  to **reduce v1 to per-project copies** — the existing per-repository
  secret store, which covers every case, suboptimally. Rationale recorded:
  both homes are eventually right — some keys are inherently per-project (a
  plugin talking to a per-project database), others naturally shared (an
  image-generation key) — so v2 likely supports both. → req 23 rewritten;
  inherited store moved to Out of scope. Supersedes the credential-home half
  of the 2026-08-11 "Tool credentials" resolution; the declared-names half
  (visibility of required/missing keys) stands.
- **2026-08-12 — Self-use for plugin development.** Stated directly by the
  user: a declared plugin must also work as a plugin inside its own
  repository for testing, editable there because it is the same repository,
  with no duplicated compose configuration — editing a plugin should be
  smooth. → req 27. Follow-up answer, same day: activation in the own repo is
  by **explicit self-declaration** (the repo declares itself as a consumer;
  agent recommendation accepted) — no automatic second activation path.
- **2026-08-12 — Req 15 reconciled with req 27** (final design review,
  finding 1). Req 27's live working tree cannot correspond to one exact
  commit, so req 15 now states its own scope: its guarantees bind tracked,
  read-only checkouts, and a self-declared repository is deliberately live.
  This records the exception the user already ratified in req 27 ("editable
  because it is the same repository"); no new decision was taken.
- **2026-08-12 — Declared hosts, informational** (doc review, round 5).
  Stated directly by the user: a plugin declares the hosts it needs in its
  manifest (otherwise the user cannot know what to add), and ShipIt offers a
  UI affordance to add them to the session or instance allowlist. This
  refines, not reverses, the 2026-08-11 egress decision: the declaration
  informs and the affordance guides, but the grant remains a deliberate user
  act — a declaration still never widens network reach by itself. → req 24
  amended.
