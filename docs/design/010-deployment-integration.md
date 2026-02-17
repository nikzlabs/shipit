# Design Doc 010: Deployment Integration — Vercel & Cloudflare Pages

## Status: Proposed

## Problem

After vibe coding a project in ShipIt, there's no way to share it with the world. The user has a working preview running inside the container, but to put it on a real URL they must: open a terminal, install a deployment CLI, authenticate, figure out the right flags, run the deploy command, and parse the output for the URL. This is the opposite of frictionless.

Specific pain points:
1. **No deployment path** — ShipIt ends at "works on my machine (container)." Users must leave the IDE to deploy.
2. **CLI complexity** — Both `vercel` and `wrangler` CLIs have dozens of flags. Getting the right combination for non-interactive, headless deployment is non-obvious.
3. **Auth friction** — OAuth flows (Vercel `login`, Wrangler `login`) don't work in a Docker container or browser-proxied environment. Users must figure out token-based auth on their own.
4. **No deployment history** — After deploying, there's no record of what was deployed, when, or to which URL.

## Goals

1. One-click deploy to Vercel or Cloudflare Pages from the ShipIt UI.
2. Token-based auth with secure storage (no OAuth — it won't work in a container).
3. Real-time deployment progress streamed to the terminal panel.
4. Deployment history per session with URLs, timestamps, and commit hashes.
5. Framework auto-detection to set sensible defaults (build command, output directory).

## Non-Goals

- **Vercel/Cloudflare project management** — creating teams, managing domains, configuring CDN rules. Use their dashboards for that.
- **Custom build pipelines** — ShipIt runs the project's `npm run build` (or equivalent). Complex build setups (monorepos, Docker builds, custom buildpacks) are out of scope.
- **Serverless function deployment** — Cloudflare Workers (as opposed to Pages) and Vercel Serverless Functions that require special configuration. V1 targets static site and SPA deployment.
- **Other deployment targets** — Netlify, AWS, Fly.io, Railway, etc. The architecture is extensible, but V1 ships with Vercel and Cloudflare only.
- **Auto-deploy on commit** — Every Claude turn auto-commits, so auto-deploying on every commit would be noisy and expensive. Deployment is always user-initiated.

## Design

### Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ Client                                                           │
│                                                                  │
│  [Deploy button] → DeployModal → configure target/env            │
│       │                              │                           │
│       ▼                              ▼                           │
│  deploy_configure   OR          initiate_deploy                  │
│  (save token)                   (trigger deploy)                 │
│                                      │                           │
│  ◄── deploy_status ─────────────────┘  (streaming updates)      │
│  ◄── log_entry (source:"deploy") ───┘  (build/deploy output)    │
│  ◄── deploy_complete ───────────────┘  (final URL + status)     │
└──────────────────────────────────────────────────────────────────┘
                              │ WebSocket
┌──────────────────────────────────────────────────────────────────┐
│ Server                                                           │
│                                                                  │
│  DeploymentManager                                               │
│    ├── detectFramework(sessionDir) → { buildCmd, outputDir }     │
│    ├── build(sessionDir) → spawn npm run build                   │
│    ├── deployVercel(sessionDir, token, opts) → spawn vercel CLI  │
│    └── deployCloudflare(sessionDir, token, opts) → spawn wrangler│
│                                                                  │
│  DeploymentStore                                                 │
│    ├── saveConfig(sessionId, config) → token + target prefs      │
│    ├── recordDeployment(sessionId, record) → deployment history  │
│    └── getHistory(sessionId) → DeploymentRecord[]                │
└──────────────────────────────────────────────────────────────────┘
```

### Deployment Flow

**Happy path — first deploy to Vercel:**

1. User clicks "Deploy" in the header.
2. `DeployModal` opens. No Vercel token yet → shows token input form with link to Vercel's token creation page.
3. User pastes token. Client sends `deploy_configure` with `{ provider: "vercel", token: "tok_xxx" }`.
4. Server validates token (quick API call), stores it encrypted on disk, responds with `deploy_config_saved`.
5. Modal shows deploy options: environment (preview/production), auto-detected framework and output directory.
6. User clicks "Deploy to Production". Client sends `initiate_deploy`.
7. Server runs `npm run build` in the session directory. Build output streams to terminal as `log_entry` with `source: "deploy"`.
8. Build succeeds. Server runs `vercel deploy --yes --prod --token=xxx` with `cwd` set to session directory.
9. Vercel CLI output streams to terminal. Server parses stdout for the deployment URL.
10. Deploy completes. Server sends `deploy_complete` with `{ url, provider, environment, commitHash, duration }`.
11. UI shows success toast with clickable URL. Deployment recorded in history.

**Subsequent deploys** skip steps 2-4 (token already stored). The modal opens directly to the deploy options.

### Server Changes

#### New: `DeploymentManager` class (`src/server/deployment-manager.ts`)

Extends `EventEmitter`, following the `ViteManager` pattern. Manages the build + deploy lifecycle as child processes.

```typescript
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

export interface FrameworkInfo {
  name: string;              // "vite", "next", "cra", "static", "unknown"
  buildCommand: string;      // "npm run build", "" (none needed)
  outputDirectory: string;   // "dist", "build", ".next", "out", "."
}

export interface DeployOptions {
  provider: "vercel" | "cloudflare";
  environment: "production" | "preview";
  projectName?: string;      // override auto-generated project name
}

export interface DeployResult {
  url: string;
  provider: "vercel" | "cloudflare";
  environment: "production" | "preview";
  duration: number;          // ms
}

export class DeploymentManager extends EventEmitter {
  private activeProcess: ChildProcess | null = null;
  private _deploying = false;

  get deploying(): boolean { return this._deploying; }

  /** Detect framework from package.json and project structure. */
  async detectFramework(workspaceDir: string): Promise<FrameworkInfo> { /* ... */ }

  /** Run the project's build command. Returns true on success. */
  async build(workspaceDir: string, buildCommand: string): Promise<boolean> { /* ... */ }

  /** Deploy to Vercel via CLI. */
  async deployVercel(
    workspaceDir: string,
    token: string,
    environment: "production" | "preview",
    projectName?: string,
  ): Promise<DeployResult> { /* ... */ }

  /** Deploy to Cloudflare Pages via wrangler CLI. */
  async deployCloudflare(
    workspaceDir: string,
    token: string,
    accountId: string,
    outputDir: string,
    projectName?: string,
  ): Promise<DeployResult> { /* ... */ }

  /** Cancel an in-progress deployment. */
  cancel(): void { /* ... */ }
}
```

**Events emitted:**

| Event | Payload | When |
|-------|---------|------|
| `log` | `{ text: string }` | Each line of build/deploy CLI output |
| `status` | `{ phase: "building" \| "deploying" \| "complete" \| "error" }` | Phase transitions |
| `complete` | `DeployResult` | Deployment succeeded |
| `error` | `{ message: string, phase: string }` | Build or deploy failed |

#### Framework Detection Logic

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

#### Vercel Deploy Implementation

```typescript
async deployVercel(
  workspaceDir: string,
  token: string,
  environment: "production" | "preview",
  projectName?: string,
): Promise<DeployResult> {
  this._deploying = true;
  const startTime = Date.now();

  const args = ["deploy", "--yes", `--token=${token}`];
  if (environment === "production") args.push("--prod");
  if (projectName) args.push(`--scope=${projectName}`); // TODO: may need vercel link

  return new Promise((resolve, reject) => {
    const proc = spawn("vercel", args, {
      cwd: workspaceDir,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeProcess = proc;

    let stdoutBuf = "";

    proc.stdout!.on("data", (chunk) => {
      const text = chunk.toString();
      stdoutBuf += text;
      // stdout is the deployment URL — don't emit as log (it's just a URL)
    });

    proc.stderr!.on("data", (chunk) => {
      const text = chunk.toString();
      // stderr contains human-readable progress
      for (const line of text.split("\n").filter(Boolean)) {
        this.emit("log", { text: line });
      }
    });

    proc.on("close", (code) => {
      this._deploying = false;
      this.activeProcess = null;
      if (code === 0) {
        const url = stdoutBuf.trim();
        const result: DeployResult = {
          url,
          provider: "vercel",
          environment,
          duration: Date.now() - startTime,
        };
        this.emit("complete", result);
        resolve(result);
      } else {
        const err = { message: `Vercel deploy failed (exit ${code})`, phase: "deploying" };
        this.emit("error", err);
        reject(new Error(err.message));
      }
    });
  });
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

#### Cloudflare Pages Deploy Implementation

```typescript
async deployCloudflare(
  workspaceDir: string,
  token: string,
  accountId: string,
  outputDir: string,
  projectName?: string,
): Promise<DeployResult> {
  this._deploying = true;
  const startTime = Date.now();

  const resolvedProjectName = projectName || path.basename(workspaceDir);
  const deployDir = path.join(workspaceDir, outputDir);

  // Ensure project exists (wrangler won't auto-create non-interactively)
  await this.ensureCloudflareProject(token, accountId, resolvedProjectName);

  return new Promise((resolve, reject) => {
    const proc = spawn("wrangler", [
      "pages", "deploy", deployDir,
      `--project-name=${resolvedProjectName}`,
      "--branch=main",
    ], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        FORCE_COLOR: "0",
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.activeProcess = proc;

    let allOutput = "";

    const handleOutput = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString();
      allOutput += text;
      for (const line of text.split("\n").filter(Boolean)) {
        this.emit("log", { text: line });
      }
    };

    proc.stdout!.on("data", handleOutput("stdout"));
    proc.stderr!.on("data", handleOutput("stderr"));

    proc.on("close", (code) => {
      this._deploying = false;
      this.activeProcess = null;
      if (code === 0) {
        // Extract URL from output (wrangler mixes it into stdout text)
        const urlMatch = allOutput.match(/https:\/\/[a-zA-Z0-9_-]+\.[\w.-]+\.pages\.dev/);
        const url = urlMatch?.[0] || `https://${resolvedProjectName}.pages.dev`;
        const result: DeployResult = {
          url,
          provider: "cloudflare",
          environment: "production",
          duration: Date.now() - startTime,
        };
        this.emit("complete", result);
        resolve(result);
      } else {
        const err = { message: `Cloudflare deploy failed (exit ${code})`, phase: "deploying" };
        this.emit("error", err);
        reject(new Error(err.message));
      }
    });
  });
}

