# Design Doc 010: Deployment Integration (Pluggable Targets)

## Status: Proposed

## Problem

After vibe coding a project in ShipIt, there's no way to share it with the world. The user has a working preview running inside the container, but to put it on a real URL they must: open a terminal, install a deployment CLI, authenticate, figure out the right flags, run the deploy command, and parse the output for the URL. This is the opposite of frictionless.

Specific pain points:
1. **No deployment path** — ShipIt ends at "works on my machine (container)." Users must leave the IDE to deploy.
2. **CLI complexity** — Deployment CLIs (`vercel`, `wrangler`, `gcloud`, `aws`) each have dozens of flags. Getting the right combination for non-interactive, headless deployment is non-obvious.
3. **Auth friction** — OAuth flows don't work in a Docker container or browser-proxied environment. Users must figure out token-based auth on their own.
4. **No deployment history** — After deploying, there's no record of what was deployed, when, or to which URL.

## Goals

1. One-click deploy from the ShipIt UI to any registered deployment target.
2. **Pluggable `DeployTarget` interface** — adding a new platform (GCP, AWS, Netlify, etc.) means implementing one interface and registering it. No changes to the WS protocol, UI framework, or deployment manager.
3. Token-based auth with secure storage (no OAuth — it won't work in a container).
4. Real-time deployment progress streamed to the terminal panel.
5. Deployment history per session with URLs, timestamps, and commit hashes.
6. Framework auto-detection to set sensible defaults (build command, output directory).

## Non-Goals

- **Platform project management** — creating teams, managing domains, configuring CDN rules, IAM roles. Use each platform's dashboard/console for that.
- **Custom build pipelines** — ShipIt runs the project's `npm run build` (or equivalent). Complex build setups (monorepos, Docker builds, custom buildpacks) are out of scope.
- **Serverless function deployment** — Cloudflare Workers, Vercel Serverless Functions, AWS Lambda, Cloud Functions with special configuration. V1 targets static site and SPA deployment.
- **Google Cloud and AWS targets** — The `DeployTarget` interface is designed with these in mind, but V1 ships with Vercel and Cloudflare Pages only. GCP (Cloud Run / Firebase Hosting) and AWS (S3 + CloudFront / Amplify) are deferred to V2.
- **Auto-deploy on commit** — Every Claude turn auto-commits, so auto-deploying on every commit would be noisy and expensive. Deployment is always user-initiated.

## Design

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Client                                                           │
│                                                                  │
│  [Deploy button] → DeployModal                                   │
│       │               │                                          │
│       │    list_deploy_targets → render config fields dynamically │
│       │               │                                          │
│       ▼               ▼                                          │
│  deploy_configure   initiate_deploy                              │
│  (save credentials)  (trigger deploy by targetId)                │
│                          │                                       │
│  ◄── deploy_status ─────┘  (streaming phase updates)            │
│  ◄── log_entry (source:"deploy") ─┘  (build/deploy output)     │
│  ◄── deploy_complete ─────┘  (final URL + status)               │
└──────────────────────────────────────────────────────────────────┘
                              │ WebSocket
┌──────────────────────────────────────────────────────────────────┐
│ Server                                                           │
│                                                                  │
│  DeploymentManager (registry + orchestrator)                     │
│    ├── register(target: DeployTarget)                            │
│    ├── getTargets() → DeployTargetInfo[]                         │
│    ├── detectFramework(sessionDir) → FrameworkInfo               │
│    ├── build(sessionDir, buildCmd) → boolean                     │
│    └── deploy(targetId, ctx: DeployContext) → DeployResult       │
│            │                                                     │
│            ├── VercelTarget.deploy(ctx)                          │
│            ├── CloudflareTarget.deploy(ctx)                      │
│            ├── (future) GCPTarget.deploy(ctx)                    │
│            └── (future) AWSTarget.deploy(ctx)                    │
│                                                                  │
│  DeploymentStore                                                 │
│    ├── saveConfig(sessionId, targetId, credentials)              │
│    ├── recordDeployment(sessionId, record)                       │
│    └── getHistory(sessionId) → DeploymentRecord[]                │
└──────────────────────────────────────────────────────────────────┘
```

### Deployment Flow

**Happy path — first deploy to Vercel:**

1. User clicks "Deploy" in the header.
2. Client sends `list_deploy_targets`. Server responds with `deploy_targets` listing all registered targets with their `configFields`.
3. `DeployModal` opens. No Vercel credentials yet → shows config form with fields dynamically rendered from Vercel target's `configFields` (token input + link to Vercel's token creation page).
4. User pastes token. Client sends `deploy_configure` with `{ targetId: "vercel", credentials: { token: "tok_xxx" } }`.
5. Server stores credentials on disk, responds with `deploy_config_saved`.
6. Modal shows deploy options: environment (preview/production), auto-detected framework and output directory.
7. User clicks "Deploy to Production". Client sends `initiate_deploy` with `{ targetId: "vercel", environment: "production" }`.
8. Server runs `npm run build` in the session directory. Build output streams to terminal as `log_entry` with `source: "deploy"`.
9. Build succeeds. Server looks up the `"vercel"` target in the registry and calls `target.deploy(ctx)`.
10. Vercel CLI output streams to terminal via the `ctx.log()` callback. Server parses stdout for the deployment URL.
11. Deploy completes. Server sends `deploy_complete` with `{ url, targetId, environment, commitHash, durationMs }`.
12. UI shows success toast with clickable URL. Deployment recorded in history.

**Subsequent deploys** skip steps 3-5 (credentials already stored). The modal opens directly to the deploy options.

### Server Changes

#### The `DeployTarget` Interface (`src/server/deploy-targets/deploy-target.ts`)

This is the core abstraction. Each deployment platform implements this interface. The `DeploymentManager` is target-agnostic — it delegates all platform-specific behavior to targets.

```typescript
import type { ChildProcess } from "node:child_process";

// ---- Types shared across all targets ----

/** Describes a credential field the user must provide (rendered dynamically by the client). */
export interface ConfigField {
  key: string;           // "token", "accountId", "projectId", "region"
  label: string;         // "API Token", "Account ID"
  required: boolean;
  sensitive: boolean;    // true → masked in UI (password field)
  helpUrl?: string;      // link to token creation page
  helpText?: string;     // short description shown under the input
  placeholder?: string;  // e.g. "tok_xxxxx", "us-east-1"
}

/** Metadata sent to the client so the UI can render target options. */
export interface DeployTargetInfo {
  id: string;            // "vercel", "cloudflare", "gcp", "aws"
  name: string;          // "Vercel", "Cloudflare Pages", "Google Cloud Run", "AWS Amplify"
  description: string;   // one-liner shown in the target picker
  iconUrl?: string;      // optional icon for the UI
  configFields: ConfigField[];
  supportsPreview: boolean;  // can this target do preview deployments?
}

/** Context passed to deploy(). Everything the target needs. */
export interface DeployContext {
  workspaceDir: string;
  outputDir: string;                       // auto-detected or user-overridden
  credentials: Record<string, string>;     // keyed by ConfigField.key
  environment: "production" | "preview";
  projectName: string;                     // auto-generated or user-overridden
  /** Emit a log line (streamed to terminal panel). */
  log: (text: string) => void;
  /** Signal from the manager — abort was requested. */
  signal: AbortSignal;
}

export interface DeployResult {
  url: string;
  environment: "production" | "preview";
  durationMs: number;
}

/** The interface every deployment target implements. */
export interface DeployTarget {
  /** Static metadata (id, name, config fields). */
  readonly info: DeployTargetInfo;

  /**
   * Optional pre-deploy hook. Called before deploy() — use for project
   * creation, resource provisioning, etc. Idempotent (safe to call every time).
   */
  prepare?(ctx: DeployContext): Promise<void>;

  /** Run the deployment. Return the live URL on success, throw on failure. */
  deploy(ctx: DeployContext): Promise<DeployResult>;
}
```

**Why this shape:**
- `configFields` drives the UI dynamically. Adding a target with a `region` field (AWS) or `projectId` field (GCP) requires zero client code changes — the modal renders whatever fields the target declares.
- `credentials: Record<string, string>` is a flat bag keyed by `ConfigField.key`. No provider-specific typed fields like `accountId?: string`.
- `prepare()` is optional. Vercel doesn't need it (auto-creates projects). Cloudflare needs it (must pre-create Pages project). GCP/AWS will need it (ensure Cloud Run service exists, or Amplify app).
- `signal: AbortSignal` — wired from `DeploymentManager.cancel()` via `AbortController`. Targets attach it to spawned child processes.
- `log()` — replaces direct `EventEmitter` coupling. The manager wires this to broadcast `log_entry` to clients.

#### V1 Targets: `VercelTarget` and `CloudflareTarget`

##### `src/server/deploy-targets/vercel.ts`

```typescript
import { spawn } from "node:child_process";
import type { DeployTarget, DeployContext, DeployResult, DeployTargetInfo } from "./deploy-target.js";

export class VercelTarget implements DeployTarget {
  readonly info: DeployTargetInfo = {
    id: "vercel",
    name: "Vercel",
    description: "Deploy to Vercel's edge network",
    configFields: [
      {
        key: "token",
        label: "Vercel Token",
        required: true,
        sensitive: true,
        helpUrl: "https://vercel.com/account/tokens",
        helpText: "Create a token at Vercel → Account Settings → Tokens",
        placeholder: "tok_xxxxx",
      },
    ],
    supportsPreview: true,
  };

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const startTime = Date.now();
    const token = ctx.credentials.token;

    const args = ["deploy", "--yes", `--token=${token}`];
    if (ctx.environment === "production") args.push("--prod");

    return new Promise((resolve, reject) => {
      const proc = spawn("vercel", args, {
        cwd: ctx.workspaceDir,
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      // Wire abort signal
      ctx.signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });

      let stdoutBuf = "";

      proc.stdout!.on("data", (chunk) => {
        stdoutBuf += chunk.toString();
        // Vercel stdout = deployment URL only, don't log it
      });

      proc.stderr!.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          ctx.log(line);
        }
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({
            url: stdoutBuf.trim(),
            environment: ctx.environment,
            durationMs: Date.now() - startTime,
          });
        } else {
          reject(new Error(`Vercel deploy failed (exit ${code})`));
        }
      });
    });
  }
}
```

**Key Vercel CLI behavior:**
- `vercel deploy --yes` skips all interactive prompts and auto-creates the project on first deploy.
- `--token` handles auth without OAuth. Tokens created at vercel.com/account/tokens.
- **stdout** contains *only* the deployment URL (e.g. `https://my-project-abc123.vercel.app`) — easy to capture.
- **stderr** contains human-readable progress messages (build status, `Inspect:` URL, etc.).
- Vercel auto-detects frameworks (React, Next.js, Vite, etc.) and sets build command + output directory.
- `--prod` targets production; omitting it creates a preview deployment.
- First deploy with `--yes` creates a `.vercel/project.json` in the working directory with `orgId` and `projectId` — subsequent deploys reuse this.

