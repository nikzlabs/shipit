---
issue: planning#239
title: Optional automatic deployment setup
description: Connect newly created repositories to a hosting provider without leaving ShipIt's repository-creation flow.
---

# Optional automatic deployment setup

## Summary

ShipIt already auto-pushes completed agent turns and renders provider-created
GitHub Deployments in the PR lifecycle card. The missing step is the one-time
connection between a GitHub repository and a hosting provider: today Project
Settings presents primary links to Vercel, Cloudflare Pages, and Netlify and
asks the user to finish setup in another product.

Add an optional **Set up automatic deployment** step to repository creation.
After a user connects a hosting account once, ShipIt creates the provider
project, links it to the new GitHub repository, and follows the first deployment
inline. Provider OAuth/installation is the only external-tab step; configuration,
progress, errors, and deployment status stay in ShipIt.

This extends `docs/084-auto-deploy-on-push`. It does not restore a manual deploy
button, run production builds inside ShipIt, or make ShipIt the deployment
runtime.

## Goals

- Make a newly created, deployable repository automatically available at a
  public preview URL when the user opts in.
- Require provider authorization once, not once per repository.
- Keep repository creation successful even when deployment setup needs input or
  fails.
- Render setup state, actionable failures, and the resulting deployment inline.
- Reuse provider-native Git deployments and the existing GitHub Deployments
  status pipeline.
- Support the same setup flow from Project Settings for existing repositories.

## Non-goals

- A manual **Deploy** button or shell-shaped deployment action.
- ShipIt-managed production builds, artifact uploads, domains, billing, or
  provider infrastructure.
- Automatically deploying every repository without explicit opt-in.
- Guessing secret values or copying ShipIt project secrets into a provider.
- Supporting every hosting provider in the first release.
- Replacing provider-native preview and production branch semantics.

## Product decisions

### Opt-in during repository creation

`NewRepoDialog` gains a **Set up automatic deployment** toggle. It is off by
default until the user has deliberately selected a default provider in
Connections settings. Enabling it reveals:

- provider;
- provider account or team;
- a short pricing/use note;
- a collapsed advanced section for production branch, root directory, build
  command, and output directory.

The first provider is Vercel. Its option must say that the free Hobby plan is
for personal, non-commercial projects and that usage limits apply. ShipIt must
not imply that a business deployment is free.

Cloudflare Pages follows through the same provider interface. Netlify is
deferred until its repository-linking API can be supported without a fragile or
provider-dashboard-dependent flow.

### Authentication is the only link-out

If the provider is not connected, the dialog offers **Connect Vercel**. OAuth or
provider installation may open an external tab because the provider owns that
authentication surface. After the callback, ShipIt resumes the pending setup
and renders the selected account inline.

Normal configuration and status must not send the user to a provider dashboard.
An escape-hatch provider link may live in an overflow menu.

### Repository creation and deployment setup are not atomic

The GitHub repository and initial commit are created first. Provider setup runs
after the initial push because Git providers require a repository and branch to
exist before they can be linked.

A provider failure never rolls back or deletes the repository. The response and
UI distinguish:

- repository creation succeeded;
- deployment setup is still running;
- deployment setup needs authorization or configuration;
- deployment setup failed and can be retried.

This avoids reporting the entire operation as failed after the user already has
a valid GitHub repository.

### Provider-native deployment remains the trigger

ShipIt creates and configures the provider project but does not invoke a deploy
command. Connecting the project to GitHub causes the provider to build the
initial commit and future pushes. Subsequent ShipIt auto-pushes continue to be
the deployment trigger.

The provider project identifier is used for setup and recovery. Normal
deployment status continues to come from GitHub Deployments through
`PrStatusPoller`, preserving the platform-neutral read path introduced by
`docs/084-auto-deploy-on-push`.

## User flow

### Connected provider

1. The user opens **Create New Repository** and chooses a deployable template.
2. The user enables **Set up automatic deployment** and confirms the inferred
   provider settings.
3. ShipIt creates the GitHub repository, scaffolds it, commits, and pushes
   `main` using the existing template flow.
4. ShipIt records a repo-level deployment setup and asks the provider to create
   a Git-linked project.
5. The dialog closes into the repository as it does today. An inline setup card
   shows **Configuring**, followed by **First deployment pending**.
