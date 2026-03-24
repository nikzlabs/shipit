---
status: done
---

# Auto-Deploy on Push

Replace the manual Deploy button/modal with automatic deployments triggered by git push, leveraging
the native Git integration that Vercel and Cloudflare Pages already provide.

## Motivation

The current deploy system (`docs/012-deployment`) reimplements what hosting platforms do natively.
Users click a button, ShipIt runs `npm run build`, then spawns `vercel deploy` or
`wrangler pages deploy`. But both Vercel and Cloudflare Pages already deploy automatically when code
is pushed to a connected branch — which ShipIt already does after every Claude turn via auto-push.

**Problems with the current approach:**

1. **Redundant** — The button duplicates what the platform does on push. Users who connect their
   repo to Vercel via Vercel's dashboard get deploys for free; ShipIt's button is then confusing.
2. **Session-scoped credentials** — Deploy config is stored per-session. Users must re-enter tokens
   for every new session on the same repo.
3. **Wrong mental model** — Deploy is presented as a per-session action, but it's really a
   repo-level concern. You deploy a repo, not a session.
4. **Build duplication** — ShipIt runs `npm run build` locally before deploying. The hosting
   platform will run its own build anyway (with its own env vars, node version, etc.). The local
   build is wasted work and can diverge from production.
5. **Prominent UI for rare action** — The Deploy button sits in the header, but most deploys should
   just happen automatically.

## Design

### Core idea

Remove the explicit deploy action. Instead:

1. User connects their repo to a hosting platform once (via the platform's Git integration, not
   ShipIt)
2. ShipIt's existing auto-push after Claude turns triggers the platform's native deploy pipeline
3. ShipIt shows deploy status passively by reading it from the platform's API

### What changes

| Aspect         | Before (012)                 | After (084)                            |
| -------------- | ---------------------------- | -------------------------------------- |
| Trigger        | Manual button click          | Automatic on git push                  |
| Build          | ShipIt runs `npm run build`  | Platform runs its own build            |
| Credentials    | Per-session token entry      | Repo-level platform connection         |
| UI entry point | Header button → Deploy modal | Settings → connect guide               |
| Status display | Modal with spinner           | Passive indicator (PR card or sidebar) |
| Configuration  | ShipIt stores API tokens     | Platform's own Git integration         |

### Deploy status tracking

After removing the manual deploy, we still want to show users whether their latest push has been
deployed. Two options:

**Option A: GitHub Deployment Status API** Both Vercel and Cloudflare create GitHub Deployments when
they deploy. We already poll GitHub for CI check status (`pr-status-poller.ts`). We can extend this
to read deployment status from the same API:

- `GET /repos/{owner}/{repo}/deployments` → list deployments
- Each deployment has a `statuses` sub-resource with `state: "success" | "failure" | "pending"`
- This works for any platform that creates GitHub Deployments (Vercel, Cloudflare, Netlify, Railway,
  Render, etc.)
- No platform-specific tokens needed — just the GitHub token we already have

**Option B: Platform-specific polling** Poll Vercel/Cloudflare APIs directly for deploy status.
Requires platform tokens and per-platform implementation. Not recommended — Option A is
platform-agnostic.

**Recommendation: Option A.** It's generic, requires no new credentials, and piggybacks on existing
GitHub polling infrastructure.

### Setup UX

Replace the current deploy configuration flow with a lightweight guide:

1. In repo settings, show a "Deployments" section
2. If no GitHub Deployments are detected for the repo, show a brief guide:
   - "Connect your repo to Vercel, Cloudflare Pages, or Netlify for automatic deploys on every
     push."
   - Link to each platform's "Import Git Repository" page
3. Once deployments are detected (via GitHub API), show the latest deploy status and URL
4. No tokens to enter, no credentials to store

### Deploy status in the UI

Show deploy status alongside existing PR/CI indicators:

- **PR lifecycle card**: Add a "Deployed" row showing the latest deployment URL and status
  (success/pending/failure), similar to how CI checks are shown today
- **Session status dot**: Optionally add a deploy-pending or deploy-failed state to the consolidated
  status dot in the sidebar

### Migration path

