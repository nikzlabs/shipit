# 027 — GitHub Repo Import & PR Status Bar

## Summary

Three related GitHub workflow enhancements:

1. **Repo Import**: Clone an existing GitHub repository into a new ShipIt session, so users can start from existing code instead of only from templates or blank projects.
2. **PR Status Bar**: A persistent banner (inspired by Claude Code Desktop) that appears after a PR is created, showing branch flow, diff stats, and a quick "View PR" link — plus a **Merge** button for completing the PR lifecycle without leaving ShipIt.
3. **Auto-Push**: Automatically push to the remote after every auto-commit, eliminating the manual push step entirely.

## Motivation

### Repo Import

Currently ShipIt only supports two starting points: pick a template or start from scratch. Users with existing GitHub repos must manually push code into a session — there's no "import" flow. This blocks the most common use case: "I have a repo, I want to vibe-code on it."

### PR Status Bar

Doc 019 covers PR *creation* (the modal form). But after a PR is created, there's no persistent visibility of it. The user has to remember the PR URL or re-open the GitHub UI. Claude Code Desktop solves this with a compact status bar:

```
┌──────────────────────────────────────────────────────────────┐
│  ⑂  main ← claude/feature-branch  [📋]  +2454 -0  [View PR]│
└──────────────────────────────────────────────────────────────┘
```

This bar shows at a glance:
- **Branch flow**: `base ← head` (which branch merges into which)
- **Copy button**: Copy the branch name to clipboard
- **Diff stats**: Total insertions/deletions vs. the base branch
- **View PR**: Opens the PR URL in a new tab

This pattern gives users continuous awareness of the PR context while they work, and a one-click path to the PR page.

### Auto-Push

The current workflow requires a manual "Push" button click after code changes. This is unnecessary friction for a vibe-coding product. The user's intent is clear: they have a remote, they have a branch — every commit should be visible on GitHub immediately. Manual push is a leftover from local dev workflows where you batch commits. In ShipIt, each Claude turn auto-commits, so auto-push is the natural complement.

## Part 1: GitHub Repo Import

### User Flow

1. From the session list / new session screen, click **"Import from GitHub"**
2. Enter a GitHub repo URL (e.g., `https://github.com/owner/repo`) or search by name
3. Optionally pick a branch (default: the repo's default branch)
4. Click **"Import"**
5. Server clones the repo into a new session workspace, sets up the remote, and starts the session
6. User lands in a fully initialized session with the repo's files, git history, and remote configured

### Server-Side

#### New GitManager Methods

```typescript
// src/server/git.ts — additions

/**
 * Clone a remote repository into this workspace directory.
 * The workspace dir must be empty or non-existent.
 */
async clone(url: string, branch?: string): Promise<void> {
  const args = ["clone", url, "."];
  if (branch) args.push("--branch", branch);
  await this.git.raw(args);
}

/**
 * Get the default branch name from a remote (e.g., "main" or "master").
 */
async getDefaultBranch(remote = "origin"): Promise<string> {
  const result = await this.git.remote(["show", remote]);
  const match = result.match(/HEAD branch:\s*(\S+)/);
  return match?.[1] ?? "main";
}
```

#### GitHub Repo Listing (for Search)

```typescript
// src/server/github-auth.ts — addition

/**
 * Search the user's accessible repos by name.
 */
async searchRepos(query: string): Promise<Array<{
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
}>> {
  if (!this._token) return [];

  const res = await fetch(
    `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}+in:name&sort=updated&per_page=10`,
    {
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    }
  );

  if (!res.ok) return [];

  const data = await res.json();
  return data.items.map((r: any) => ({
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    defaultBranch: r.default_branch,
    cloneUrl: r.clone_url,
  }));
}
```

#### New Message Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsGitHubImportRepo {
  type: "github_import_repo";
  /** Full clone URL or "owner/repo" shorthand. */
  url: string;
  /** Optional branch to check out. Defaults to repo's default branch. */
  branch?: string;
}

export interface WsGitHubSearchRepos {
  type: "github_search_repos";
  query: string;
}

// Server → Client
export interface WsGitHubImportProgress {
  type: "github_import_progress";
  stage: "cloning" | "installing" | "ready";
  message: string;
}

export interface WsGitHubImportComplete {
  type: "github_import_complete";
  success: boolean;
  sessionId?: string;
  message?: string;
}

