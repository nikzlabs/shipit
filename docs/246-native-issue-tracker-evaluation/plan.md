---
title: Native issue tracker evaluation
description: Compare a first-party ShipIt tracker with open-source services ShipIt could run behind its existing Issues surface.
---

# 246 — Native issue tracker evaluation

## Status and recommendation

This document evaluates six implementation options and one already-shipped
baseline for issue tracking that does not depend on Linear's issue allowance:

- Baseline: existing GitHub Issues integration (ShipIt does not run it)

1. Vikunja
2. Forgejo
3. Plane
4. Leantime
5. Huly
6. A first-party implementation in ShipIt

**Recommendation:** first evaluate the already-shipped GitHub adapter against a
dedicated private GitHub repository. This meets requirement 6 with no new
storage service, but its repository-bound Open/Closed model may still be too
narrow. If it is, run a short, bounded Vikunja integration spike before
committing to a first-party implementation. Vikunja is the best operational fit
among reusable self-hosted services: one container, SQLite, a REST/OpenAPI API,
and enough task features to satisfy ShipIt's normalized tracker contract. Its
principal risk is semantic: workflow states are represented by Kanban buckets.

If the spike shows that bucket-backed statuses, unattended provisioning, or
deployment scoping are brittle, build the first-party option. Do not fall back
to Plane or Huly merely to avoid writing storage code; their deployment cost is
disproportionate for a subsystem that should be invisible inside ShipIt.

This is an evaluation, not an implementation commitment. The requirements are
in [requirements.md](./requirements.md), and implementation gates are recorded
in [checklist.md](./checklist.md).

## Problem

ShipIt currently brokers Linear and GitHub Issues behind a tracker-neutral
surface. The user can list, filter, inspect, create, edit, comment on, and start
sessions from issues without leaving ShipIt. The agent uses the same abstraction
through `shipit issue`, and PR bodies drive `Refs` and `Closes` lifecycle effects.