6. Existing GitHub deployment polling updates the PR lifecycle UI and the setup
   card resolves to the production or preview URL.

### Provider not connected

1. Enabling automatic deployment shows a provider connection call to action.
2. ShipIt persists the draft settings before starting OAuth.
3. The provider callback returns to the same ShipIt repository-creation flow.
4. The user selects an account/team if more than one is available, then creates
   the repository.

If OAuth is interrupted, the draft remains recoverable but no repository is
created until the user submits the form.

### Existing repository

Project Settings → Deployments uses the same setup component and state model.
The current link list becomes a connection/setup view:

- no setup: choose and connect a provider;
- configuring: show progress;
- needs input or failed: show the specific remediation and retry;
- active: show provider, linked project, production branch, and latest
  deployment;
- provider deployment detected but not ShipIt-managed: show it as
  **Connected externally** without trying to take ownership.

## Deployment setup state

Deployment setup is repository-scoped and persisted independently of sessions:

```ts
type DeploymentSetupState =
  | "awaiting_connection"
  | "queued"
  | "configuring"
  | "first_deploy_pending"
  | "active"
  | "needs_input"
  | "failed";
```

Each record contains:

- canonical repository URL;
- provider ID;
- provider account/team ID and display name;
- provider project ID and display name when created;
- production branch, root directory, build command, and output directory;
- current state and a stable, user-safe error code/message;
- timestamps and the last completed setup step.

Provider project creation uses an idempotency key derived from the repository,
provider, and account. Retries first look up an existing linked project before
creating one. This prevents duplicate provider projects after timeouts or
process restarts.

The setup operation must resume after orchestrator restart. It cannot depend on
an open WebSocket, an active session container, or the browser remaining on the
creation screen.

## Provider connection and security

Provider connections are account/workspace connections, while deployment setup
records are repository-scoped.

- Provider access and refresh tokens use the existing encrypted credential
  storage boundary and are never written into a repository, session database
  row, chat message, or agent environment.
- Store the least provider scope needed to list accounts/projects and create or
  configure a Git-linked project.
- Provider API calls run in the orchestrator, never in the session container.
- API responses and errors are untrusted external data. Normalize them before
  persistence or display and never include raw tokens, request headers, or
  provider payloads in chat history.
- Disconnecting an account prevents new setup and retries. It does not delete
  provider projects or disable their native Git integration.
- Deleting a ShipIt repository registration does not delete the GitHub
  repository or provider project.

Self-hosted installations need a configured provider OAuth application before
the connection option is enabled. The UI should report that capability
truthfully instead of presenting a dead connection button.

## Template metadata and inference

Templates should provide explicit deployment metadata:

```ts
interface TemplateDeploymentDefaults {
  providers: Array<"vercel" | "cloudflare_pages">;
  framework?: string;
  buildCommand?: string;
  outputDirectory?: string;
  rootDirectory?: string;
}
```

Explicit template metadata wins. For existing repositories, a detector may
inspect package scripts, framework configuration, and workspace metadata.
Detection returns values with a confidence level:

- **high**: prefill and allow immediate setup;
- **medium**: prefill but require confirmation;
- **low/unsupported**: explain what is missing and leave setup off.

Backend-only and empty templates are not offered automatic deployment unless a
provider adapter explicitly supports them. Environment variable names may be
detected, but values are never inferred or copied. Missing required variables
move the setup to `needs_input`.

## Server architecture

Use the existing Routes → Services → Managers split:

- HTTP routes expose provider connection status, OAuth start/callback, setup
  create/read/retry, and provider-account selection.
- A deployment setup service validates repo ownership and desired
  configuration, persists state, and schedules provider work.
- Provider adapters implement capability discovery, account listing,
  project lookup, and idempotent project creation.
- A manager owns resumable background setup work and emits repository-level
  state changes through global SSE.
- Provider OAuth and credential persistence remain separate from repository
  setup records.

Repository creation accepts an optional deployment request, but
`createRepoWithTemplate` remains responsible only for GitHub/template work. The
route creates the deployment setup after the initial push succeeds so the two
failure domains remain explicit.

Suggested shared types:

```ts
type DeploymentProviderId = "vercel" | "cloudflare_pages";

interface DeploymentSetupRequest {
  provider: DeploymentProviderId;
  accountId: string;
  productionBranch: string;
  rootDirectory?: string;
  buildCommand?: string;
  outputDirectory?: string;
}
```