##### `src/server/deploy-targets/cloudflare.ts`

```typescript
import { spawn } from "node:child_process";
import path from "node:path";
import type { DeployTarget, DeployContext, DeployResult, DeployTargetInfo } from "./deploy-target.js";

export class CloudflareTarget implements DeployTarget {
  readonly info: DeployTargetInfo = {
    id: "cloudflare",
    name: "Cloudflare Pages",
    description: "Deploy static assets to Cloudflare's global network",
    configFields: [
      {
        key: "token",
        label: "API Token",
        required: true,
        sensitive: true,
        helpUrl: "https://dash.cloudflare.com/profile/api-tokens",
        helpText: "Create a token with 'Cloudflare Pages: Edit' permission",
        placeholder: "xxxxx",
      },
      {
        key: "accountId",
        label: "Account ID",
        required: true,
        sensitive: false,
        helpUrl: "https://dash.cloudflare.com",
        helpText: "Found on the right sidebar of your Cloudflare dashboard",
        placeholder: "abcdef1234567890",
      },
    ],
    supportsPreview: true,
  };

  /** Ensure the Cloudflare Pages project exists. Idempotent. */
  async prepare(ctx: DeployContext): Promise<void> {
    return new Promise((resolve) => {
      const proc = spawn("wrangler", [
        "pages", "project", "create", ctx.projectName,
        "--production-branch=main",
      ], {
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: ctx.credentials.token,
          CLOUDFLARE_ACCOUNT_ID: ctx.credentials.accountId,
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Ignore exit code — project may already exist
      proc.on("close", () => resolve());
    });
  }

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    const startTime = Date.now();
    const deployDir = path.join(ctx.workspaceDir, ctx.outputDir);

    return new Promise((resolve, reject) => {
      const proc = spawn("wrangler", [
        "pages", "deploy", deployDir,
        `--project-name=${ctx.projectName}`,
        "--branch=main",
      ], {
        cwd: ctx.workspaceDir,
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: ctx.credentials.token,
          CLOUDFLARE_ACCOUNT_ID: ctx.credentials.accountId,
          FORCE_COLOR: "0",
          WRANGLER_SEND_METRICS: "false",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      ctx.signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });

      let allOutput = "";
      const handleChunk = (chunk: Buffer) => {
        const text = chunk.toString();
        allOutput += text;
        for (const line of text.split("\n").filter(Boolean)) {
          ctx.log(line);
        }
      };

      proc.stdout!.on("data", handleChunk);
      proc.stderr!.on("data", handleChunk);

      proc.on("close", (code) => {
        if (code === 0) {
          // Extract URL from mixed output
          const urlMatch = allOutput.match(/https:\/\/[a-zA-Z0-9_-]+\.[\w.-]+\.pages\.dev/);
          resolve({
            url: urlMatch?.[0] || `https://${ctx.projectName}.pages.dev`,
            environment: ctx.environment,
            durationMs: Date.now() - startTime,
          });
        } else {
          reject(new Error(`Cloudflare deploy failed (exit ${code})`));
        }
      });
    });
  }
}
```

**Key Wrangler CLI behavior:**
- `wrangler pages deploy <dir>` uploads a directory of static assets directly — no build step needed (ShipIt runs the build separately).
- Auth via `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables. OAuth (`wrangler login`) fails in proxied/container environments.
- `--project-name` is required for non-interactive mode. Without it, Wrangler prompts interactively.
- The project **must exist** before deploying non-interactively. `prepare()` handles this via `wrangler pages project create`, which is idempotent.
- **No `--json` flag on deploy.** Output is human-readable text with the URL embedded. We extract it via regex.
- `--branch=main` targets production. Any other branch creates a preview deployment.
- Deploy speed for pre-built assets is fast — typically under 30 seconds.