export interface WsGitHubSearchResults {
  type: "github_search_results";
  repos: Array<{
    fullName: string;
    description: string | null;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }>;
}
```

#### Handler in `src/server/index.ts`

```typescript
if (msg.type === "github_import_repo") {
  if (!githubAuthManager.authenticated) {
    send({ type: "error", message: "Not authenticated with GitHub" });
    return;
  }

  let url = typeof msg.url === "string" ? msg.url.trim() : "";
  if (!url) {
    send({ type: "error", message: "Repository URL is required" });
    return;
  }

  // Support "owner/repo" shorthand → full HTTPS URL
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(url)) {
    url = `https://github.com/${url}.git`;
  }

  // Validate URL format
  if (!url.startsWith("https://") && !url.startsWith("git@")) {
    send({ type: "error", message: "Invalid repository URL" });
    return;
  }

  try {
    // 1. Create a new session
    send({ type: "github_import_progress", stage: "cloning", message: "Creating session..." });
    const sessionId = crypto.randomUUID();
    const sessionDir = path.join(WORKSPACE_BASE, "sessions", sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    // 2. Clone the repo
    send({ type: "github_import_progress", stage: "cloning", message: "Cloning repository..." });
    const git = deps.createGitManager(sessionDir);
    await git.clone(url, msg.branch || undefined);

    // 3. Configure credentials for push
    await githubAuthManager.configureGitCredentials(sessionDir);

    // 4. Register session
    const repoName = url.split("/").pop()?.replace(".git", "") ?? "imported-repo";
    sessionManager.track(sessionId, repoName, sessionDir);

    // 5. Detect and install dependencies
    const pkgJsonPath = path.join(sessionDir, "package.json");
    const hasPkg = await fs.access(pkgJsonPath).then(() => true).catch(() => false);
    if (hasPkg) {
      send({ type: "github_import_progress", stage: "installing", message: "Installing dependencies..." });
      // Run npm install in background — don't block the response
      // (ViteManager or user can trigger this)
    }

    send({
      type: "github_import_complete",
      success: true,
      sessionId,
      message: `Imported ${repoName} successfully`,
    });
  } catch (err) {
    send({
      type: "github_import_complete",
      success: false,
      message: `Import failed: ${getErrorMessage(err)}`,
    });
  }
}

if (msg.type === "github_search_repos") {
  const query = typeof msg.query === "string" ? msg.query.trim() : "";
  if (!query || query.length < 2) {
    send({ type: "github_search_results", repos: [] });
    return;
  }

  const repos = await githubAuthManager.searchRepos(query);
  send({ type: "github_search_results", repos });
}
```

### Client-Side

#### ImportRepoOverlay Component (`src/client/components/ImportRepoOverlay.tsx`)

A modal dialog for importing repositories:

```
┌─────────────────────────────────────────────┐
│  Import from GitHub                      [×]│
├─────────────────────────────────────────────┤
│                                             │
│  ┌─────────────────────────────────────────┐│
│  │ 🔍 Search repos or paste URL...        ││
│  └─────────────────────────────────────────┘│
│                                             │
│  Recent / Search Results:                   │
│  ┌─────────────────────────────────────────┐│
│  │ ☐ acme/web-app                         ││
│  │   React dashboard with auth  · private ││
│  │                                         ││
│  │ ☐ acme/api-server                      ││
│  │   Express REST API  · public           ││
│  │                                         ││
│  │ ☐ acme/shared-utils                    ││
│  │   Shared TypeScript utilities  · public││
│  └─────────────────────────────────────────┘│
│                                             │
│  Branch: [main ▼]  (optional)               │
│                                             │
│  [Cancel]                    [Import]       │
│                                             │
│  ── Importing... ──                         │
│  ✓ Cloning repository...                   │
│  ⟳ Installing dependencies...              │
│                                             │
└─────────────────────────────────────────────┘
```

**Features:**
- **Dual input**: Paste a URL directly, or type to search by name (debounced, 300ms)
- **Repo list**: Shows search results with name, description, visibility badge (public/private)
- **Branch selector**: Optional dropdown, defaults to the repo's default branch
- **Progress indicators**: Real-time progress as the server clones and sets up
- **Auto-redirect**: On success, automatically switch to the new session

#### Integration Points

**New Session screen**: Add an "Import from GitHub" option alongside the existing template picker and blank project options. Only visible when GitHub is authenticated.

**Header**: Add an import icon/button near the existing "New Session" button.

---

## Part 2: Auto-Push on Commit

### Behavior

When a remote is configured and the user is authenticated with GitHub, every `git_committed` event triggers an automatic push to the remote branch. No manual "Push" button needed.

```
Claude turn completes
  → auto-commit (existing)
    → auto-push to origin/{branch} (new)
      → PR status bar diff stats refresh
