---
title: Native issue tracker evaluation
description: Compare a first-party ShipIt tracker with open-source services ShipIt could run behind its existing Issues surface.
---

# 246 — Native issue tracker evaluation

## Status and recommendation

This document evaluates six ways to give ShipIt a tracker that does not depend
on Linear's issue allowance:

1. Vikunja
2. Forgejo
3. Plane
4. Leantime
5. Huly
6. A first-party implementation in ShipIt

**Recommendation:** run a short, bounded Vikunja integration spike before
committing to a first-party implementation. Vikunja is the best operational
fit: one container, SQLite, a maintained REST/OpenAPI API, and enough task
features to satisfy ShipIt's normalized tracker contract. Its principal risk is
semantic rather than operational: workflow states are represented by Kanban
buckets, so the adapter must make that mapping reliable.

If the spike shows that bucket-backed statuses or account isolation are brittle,
build the first-party option. Do not fall back to Plane or Huly merely to avoid
writing storage code; their deployment cost is disproportionate for a subsystem
that should be invisible inside ShipIt.

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
status-transition bug ShipIt can fix safely.

A ShipIt-operated tracker removes that constraint. The tracker should remain an
implementation detail: ShipIt is still the user surface and the agent is still
the actor. A third-party UI may be retained as an administrative escape hatch,
but must not become the happy path.

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

The comparison weights the following concerns:

| Criterion | Weight | Why it matters |
|---|---:|---|
| Operational simplicity | 25% | A bundled tracker must not materially raise ShipIt's minimum host size or failure surface. |
| Tracker-model fit | 20% | Status, priority, labels, comments, parents, and reopening should not depend on fragile conventions. |
| API quality | 15% | ShipIt needs stable, complete, automatable reads and writes. |
| Authentication and tenancy | 15% | ShipIt must isolate accounts without exposing backend credentials. |
| Maintenance and project health | 10% | ShipIt would inherit upgrades, migrations, vulnerabilities, and upstream changes. |
| License and redistribution fit | 10% | ShipIt must be able to deploy or redistribute the service while meeting its obligations. |
| Import/export and escape path | 5% | Users need a credible way in and out, especially from Linear. |

Scores below are directional (`1` poor through `5` excellent), based on the
documented community/self-hosted editions available on 2026-08-02. They should
be revalidated against pinned versions before implementation.

## Comparison summary

| Option | Ops | Model | API | Tenancy | Maintenance | License | Migration | Weighted result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **Vikunja** | 5 | 3 | 5 | 3 | 4 | 3 | 3 | **4.00** |
| **First-party ShipIt** | 5 | 5 | 5 | 5 | 2 | 5 | 3 | **4.55** |
| **Forgejo** | 5 | 2 | 4 | 3 | 5 | 4 | 3 | **3.70** |
| **Plane** | 1 | 5 | 5 | 4 | 4 | 3 | 5 | **3.50** |
| **Leantime** | 3 | 3 | 3 | 3 | 3 | 3 | 2 | **2.95** |
| **Huly** | 1 | 5 | 3 | 4 | 3 | 3 | 2 | **2.95** |

The first-party option scores highest on product fit, but the score hides its
largest cost: ShipIt becomes the permanent maintainer of issue persistence and
collaboration semantics. Vikunja ranks first among reusable services and gives
the proposed spike a cheap way to test whether avoiding that ownership is real.

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
| Account workspace | Project, or a per-account project hierarchy |
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
database. ShipIt could create one internal repository per ShipIt repository or
account and adapt Forgejo issue endpoints.

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

## Option 6 — First-party ShipIt implementation

### Scope

ShipIt can implement a deliberately small tracker inside the orchestrator and
persist it in the existing deployment database. This is not a new tracker UI:
the existing Issues panel, agent broker, and lifecycle automation remain the
only normal surfaces.

The minimum useful model is:

- Account-scoped issues with an optional repository association.
- Monotonic public identifiers such as `SHP-123`.
- Title and Markdown description.
- Fixed normalized states: Backlog, Todo, In Progress, Done, Canceled.
- Normalized priority: urgent, high, medium, low, none.
- Labels with color.
- Parent/sub-issue relationship.
- Comments.
- Optional assignee identity tied to a ShipIt account.
- Created, updated, completed, canceled, and archived timestamps.

Boards, projects, cycles, estimates, custom fields, custom workflows,
notifications, email ingestion, and time tracking are explicitly outside the
lightweight implementation.

### Proposed storage

Use explicit relational tables rather than serializing the entire issue as JSON:

```text
native_issue_counters
  account_id, next_number

native_issues
  id, account_id, number, repo_id?, parent_id?, title, description,
  status, priority, assignee_account_id?, created_at, updated_at,
  terminal_at?, archived_at?

native_issue_labels
  id, account_id, name, color, description?

native_issue_label_links
  issue_id, label_id

native_issue_comments
  id, issue_id, author_account_id?, author_kind, body, created_at, updated_at?
```