##### Deferred: `GCPTarget` and `AWSTarget`

These targets are designed for V2. The interface already accommodates their needs:

**Google Cloud (Cloud Run or Firebase Hosting):**
```typescript
// Sketch — NOT implemented in V1
const gcpTarget: DeployTargetInfo = {
  id: "gcp",
  name: "Google Cloud Run",
  description: "Deploy as a containerized service on Google Cloud",
  configFields: [
    { key: "projectId", label: "GCP Project ID", required: true, sensitive: false,
      helpUrl: "https://console.cloud.google.com", placeholder: "my-project-12345" },
    { key: "serviceAccountKey", label: "Service Account Key (JSON)", required: true, sensitive: true,
      helpText: "Create a service account with Cloud Run Admin role" },
    { key: "region", label: "Region", required: true, sensitive: false,
      placeholder: "us-central1" },
  ],
  supportsPreview: false,  // Cloud Run doesn't have native preview deployments
};
// deploy() would: gcloud run deploy --image=... --region=... --allow-unauthenticated
// prepare() would: ensure Cloud Run service exists, build+push Docker image to Artifact Registry
```

**AWS (Amplify or S3 + CloudFront):**
```typescript
// Sketch — NOT implemented in V1
const awsTarget: DeployTargetInfo = {
  id: "aws",
  name: "AWS Amplify",
  description: "Deploy to AWS Amplify Hosting",
  configFields: [
    { key: "accessKeyId", label: "Access Key ID", required: true, sensitive: true,
      helpUrl: "https://console.aws.amazon.com/iam/", helpText: "IAM user with Amplify permissions" },
    { key: "secretAccessKey", label: "Secret Access Key", required: true, sensitive: true },
    { key: "region", label: "AWS Region", required: true, sensitive: false,
      placeholder: "us-east-1" },
    { key: "appId", label: "Amplify App ID", required: false, sensitive: false,
      helpText: "Leave blank to auto-create" },
  ],
  supportsPreview: true,  // Amplify supports branch-based previews
};
// deploy() would: aws amplify start-deployment --app-id=... --branch-name=main
// prepare() would: ensure Amplify app exists (create if appId not provided)
```

The key point: these targets declare their `configFields`, and the client renders them automatically. No UI changes needed.

#### `DeploymentManager` class (`src/server/deployment-manager.ts`)

The manager is now a **registry + orchestrator**. It does not contain any provider-specific logic — that lives in the targets.