```

### Server-Side

Hook into the existing auto-commit flow in `src/server/index.ts`. After `git.autoCommit()` succeeds, if conditions are met, push automatically:

```typescript
// After auto-commit in the Claude turn handler:
if (commitHash && autoPushEnabled) {
  try {
    const branch = await git.getCurrentBranch();
    await git.push("origin", branch);
    send({
      type: "github_push_result",
      success: true,
      message: `Auto-pushed to origin/${branch}`,
      branch,
    });
  } catch (err) {
    // Auto-push failure is non-fatal — log it, don't block the user
    send({
      type: "log_entry",
      source: "server",
      text: `Auto-push failed: ${getErrorMessage(err)}`,
    });
  }
}
```

**Conditions for auto-push** (`autoPushEnabled`):
1. GitHub is authenticated (`githubAuthManager.authenticated`)
2. An `origin` remote is configured
3. Git credentials are configured for this session
4. The session isn't in a detached HEAD state

These conditions are checked once on session load and cached, then rechecked when remotes or auth change.

### Auto-Push is Non-Blocking

Push failures must **never** block the coding workflow:
- Network failures are silently logged to the terminal (server log source)
- The commit still exists locally — nothing is lost
- A retry happens on the next commit
- If the remote branch has diverged (e.g., someone pushed to it externally), log a warning and skip. The user can resolve manually via the terminal.

### Debouncing

During rapid Claude turns (e.g., auto-fix loops), pushing after every single commit would be wasteful. Debounce auto-push with a 5-second trailing delay:

```typescript
let pushTimer: NodeJS.Timeout | null = null;

function scheduleAutoPush(git: GitManager, send: SendFn) {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    try {
      const branch = await git.getCurrentBranch();
      await git.push("origin", branch);
      send({ type: "github_push_result", success: true, branch, message: `Auto-pushed to origin/${branch}` });
    } catch (err) {
      send({ type: "log_entry", source: "server", text: `Auto-push failed: ${getErrorMessage(err)}` });
    }
  }, 5000);
}
```

This means: after the last commit in a burst, wait 5 seconds, then push once with all accumulated commits.

### Opt-Out

Auto-push is **on by default** when a remote is configured. Users can disable it via a setting toggle in the GitHub section of the UI. This is a per-session preference stored in session metadata.

```typescript
// New session metadata field:
export interface SessionMetadata {
  // ... existing fields ...
  autoPush?: boolean;  // default: true
}
```

---

## Part 3: PR Status Bar

### Design (Inspired by Claude Code Desktop)

A compact, persistent banner that appears in the header area whenever a PR is associated with the current session:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  ⑂  main ← claude/feature-branch  [📋]   +247 -38   [View PR]  [Merge ▼]   │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Elements (left to right):**

1. **Git merge icon** (`⑂`): Visual indicator that this is a PR context
2. **Branch flow**: `{base} ← {head}` showing which branch merges into which. The head branch is the current working branch.
3. **Copy button** (`📋`): Copies the head branch name to clipboard (useful for `git checkout` commands or sharing)
4. **Diff stats**: `+{insertions} -{deletions}` — total lines changed vs. the base branch. Green/red colored for visual clarity.
5. **View PR button**: Opens the PR's GitHub URL in a new browser tab
6. **Merge button**: Merge the PR directly from ShipIt (see Merge Flow below)

### State Tracking

The PR status bar needs to know:
- Whether a PR exists for the current branch
- The PR URL, number, base branch
- Current diff stats vs. the base branch

This data comes from two sources:
1. **PR creation** (doc 019): When `github_pr_created` fires with `success: true`, store the PR metadata
2. **Existing PRs**: On session load, check if the current branch has an open PR

### Merge Flow

The Merge button completes the PR lifecycle without leaving ShipIt. It handles three scenarios:

#### Scenario 1: Checks Passed (or No Required Checks)
The PR is mergeable immediately. Clicking **Merge** merges the PR via the GitHub API.

#### Scenario 2: Checks Pending
GitHub Actions CI is still running. Clicking **Merge** enables **auto-merge** via the GitHub API — the PR will merge automatically once all required checks pass.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│  ⑂  main ← feature-branch  [📋]   +247 -38   ⏳ CI running   [View PR]  [Merge]│
└───────────────────────────────────────────────────────────────────────────────────┘
                                                      ↓ click Merge
┌───────────────────────────────────────────────────────────────────────────────────┐
│  ⑂  main ← feature-branch  [📋]   +247 -38   ⏳ Auto-merge enabled  [View PR]  │
└───────────────────────────────────────────────────────────────────────────────────┘
                                                      ↓ CI passes
┌───────────────────────────────────────────────────────────────────────────────────┐
│  ⑂  main ← feature-branch  [📋]   +247 -38   ✓ Merged!              [View PR]  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

#### Scenario 3: Checks Failed
CI has failed. The Merge button is disabled with a tooltip explaining why. The user must fix the failing checks first (with Claude's help).

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│  ⑂  main ← feature-branch  [📋]   +247 -38   ✗ CI failed    [View PR]  [Merge ⊘] │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

#### Merge Method Dropdown

The Merge button has a dropdown (▼) for selecting the merge method:
- **Merge commit** (default) — `merge`
- **Squash and merge** — `squash`
- **Rebase and merge** — `rebase`

The selected method is remembered per session.

#### Server-Side: Merge and Auto-Merge

```typescript
// src/server/github-auth.ts — additions

