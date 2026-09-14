---
name: deployment-architecture
description: "ShipIt deployment architecture: auto-deploy on push via platform Git integration, GitHub Deployments API for status tracking, deployment status in PR lifecycle card. Load when working on deployment features."
user-invocable: true
---

# Deployment Architecture

ShipIt uses **automatic deployments via platform Git integration** — no manual deploy button or
ShipIt-managed build. Users connect their repo to Vercel, Cloudflare Pages, or Netlify once, and
every push triggers the platform's native deploy pipeline. Since ShipIt auto-pushes after every
agent turn, deploys happen automatically.

## How It Works

1. User imports their GitHub repo on a hosting platform (Vercel, Cloudflare Pages, Netlify)
2. ShipIt's auto-push after agent turns triggers the platform's deploy pipeline
3. The platform creates GitHub Deployments on each deploy
4. ShipIt's `PrStatusPoller` fetches deployment status via the GitHub GraphQL API
5. Deployment status (URLs, state) appears in the PR lifecycle card

## Components

| Component | Location | Role |
|-----------|----------|------|
| `PrStatusPoller` | `src/server/orchestrator/pr-status-poller.ts` | Polls GitHub for PR + deployment status |
| GraphQL selection + `mapDeploymentState` | `src/server/orchestrator/pr-status-parser.ts` | The `deployments` query fields and the GitHub-state → ShipIt-state mapping |
| `GitHubDeploymentStatus` | `src/server/shared/types/deployment-types.ts` | Type for deployment status data |
| `PrStatusSummary.deployments` | `src/server/shared/types/github-types.ts` | Deployment data on PR status |
| `DeploymentStatusRow` | `src/client/components/PrLifecycleCard/indicators/DeploymentStatusRow.tsx` | UI row showing deploy status, rendered from `phases/OpenPhase.tsx` |
| PR tab Status section | `src/client/components/pr-detail/PrStatusSection.tsx` | The second render site — same rows, without the "via" attribution |
| Project Settings "Deployments" tab | `src/client/components/ProjectSettings.tsx` | Setup guide with platform links |

## Deployment Status Tracking

The PR status GraphQL selection includes `commit.deployments(last: 3)` on the PR's head commit —
so only the **three most recent** deployments of that commit are ever fetched. Each deployment
includes:

- **environment** — e.g. "Production", "Preview"
- **latestStatus.state** — normalized by `mapDeploymentState`: `SUCCESS`/`ACTIVE` → success,
  `FAILURE` → failure, `ERROR` → error, `INACTIVE`/`DESTROYED`/`ABANDONED` → inactive,
  `IN_PROGRESS` → in_progress, `QUEUED`/`WAITING` → queued, `PENDING` and anything unrecognized
  → pending
- **latestStatus.environmentUrl** — the deployed URL (preview or production), or `null`
- **createdAt**
- **creator.login** — the platform that created the deployment (e.g. "vercel[bot]"). Recorded
  only; **nothing filters on it**, so a repo's own GitHub Actions workflow renders identically

This data is broadcast via SSE `pr_status` events and displayed in both render sites above.

## Setup Guide

The per-repo **Project Settings → Deployments** tab shows:
- Links to import repos on Vercel, Cloudflare Pages, and Netlify
- A brief explanation of how auto-deploy works with ShipIt

That tab opens from a repository group's overflow menu in the sidebar, so it exists per repository
and a sandbox session has no such menu. No credentials are stored — the platform's own Git
integration handles auth.

## Key Design Decisions

- **No manual deploy button** — deploys happen on push, not on click
- **No ShipIt-managed builds** — the platform runs its own build with its own env vars
- **GitHub Deployments API** — platform-agnostic status tracking (works with any platform that
  creates GitHub Deployments)
- **No new credentials** — uses the existing GitHub token from PR polling
- **Inline on the PR only** — the lifecycle card and the PR tab, no toasts or notifications
  (deploys are frequent due to auto-push)

## Shipped docs to keep in step

Changing anything above means changing the material baked into session containers:

- `src/server/shipit-docs/deployment.md` — the agent's operating manual: the Actions log reads,
  the one permitted `gh run rerun` and its scope, polling behaviour
- `src/server/shipit-docs/wiki/deploying.md` — the product-facing page the agent answers a
  *user's* "can ShipIt deploy?" from