```typescript
import { EventEmitter } from "node:events";
import type { DeployTarget, DeployTargetInfo, DeployContext, DeployResult } from "./deploy-targets/deploy-target.js";

export interface FrameworkInfo {
  name: string;              // "vite", "next", "cra", "static", "unknown"
  buildCommand: string;      // "npm run build", "" (none needed)
  outputDirectory: string;   // "dist", "build", ".next", "out", "."
}

export class DeploymentManager extends EventEmitter {
  private targets = new Map<string, DeployTarget>();
  private abortController: AbortController | null = null;
  private _deploying = false;

  get deploying(): boolean { return this._deploying; }

  /** Register a deployment target. Called at startup. */
  register(target: DeployTarget): void {
    if (this.targets.has(target.info.id)) {
      throw new Error(`Deploy target "${target.info.id}" is already registered`);
    }
    this.targets.set(target.info.id, target);
  }

  /** Return metadata for all registered targets (sent to client for UI rendering). */
  getTargets(): DeployTargetInfo[] {
    return Array.from(this.targets.values()).map((t) => t.info);
  }

  /** Look up a target by ID. Returns undefined if not registered. */
  getTarget(targetId: string): DeployTarget | undefined {
    return this.targets.get(targetId);
  }

  /** Detect framework from package.json and project structure. */
  async detectFramework(workspaceDir: string): Promise<FrameworkInfo> {
    // (unchanged — see Framework Detection Logic section)
  }

  /** Run the project's build command. Returns true on success. */
  async build(workspaceDir: string, buildCommand: string): Promise<boolean> {
    // (unchanged — spawns child process, emits "log" events)
  }

  /**
   * Deploy to a registered target. This is the single entry point for all
   * deployments regardless of platform.
   */
  async deploy(targetId: string, ctx: Omit<DeployContext, "log" | "signal">): Promise<DeployResult> {
    const target = this.targets.get(targetId);
    if (!target) throw new Error(`Unknown deploy target: "${targetId}"`);
    if (this._deploying) throw new Error("Deployment already in progress");

    this._deploying = true;
    this.abortController = new AbortController();

    // Wire the context with log + signal
    const fullCtx: DeployContext = {
      ...ctx,
      log: (text: string) => this.emit("log", { text }),
      signal: this.abortController.signal,
    };

    try {
      this.emit("status", { phase: "deploying" });

      // Optional pre-deploy hook (project creation, etc.)
      if (target.prepare) {
        await target.prepare(fullCtx);
      }

      const result = await target.deploy(fullCtx);
      this.emit("complete", { ...result, targetId });
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit("error", { message, phase: "deploying" });
      throw err;
    } finally {
      this._deploying = false;
      this.abortController = null;
    }
  }

  /** Cancel an in-progress deployment. */
  cancel(): void {
    this.abortController?.abort();
  }
}
```

**Events emitted (unchanged):**

| Event | Payload | When |
|-------|---------|------|
| `log` | `{ text: string }` | Each line of build/deploy CLI output |
| `status` | `{ phase: "building" \| "deploying" \| "complete" \| "error" }` | Phase transitions |
| `complete` | `DeployResult & { targetId: string }` | Deployment succeeded |
| `error` | `{ message: string, phase: string }` | Build or deploy failed |

**Startup registration** (in `buildApp()`):

```typescript
import { VercelTarget } from "./deploy-targets/vercel.js";
import { CloudflareTarget } from "./deploy-targets/cloudflare.js";

const deploymentManager = deps.deploymentManager ?? (() => {
  const mgr = new DeploymentManager();
  mgr.register(new VercelTarget());
  mgr.register(new CloudflareTarget());
  // Future: mgr.register(new GCPTarget());
  // Future: mgr.register(new AWSTarget());
  return mgr;
})();
```

#### Framework Detection Logic