/**
 * Merge a pull request.
 */
async mergePullRequest(
  owner: string,
  repo: string,
  pullNumber: number,
  method: "merge" | "squash" | "rebase" = "merge",
): Promise<{ success: boolean; message: string }> {
  if (!this._token) return { success: false, message: "Not authenticated" };

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "ShipIt",
      },
      body: JSON.stringify({ merge_method: method }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    // 405 = not mergeable (checks pending/failed, conflicts, etc.)
    if (res.status === 405) {
      return { success: false, message: err.message || "PR is not mergeable" };
    }
    return { success: false, message: err.message || `GitHub API returned ${res.status}` };
  }

  return { success: true, message: "Pull request merged" };
}

/**
 * Enable auto-merge on a pull request.
 * Uses the GraphQL API since REST doesn't support auto-merge.
 * Requires the repo to have "Allow auto-merge" enabled in settings.
 */
async enableAutoMerge(
  owner: string,
  repo: string,
  pullNumber: number,
  method: "MERGE" | "SQUASH" | "REBASE" = "MERGE",
): Promise<{ success: boolean; message: string }> {
  if (!this._token) return { success: false, message: "Not authenticated" };

  // First, get the PR's node ID (needed for GraphQL)
  const prRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
    {
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    }
  );

  if (!prRes.ok) return { success: false, message: "Failed to fetch PR details" };
  const prData = await prRes.json();
  const nodeId = prData.node_id;

  // Enable auto-merge via GraphQL
  const graphqlRes = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${this._token}`,
      "Content-Type": "application/json",
      "User-Agent": "ShipIt",
    },
    body: JSON.stringify({
      query: `mutation EnableAutoMerge($prId: ID!, $method: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $prId, mergeMethod: $method }) {
          pullRequest { autoMergeRequest { enabledAt } }
        }
      }`,
      variables: { prId: nodeId, method },
    }),
  });

  if (!graphqlRes.ok) return { success: false, message: "Failed to enable auto-merge" };
  const graphqlData = await graphqlRes.json();

  if (graphqlData.errors) {
    const errMsg = graphqlData.errors[0]?.message ?? "Unknown error";
    // Common case: repo doesn't have auto-merge enabled
    if (errMsg.includes("auto-merge")) {
      return { success: false, message: "Auto-merge is not enabled for this repository. Enable it in repo Settings → General." };
    }
    return { success: false, message: errMsg };
  }

  return { success: true, message: "Auto-merge enabled — PR will merge when checks pass" };
}

/**
 * Get CI check status for a PR's head commit.
 */
async getCheckStatus(
  owner: string,
  repo: string,
  ref: string,
): Promise<{ state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number }> {
  if (!this._token) return { state: "none", total: 0, passed: 0, failed: 0, pending: 0 };

  // Get combined status (legacy status API)
  const statusRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/status`,
    {
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    }
  );

  // Also get check runs (GitHub Actions uses this API)
  const checksRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/commits/${ref}/check-runs`,
    {
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    }
  );

  let passed = 0, failed = 0, pending = 0;

  if (statusRes.ok) {
    const statusData = await statusRes.json();
    for (const s of statusData.statuses) {
      if (s.state === "success") passed++;
      else if (s.state === "failure" || s.state === "error") failed++;
      else pending++;
    }
  }

  if (checksRes.ok) {
    const checksData = await checksRes.json();
    for (const check of checksData.check_runs) {
      if (check.conclusion === "success") passed++;
      else if (check.conclusion === "failure" || check.conclusion === "cancelled" || check.conclusion === "timed_out") failed++;
      else if (check.status !== "completed") pending++;
    }
  }

  const total = passed + failed + pending;
  const state = total === 0 ? "none" : failed > 0 ? "failure" : pending > 0 ? "pending" : "success";

  return { state, total, passed, failed, pending };
}
```

#### New Message Types for Merge

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsMergePr {
  type: "merge_pr";
  method?: "merge" | "squash" | "rebase";
}