Linear's free allowance counts issues that are completed, canceled, or otherwise
closed until Linear's own automatic archiver archives them. Linear does not
publish a supported mutation for ShipIt to archive an issue synchronously. This
makes the free allowance an upstream storage-policy constraint rather than a
status-transition bug ShipIt can fix safely. Linear's current documentation is
explicit that archiving is automatic and offers no manual archive action; an
issue can also be held back by an open parent/sub-issue, active cycle, or
unfinished project. See [Delete and archive issues](https://linear.app/docs/delete-archive-issues)
and [Issue status](https://linear.app/docs/configuring-workflows).

Moving issue storage out of Linear removes the allowance constraint in
requirement 5. Keeping that replacement outside ShipIt's public repository
satisfies the separate privacy constraint in requirement 6. Storage may be a
dedicated private GitHub repository or a ShipIt-operated service. In either
case, ShipIt remains the user surface and the agent remains the actor; an
upstream UI is only an administrative escape hatch.

## Existing ShipIt foundation

The majority of the product surface already exists:

- `Tracker` normalizes list, detail, status, priority, labels, comments,
  assignees, parent relationships, creation, editing, and undo operations.
- `TrackerIssue` supplies one data shape to the Issues list and detail view.
- The Issues UI already provides search, filters, sorting, nesting, inline field
  editing, comments, and session creation.
- `shipit issue` exposes tracker-neutral reads and brokered writes to the agent.
- PR lifecycle automation interprets `Refs <pointer>` and `Closes <pointer>`.
- Tracker credentials remain in the orchestrator rather than entering session
  containers.

Therefore an external open-source candidate is primarily a storage/API engine,
not a replacement UI. Its adapter should implement the existing contract and
let every established ShipIt path continue to work.

## Evaluation criteria

The comparison uses qualitative judgments rather than pseudo-precise weighted
scores. A previous draft assigned numeric weights, but arithmetic errors and an
omitted implementation-effort axis made its result less trustworthy than the
underlying evidence.

| Criterion | Why it matters |
|---|---|
| Operational simplicity | A bundled tracker must not materially raise ShipIt's minimum host size or failure surface. |
| Tracker-model fit | Status, priority, labels, comments, parents, and reopening should not depend on fragile conventions. |
| API quality and maturity | ShipIt needs stable, complete, automatable reads and writes. |
| Deployment scope and credential isolation | The backend must fit ShipIt's current deployment-wide tracker model without exposing credentials. |
| Maintenance and project health | ShipIt would inherit upgrades, migrations, vulnerabilities, and upstream changes. |
| License and redistribution fit | ShipIt must be able to deploy or redistribute the service while meeting its obligations. |
| Import/export and escape path | Users need a credible way in and out, especially from Linear. |
| Implementation effort and time to value | The choice is build versus reuse; integration cost must be visible. |

## Comparison summary

| Option | Operations | Model fit | API/maturity | Implementation effort | Principal tradeoff |
|---|---|---|---|---|---|
| **GitHub Issues in a private repo** | GitHub-hosted; no new ShipIt service | Partial | Already integrated | Low: support a dedicated tracker repo binding | Hosted but private; repository-bound and Open/Closed |
| **Vikunja** | Low: one container + SQLite | Good with bucket mapping | Strong, but v2 is new | Medium adapter/provisioning spike | Workflow state is Kanban membership |
| **First-party ShipIt** | Lowest runtime complexity | Exact | Internal contract | Highest build and permanent maintenance cost | ShipIt owns the tracker forever |
| **Forgejo** | Low: one container + SQLite | Partial | Mature | Medium | Runs a full Git forge for an Open/Closed tracker |
| **Plane** | High: multi-service, 4 GB minimum | Excellent | Strong | Medium integration, high operations | Full project platform as hidden infrastructure |
| **Leantime** | Medium: application + MySQL | Good | JSON-RPC; no built-in webhooks | Medium/high | More planning machinery than ShipIt needs |
| **Huly** | Very high: platform stack | Excellent | Broad but operationally coupled | High | Collaboration platform, not lightweight storage |

The implementation decision is sequential: validate a dedicated private GitHub
repository first; if its workflow model is insufficient, falsify the lightest
self-hosted reusable service (Vikunja) with a bounded spike; build first-party
only when both adapters compromise the product more than owning storage would.

Every candidate moves issue storage out of Linear and therefore avoids Linear's
issue-count allowance. For hosted GitHub this depends on GitHub's service terms;
for self-hosted and first-party options, practical capacity is deployment
storage rather than a vendor issue counter.

## Baseline — existing GitHub Issues adapter

ShipIt already implements the complete `Tracker` contract for GitHub Issues in
`src/server/orchestrator/trackers/github/adapter.ts`. It lists and reads issues,
creates issues and labels, edits fields, comments, changes Open/Closed state,
and assigns users. It has no new service, persistence, authentication, or
runtime operations, and GitHub does not document a Linear-style issue-count
allowance. It does require a safety-critical binding change: today the GitHub tracker
context is derived from the active session's code repository, whereas this
option needs deployment/project settings to name a separate private issue
repository and the GitHub token must have Issues access to it.

The binding change is safety-critical, not merely configuration. The shared
pointer parser currently retains `owner/repo` only in the display identifier and
passes the bare issue number to tracker services. Those services reconstruct
GitHub context from the session's code remote. Consequently, a cross-repository
`Closes tracker-owner/private-tracker#42` can target issue `#42` in the code
repository (or 404) instead of the named private tracker. The private-repo
option must carry the pointer's owner/repo as authoritative routing data through
reads, writes, undo, seed-time Started, and merged-PR lifecycle effects before
it is safe to enable.

This baseline is not a ShipIt-run open-source service, so it does not satisfy
requirement 2 by itself. It does satisfy requirement 6 when ShipIt binds the
adapter to a dedicated private repository rather than the public ShipIt source
repository. The remaining question is model fit, not privacy.

Its limitations are material:

- Issues belong to a repository rather than a deployment-wide workspace.
- Workflow is Open/Closed; Started/Canceled require conventions.
- Priority reads are label-derived conventions, and the adapter rejects
  priority writes because GitHub has no native issue-priority field.
- Parent/sub-issues are not available through the current normalized mapping.
- It requires the private tracker repository and issue workflow to live on
  GitHub, and introduces a cross-repository binding the current adapter does not
  yet expose.

## Option 1 — Vikunja

### What ShipIt would run

Vikunja ships its frontend and API together as a single binary/container and
supports SQLite using a persistent database directory. Its documented minimal
Docker deployment is one container plus mounted `files` and `db` paths.

ShipIt would deploy one pinned Vikunja image at the **deployment level**, never
inside each coding session. The orchestrator would hold a scoped service-account
token and communicate with Vikunja's v2 REST API. Users and agents would continue
to use ShipIt's UI and `shipit issue` broker.

### Model mapping

| ShipIt concept | Vikunja concept |
|---|---|
| ShipIt deployment backlog | One managed project or project hierarchy |
| Issue | Task |
| Backlog / Todo / Started / Done / Canceled | Named manual Kanban buckets |
| Terminal state | Done flag plus Done or Canceled bucket |
| Priority | Native task priority |
| Labels | Native labels |
| Parent/sub-issue | Parent/subtask relation |
| Comments | Native task comments |
| Assignee | Native task assignee |
| Archive | Hidden terminal task; no quota-driven archival required |

Vikunja explicitly treats Kanban buckets as workflow stages. Moving a task into
the configured done bucket marks it done; moving it back out reopens it. ShipIt
would own the canonical bucket names/IDs and map them to normalized status types.
Canceled needs a distinct terminal bucket even though the underlying task is
also done.

### Strengths

- Single deployable container and first-class SQLite path.
- Standard REST semantics and an OpenAPI 3.1 specification in API v2.
- Native priority, labels, assignees, comments, attachments, task relations,
  filtering, webhooks, and Kanban workflows.
- Community edition is described by Vikunja as fully functional; Pro gates
  administration, time tracking, and audit features rather than core task work.
- The upstream frontend remains available as a recovery/admin escape hatch.

### Risks and required proof

- Workflow state is view/bucket membership, not a first-class task status.
- API v2 only shipped in Vikunja 2.4.0 in July 2026. A new integration should
  pin and contract-test an exact release rather than treating the new API as
  mature merely because it has an OpenAPI document.
- ShipIt must prevent users or upstream migrations from deleting/renaming its
  canonical buckets without repair.
- A single service account simplifies brokering but makes per-user authorship
  and assignee identity synthetic unless ShipIt provisions Vikunja users.
- Vikunja is AGPL-licensed. Keeping it unmodified behind an API limits coupling,
  but redistribution, source availability, notices, and any modifications need
  review before shipping. This document is not legal advice.
- Vikunja's documented imports do not include Linear. ShipIt would need a
  purpose-built Linear importer or an intermediate CSV mapping.

### Sources

- [Vikunja installation](https://vikunja.io/docs/installing/)
- [Vikunja API v2](https://vikunja.io/docs/api-v2/)
- [Tasks and bucket behavior](https://vikunja.io/help/tasks/)
- [Views and Kanban workflows](https://vikunja.io/help/views/)
- [Task relations](https://vikunja.io/help/task-relations/)
- [Webhooks](https://vikunja.io/help/webhooks/)
- [Community/Pro licensing boundary](https://vikunja.io/docs/pro/)
- [Import and export](https://vikunja.io/help/import-and-export/)

## Option 2 — Forgejo

### What ShipIt would run

Forgejo is a complete Git forge whose issue tracker is reachable through its
REST API. It supports a single-container deployment and an embedded SQLite
database. ShipIt could create one internal repository per ShipIt deployment or
project and adapt Forgejo issue endpoints.

### Model mapping

Forgejo maps issues, comments, labels, milestones, and assignees directly, but
its issue lifecycle is principally Open/Closed. Backlog, Todo, Started,
Canceled, and priority would need labels or project-board conventions. Parent
issues would likewise require relationships or conventions that are less direct
than ShipIt's current Linear model.

### Strengths

- Mature, actively maintained, single-binary service with SQLite support.
- Familiar GitHub/Gitea-shaped issue API; parts of ShipIt's GitHub adapter may
  provide implementation patterns.
- Strong backup, upgrade, access-token, and repository isolation machinery.
- GPL-licensed community project with no core issue-count allowance.

### Risks

- ShipIt would operate a full Git hosting platform while using only its issue
  subsystem, duplicating GitHub integration and increasing attack surface.
- Label-encoded workflow and priority weaken filtering and make state mutations
  multi-field conventions rather than native transitions.
- Issues are repository-bound, while ShipIt's Linear view is workspace-wide.
- Forgejo's OAuth provider documentation warns that OAuth scopes are not yet
  implemented; internal service tokens should be narrowly scoped and never
  exposed to sessions.

### Sources

- [Forgejo database and SQLite support](https://forgejo.org/docs/latest/admin/installation/database-preparation/)
- [Forgejo API configuration](https://forgejo.org/docs/latest/admin/config-cheat-sheet/)
- [Forgejo issue-tracking guide](https://forgejo.org/docs/latest/user/)
- [Forgejo OAuth2 provider limitations](https://forgejo.org/docs/latest/user/oauth2-provider/)
- [Forgejo upgrade guidance](https://forgejo.org/docs/latest/admin/upgrade/)

## Option 3 — Plane

### What ShipIt would run

Plane is the closest product match to Linear: work items, custom states,
priorities, labels, comments, relations, projects, cycles, modules, APIs,
webhooks, and a documented Linear importer. ShipIt would integrate through its
REST API while leaving Plane's UI as an administrative escape hatch.

### Strengths

- Best external semantic match, requiring the least distortion in the tracker
  adapter.
- Broad REST API and webhook support.
- Existing Linear import path materially improves migration.
- Mature collaboration and workspace model.

### Risks

- Official Docker Compose guidance specifies at least 2 CPUs and 4 GB RAM, with
  8 GB recommended.
- The production architecture includes multiple application roles plus
  Postgres, Redis, and object storage concerns. Plane's all-in-one image is
  described as suitable for evaluation, not production.
- Community and commercial editions require careful feature/license review.
- ShipIt would inherit a second substantial web application and its operational
  lifecycle merely to provide an internal persistence engine.

### Sources

- [Plane Docker Compose and requirements](https://developers.plane.so/self-hosting/methods/docker-compose)
- [Plane developer docs and REST API](https://developers.plane.so/)
- [Plane architecture](https://developers.plane.so/self-hosting/plane-architecture)
- [Plane product and import documentation](https://docs.plane.so/)

## Option 4 — Leantime

### What ShipIt would run

Leantime is an open-source project-management application distributed as an
official Docker image. Its normal Docker deployment pairs the PHP application
with MySQL or MariaDB, and integration uses a JSON-RPC endpoint. It models
projects and tickets with richer planning features than ShipIt needs.

### Strengths

- Lower documented resource needs than Plane or Huly: 512 MB minimum and 1 GB
  recommended in the official FAQ.
- Official Docker image and API access.
- Mature issue/project-management concepts and a maintained upstream.

### Risks

- Requires a separate MySQL/MariaDB service for the supported default path.
- JSON-RPC is less conventional than the REST/OpenAPI contracts offered by
  Vikunja and Plane.
- Webhooks are not built in according to the official FAQ.
- The official MCP path is a paid marketplace plugin and should not be a ShipIt
  dependency; ShipIt would use the underlying API instead.
- Plugin, scheduler, mail, and upgrade operations add machinery unrelated to a
  lightweight issue backend.

### Sources

- [Leantime Docker installation](https://docs.leantime.io/installation/docker)
- [Leantime system requirements](https://docs.leantime.io/installation/system-requirements)
- [Leantime FAQ and API notes](https://docs.leantime.io/installation/frequently-asked-questions)
- [Leantime MCP plugin boundary](https://docs.leantime.io/installation/leantime-mcp)

## Option 5 — Huly

### What ShipIt would run

Huly is a broad collaboration platform spanning issue tracking, documents,
chat, notifications, and optional communications/AI services. Its issue model
can represent ShipIt's needs, but the self-hosted package is a platform stack,
not a small tracker daemon.

### Strengths

- Rich issue, project, collaboration, and relation model.
- Self-hosting is explicitly supported.
- Capable of becoming a broader collaboration backend if ShipIt deliberately
  chose that product direction later.

### Risks

- Highest operational and conceptual weight in the comparison.
- Official documentation delegates setup and maintenance details to a separate
  self-host repository and describes support as community-driven.
- Some cloud capabilities are not packaged for self-hosting, and integrations
  can require additional services or app registrations.
- Adopting Huly for issue storage would duplicate major collaboration surfaces
  while making ShipIt dependent on a complex upstream deployment.

### Sources

- [Huly self-hosting documentation](https://docs.huly.io/getting-started/self-host/)
- [Huly self-host deployment repository](https://github.com/hcengineering/huly-selfhost)

## Additional candidates screened but not shortlisted

These alternatives are worth recording so the shortlist is not mistaken for an
exhaustive market inventory:

| Candidate | Why it was not promoted to a full option |
|---|---|
| **Gitea** | Technically credible, with Docker, SQLite, an issue API, and an MIT-licensed self-hosted edition. It is the same “run a whole Git forge for an Open/Closed issue tracker” shape as Forgejo, so a second full section would duplicate the comparison. [Docker](https://docs.gitea.com/1.24/installation/install-with-docker), [API](https://docs.gitea.com/api/) |
| **Kanboard** | Lightweight and SQLite-capable, but its board/task model would require another semantic adapter assessment and it offers no clear advantage over the better-documented Vikunja spike. [Installation](https://docs.kanboard.org/v1/admin/installation/) |
| **OpenProject** | Full-featured but officially calls for 4 CPU cores, 4 GB RAM, 20 GB disk, and PostgreSQL for a small supported installation. It falls into the same heavyweight-platform rejection as Plane/Huly. [Requirements](https://www.openproject.org/docs/installation-and-operations/system-requirements/) |
| **Taiga / Redmine** | Mature project-management systems, but both broaden the operational and domain surface beyond the lightweight backend goal. Reconsider only if ShipIt expands into full project planning. |
| **git-bug-style Git storage** | Attractive because issues travel as Git objects without a service, but it couples tracker data to repository synchronization and conflict semantics. A dedicated private GitHub issue repository is simpler and already has a ShipIt adapter. |

## Option 6 — First-party ShipIt implementation

### Scope

ShipIt can implement a deliberately small tracker inside the orchestrator and
persist it in the existing deployment database. This is not a new tracker UI:
the existing Issues panel, agent broker, and lifecycle automation remain the
only normal surfaces.

The minimum useful model is:

- Deployment-scoped issues with an optional repository association. The
  [Projects design](../231-projects/plan.md) may narrow visibility, but this
  design does not invent a ShipIt user-account tenancy model.
- Monotonic public identifiers such as `SHP-123`.
- Title and Markdown description.
- Fixed normalized states: Backlog, Todo, In Progress, Done, Canceled.
- Normalized priority: urgent, high, medium, low, none.
- Labels with color.
- Parent/sub-issue relationship.
- Comments.
- Optional assignee display metadata; durable ShipIt-user identity is deferred
  until ShipIt has such an identity model.
- Created, updated, completed, canceled, and archived timestamps.

Boards, projects, cycles, estimates, custom fields, custom workflows,
notifications, email ingestion, and time tracking are explicitly outside the
lightweight implementation.

### Proposed storage

Use explicit relational tables rather than serializing the entire issue as JSON:

```text
native_issues
  id, number, repo_id?, parent_id?, title, description,
  status, priority, assignee_name?, created_at, updated_at,
  terminal_at?, archived_at?

native_issue_labels
  id, name, color, description?

native_issue_label_links
  issue_id, label_id

native_issue_comments
  id, issue_id, author_name?, author_kind, body, created_at, updated_at?
```

Foreign keys should enforce parent consistency. Issue numbers are allocated
transactionally at deployment scope; the concrete allocator belongs in an
implementation plan, not this evaluation. Internal UUIDs remain stable even if
display prefixes change.

### Adapter and pointer behavior

Add a native tracker ID such as `shipit` and implement the complete `Tracker`
contract over a `NativeIssueStore`. `isConfigured()` is always true. Native
issues should be the default sub-tab when no external tracker is configured.

A bare `ABC-123` currently resolves as Linear-shaped input. Native pointers
therefore need an unambiguous canonical form, for example:

```text
shipit:SHP-123
```

ShipIt-generated internal issue URLs can display the shorter `SHP-123`, but
agent commands, docs frontmatter, and PR bodies should accept the qualified
pointer. The shared pointer parser, `ParsedIssueRef.tracker` union,
`TrackerId`, markdown linkifier, and `extractIssueRefsFromText` must all gain
this form so session-seed recovery and PR lifecycle parsing do not silently
lose native references. Issue-write attribution also needs an explicit native
value rather than pretending the first-party store is an external workspace.

### Terminal and archive behavior

Status and archival remain distinct:

- Setting Done or Canceled records `terminal_at`.
- Terminal issues are excluded from the default working set immediately.
- A retention job may set `archived_at` after a configurable period.
- Reopening clears both `terminal_at` and `archived_at` atomically.
- Archived issues remain searchable through an explicit historical scope.

There is no issue-count quota, so archive timing becomes a UX and storage
retention choice rather than a billing workaround. This preserves recent work
without repeating Linear's allowance problem.

### Data flow

```text
Issues UI / shipit issue / PR lifecycle
                  │
          existing issue services
                  │
          NativeTracker adapter
                  │
          NativeIssueStore
                  │
       ShipIt deployment SQLite DB
```

The adapter preserves the same provenance-card and undo behavior as Linear and
GitHub. User-authored inline edits use the existing user-write services; agent
writes continue to be persisted and surfaced in chat.

### Strengths

- Exact fit for ShipIt's normalized domain and product lifecycle.
- No secondary service, service token, health check, upgrade cadence, or network
  boundary.
- Deployment scoping matches ShipIt's current tracker-binding model without
  inventing a second identity source.
- The smallest possible backup story: the ShipIt database already needs backup.
- No upstream API drift or licensing dependency.

### Risks

- ShipIt permanently owns schema migrations, search, integrity, imports,
  exports, attachment support, audit behavior, and collaboration edge cases.
- The tracker may grow feature by feature until ShipIt has recreated a sizable
  subset of Linear.
- Database coupling raises the blast radius of issue-store bugs.
- A credible export format and recovery path must ship early to avoid replacing
  vendor lock-in with ShipIt lock-in.

## Architecture for an externally managed backend

Whichever external candidate is selected, it should follow these boundaries:

### Deployment scope

The tracker is one optional service per ShipIt deployment. It is not a
`ServiceManager` workload and is never placed in a user's repository
`docker-compose.yml`; those services are session/repository workloads and follow
session lifecycle. Tracker data must outlive every session.

The deployment definition must pin an image digest or version and mount named
persistent volumes. ShipIt upgrades must not silently advance the tracker image.
Backups need to include its database and attachment volumes.

### Authentication

The orchestrator owns the backend credential. It is encrypted through ShipIt's
credential/secret machinery and never enters a session container. Agent access
continues through the brokered `shipit issue` routes.

The MVP can use one internal service account and one managed backend
workspace/project per ShipIt deployment. Comments initially show a ShipIt actor
rather than a native backend user; ShipIt's inline UI remains the authoritative
authorship surface. Any later project-level isolation should follow the
[Projects design](../231-projects/plan.md) rather than introducing user accounts
here.

### Availability

External tracker failure must not prevent ShipIt sessions, Git operations, or
the rest of the IDE from starting. The Issues panel should show a scoped
unavailable state, and mutations should fail without optimistic state becoming
permanent.

The orchestrator needs a readiness probe, bounded request timeouts, and explicit
version-compatibility checks. A circuit breaker or queue is not justified for
the spike; issue writes should return a clear retryable error.

### Upgrades and compatibility

ShipIt must pin a supported backend version, back up its persistent volumes, and
run a small API contract probe before marking it available after an upgrade.
Detailed upgrade and rollback procedures belong to the selected option's
implementation plan.

## Migration from Linear

Migration should be one-way for the first release, preserve source identifiers
and relationships, and be idempotent by Linear issue ID. It must provide a
dry-run summary and never mutate the Linear originals. Detailed field ordering
and importer mechanics belong to the selected option's implementation plan.
Continuous two-way sync is out of scope because it would make both systems
authoritative.

## Decision gates

### Gate 0 — dedicated private GitHub repository

GitHub is sufficient only if a focused adapter change demonstrates all of the
following without label conventions becoming a second hidden workflow engine:

- A full private-repo pointer round-trips through list, detail, create/edit,
  comment, undo, seed-time Started, `Refs`, and merged-PR `Closes` without ever
  falling back to the code repository. A same-numbered issue in the code repo is
  included as a wrong-target regression test.
- The private tracker repository is selected through deployment settings or the
  existing [Projects design](../231-projects/plan.md), not inferred from the
  active session remote.
- Backlog, Todo, Started, Done, and Canceled remain distinguishable and writable
  through an explicit, documented convention.
- Priority can be edited, not merely inferred from labels on reads.
- Parent/sub-issue nesting survives list, detail, edit, and session-seed flows.
- The Issues list can show the deployment/project backlog independently of the
  currently active code repository.

If any workflow requirement needs substantial emulation beyond the adapter,
Gate 0 fails and ShipIt proceeds to Gate 1. Privacy alone does not fail Gate 0:
a dedicated private repository satisfies requirement 6.

### Gate 1 — Vikunja spike

Before starting the spike, confirm that distributing/running the pinned AGPL
image is acceptable for ShipIt's deployment and distribution model. If not,
reject Vikunja without spending implementation time.

Run this gate only if Gate 0 fails on model fit or cross-repository behavior.

The spike succeeds only if all of these are demonstrated against a pinned image:

- Cold start provisions storage and a usable internal workspace without a
  browser setup wizard.
- CRUD, labels, priority, comments, and parent relations satisfy the existing
  `Tracker` contract.
- Status bucket IDs survive restart and can be repaired deterministically.
- Done, canceled, and reopen mappings round-trip without ambiguity.
- Backup/restore preserves identifiers and relationships.
- The adapter paginates through at least 1,000 seeded issues and returns the
  first 100-item page in under 500 ms at p95 in a recorded 2-vCPU/4-GB reference
  deployment, so the benchmark is repeatable even though ShipIt auto-sizes
  production sessions.
- Tracker unavailability remains scoped to the Issues surface and never blocks
  sessions or Git operations.

### Gate 2 — choose reuse or first-party

- If Gate 0 passes, use the dedicated private GitHub repository and do not run
  Gate 1.
- If Gate 1 passes without product-visible compromises, proceed with Vikunja.
- If it fails on workflow semantics, unattended bootstrap, deployment scoping,
  or operational fit, choose the first-party implementation.
- Do not select Plane/Huly unless ShipIt intentionally expands the requirement
  from “lightweight issue backend” to “full project collaboration platform.”
- Forgejo remains a fallback only if ShipIt accepts an Open/Closed issue model
  with label-backed workflow conventions.

## Rejected shortcuts

### Automatically archive Linear through undocumented GraphQL mutations

Linear documents automatic archival and does not publish a supported manual
issue archive/unarchive mutation. Depending on an internal mutation would create
an unstable integration and could violate Linear's own archive eligibility
rules. The official product documentation linked under **Problem** is
authoritative; schema-shaped claims from third-party indexes are insufficient
when Linear explicitly says manual archival is unavailable.

### Let users work primarily in the upstream tracker UI

That would undo ShipIt's inline issue work and violate the product principle
that ShipIt is the surface. The backend is replaceable infrastructure, not a
second product destination.

### Build continuous Linear synchronization in v1

Two-way sync makes both systems authoritative and adds substantially more
failure modes than either a migration or a native tracker. It is explicitly
deferred unless real migration demand proves it necessary.

## Anticipated ShipIt touchpoints

These are planning targets, not commitments until an option is selected:

- `src/server/orchestrator/trackers/tracker.ts` — preserve or minimally extend
  the normalized tracker contract.
- `src/server/orchestrator/trackers/registry.ts` — register the built-in adapter,
  thread a `NativeIssueStore` (or external client) through the registry factory
  and every service call site, and define tab/default behavior when external
  trackers are also configured.
- `src/server/shared/types/domain-types/issue.ts` — add an unambiguous native
  tracker ID and any archive/source metadata the UI genuinely needs.
- `src/server/shared/issue-ref.ts` — parse and extract qualified ShipIt pointers,
  including the separate `ParsedIssueRef.tracker` union and
  `extractIssueRefsFromText` recovery path.
- `src/server/shared/pr-issue-refs.ts` — preserve a GitHub pointer's owner/repo
  through `Refs`/`Closes` parsing instead of reducing it to a bare number.
- `src/server/orchestrator/api-routes-issues.ts` — resolve a configured private
  GitHub tracker repository rather than always deriving context from the active
  session remote.
- `src/server/orchestrator/issue-lifecycle.ts` — route seed-time and merged-PR
  effects to the pointer's configured repository, including idempotent undo and
  wrong-target regression coverage.
- `src/server/orchestrator/services/issues.ts` — keep user and agent operations
  tracker-neutral.
- `src/client/stores/issues-store.ts` and Issues components — support the new
  tracker without backend-specific branches.
- `src/server/session/agent-shim/shipit.ts` and agent issue docs — accept native
  pointers with the same commands.
- Deployment manifests and operator docs — only for an external-service option.
- `src/server/shared/database.ts` plus a new `NativeIssueStore` — only for the
  first-party option.

## Validation strategy

Regardless of selection:

- Run the existing tracker contract tests against the new adapter.
- Add integration coverage for both UI HTTP routes and agent broker routes.
- Exercise create → started → comment/edit → PR `Refs` → PR `Closes` → reopen.
- Verify undo snapshots against every supported mutation.
- Verify terminal issues disappear from the default list but remain retrievable.
- Verify identifiers survive restart, backup, restore, and migration retries.
- Verify repository/project scoping, when configured, does not leak issues
  across the intended boundary.
- Browser-test the existing list and detail surfaces with the new tracker active.

## Decision record

No implementation option has been selected. The current recommendation is to
validate a dedicated private GitHub issue repository first, then use the Vikunja
spike as a falsifiable self-hosted reuse test if GitHub's model is insufficient,
with the first-party design as the final fallback.
