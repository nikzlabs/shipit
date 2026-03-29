---
name: deployment-architecture
description: "ShipIt deployment architecture: auto-deploy on push via platform Git integration, GitHub Deployments API for status tracking, deployment status in PR lifecycle card. Load when working on deployment features."
user-invocable: true
---

# Deployment Architecture

ShipIt uses **automatic deployments via platform Git integration** — no manual deploy button or
ShipIt-managed build. Users connect their repo to Vercel, Cloudflare Pages, or Netlify once, and
every push triggers the platform's native deploy pipeline. Since ShipIt auto-pushes after every
Claude turn, deploys happen automatically.

## How It Works

1. User imports their GitHub repo on a hosting platform (Vercel, Cloudflare Pages, Netlify)
2. ShipIt's auto-push after Claude turns triggers the platform's deploy pipeline
3. The platform creates GitHub Deployments on each deploy
4. ShipIt's `PrStatusPoller` fetches deployment status via the GitHub GraphQL API
5. Deployment status (URLs, state) appears in the PR lifecycle card

## Components

| Component | Location | Role |
|-----------|----------|------|
| `PrStatusPoller` | `orchestrator/pr-status-poller.ts` | Polls GitHub for PR + deployment status |
| `GitHubDeploymentStatus` | `shared/types/deployment-types.ts` | Type for deployment status data |
| `PrStatusSummary.deployments` | `shared/types/github-types.ts` | Deployment data on PR status |
| `DeploymentStatusRow` | `client/components/PrLifecycleCard.tsx` | UI row showing deploy status |
| Settings "Deployments" tab | `client/components/Settings.tsx` | Setup guide with platform links |

## Deployment Status Tracking

The `PrStatusPoller` GraphQL query includes `commit.deployments(last:5)` to fetch the latest
deployments for each PR's head commit. Each deployment includes:

- **environment** — e.g. "Production", "Preview"
- **state** — pending, success, failure, error, in_progress, etc.
- **environmentUrl** — the deployed URL (preview or production)
- **creator** — the platform that created the deployment (e.g. "vercel[bot]")

This data is broadcast via SSE `pr_status` events and displayed in the PR lifecycle card's
`DeploymentStatusRow` component.

## Setup Guide

The Settings dialog has a "Deployments" tab under the "Project" section that shows:
- Links to import repos on Vercel, Cloudflare Pages, and Netlify
- A brief explanation of how auto-deploy works with ShipIt

No credentials are stored — the platform's own Git integration handles auth.

## Key Design Decisions

- **No manual deploy button** — deploys happen on push, not on click
- **No ShipIt-managed builds** — the platform runs its own build with its own env vars
- **GitHub Deployments API** — platform-agnostic status tracking (works with any platform that
  creates GitHub Deployments)
- **No new credentials** — uses the existing GitHub token from PR polling
- **PR card only** — no toasts or notifications (deploys are frequent due to auto-push)