/** Ensure the Cloudflare Pages project exists. Create if missing. */
private async ensureCloudflareProject(
  token: string,
  accountId: string,
  projectName: string,
): Promise<void> {
  // Use wrangler pages project create. If it already exists, the command
  // exits with a non-zero code and a "project already exists" error — we ignore that.
  return new Promise((resolve) => {
    const proc = spawn("wrangler", [
      "pages", "project", "create", projectName,
      "--production-branch=main",
    ], {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("close", () => resolve()); // Ignore exit code — project may already exist
  });
}
```

**Key Wrangler CLI behavior:**
- `wrangler pages deploy <dir>` uploads a directory of static assets directly — no build step needed (ShipIt runs the build separately).
- Auth via `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` environment variables. OAuth (`wrangler login`) fails in proxied/container environments.
- `--project-name` is required for non-interactive mode. Without it, Wrangler prompts interactively.
- The project **must exist** before deploying non-interactively. `wrangler pages project create` handles this, and is idempotent (errors harmlessly if the project already exists).
- **No `--json` flag on deploy.** Output is human-readable text with the URL embedded. We extract it via regex.
- `--branch=main` targets production. Any other branch creates a preview deployment.
- Deploy speed for pre-built assets is fast — typically under 30 seconds.

#### New: `DeploymentStore` class (`src/server/deployment-store.ts`)

Persists deployment configuration (tokens) and history per session. Follows the `ChatHistoryManager` pattern.

```typescript
export interface DeploymentConfig {
  provider: "vercel" | "cloudflare";
  token: string;                    // stored on disk (container-scoped security)
  accountId?: string;               // Cloudflare only
  projectName?: string;             // user override
}

export interface DeploymentRecord {
  id: string;                       // UUID
  provider: "vercel" | "cloudflare";
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
  private configDir: string;   // /workspace/.shipit-deploy/

  /** Save provider config (token + prefs) for a session. */
  saveConfig(sessionId: string, config: DeploymentConfig): void { /* ... */ }

  /** Load provider config for a session. Returns null if not configured. */
  loadConfig(sessionId: string, provider: "vercel" | "cloudflare"): DeploymentConfig | null { /* ... */ }

  /** Delete provider config for a session (logout). */
  deleteConfig(sessionId: string, provider: "vercel" | "cloudflare"): void { /* ... */ }

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
      vercel.json           # { token, projectName }
      cloudflare.json       # { token, accountId, projectName }
  history/
    {sessionId}.json        # DeploymentRecord[]
```

**Security note:** Tokens are stored in plaintext JSON files on the container's volume. This is acceptable because (a) the container is single-tenant — only the user who owns it can access it, (b) the volume is ephemeral or user-controlled, and (c) this mirrors how `vercel` and `wrangler` CLIs store their own credentials on disk. The tokens are not exposed via the WebSocket protocol (the server never sends tokens back to the client).

#### `index.ts` — new WS message handlers

Wire the deployment manager into the WebSocket handler, following the existing GitHub integration pattern:

```typescript
// In buildApp(), add to AppDeps:
const deploymentManager = deps.deploymentManager ?? new DeploymentManager();
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
    ...result,
    commitHash: commitInfo?.[0]?.hash,
    commitMessage: commitInfo?.[0]?.message,
    timestamp: new Date().toISOString(),
    durationMs: result.duration,
    status: "success",
  });
  broadcast({ type: "deploy_complete", ...result });
});