This is a **remove-and-replace**, not a refactor. The new system shares almost no code with the old
one.

**Phase 1: Add deploy status from GitHub API**

- Extend `pr-status-poller.ts` to fetch GitHub Deployments alongside CI checks
- Add deployment status to the PR lifecycle card
- This works immediately for users who already have their repo connected to a platform

**Phase 2: Remove manual deploy**

- Remove the Deploy button from the header
- Remove `DeployModal` component
- Remove deploy-related WS messages (`initiate_deploy`, `cancel_deploy`, `deploy_status`,
  `deploy_complete`, `deploy_error`)
- Remove `DeploymentManager`, `DeploymentStore`, deploy targets, framework detection
- Remove deploy store from client
- Clean up `deploy_configs` and `deploy_history` DB tables
- Remove `api-routes-deploy.ts` HTTP routes
- Remove deploy handlers from WS dispatcher

**Phase 3: Add setup guide**

- Add "Deployments" section to repo settings
- Show connection guide when no deployments are detected
- Show latest deploy status and URL when deployments exist

Phases 1 and 2 can ship together. Phase 3 is a polish step.

## Code impact

### Files to remove entirely

- `src/server/orchestrator/deploy-targets/` (entire directory)
- `src/server/orchestrator/deployment-manager.ts`
- `src/server/orchestrator/deployment-store.ts`
- `src/server/orchestrator/ws-handlers/deploy-handlers.ts`
- `src/server/orchestrator/api-routes-deploy.ts`
- `src/server/orchestrator/services/deploy.ts`
- `src/client/components/DeployModal.tsx`
- `src/client/stores/deploy-store.ts`

### Files to modify

- `src/server/orchestrator/app-di.ts` — remove DeploymentManager, DeploymentStore init
- `src/server/orchestrator/app-lifecycle.ts` — remove deploy event wiring
- `src/server/orchestrator/api-routes.ts` — remove deploy route registration
- `src/server/shared/types/ws-client-messages.ts` — remove `initiate_deploy`, `cancel_deploy`
- `src/server/shared/types/ws-server-messages.ts` — remove `deploy_status`, `deploy_complete`,
  `deploy_error`
- `src/server/shared/types/deployment-types.ts` — simplify to just GitHub deployment status types
- `src/client/App.tsx` — remove deploy modal, deploy store usage, deploy button prop
- `src/client/AppLayout.tsx` — remove deploy button from header, remove `onDeployOpen` prop
- `src/client/components/SessionTopBar.tsx` — remove deploy menu item
- `src/client/hooks/useMessageHandler.ts` — remove deploy message handlers
- `src/server/orchestrator/pr-status-poller.ts` — extend to fetch GitHub Deployments
- `src/client/components/PrLifecycleCard.tsx` — add deployment status row

### Files to add

- `src/server/shared/types/deployment-types.ts` — (rewrite) GitHub deployment status types
- Possibly a small "deploy setup guide" component in the settings UI

## Decisions

1. **Preview deploy URLs** — Yes, show them. Vercel/Cloudflare create per-branch preview URLs that
   the GitHub Deployments API returns for free. Display both preview and production URLs in the PR
   lifecycle card.

2. **Deploy notifications** — PR card only. No toasts. Since deploys happen after every Claude turn
   via auto-push, toasts would be noisy. The PR lifecycle card is the passive, always-visible
   indicator.

3. **Migration** — Remove the manual deploy system immediately. Ship Phase 1 (status tracking) and
   Phase 2 (removal) together. No transition period — less code to maintain.

4. **First-time setup** — Deep link to platform import pages. A "Deploy with Vercel" / "Deploy with
   Cloudflare" link that opens the platform's repo import page with the repo URL pre-filled. Minimal
   friction, no credentials to store.

## Open questions

1. **Non-GitHub repos** — The GitHub Deployments API only works for GitHub-hosted repos. For
   local-only repos (no remote), we'd have no deploy status. Is this acceptable? (These users likely
   aren't deploying to Vercel/Cloudflare anyway.)

2. **Existing users** — Users who have configured deploy credentials in the current system will lose
   that config. We should show a migration notice explaining the new model.