(Unchanged — lives on `DeploymentManager`, not on individual targets, because it's platform-agnostic.)

```typescript
async detectFramework(workspaceDir: string): Promise<FrameworkInfo> {
  const pkgPath = path.join(workspaceDir, "package.json");

  // No package.json → static site
  if (!existsSync(pkgPath)) {
    return { name: "static", buildCommand: "", outputDirectory: "." };
  }

  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Next.js
  if (deps["next"]) {
    return { name: "next", buildCommand: "npm run build", outputDirectory: ".next" };
  }

  // Vite (most ShipIt templates)
  if (deps["vite"]) {
    return { name: "vite", buildCommand: "npm run build", outputDirectory: "dist" };
  }

  // Create React App
  if (deps["react-scripts"]) {
    return { name: "cra", buildCommand: "npm run build", outputDirectory: "build" };
  }

  // Has a build script but unknown framework
  if (pkg.scripts?.build) {
    return { name: "unknown", buildCommand: "npm run build", outputDirectory: "dist" };
  }

  // No build script → treat as static
  return { name: "static", buildCommand: "", outputDirectory: "." };
}
```

#### `DeploymentStore` class (`src/server/deployment-store.ts`)

Persists deployment credentials and history per session. Credentials are stored as a generic `Record<string, string>` keyed by `ConfigField.key` — the store is target-agnostic.

```typescript
/** Stored credentials for a deploy target. Generic bag of key-value pairs. */
export interface DeployCredentials {
  targetId: string;                        // "vercel", "cloudflare", "gcp", "aws"
  credentials: Record<string, string>;     // { token: "tok_xxx" } or { token: "xxx", accountId: "yyy" }
  projectName?: string;                    // user override
}

export interface DeploymentRecord {
  id: string;                       // UUID
  targetId: string;                 // "vercel", "cloudflare", etc.
  environment: "production" | "preview";
  url: string;
  commitHash?: string;
  commitMessage?: string;
  timestamp: string;
  durationMs: number;
  status: "success" | "failed";
  error?: string;
}

export class DeploymentStore {
  private baseDir: string;   // /workspace/.shipit-deploy/

  constructor(workspaceDir: string) {
    this.baseDir = path.join(workspaceDir, ".shipit-deploy");
  }

  /** Save credentials for a target. */
  saveConfig(sessionId: string, config: DeployCredentials): void { /* ... */ }

  /** Load credentials for a target. Returns null if not configured. */
  loadConfig(sessionId: string, targetId: string): DeployCredentials | null { /* ... */ }

  /** Delete credentials for a target (disconnect). */
  deleteConfig(sessionId: string, targetId: string): void { /* ... */ }

  /** List which targets have credentials configured for a session. */
  listConfiguredTargets(sessionId: string): string[] { /* ... */ }

  /** Record a completed deployment. */
  recordDeployment(sessionId: string, record: DeploymentRecord): void { /* ... */ }

  /** Get deployment history for a session. */
  getHistory(sessionId: string): DeploymentRecord[] { /* ... */ }

  /** Delete all deployment data for a session (called on session delete). */
  deleteSession(sessionId: string): void { /* ... */ }
}
```

**Storage layout:**
```
/workspace/.shipit-deploy/
  configs/
    {sessionId}/
      vercel.json           # { targetId, credentials: { token }, projectName? }
      cloudflare.json       # { targetId, credentials: { token, accountId }, projectName? }
      gcp.json              # (future) { targetId, credentials: { projectId, serviceAccountKey, region } }
      aws.json              # (future) { targetId, credentials: { accessKeyId, secretAccessKey, region } }
  history/
    {sessionId}.json        # DeploymentRecord[]
```

**Security note:** Tokens are stored in plaintext JSON files on the container's volume. This is acceptable because (a) the container is single-tenant — only the user who owns it can access it, (b) the volume is ephemeral or user-controlled, and (c) this mirrors how deployment CLIs store their own credentials on disk. Credentials are never sent back to the client via the WebSocket protocol.

#### `index.ts` — new WS message handlers

Wire the deployment manager into the WebSocket handler. Note: handlers are **target-agnostic** — they dispatch by `targetId` string, never switch on specific providers.

```typescript
// In buildApp(), add to AppDeps:
import { VercelTarget } from "./deploy-targets/vercel.js";
import { CloudflareTarget } from "./deploy-targets/cloudflare.js";

const deploymentManager = deps.deploymentManager ?? (() => {
  const mgr = new DeploymentManager();
  mgr.register(new VercelTarget());
  mgr.register(new CloudflareTarget());
  return mgr;
})();
const deploymentStore = deps.deploymentStore ?? new DeploymentStore(WORKSPACE);

// Wire events (inside socket.on("connection")):
deploymentManager.on("log", ({ text }) => {
  broadcastLog("deploy", text);
});

deploymentManager.on("status", (status) => {
  broadcast({ type: "deploy_status", ...status });
});

deploymentManager.on("complete", (result) => {
  // Record in history
  const commitInfo = await getActiveGitManager()?.log(1);
  deploymentStore.recordDeployment(activeAppSessionId!, {
    id: crypto.randomUUID(),
    targetId: result.targetId,
    environment: result.environment,
    url: result.url,
    commitHash: commitInfo?.[0]?.hash,
    commitMessage: commitInfo?.[0]?.message,
    timestamp: new Date().toISOString(),
    durationMs: result.durationMs,
    status: "success",
  });
  broadcast({ type: "deploy_complete", url: result.url, targetId: result.targetId,
              environment: result.environment, durationMs: result.durationMs });
});

deploymentManager.on("error", (err) => {
  broadcast({ type: "deploy_error", message: err.message, phase: err.phase });
});

// Handler: list available deploy targets (for UI rendering)
if (msg.type === "list_deploy_targets") {
  send({ type: "deploy_targets", targets: deploymentManager.getTargets() });
}

// Handler: configure credentials for a target
if (msg.type === "deploy_configure") {
  const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
  const target = deploymentManager.getTarget(targetId);
  if (!target) {
    send({ type: "error", message: `Unknown deploy target: "${targetId}"` });
    return;
  }

  // Validate credentials against the target's configFields
  const credentials: Record<string, string> = {};
  for (const field of target.info.configFields) {
    const value = typeof msg.credentials?.[field.key] === "string"
      ? msg.credentials[field.key].trim() : "";
    if (field.required && !value) {
      send({ type: "error", message: `${field.label} is required` });
      return;
    }
    if (value.length > 2000) {
      send({ type: "error", message: `${field.label} is too long` });
      return;
    }
    if (value) credentials[field.key] = value;
  }

  const projectName = typeof msg.projectName === "string" ? msg.projectName.trim() : undefined;

  deploymentStore.saveConfig(activeAppSessionId!, { targetId, credentials, projectName });
  send({ type: "deploy_config_saved", targetId });
}

// Handler: initiate deployment (target-agnostic dispatch)
if (msg.type === "initiate_deploy") {
  if (!activeSessionDir) {
    send({ type: "error", message: "No active session" });
    return;
  }
  if (deploymentManager.deploying) {
    send({ type: "error", message: "Deployment already in progress" });
    return;
  }

  const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
  const target = deploymentManager.getTarget(targetId);
  if (!target) {
    send({ type: "error", message: `Unknown deploy target: "${targetId}"` });
    return;
  }

  const environment = msg.environment === "production" ? "production" : "preview";
  const config = deploymentStore.loadConfig(activeAppSessionId!, targetId);
  if (!config) {
    send({ type: "error", message: `No credentials configured for ${target.info.name}. Set up deployment first.` });
    return;
  }

  // Detect framework and build
  broadcast({ type: "deploy_status", phase: "building" });
  const framework = await deploymentManager.detectFramework(activeSessionDir);

  if (framework.buildCommand) {
    const buildOk = await deploymentManager.build(activeSessionDir, framework.buildCommand);
    if (!buildOk) {
      send({ type: "deploy_error", message: "Build failed", phase: "building" });
      return;
    }
  }

  // Deploy (target-agnostic — the manager dispatches to the right target)
  try {
    await deploymentManager.deploy(targetId, {
      workspaceDir: activeSessionDir,
      outputDir: framework.outputDirectory,
      credentials: config.credentials,
      environment,
      projectName: config.projectName || path.basename(activeSessionDir),
    });
  } catch {
    // Error already emitted via event
  }
}

// Handler: get deployment history
if (msg.type === "get_deploy_history") {
  if (!activeAppSessionId) {
    send({ type: "error", message: "No active session" });
    return;
  }
  const history = deploymentStore.getHistory(activeAppSessionId);
  send({ type: "deploy_history", deployments: history });
}

// Handler: cancel deployment
if (msg.type === "cancel_deploy") {
  deploymentManager.cancel();
}

// Handler: get deployment config status
if (msg.type === "get_deploy_config") {
  const targets = deploymentManager.getTargets();
  const configured: Record<string, { configured: boolean; projectName?: string }> = {};
  for (const t of targets) {
    const config = deploymentStore.loadConfig(activeAppSessionId!, t.id);
    configured[t.id] = config
      ? { configured: true, projectName: config.projectName }
      : { configured: false };
  }
  send({ type: "deploy_config", targets: configured });
}

// Handler: delete credentials
if (msg.type === "delete_deploy_config") {
  const targetId = typeof msg.targetId === "string" ? msg.targetId.trim() : "";
  deploymentStore.deleteConfig(activeAppSessionId!, targetId);
  send({ type: "deploy_config_saved", targetId });
}
```

### Protocol Changes

New WS message types added to `src/server/types.ts`. Note: **`targetId` is a `string`, not a union.** This means adding a new target requires zero changes to the type definitions — the protocol is already extensible.

#### Client → Server

```typescript
// ---- Deployment messages ----

export interface WsListDeployTargets {
  type: "list_deploy_targets";
}

export interface WsDeployConfigure {
  type: "deploy_configure";
  targetId: string;                          // "vercel", "cloudflare", "gcp", "aws", ...
  credentials: Record<string, string>;       // { token: "xxx" } or { token: "xxx", accountId: "yyy" }
  projectName?: string;                      // optional override
}

export interface WsInitiateDeploy {
  type: "initiate_deploy";
  targetId: string;                          // "vercel", "cloudflare", ...
  environment?: "production" | "preview";    // defaults to "preview"
}

export interface WsGetDeployHistory {
  type: "get_deploy_history";
}

export interface WsGetDeployConfig {
  type: "get_deploy_config";
}

export interface WsCancelDeploy {
  type: "cancel_deploy";
}

export interface WsDeleteDeployConfig {
  type: "delete_deploy_config";
  targetId: string;
}
```

#### Server → Client

```typescript
export interface WsDeployTargets {
  type: "deploy_targets";
  targets: DeployTargetInfo[];   // full metadata with configFields for UI rendering
}

export interface WsDeployConfigSaved {
  type: "deploy_config_saved";
  targetId: string;
}

export interface WsDeployConfig {
  type: "deploy_config";
  /** Keyed by targetId. Dynamic — reflects whatever targets are registered. */
  targets: Record<string, { configured: boolean; projectName?: string }>;
}

export interface WsDeployStatus {
  type: "deploy_status";
  phase: "building" | "deploying" | "complete" | "error";
}

export interface WsDeployComplete {
  type: "deploy_complete";
  url: string;
  targetId: string;
  environment: "production" | "preview";
  durationMs: number;
}

export interface WsDeployError {
  type: "deploy_error";
  message: string;
  phase: "building" | "deploying";
}

export interface WsDeployHistory {
  type: "deploy_history";
  deployments: DeploymentRecord[];
}
```

Terminal log source extension:

```typescript
export interface WsLogEntry {
  type: "log_entry";
  source: "stderr" | "stdout" | "server" | "preview" | "deploy";  // add "deploy"
  text: string;
  timestamp: string;
}
```

### Client Changes

#### New: `DeployModal` component (`src/client/components/DeployModal.tsx`)

Full-screen modal overlay following the `SystemPromptEditor` / `GitHubAuthOverlay` pattern. The modal renders **dynamically** based on target metadata received via `deploy_targets` — it never hardcodes provider-specific fields.

**States:**

1. **Target picker** — Shows a card for each registered target (from `deploy_targets` response). Each card shows the target name, description, and a "Configure" or "Deploy" button depending on whether credentials are saved.

2. **Config state** — User selected a target that isn't configured yet. Form fields are rendered dynamically from the target's `configFields`:
   - Each `ConfigField` → an input (type `"password"` if `sensitive`, else `"text"`)
   - `helpUrl` → clickable "Get token" link
   - `helpText` → gray subtext under the input
   - `placeholder` → input placeholder
   - "Save" button. Client sends `deploy_configure` with `{ targetId, credentials: { ... } }`.

3. **Ready state** — Target is configured. Shows:
   - Selected target name and icon
   - Auto-detected framework info (`Detected: Vite (React)`)
   - Environment selector (Production / Preview toggle — hidden if `!target.supportsPreview`)
   - Optional project name override
   - "Deploy" button
   - "Deploy History" section at the bottom (last 5 deployments with URLs, timestamps, status badges)
   - Link to switch to a different target

4. **Deploying state** — Deploy in progress. Shows:
   - Progress indicator with current phase (Building... / Deploying...)
   - Live log output (scrolling terminal-like view, fed from `log_entry` with `source: "deploy"`)
   - "Cancel" button

5. **Complete state** — Deploy succeeded. Shows:
   - Green success indicator with deployment URL (clickable, opens in new tab)
   - "Open Preview" button
   - Duration and commit info
   - "Deploy Again" and "Close" buttons

6. **Error state** — Deploy failed. Shows:
   - Red error indicator with error message
   - Build/deploy output for debugging
   - "Send to Claude" button (composes error into chat message, same pattern as preview error capture)
   - "Retry" and "Close" buttons

**Dynamic field rendering (key pattern):**

```tsx
// Renders config fields for ANY target without knowing what they are
function TargetConfigForm({ target, onSave }: { target: DeployTargetInfo; onSave: (creds: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <form onSubmit={() => onSave(values)}>
      {target.configFields.map((field) => (
        <div key={field.key}>
          <label>{field.label}{field.required && " *"}</label>
          <input
            type={field.sensitive ? "password" : "text"}
            placeholder={field.placeholder}
            value={values[field.key] || ""}
            onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
          />
          {field.helpText && <p className="text-xs text-gray-500">{field.helpText}</p>}
          {field.helpUrl && <a href={field.helpUrl} target="_blank">Get credentials</a>}
        </div>
      ))}
      <button type="submit">Save</button>
    </form>
  );
}
```

This means adding GCP or AWS as a target requires **zero changes to the client** — the modal will automatically render their `configFields` (project ID, region, access keys, etc.).

#### Header Integration

Add a "Deploy" button to the header, between the GitHub section and the System Prompt gear icon:

```tsx
<button
  onClick={() => setShowDeployModal(true)}
  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ..."
  title="Deploy your project"
>
  <RocketIcon className="w-4 h-4" />
  <span className="hidden sm:inline text-sm">Deploy</span>
</button>
```

When a deployment is in progress, the button shows an animated spinner and the current phase. When the last deployment succeeded, a small green dot indicates "deployed" status.

#### `App.tsx` State Additions

```typescript
const [showDeployModal, setShowDeployModal] = useState(false);
const [deployTargets, setDeployTargets] = useState<DeployTargetInfo[]>([]);
const [deployStatus, setDeployStatus] = useState<DeployPhase | null>(null);
const [lastDeployUrl, setLastDeployUrl] = useState<string | null>(null);
const [deployConfig, setDeployConfig] = useState<
  Record<string, { configured: boolean; projectName?: string }>
>({});
```

WS message handler additions:

```typescript
if (data.type === "deploy_targets") {
  setDeployTargets(data.targets);
}

if (data.type === "deploy_config_saved") {
  setDeployConfig(prev => ({
    ...prev,
    [data.targetId]: { configured: true },
  }));
}

if (data.type === "deploy_config") {
  setDeployConfig(data.targets);
}

if (data.type === "deploy_status") {
  setDeployStatus(data.phase);
}

if (data.type === "deploy_complete") {
  setDeployStatus(null);
  setLastDeployUrl(data.url);
}

if (data.type === "deploy_error") {
  setDeployStatus(null);
}

if (data.type === "deploy_history") {
  // Pass to DeployModal
}
```

#### Terminal Panel Integration

Deploy output appears in the Terminal tab with a new source: `"deploy"`, styled in blue (distinct from stderr red, preview orange, and server gray):

```typescript
// In TerminalPanel.tsx
const sourceColors: Record<string, string> = {
  stderr: "text-red-400",
  stdout: "text-gray-300",
  server: "text-gray-500",
  preview: "text-orange-400",
  deploy: "text-blue-400",       // new
};
```

### Dependency Injection for Testing

Add to `AppDeps`:

```typescript
export interface AppDeps {
  // ...existing fields...
  deploymentManager?: DeploymentManager;
  deploymentStore?: DeploymentStore;
}
```

#### `FakeDeployTarget` and `StubDeploymentManager` (in `test-helpers.ts`)

```typescript
/** A fake target that resolves immediately with a predictable URL. */
export class FakeDeployTarget implements DeployTarget {
  readonly info: DeployTargetInfo;
  lastCtx: DeployContext | null = null;
  shouldFail = false;
  failMessage = "deploy failed";

  constructor(id = "fake", name = "Fake Target", configFields: ConfigField[] = [
    { key: "token", label: "Token", required: true, sensitive: true },
  ]) {
    this.info = { id, name, description: "For testing", configFields, supportsPreview: true };
  }

  async deploy(ctx: DeployContext): Promise<DeployResult> {
    this.lastCtx = ctx;
    if (this.shouldFail) throw new Error(this.failMessage);
    return {
      url: `https://${this.info.id}-test.example.com`,
      environment: ctx.environment,
      durationMs: 100,
    };
  }
}

