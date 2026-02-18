# 027 — GitHub Repo Import & PR Status Bar

## Summary

Two related GitHub workflow enhancements:

1. **Repo Import**: Clone an existing GitHub repository into a new ShipIt session, so users can start from existing code instead of only from templates or blank projects.
2. **PR Status Bar**: A persistent banner (inspired by Claude Code Desktop) that appears after a PR is created, showing branch flow, diff stats, and a quick "View PR" link.

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

## Part 2: PR Status Bar

### Design (Inspired by Claude Code Desktop)

A compact, persistent banner that appears in the header area whenever a PR is associated with the current session:

```
┌──────────────────────────────────────────────────────────────────┐
│  ⑂  main ← claude/feature-branch  [📋]    +247 -38   [View PR] │
└──────────────────────────────────────────────────────────────────┘
```

**Elements (left to right):**

1. **Git merge icon** (`⑂`): Visual indicator that this is a PR context
2. **Branch flow**: `{base} ← {head}` showing which branch merges into which. The head branch is the current working branch.
3. **Copy button** (`📋`): Copies the head branch name to clipboard (useful for `git checkout` commands or sharing)
4. **Diff stats**: `+{insertions} -{deletions}` — total lines changed vs. the base branch. Green/red colored for visual clarity.
5. **View PR button**: Opens the PR's GitHub URL in a new browser tab

### State Tracking

The PR status bar needs to know:
- Whether a PR exists for the current branch
- The PR URL, number, base branch
- Current diff stats vs. the base branch

This data comes from two sources:
1. **PR creation** (doc 019): When `github_pr_created` fires with `success: true`, store the PR metadata
2. **Existing PRs**: On session load, check if the current branch has an open PR

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
}
```

**Rendering:**

```tsx
export function PrStatusBar({ baseBranch, headBranch, insertions, deletions, prUrl, prNumber }: PrStatusBarProps) {
  const [copied, setCopied] = useState(false);

  const copyBranch = () => {
    navigator.clipboard.writeText(headBranch);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
      <button
        onClick={copyBranch}
        className="text-gray-500 hover:text-gray-300 transition-colors"
        title="Copy branch name"
      >
        {copied ? "✓" : "📋"}
      </button>

      {/* Diff stats */}
      <span className="flex items-center gap-1.5 text-xs">
        <span className="text-green-400">+{insertions}</span>
        <span className="text-red-400">-{deletions}</span>
      </span>

      {/* View PR button */}
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded text-xs font-medium transition-colors"
      >
        View PR
      </a>
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

// Update after successful push
// (in the github_push_result handler)
if (data.type === "github_push_result" && data.success) {
  // Re-fetch PR status — a PR might exist for this branch
  send({ type: "get_pr_status" });
}

// Update after PR creation
if (data.type === "github_pr_created" && data.success) {
  send({ type: "get_pr_status" });
}

// Update after git commit (diff stats change)
if (data.type === "git_committed") {
  if (prStatus) {
    // Refresh diff stats
    send({ type: "get_pr_status" });
  }
}

// Handle PR status response
if (data.type === "pr_status") {
  setPrStatus(data.pr);
}
```

#### Refresh Triggers

The PR status bar refreshes its data when:
1. **Session loads**: Initial fetch to check for existing PRs
2. **After push**: The pushed changes may have created/updated a PR
3. **After PR creation**: The PR was just created via doc 019's modal
4. **After git commit**: Diff stats have changed (debounced — not on every commit, but after Claude turns complete)

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

### PR Status Bar — Integration Tests (`src/server/integration_tests/pr-status.test.ts`)
1. **No PR**: No PR for current branch → `pr_status` with `pr: null`
2. **Existing PR**: PR exists → returns correct metadata and diff stats
3. **No remote**: No origin configured → `pr_status` with `pr: null`
4. **Not authenticated**: Not logged in → `pr_status` with `pr: null`

### PR Status Bar — Component Tests (`src/client/components/PrStatusBar.test.tsx`)
1. Renders branch flow correctly (`main ← feature-branch`)
2. Copy button copies branch name to clipboard
3. Diff stats show correct insertions/deletions with color
4. View PR link opens correct URL in new tab
5. Component doesn't render when prStatus is null

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
| **PR Status Bar** | |
| `src/server/types.ts` | Add `WsGetPrStatus`, `WsPrStatus` |
| `src/server/git.ts` | Add `diffStatVsBranch()` |
| `src/server/github-auth.ts` | Add `findPullRequest()` |
| `src/server/index.ts` | Add `get_pr_status` handler |
| `src/client/components/PrStatusBar.tsx` | New: persistent PR status banner |
| `src/client/components/PrStatusBar.test.tsx` | Component tests |
| `src/client/App.tsx` | Add prStatus state, refresh triggers, render bar |
| `src/server/integration_tests/pr-status.test.ts` | Integration tests |

## Dependencies

No new npm packages. All functionality uses existing dependencies:
- `simple-git` for clone/diff operations
- `fetch` for GitHub API calls
- Existing GitHub auth infrastructure

## Complexity

**Import**: Medium. The git clone operation is straightforward, but the UX flow (search, progress, session creation, error handling) has many states to manage. Estimate: ~600-800 lines.

**PR Status Bar**: Low-medium. One GitHub API call, one git diff stat, one compact UI component. The main complexity is in the refresh triggers (when to re-fetch). Estimate: ~300-400 lines.

**Total**: ~900-1200 lines of new code.