// Server → Client
export interface WsMergePrResult {
  type: "merge_pr_result";
  success: boolean;
  message: string;
  /** If checks are pending, auto-merge was enabled instead of immediate merge. */
  autoMergeEnabled?: boolean;
}
```

#### Merge Handler

```typescript
if (msg.type === "merge_pr") {
  if (!githubAuthManager.authenticated || !prStatus) {
    send({ type: "merge_pr_result", success: false, message: "No active PR" });
    return;
  }

  const method = msg.method || "merge";
  const { owner, repo } = parsedRemote;  // cached from PR status lookup

  // First, try direct merge
  const result = await githubAuthManager.mergePullRequest(owner, repo, prStatus.number, method);

  if (result.success) {
    send({ type: "merge_pr_result", success: true, message: "Pull request merged" });
    // Clear PR status — it's merged
    send({ type: "pr_status", pr: null });
    return;
  }

  // If merge failed because checks are pending, enable auto-merge
  const checks = await githubAuthManager.getCheckStatus(owner, repo, prStatus.headBranch);
  if (checks.state === "pending") {
    const graphqlMethod = method === "merge" ? "MERGE" : method === "squash" ? "SQUASH" : "REBASE";
    const autoResult = await githubAuthManager.enableAutoMerge(owner, repo, prStatus.number, graphqlMethod);
    send({
      type: "merge_pr_result",
      success: autoResult.success,
      message: autoResult.message,
      autoMergeEnabled: autoResult.success,
    });
    return;
  }

  // Checks failed or other issue
  send({ type: "merge_pr_result", success: false, message: result.message });
}
```

#### CI Status in PR Status Bar

The PR status bar includes a CI check indicator that polls periodically:

```typescript
// Extended pr_status response
export interface WsPrStatus {
  type: "pr_status";
  pr: {
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
    /** CI check status. */
    checks: {
      state: "pending" | "success" | "failure" | "none";
      total: number;
      passed: number;
      failed: number;
      pending: number;
    };
    /** Whether auto-merge is currently enabled. */
    autoMergeEnabled: boolean;
    /** Whether the PR is mergeable (no conflicts). */
    mergeable: boolean;
  } | null;
}
```

**Polling**: When `checks.state === "pending"`, the client polls `get_pr_status` every 30 seconds until checks resolve. This catches the auto-merge completion and updates the UI.

```typescript
// In App.tsx:
useEffect(() => {
  if (prStatus?.checks.state === "pending") {
    const interval = setInterval(() => {
      send({ type: "get_pr_status" });
    }, 30_000);
    return () => clearInterval(interval);
  }
}, [prStatus?.checks.state]);
```

#### New Server-Side Method

```typescript
// src/server/github-auth.ts — addition

/**
 * Check if an open PR exists for the given head branch.
 * Returns PR metadata if found, null otherwise.
 */
async findPullRequest(
  owner: string,
  repo: string,
  head: string,
): Promise<{ url: string; number: number; base: string; title: string } | null> {
  if (!this._token) return null;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${head}&state=open`,
    {
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "ShipIt",
      },
    }
  );

  if (!res.ok) return null;
  const prs = await res.json();
  if (prs.length === 0) return null;

  const pr = prs[0];
  return {
    url: pr.html_url,
    number: pr.number,
    base: pr.base.ref,
    title: pr.title,
  };
}
```

#### Diff Stats Computation

```typescript
// src/server/git.ts — addition

/**
 * Get total insertions/deletions between the current branch and a base branch.
 * Used for the PR status bar diff stats.
 */
async diffStatVsBranch(baseBranch: string): Promise<{ insertions: number; deletions: number }> {
  try {
    const result = await this.git.diffSummary([`origin/${baseBranch}...HEAD`]);
    return {
      insertions: result.insertions,
      deletions: result.deletions,
    };
  } catch {
    return { insertions: 0, deletions: 0 };
  }
}
```

#### New Message Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsGetPrStatus {
  type: "get_pr_status";
}