/**
 * A DeploymentManager pre-loaded with a FakeDeployTarget.
 * Tests can access the fake target to inspect calls and control behavior.
 */
export function createStubDeploymentManager(): {
  manager: DeploymentManager;
  fakeTarget: FakeDeployTarget;
} {
  const manager = new DeploymentManager();
  const fakeTarget = new FakeDeployTarget();
  manager.register(fakeTarget);
  return { manager, fakeTarget };
}
```

This lets integration tests verify the full flow (WS → handler → manager → target → events → WS response) without spawning real CLI processes. Tests can also register multiple `FakeDeployTarget` instances with different IDs to test the target-picker UI and multi-target config.

### Edge Cases

1. **No build script** — If `package.json` has no `scripts.build`, skip the build step and deploy the directory as-is (static site).

2. **Build failure** — Build errors stream to terminal. Server sends `deploy_error` with `phase: "building"`. The "Send to Claude" button lets users ask Claude to fix build errors before retrying.

3. **Missing node_modules** — If `node_modules` doesn't exist, `npm run build` will fail. The build step should detect this and run `npm install` first (or tell the user to install dependencies).

4. **Deploy while deploying** — Reject with error. Only one deployment can run at a time per server (same model as `ClaudeProcess`).

5. **Deploy during Claude turn** — Allowed. Deployment runs as a separate child process. The session directory may be changing while deploying — this is a race condition. Mitigation: deploy uses the committed state (git HEAD), not uncommitted working directory. **V1 simplification:** warn the user if Claude is active but don't block. A full solution (deploy from a specific commit) is a future enhancement.

6. **Token expiration** — Vercel tokens expire after 10 days of inactivity. Cloudflare tokens can be revoked. If the CLI returns an auth error, surface it clearly and prompt the user to re-enter a token.

7. **Cloudflare project creation race** — `ensureCloudflareProject` runs before every deploy. If the project already exists, the command fails harmlessly. If two deploys run concurrently (different clients), both might try to create — also harmless since only one succeeds and the other sees "already exists."

8. **Large output directories** — Cloudflare Pages has a 20,000 file limit and 25MB per file. Vercel has a 32MB total limit for serverless functions. Surface CLI error output clearly.

9. **Session delete** — `deploymentStore.deleteSession()` is called alongside chat history and workspace dir cleanup. Removes configs and history for that session.

10. **No internet in container** — Both CLIs will fail with network errors. Surface the error clearly. The user needs to ensure the container has outbound internet access.

### Target Comparison

| Concern | Vercel (V1) | Cloudflare Pages (V1) | GCP Cloud Run (V2) | AWS Amplify (V2) |
|---------|------------|----------------------|--------------------|--------------------|
| **Config fields** | `token` | `token`, `accountId` | `projectId`, `serviceAccountKey`, `region` | `accessKeyId`, `secretAccessKey`, `region`, `appId?` |
| **CLI** | `vercel` | `wrangler` | `gcloud` | `aws amplify` |
| **Project auto-create** | Yes (`--yes`) | No — needs `prepare()` | No — needs `prepare()` | Optional (`appId` blank → create) |
| **Build step** | Remote (Vercel builds) | Local (we build, wrangler uploads) | Local (build + Docker) | Remote (Amplify builds) |
| **URL extraction** | stdout = URL only | Regex from mixed stdout | JSON output (`gcloud run deploy --format=json`) | JSON output (`aws amplify`) |
| **Deploy speed** | 30-90s | < 30s | 60-180s (container build) | 60-120s |
| **Preview support** | Yes (`--prod` vs default) | Yes (`--branch` != main) | No (not native) | Yes (branch-based) |

**Design implication:** The `DeployTarget` interface handles all these differences naturally:
- **Config variation** → each target declares its own `configFields`
- **Project creation** → `prepare()` is optional, only Cloudflare/GCP/AWS implement it
- **URL extraction** → each `deploy()` method handles its own CLI output parsing
- **Preview support** → `supportsPreview` flag controls whether the environment toggle appears in the UI

### File Layout

| File | Change |
|------|--------|
| `src/server/deploy-targets/deploy-target.ts` | New — `DeployTarget` interface, `DeployContext`, `DeployResult`, `ConfigField`, `DeployTargetInfo` |
| `src/server/deploy-targets/vercel.ts` | New — `VercelTarget` implementation |
| `src/server/deploy-targets/vercel.test.ts` | New — unit tests (mocked `spawn`) |
| `src/server/deploy-targets/cloudflare.ts` | New — `CloudflareTarget` implementation |
| `src/server/deploy-targets/cloudflare.test.ts` | New — unit tests (mocked `spawn`) |
| `src/server/deployment-manager.ts` | New — `DeploymentManager` registry + orchestrator |
| `src/server/deployment-manager.test.ts` | New — unit tests for framework detection, build, target dispatch |
| `src/server/deployment-store.ts` | New — `DeploymentStore` class for credentials + history |
| `src/server/deployment-store.test.ts` | New — unit tests for config CRUD, history, session cleanup |
| `src/server/types.ts` | Add deployment WS message types, extend `WsLogEntry` source, extend unions |
| `src/server/index.ts` | Add deployment WS handlers, register targets, wire events, add to `AppDeps` |
| `src/client/components/DeployModal.tsx` | New — dynamic target picker + config form + deploy UI |
| `src/client/components/DeployModal.test.tsx` | New — component tests |
| `src/client/App.tsx` | Add deploy state, WS handlers, header button, modal rendering |
| `src/server/integration_tests/deployment.test.ts` | New — integration tests for deploy flow |
| `src/server/integration_tests/test-helpers.ts` | Add `FakeDeployTarget`, `createStubDeploymentManager` |

### Quality Checklist

- [ ] Input validation: `deploy_configure` validates credentials against `configFields` (required fields non-empty, max 2000 chars). `initiate_deploy` validates `targetId` exists in registry. Reject if no active session.
- [ ] Component tests: `DeployModal` — dynamic config form (renders fields from `configFields`, validates required), target picker, deploy trigger (env selection, deploy button), deploying state (progress, cancel), complete state (URL display, open link), error state (error message, Send to Claude). Framework detection display.
- [ ] Integration tests: Configure credentials → initiate deploy → verify status + complete messages. Error paths: unknown target, missing credentials, no active session, deploy while deploying. History retrieval. Multi-target config.
- [ ] Unit tests for each `DeployTarget`: mock `spawn`, verify CLI args, test URL extraction, test `prepare()` idempotency.
- [ ] Edge cases: No package.json (static site), no build script, build failure, token expiration, cancel during deploy, session delete clears deploy data.
- [ ] Terminal integration: Deploy logs appear with `source: "deploy"` and blue styling.
- [ ] Security: Credentials stored on disk only, never sent back to client via WS. Path traversal guard on deploy directory.

### Future Enhancements

- **GCP Cloud Run target** — Implement `GCPTarget` with `gcloud run deploy`. Requires Docker build step in `prepare()`.
- **AWS Amplify target** — Implement `AWSTarget` with `aws amplify` CLI. Handle app auto-creation.
- **Deploy from specific commit** — Build and deploy a pinned git commit rather than the current working directory, avoiding race conditions with in-progress Claude turns.
- **Custom build commands** — Let users override the auto-detected build command and output directory in the deploy modal.
- **Deploy previews in chat** — When Claude makes changes, show a "Deploy preview" button inline that creates a preview deployment.
- **Netlify, Fly.io, Railway** — Implement as additional `DeployTarget` classes and register them.
- **Deploy status polling** — After deploy, periodically check the deployment status (especially for Vercel, which builds remotely) and update the UI.
- **Deployment rollback** — Re-deploy a previous deployment by commit hash.
- **Environment variables UI** — Extend `DeployContext` with env vars. Each target maps them to its CLI flags (`-e`, `--var`, `--set-env-vars`).
- **Custom domains** — Display and manage custom domains assigned to deployments.
- **Target-specific validation** — Optional `validateCredentials()` method on `DeployTarget` to verify tokens before saving (e.g. hit the Vercel API to check if the token is valid).