SSE is transport, not persistence. Setup state must be committed before it is
broadcast, and clients rehydrate it over HTTP on reload.

## Client architecture

- `NewRepoDialog` owns the draft selection and renders a reusable deployment
  setup form.
- The repository creation response carries `repoUrl`, `sessionId` when
  available, and the persisted deployment setup summary.
- A repo-scoped store caches setup summaries and consumes global SSE updates.
- Project Settings → Deployments renders the same setup summary and remediation
  actions.
- Long-running progress appears inline. A durable transcript card is only
  appropriate if setup is also surfaced in chat; if added, it must use
  `emitChatCard` and the full persisted-card pattern rather than a bare WS
  emission.
- Provider authorization callbacks restore the pending UI route and draft; they
  do not rely on component-local state surviving navigation.

## Failure handling

Errors are categorized rather than rendered as raw provider messages:

| Category | Result |
|---|---|
| Provider not connected or token revoked | `awaiting_connection`; reconnect |
| Account/team no longer available | `needs_input`; choose another account |
| GitHub installation cannot access repo | `needs_input`; update provider installation |
| Missing/invalid build configuration | `needs_input`; edit detected settings |
| Name collision with unrelated provider project | `needs_input`; choose another project name |
| Provider rate limit or temporary outage | `failed`; show retry timing |
| Timeout after create request | Look up by repo/idempotency key before retry |
| First build fails | Setup remains linked; existing deployment status shows failure |

Repository creation success is always reported independently from these states.

## Rollout

### Phase 1 — Vercel setup for new template repositories

- provider connection capability and encrypted credentials;
- Vercel account/team discovery;
- Vercel project creation linked to GitHub;
- explicit deployment defaults on supported frontend templates;
- optional creation-dialog control;
- persisted state, recovery, and inline first-deployment progress.

### Phase 2 — existing repositories and Project Settings

- replace primary link-outs with inline setup;
- detection and confirmation for repositories not created from templates;
- retry, reconnect, and externally-connected states.

### Phase 3 — Cloudflare Pages

- implement the second provider adapter;
- validate that the GitHub installation can access the new repository;
- add provider-specific build and preview settings without leaking them into
  the common interface.

## Testing

- Unit-test template defaults and repository detection without asserting UI
  prose.
- Unit-test provider adapters with HTTP fakes, including lookup-before-create,
  token redaction, account selection, and normalized error mapping.
- Service tests cover every state transition, retry idempotency, and restart
  recovery.
- Integration tests cover repository success when provider setup fails and SSE
  rehydration after reload.
- Client tests cover the opt-in default, provider connection return, inferred
  setting confirmation, and Project Settings recovery actions.
- Browser verification covers the complete new-repository flow at desktop and
  mobile sizes.
- Existing `PrStatusPoller` deployment parsing remains the source of truth for
  deployed status and receives regression coverage for the first deployment.

## Key files

Existing touchpoints:

- `docs/084-auto-deploy-on-push/plan.md`
- `src/client/components/NewRepoDialog.tsx`
- `src/client/components/ProjectSettings.tsx`
- `src/client/components/PrLifecycleCard/indicators/DeploymentStatusRow.tsx`
- `src/server/orchestrator/api-routes-session-repos.ts`
- `src/server/orchestrator/services/templates.ts`
- `src/server/orchestrator/pr-status-poller.ts`
- `src/server/shared/types/deployment-types.ts`

Expected additions:

- provider connection routes and service;
- deployment setup routes, service, manager, and persistence;
- Vercel and Cloudflare Pages provider adapters;
- shared setup request/summary types;
- reusable client deployment setup form and repo-scoped store.

## Open questions

1. Should a user-selected default provider make the creation toggle default on,
   or should every repository require an explicit opt-in?
2. Does the existing credential store have the correct user/workspace ownership
   scope for provider OAuth on multi-user installations?
3. Which templates have sufficiently deterministic Vercel settings for Phase 1?
4. Can every supported provider reliably publish GitHub Deployments for the
   initial default-branch build, or does the setup card need a provider API
   fallback only until the first GitHub Deployment appears?
5. Should required environment variables be configured inline in Phase 1 or
   block setup with a focused `needs_input` state until a later phase?
