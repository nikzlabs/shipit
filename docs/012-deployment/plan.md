
> **Superseded by [084-auto-deploy-on-push](../084-auto-deploy-on-push/plan.md).**
> The manual deploy system described here has been removed. Deployments now happen
> automatically via platform Git integration (Vercel, Cloudflare Pages, etc.).

# Deployment Integration

Users can deploy to Vercel or Cloudflare Pages from the UI. Pluggable `DeployTarget` interface supports adding new platforms.

## Architecture

- **`DeployTarget` interface**: `info` (metadata + configFields) + `deploy(ctx)` + optional `prepare(ctx)`
- **`DeploymentManager`**: Target registry, framework auto-detection, build orchestration, deploy dispatch
- **`DeploymentStore`**: Per-session credential storage (`Record<string, string>`), deployment history, JSON persistence

## Deploy flow

1. User clicks Deploy → client sends `list_deploy_targets` + `get_deploy_config`
2. `DeployModal` shows target picker → config form → ready screen
3. User enters credentials → `deploy_configure` saves via `DeploymentStore`
4. User clicks "Deploy" → `initiate_deploy`
5. Server: auto-detect framework from `package.json`, run `npm run build`, dispatch to target
6. Progress streams to Terminal with `source: "deploy"` (cyan `[dpl]` label)
7. Success: `deploy_complete` with live URL. Failure: `deploy_error`
8. Deployment recorded in history

## Framework detection

Inspects session's `package.json`:
- Vite → `vite build`
- Next.js → `next build`
- CRA → `react-scripts build`
- Unknown → `npm run build`

## Implemented targets

| Target | CLI | Key behavior |
|--------|-----|-------------|
| `VercelTarget` | `vercel deploy --yes --prod --token=xxx` | URL from stdout |
| `CloudflareTarget` | `wrangler pages deploy` | `prepare()` creates project, URL via regex |

## Key files

- `src/server/deploy-targets/deploy-target.ts` — `DeployTarget` interface, `DeployContext`, `DeployResult`
- `src/server/deploy-targets/vercel.ts` — `VercelTarget`
- `src/server/deploy-targets/cloudflare.ts` — `CloudflareTarget`
- `src/server/deployment-manager.ts` — `DeploymentManager` class
- `src/server/deployment-store.ts` — `DeploymentStore` class
- `src/server/index.ts` — All deployment WS handlers
- `src/client/components/DeployModal.tsx` — Multi-view modal
- `src/client/App.tsx` — Deploy state, header button