deploymentManager.on("error", (err) => {
  broadcast({ type: "deploy_error", message: err.message, phase: err.phase });
});

// Handler: configure deployment
if (msg.type === "deploy_configure") {
  const provider = msg.provider;
  const token = typeof msg.token === "string" ? msg.token.trim() : "";
  if (!token) {
    send({ type: "error", message: "Deployment token cannot be empty" });
    return;
  }
  if (token.length > 500) {
    send({ type: "error", message: "Token too long" });
    return;
  }
  if (provider !== "vercel" && provider !== "cloudflare") {
    send({ type: "error", message: "Invalid provider" });
    return;
  }

  const config: DeploymentConfig = { provider, token };
  if (provider === "cloudflare") {
    const accountId = typeof msg.accountId === "string" ? msg.accountId.trim() : "";
    if (!accountId) {
      send({ type: "error", message: "Cloudflare Account ID is required" });
      return;
    }
    config.accountId = accountId;
  }

  deploymentStore.saveConfig(activeAppSessionId!, config);
  send({ type: "deploy_config_saved", provider });
}

// Handler: initiate deployment
if (msg.type === "initiate_deploy") {
  if (!activeSessionDir) {
    send({ type: "error", message: "No active session" });
    return;
  }
  if (deploymentManager.deploying) {
    send({ type: "error", message: "Deployment already in progress" });
    return;
  }

  const provider = msg.provider;
  const environment = msg.environment || "preview";
  const config = deploymentStore.loadConfig(activeAppSessionId!, provider);
  if (!config) {
    send({ type: "error", message: `No ${provider} token configured. Set up deployment first.` });
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

  // Deploy
  broadcast({ type: "deploy_status", phase: "deploying" });
  try {
    if (provider === "vercel") {
      await deploymentManager.deployVercel(
        activeSessionDir, config.token, environment, config.projectName,
      );
    } else {
      await deploymentManager.deployCloudflare(
        activeSessionDir, config.token, config.accountId!,
        framework.outputDirectory, config.projectName,
      );
    }
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

// Handler: get deployment config status (are tokens configured?)
if (msg.type === "get_deploy_config") {
  const vercel = deploymentStore.loadConfig(activeAppSessionId!, "vercel");
  const cloudflare = deploymentStore.loadConfig(activeAppSessionId!, "cloudflare");
  send({
    type: "deploy_config",
    vercel: vercel ? { configured: true, projectName: vercel.projectName } : { configured: false },
    cloudflare: cloudflare ? { configured: true, projectName: cloudflare.projectName } : { configured: false },
  });
}
```

### Protocol Changes

New WS message types added to `src/server/types.ts`:

#### Client → Server

```typescript
// ---- Deployment messages ----

export interface WsDeployConfigure {
  type: "deploy_configure";
  provider: "vercel" | "cloudflare";
  token: string;
  accountId?: string;          // Cloudflare only
  projectName?: string;        // optional override
}

export interface WsInitiateDeploy {
  type: "initiate_deploy";
  provider: "vercel" | "cloudflare";
  environment?: "production" | "preview";  // defaults to "preview"
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
  provider: "vercel" | "cloudflare";
}
```

#### Server → Client

```typescript
export interface WsDeployConfigSaved {
  type: "deploy_config_saved";
  provider: "vercel" | "cloudflare";
}

export interface WsDeployConfig {
  type: "deploy_config";
  vercel: { configured: boolean; projectName?: string };
  cloudflare: { configured: boolean; projectName?: string };
}

export interface WsDeployStatus {
  type: "deploy_status";
  phase: "building" | "deploying" | "complete" | "error";
}

export interface WsDeployComplete {
  type: "deploy_complete";
  url: string;
  provider: "vercel" | "cloudflare";
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

Full-screen modal overlay following the `SystemPromptEditor` / `GitHubAuthOverlay` pattern.

**States:**

1. **Config state** — No token configured for either provider. Shows two cards: Vercel and Cloudflare. Each card has a token input, a link to the provider's token creation page, and a "Save" button. Cloudflare card also has an Account ID field.

2. **Ready state** — At least one provider configured. Shows:
   - Provider selector (Vercel / Cloudflare tabs or radio)
   - Auto-detected framework info (`Detected: Vite (React)`)
   - Environment selector (Production / Preview toggle)
   - Optional project name override
   - "Deploy" button with provider icon
   - "Deploy History" section at the bottom (last 5 deployments with URLs, timestamps, status badges)

3. **Deploying state** — Deploy in progress. Shows:
   - Progress indicator with current phase (Building... / Deploying...)
   - Live log output (scrolling terminal-like view, fed from `log_entry` with `source: "deploy"`)
   - "Cancel" button

4. **Complete state** — Deploy succeeded. Shows:
   - Green success indicator with deployment URL (clickable, opens in new tab)
   - "Open Preview" button
   - Duration and commit info
   - "Deploy Again" and "Close" buttons

5. **Error state** — Deploy failed. Shows:
   - Red error indicator with error message
   - Build/deploy output for debugging
   - "Send to Claude" button (composes error into chat message, same pattern as preview error capture)
   - "Retry" and "Close" buttons

#### Header Integration

Add a "Deploy" button to the header, between the GitHub section and the System Prompt gear icon:

```tsx
<button
  onClick={() => setShowDeployModal(true)}
  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg ..."
  title="Deploy to Vercel or Cloudflare"
>
  <RocketIcon className="w-4 h-4" />
  <span className="hidden sm:inline text-sm">Deploy</span>
</button>
```

When a deployment is in progress, the button shows an animated spinner and the current phase. When the last deployment succeeded, a small green dot indicates "deployed" status.

#### `App.tsx` State Additions

```typescript
const [showDeployModal, setShowDeployModal] = useState(false);
const [deployStatus, setDeployStatus] = useState<DeployPhase | null>(null);
const [lastDeployUrl, setLastDeployUrl] = useState<string | null>(null);
const [deployConfig, setDeployConfig] = useState<{
  vercel: { configured: boolean; projectName?: string };
  cloudflare: { configured: boolean; projectName?: string };
}>({ vercel: { configured: false }, cloudflare: { configured: false } });
```

WS message handler additions:

```typescript
if (data.type === "deploy_config_saved") {
  setDeployConfig(prev => ({
    ...prev,
    [data.provider]: { configured: true },
  }));
}

if (data.type === "deploy_config") {
  setDeployConfig({ vercel: data.vercel, cloudflare: data.cloudflare });
}

if (data.type === "deploy_status") {
  setDeployStatus(data.phase);
}

if (data.type === "deploy_complete") {
  setDeployStatus(null);
  setLastDeployUrl(data.url);
  // Show success toast or update header badge
}

if (data.type === "deploy_error") {
  setDeployStatus(null);
  // Show error in deploy modal
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

#### `StubDeploymentManager` (in `test-helpers.ts`)

```typescript
export class StubDeploymentManager extends EventEmitter {
  deploying = false;
  lastDeployArgs: { provider: string; workspaceDir: string } | null = null;

  async detectFramework(): Promise<FrameworkInfo> {
    return { name: "vite", buildCommand: "npm run build", outputDirectory: "dist" };
  }

  async build(): Promise<boolean> { return true; }

  async deployVercel(workspaceDir: string): Promise<DeployResult> {
    this.lastDeployArgs = { provider: "vercel", workspaceDir };
    const result = { url: "https://test.vercel.app", provider: "vercel" as const,
                     environment: "production" as const, duration: 5000 };
    this.emit("complete", result);
    return result;
  }

  async deployCloudflare(workspaceDir: string): Promise<DeployResult> {
    this.lastDeployArgs = { provider: "cloudflare", workspaceDir };
    const result = { url: "https://test.pages.dev", provider: "cloudflare" as const,
                     environment: "production" as const, duration: 3000 };
    this.emit("complete", result);
    return result;
  }

  cancel(): void { this.deploying = false; }

  /** Test helper: simulate a deploy failure. */
  simulateError(message: string, phase: string): void {
    this.emit("error", { message, phase });
  }
}
```

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

### Vercel vs Cloudflare: Platform Differences

| Concern | Vercel | Cloudflare Pages |
|---------|--------|-----------------|
| **Auth** | `--token` flag or `VERCEL_TOKEN` env | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` env |
| **Project auto-create** | Yes (with `--yes`) | No — must pre-create via `wrangler pages project create` |
| **Build step** | Vercel runs build remotely by default | Wrangler only uploads — we build locally first |
| **URL extraction** | stdout = URL only (clean) | URL mixed into stdout text (regex extraction) |
| **Framework detection** | Auto-detects build cmd + output dir | No auto-detection (we handle it ourselves) |
| **Deploy speed** | 30-90s (includes remote build) | < 30s (direct upload of pre-built assets) |
| **First deploy setup** | Creates `.vercel/project.json` | Needs `--project-name` + pre-created project |
| **JSON output** | No `--json` flag; stdout = URL | No `--json` on deploy; `WRANGLER_OUTPUT_FILE_PATH` for NDJSON |

**Implication:** Vercel is simpler for the user (fewer config fields, auto-creates project) but slower. Cloudflare requires an Account ID upfront but deploys faster since we upload pre-built assets directly.

### File Layout

| File | Change |
|------|--------|
| `src/server/deployment-manager.ts` | New — `DeploymentManager` class |
| `src/server/deployment-manager.test.ts` | New — unit tests for framework detection, build, deploy |
| `src/server/deployment-store.ts` | New — `DeploymentStore` class for config + history persistence |
| `src/server/deployment-store.test.ts` | New — unit tests for config CRUD, history, session cleanup |
| `src/server/types.ts` | Add deployment WS message types, extend `WsLogEntry` source, extend `WsClientMessage`/`WsServerMessage` unions |
| `src/server/index.ts` | Add deployment WS handlers, wire `DeploymentManager` events, add to `AppDeps` |
| `src/client/components/DeployModal.tsx` | New — deployment configuration + trigger UI |
| `src/client/components/DeployModal.test.tsx` | New — component tests |
| `src/client/App.tsx` | Add deploy state, WS handlers, header button, modal rendering |
| `src/server/integration_tests/deployment.test.ts` | New — integration tests for deploy flow |
| `src/server/integration_tests/test-helpers.ts` | Add `StubDeploymentManager`, `StubDeploymentStore` |

### Quality Checklist

- [ ] Input validation: `deploy_configure` validates token (non-empty, max 500 chars, string type), provider (enum), accountId for Cloudflare. `initiate_deploy` validates provider, environment. Reject if no active session.
- [ ] Component tests: `DeployModal` — config form (save token, validation), deploy trigger (provider/env selection, deploy button), deploying state (progress, cancel), complete state (URL display, open link), error state (error message, Send to Claude). Framework detection display.
- [ ] Integration tests: Configure token → initiate deploy → verify status + complete messages. Error paths: missing token, no active session, deploy while deploying. History retrieval.
- [ ] Edge cases: No package.json (static site), no build script, build failure, token expiration, cancel during deploy, session delete clears deploy data.
- [ ] Terminal integration: Deploy logs appear with `source: "deploy"` and blue styling.
- [ ] Security: Tokens stored on disk only, never sent back to client via WS. Path traversal guard on deploy directory.

### Future Enhancements

- **Deploy from specific commit** — Build and deploy a pinned git commit rather than the current working directory, avoiding race conditions with in-progress Claude turns.
- **Custom build commands** — Let users override the auto-detected build command and output directory in the deploy modal.
- **Deploy previews in chat** — When Claude makes changes, show a "Deploy preview" button inline that creates a preview deployment.
- **Netlify, Fly.io, Railway** — Add more deployment targets using the same `DeploymentManager` pattern. Each target is a new method + provider enum value.
- **Deploy status polling** — After deploy, periodically check the deployment status (especially for Vercel, which builds remotely) and update the UI.
- **Deployment rollback** — Re-deploy a previous deployment by commit hash.
- **Environment variables UI** — Let users set runtime environment variables (Vercel `-e`, Cloudflare `--var`) in the deploy modal.
- **Custom domains** — Display and manage custom domains assigned to deployments.