Foreign keys should enforce account boundaries and parent consistency. Issue
numbers are allocated transactionally per account. Internal UUIDs remain stable
even if display prefixes change.

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
pointer. The shared pointer parser and markdown linkifier must gain this form.

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
- Account identity and permissions reuse ShipIt's source of truth.
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

The MVP can use one internal service account with one backend workspace/project
per ShipIt account. This preserves data isolation while avoiding one backend
identity per user. It means comments initially show a ShipIt actor rather than a
native backend user; ShipIt's inline UI remains the authoritative authorship
surface.

### Availability

External tracker failure must not prevent ShipIt sessions, Git operations, or
the rest of the IDE from starting. The Issues panel should show a scoped
unavailable state, and mutations should fail without optimistic state becoming
permanent.

The orchestrator needs a readiness probe, bounded request timeouts, and explicit
version-compatibility checks. A circuit breaker or queue is not justified for
the spike; issue writes should return a clear retryable error.

### Upgrades and compatibility

ShipIt owns a tested compatibility matrix from ShipIt release to pinned tracker
version. Upgrade procedure:

1. Back up tracker volumes.
2. Start the pinned new image and let its supported migration run.
3. Probe its version and critical API operations.
4. Mark the tracker available only after the contract probe passes.
5. Retain documented rollback limits; database migrations may forbid downgrade.

### No iframe as the primary UI

The upstream frontend is an administrative/recovery escape hatch only. ShipIt
must continue rendering lists, detail, edits, comments, lifecycle actions, and
errors inline. An iframe would introduce a second login, conflicting navigation,
theme/accessibility problems, cross-origin constraints, and a second interaction
model.

## Migration from Linear

Migration should be one-way for the first release. Continuous two-way sync adds
identity mapping, webhook ordering, conflict resolution, deletion semantics,
status mapping, and failure recovery—the opposite of a lightweight replacement.

The importer should:

1. Read Linear issues through the existing adapter using an explicit scope.
2. Create native/backend issues in parent-before-child order.
3. Map workflow types to the canonical five ShipIt states.
4. Preserve title, description, priority, labels, comments when available,
   assignee display metadata, and timestamps where the destination permits it.
5. Store the original Linear URL and identifier as migration metadata.
6. Be idempotent using `(source tracker, source issue id)` as the natural key.
7. Produce a dry-run report and a final created/skipped/failed summary.
8. Never delete, cancel, or archive the Linear originals automatically.

After verification, the user can disconnect Linear and choose whether to archive
the originals using Linear's supported facilities. ShipIt should not use
undocumented Linear mutations.

## Decision gates

### Gate 1 — Vikunja spike

The spike succeeds only if all of these are demonstrated against a pinned image:

- Cold start provisions storage and a usable internal workspace without a
  browser setup wizard.
- CRUD, labels, priority, comments, and parent relations satisfy the existing
  `Tracker` contract.
- Status bucket IDs survive restart and can be repaired deterministically.
- Done, canceled, and reopen mappings round-trip without ambiguity.
- Two synthetic ShipIt accounts cannot read or mutate each other's issues.
- Backup/restore preserves identifiers and relationships.
- The adapter can list at least 1,000 issues with bounded pagination and
  acceptable latency.
- License and redistribution obligations are reviewed and accepted.

### Gate 2 — choose reuse or first-party

- If Gate 1 passes without product-visible compromises, proceed with Vikunja.
- If it fails on workflow semantics, isolation, unattended bootstrap, or license
  fit, choose the first-party implementation.
- Do not select Plane/Huly unless ShipIt intentionally expands the requirement
  from “lightweight issue backend” to “full project collaboration platform.”
- Forgejo remains a fallback only if ShipIt accepts an Open/Closed issue model
  with label-backed workflow conventions.

## Rejected shortcuts

### Automatically archive Linear through undocumented GraphQL mutations

Linear documents automatic archival and does not publish a supported manual
issue archive/unarchive mutation. Depending on an internal mutation would create
an unstable integration and could violate Linear's own archive eligibility
rules.

### Treat terminal status as deletion

Deleting history would break issue links, PR lifecycle records, comments, and
auditability. Terminal issues should leave the working set without being
destroyed.

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
- `src/server/orchestrator/trackers/registry.ts` — register the built-in adapter
  and make configuration/default behavior explicit.
- `src/server/shared/types/domain-types/issue.ts` — add an unambiguous native
  tracker ID and any archive/source metadata the UI genuinely needs.
- `src/server/shared/issue-ref.ts` — parse qualified ShipIt pointers.
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
- Verify foreign-account pointers return not found without leaking existence.
- Browser-test the existing list and detail surfaces with the new tracker active.

## Decision record

No implementation option has been selected. The current recommendation is to
use the Vikunja spike as a falsifiable reuse test, with the first-party design as
the fallback when model fidelity or tenancy makes reuse more expensive than it
appears.
