# Deployment Architecture

ShipIt supports deploying user projects to external hosting platforms. The system uses a plugin-based architecture where deploy targets implement a common interface, and the UI is automatically generated from target metadata.

## Components

| Component | Location | Role |
|-----------|----------|------|
| `DeploymentManager` | `orchestrator/deployment-manager.ts` | Target registry, framework detection, build execution, deploy dispatch |
| `DeploymentStore` | `orchestrator/deployment-store.ts` | Credentials and deploy history persistence |
| `DeployTarget` | `orchestrator/deploy-targets/deploy-target.ts` | Interface that each target implements |
| `VercelTarget` | `orchestrator/deploy-targets/vercel.ts` | Vercel deployment via CLI |
| `CloudflareTarget` | `orchestrator/deploy-targets/cloudflare.ts` | Cloudflare Pages deployment |

## DeployTarget Interface

```typescript
interface DeployTarget {
  info: DeployTargetInfo;                          // Metadata + config fields
  prepare?(ctx: DeployContext): Promise<void>;     // Optional pre-deploy setup
  deploy(ctx: DeployContext): Promise<DeployResult>; // Execute deployment
}
```

`DeployTargetInfo` includes an `id`, `name`, and `configFields` array. Each config field describes a UI input (text, password, select) that the client renders automatically — no client changes needed when adding a new target.

`DeployContext` provides:
- `workspaceDir` — project root
- `outputDir` — build output directory
- `credentials` — config values from the UI form
- `environment` — `"production"` or `"preview"`
- `projectName` — project identifier
- `log(text)` — emit a log line (streamed to client)
- `signal` — `AbortSignal` for cancellation

## Deploy Flow

1. **Client** sends `initiate_deploy` WS message with target ID and credentials
2. **Handler** (`deploy-handlers.ts`) looks up the target and saves credentials
3. **Framework detection**: `DeploymentManager.detectFramework()` reads `package.json` to identify Next.js, Vite, CRA, or static
4. **Build**: `DeploymentManager.build()` runs the build command (e.g., `npm run build`)
5. **Deploy**: `target.deploy(ctx)` executes target-specific logic (e.g., `vercel deploy`)
6. **Events streamed to client**: `deploy_status` (phase changes), `deploy_log` (output lines), `deploy_complete` (success URL), `deploy_error` (failure)
7. **History**: deploy result saved to `DeploymentStore`

Deployments can be cancelled mid-flight via `cancel_deploy` WS message, which triggers the `AbortController`.

## Framework Detection

`DeploymentManager.detectFramework(workspaceDir)` checks `package.json` dependencies:

| Framework | Detection | Build Command | Output Dir |
|-----------|-----------|---------------|------------|
| Next.js | `next` in deps | `npm run build` | `.next` |
| Vite | `vite` in deps | `npm run build` | `dist` |
| CRA | `react-scripts` in deps | `npm run build` | `build` |
| Unknown | has `build` script | `npm run build` | `dist` |
| Static | no build script | (none) | `.` |

## Adding a New Deploy Target

1. Create `src/server/orchestrator/deploy-targets/my-target.ts` implementing `DeployTarget`
2. Define `info` with metadata and `configFields` (the UI renders these automatically)
3. Implement `deploy(ctx)` — use `ctx.log()` for streaming output, check `ctx.signal` for cancellation
4. Optionally implement `prepare(ctx)` for pre-deploy setup
5. Register in `buildApp()`: `deploymentManager.register(new MyTarget())`

The client automatically renders config fields from `info.configFields` — no frontend changes needed.