// Server → Client
export interface WsPrStatus {
  type: "pr_status";
  /** Null if no PR exists for the current branch. */
  pr: {
    url: string;
    number: number;
    title: string;
    baseBranch: string;
    headBranch: string;
    insertions: number;
    deletions: number;
  } | null;
}
```

#### Handler

```typescript
if (msg.type === "get_pr_status") {
  if (!githubAuthManager.authenticated) {
    send({ type: "pr_status", pr: null });
    return;
  }

  try {
    const git = getActiveGitManager();
    const remotes = await git.getRemotes();
    const origin = remotes.find(r => r.name === "origin");
    if (!origin) {
      send({ type: "pr_status", pr: null });
      return;
    }

    const parsed = GitManager.parseGitHubRemote(origin.url);
    if (!parsed) {
      send({ type: "pr_status", pr: null });
      return;
    }

    const head = await git.getCurrentBranch();
    const pr = await githubAuthManager.findPullRequest(parsed.owner, parsed.repo, head);

    if (!pr) {
      send({ type: "pr_status", pr: null });
      return;
    }

    const stats = await git.diffStatVsBranch(pr.base);

    send({
      type: "pr_status",
      pr: {
        url: pr.url,
        number: pr.number,
        title: pr.title,
        baseBranch: pr.base,
        headBranch: head,
        insertions: stats.insertions,
        deletions: stats.deletions,
      },
    });
  } catch {
    send({ type: "pr_status", pr: null });
  }
}
```

### Client-Side

#### PrStatusBar Component (`src/client/components/PrStatusBar.tsx`)

```typescript
export interface PrStatusBarProps {
  baseBranch: string;
  headBranch: string;
  insertions: number;
  deletions: number;
  prUrl: string;
  prNumber: number;
  checks: { state: "pending" | "success" | "failure" | "none"; total: number; passed: number; failed: number; pending: number };
  autoMergeEnabled: boolean;
  mergeable: boolean;
  onMerge: (method: "merge" | "squash" | "rebase") => void;
}
```

**Rendering:**

```tsx
export function PrStatusBar(props: PrStatusBarProps) {
  const { baseBranch, headBranch, insertions, deletions, prUrl, checks, autoMergeEnabled, mergeable, onMerge } = props;
  const [copied, setCopied] = useState(false);
  const [mergeMethod, setMergeMethod] = useState<"merge" | "squash" | "rebase">("merge");
  const [showDropdown, setShowDropdown] = useState(false);

  const copyBranch = () => {
    navigator.clipboard.writeText(headBranch);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Merge button state
  const mergeDisabled = checks.state === "failure" || !mergeable;
  const mergeLabel = autoMergeEnabled
    ? "Auto-merge enabled"
    : checks.state === "pending"
      ? "Merge (when CI passes)"
      : "Merge";

  return (
    <div className="flex items-center gap-3 px-3 py-1.5 bg-gray-900 border-b border-gray-800 text-xs">
      {/* Git merge icon */}
      <svg className="w-4 h-4 text-gray-400" ...>{/* branch/merge icon */}</svg>

      {/* Branch flow */}
      <span className="text-gray-400">
        <span className="text-gray-300 font-medium">{baseBranch}</span>
        {" ← "}
        <span className="text-blue-400 font-medium">{headBranch}</span>
      </span>

      {/* Copy branch name */}
      <button onClick={copyBranch} className="text-gray-500 hover:text-gray-300 transition-colors" title="Copy branch name">
        {copied ? "✓" : "📋"}
      </button>

      {/* Diff stats */}
      <span className="flex items-center gap-1.5 text-xs">
        <span className="text-green-400">+{insertions}</span>
        <span className="text-red-400">-{deletions}</span>
      </span>

      {/* CI status indicator */}
      {checks.state !== "none" && (
        <span className="flex items-center gap-1" title={`${checks.passed}/${checks.total} checks passed`}>
          {checks.state === "success" && <span className="text-green-400">✓ CI passed</span>}
          {checks.state === "pending" && <span className="text-yellow-400 animate-pulse">⏳ CI running ({checks.passed}/{checks.total})</span>}
          {checks.state === "failure" && <span className="text-red-400">✗ CI failed ({checks.failed} failed)</span>}
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {/* View PR */}
        <a href={prUrl} target="_blank" rel="noopener noreferrer"
          className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded text-xs font-medium transition-colors">
          View PR
        </a>

        {/* Merge button with dropdown */}
        <div className="relative">
          <div className="flex">
            <button
              onClick={() => onMerge(mergeMethod)}
              disabled={mergeDisabled}
              className={`px-2.5 py-1 rounded-l text-xs font-medium transition-colors ${
                mergeDisabled
                  ? "bg-gray-800 text-gray-500 cursor-not-allowed"
                  : autoMergeEnabled
                    ? "bg-yellow-600 hover:bg-yellow-500 text-white"
                    : "bg-green-600 hover:bg-green-500 text-white"
              }`}
              title={mergeDisabled ? (checks.state === "failure" ? "CI checks failed" : "PR has merge conflicts") : mergeLabel}
            >
              {autoMergeEnabled ? "Auto-merge ✓" : mergeDisabled ? "Merge ⊘" : "Merge"}
            </button>
            <button
              onClick={() => setShowDropdown(!showDropdown)}
              disabled={mergeDisabled}
              className={`px-1.5 py-1 rounded-r border-l border-black/20 text-xs ${
                mergeDisabled
                  ? "bg-gray-800 text-gray-500 cursor-not-allowed"
                  : autoMergeEnabled
                    ? "bg-yellow-600 hover:bg-yellow-500 text-white"
                    : "bg-green-600 hover:bg-green-500 text-white"
              }`}
            >
              ▼
            </button>
          </div>

          {/* Merge method dropdown */}
          {showDropdown && (
            <div className="absolute right-0 top-full mt-1 bg-gray-800 rounded shadow-lg border border-gray-700 py-1 z-50">
              {(["merge", "squash", "rebase"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => { setMergeMethod(m); setShowDropdown(false); }}
                  className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-gray-700 ${
                    mergeMethod === m ? "text-white font-medium" : "text-gray-300"
                  }`}
                >
                  {m === "merge" ? "Merge commit" : m === "squash" ? "Squash and merge" : "Rebase and merge"}
                  {mergeMethod === m && " ✓"}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
```

#### Placement in Layout

The PR status bar renders **below the main header** and **above the workspace panels**, spanning the full width. It only appears when `prStatus` is non-null:

```tsx
// In App.tsx layout:
<header>...</header>
{prStatus && (
  <PrStatusBar
    baseBranch={prStatus.baseBranch}
    headBranch={prStatus.headBranch}
    insertions={prStatus.insertions}
    deletions={prStatus.deletions}
    prUrl={prStatus.url}
    prNumber={prStatus.number}
  />
)}
<main>...</main>
```

#### State Management

```typescript
// In App.tsx:
const [prStatus, setPrStatus] = useState<PrStatusData | null>(null);

// Fetch PR status on session load and after push/PR creation
useEffect(() => {
  if (activeSessionId && githubAuthenticated) {
    send({ type: "get_pr_status" });
  }
}, [activeSessionId, githubAuthenticated]);

// Update after successful auto-push
if (data.type === "github_push_result" && data.success) {
  send({ type: "get_pr_status" });
}

// Update after PR creation
if (data.type === "github_pr_created" && data.success) {
  send({ type: "get_pr_status" });
}

// Handle PR status response
if (data.type === "pr_status") {
  setPrStatus(data.pr);
}

// Handle merge result
if (data.type === "merge_pr_result") {
  if (data.success && !data.autoMergeEnabled) {
    // PR was merged — clear status
    setPrStatus(null);
    // Show success toast
  } else if (data.autoMergeEnabled) {
    // Auto-merge enabled — refresh to show new state
    send({ type: "get_pr_status" });
  }
}

// Merge handler
const handleMergePr = useCallback((method: "merge" | "squash" | "rebase") => {
  send({ type: "merge_pr", method });
}, [send]);

// Poll while CI is pending (for auto-merge completion detection)
useEffect(() => {
  if (prStatus?.checks.state === "pending") {
    const interval = setInterval(() => {
      send({ type: "get_pr_status" });
    }, 30_000); // every 30 seconds
    return () => clearInterval(interval);
  }
}, [prStatus?.checks.state]);
```

#### Refresh Triggers

The PR status bar refreshes its data when:
1. **Session loads**: Initial fetch to check for existing PRs
2. **After auto-push**: Each auto-push updates the diff stats and CI status
3. **After PR creation**: The PR was just created via doc 019's modal
4. **While CI pending**: Polls every 30s until checks resolve (catches auto-merge completion)
5. **After merge**: Clears the bar on successful merge, or refreshes on auto-merge enable

## Testing

### Import — Integration Tests (`src/server/integration_tests/github-import.test.ts`)
1. **Happy path**: Authenticated + valid URL → clone succeeds → session created → `github_import_complete` with success
2. **Owner/repo shorthand**: Send `"owner/repo"` → server expands to full URL
3. **Missing auth**: Not authenticated → error
4. **Empty URL**: Empty string → validation error
5. **Invalid URL**: Non-HTTP/SSH URL → validation error
6. **Search repos**: Send `github_search_repos` → verify response format
7. **Progress events**: Verify `github_import_progress` events fire in order

### Import — Component Tests (`src/client/components/ImportRepoOverlay.test.tsx`)
1. Renders search input and repo list
2. Typing triggers debounced search
3. Selecting a repo populates the URL field
4. Submit calls import handler
5. Progress indicators appear during import
6. Success redirects to new session
7. Cancel closes overlay

### Auto-Push — Integration Tests (`src/server/integration_tests/auto-push.test.ts`)
1. **Auto-push after commit**: Authenticated + remote configured → auto-commit triggers push → `github_push_result` received
2. **Debouncing**: Two rapid commits → only one push (after 5s delay)
3. **No remote**: No origin → no push attempt, no error
4. **Not authenticated**: No GitHub token → no push attempt
5. **Push failure is non-fatal**: Network error during push → log entry emitted, no crash

### PR Status Bar — Integration Tests (`src/server/integration_tests/pr-status.test.ts`)
1. **No PR**: No PR for current branch → `pr_status` with `pr: null`
2. **Existing PR**: PR exists → returns correct metadata, diff stats, and check status
3. **No remote**: No origin configured → `pr_status` with `pr: null`
4. **Not authenticated**: Not logged in → `pr_status` with `pr: null`
5. **CI status**: PR with pending checks → `checks.state === "pending"` with correct counts

### Merge — Integration Tests (`src/server/integration_tests/merge-pr.test.ts`)
1. **Direct merge**: Checks passed → `merge_pr` → `merge_pr_result` with success
2. **Auto-merge on pending CI**: Checks pending → `merge_pr` → `merge_pr_result` with `autoMergeEnabled: true`
3. **Failed checks**: Checks failed → `merge_pr` → `merge_pr_result` with `success: false`
4. **Merge methods**: Squash merge → verify correct method passed to API
5. **No active PR**: No PR → `merge_pr` → error

### PR Status Bar — Component Tests (`src/client/components/PrStatusBar.test.tsx`)
1. Renders branch flow correctly (`main ← feature-branch`)
2. Copy button copies branch name to clipboard
3. Diff stats show correct insertions/deletions with color
4. View PR link opens correct URL in new tab
5. Component doesn't render when prStatus is null
6. **CI indicators**: Pending shows yellow spinner, success shows green check, failure shows red X
7. **Merge button**: Enabled when checks pass, disabled when checks fail
8. **Merge dropdown**: Selecting method updates button behavior
9. **Auto-merge state**: Shows "Auto-merge ✓" with yellow styling when auto-merge is enabled
10. **Merge conflicts**: Button disabled with "merge conflicts" tooltip when `mergeable: false`

## Key Files

| File | Change |
|---|---|
| **Import** | |
| `src/server/types.ts` | Add `WsGitHubImportRepo`, `WsGitHubImportProgress`, `WsGitHubImportComplete`, `WsGitHubSearchRepos`, `WsGitHubSearchResults` |
| `src/server/git.ts` | Add `clone()`, `getDefaultBranch()` |
| `src/server/github-auth.ts` | Add `searchRepos()` |
| `src/server/index.ts` | Add `github_import_repo` and `github_search_repos` handlers |
| `src/client/components/ImportRepoOverlay.tsx` | New: import modal with search |
| `src/client/components/ImportRepoOverlay.test.tsx` | Component tests |
| `src/client/App.tsx` | Add import overlay state, integrate with session list |
| `src/server/integration_tests/github-import.test.ts` | Integration tests |
| **Auto-Push** | |
| `src/server/index.ts` | Add auto-push after auto-commit with debounce |
| `src/server/types.ts` | Extend `SessionMetadata` with `autoPush` field |
| `src/server/sessions.ts` | Persist auto-push preference |
| `src/server/integration_tests/auto-push.test.ts` | Integration tests |
| **PR Status Bar + Merge** | |
| `src/server/types.ts` | Add `WsGetPrStatus`, `WsPrStatus` (with checks, mergeable, autoMergeEnabled), `WsMergePr`, `WsMergePrResult` |
| `src/server/git.ts` | Add `diffStatVsBranch()` |
| `src/server/github-auth.ts` | Add `findPullRequest()`, `mergePullRequest()`, `enableAutoMerge()`, `getCheckStatus()` |
| `src/server/index.ts` | Add `get_pr_status` and `merge_pr` handlers |
| `src/client/components/PrStatusBar.tsx` | New: persistent banner with CI status, merge button + dropdown |
| `src/client/components/PrStatusBar.test.tsx` | Component tests |
| `src/client/App.tsx` | Add prStatus state, merge handler, CI polling, render bar |
| `src/server/integration_tests/pr-status.test.ts` | Integration tests |
| `src/server/integration_tests/merge-pr.test.ts` | Integration tests |

## Dependencies

No new npm packages. All functionality uses existing dependencies:
- `simple-git` for clone/diff operations
- `fetch` for GitHub API calls
- Existing GitHub auth infrastructure

## Complexity

**Import**: Medium. The git clone operation is straightforward, but the UX flow (search, progress, session creation, error handling) has many states to manage. Estimate: ~600-800 lines.

**Auto-Push**: Low. A debounced push call after auto-commit, with condition checks. Estimate: ~100-150 lines.

**PR Status Bar + Merge**: Medium. The status bar itself is simple, but the merge flow has three code paths (direct merge, auto-merge, failure) and requires both REST and GraphQL GitHub API calls. CI polling adds client-side state complexity. Estimate: ~600-800 lines.

**Total**: ~1300-1750 lines of new code.
