# 019 — In-App Pull Request Creation

## Summary

Add the ability to create GitHub pull requests directly from ShipIt's UI, completing the push → PR → review workflow without leaving the browser.

## Motivation

ShipIt already has GitHub integration: token-based auth, push, pull, create repo, set remote. But the workflow stops at `push` — users must switch to GitHub's web UI to create a pull request. This context switch breaks the flow, especially for vibe coding sessions where the user wants to go from idea → code → PR in one sitting.

The Claude Code App includes built-in PR creation from its diff viewer. ShipIt should match this capability since all the prerequisites (auth, push, remote) are already in place.

## How It Works

### Prerequisites

Before creating a PR, the user must have:
1. A GitHub token set (via the existing `github_set_token` flow)
2. A remote configured (via `github_set_remote` or auto-configured after `github_create_repo`)
3. Changes pushed to a branch (via `github_push`)

The PR creation flow should validate these prerequisites and guide the user through any missing steps.

### Server-Side

#### New GitHubAuthManager Method

```typescript
// src/server/github-auth.ts — addition

/**
 * Create a pull request on GitHub.
 * Returns the PR URL on success, or an error message.
 */
async createPullRequest(options: {
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;     // source branch
  base: string;     // target branch (e.g., "main")
  draft?: boolean;
}): Promise<{ success: boolean; url?: string; number?: number; message?: string }> {
  if (!this._token) {
    return { success: false, message: "Not authenticated with GitHub" };
  }

  const res = await fetch(
    `https://api.github.com/repos/${options.owner}/${options.repo}/pulls`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this._token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "ShipIt",
      },
      body: JSON.stringify({
        title: options.title,
        body: options.body,
        head: options.head,
        base: options.base,
        draft: options.draft ?? false,
      }),
    }
  );

  if (!res.ok) {
    const err = await res.json();
    return { success: false, message: err.message || `GitHub API returned ${res.status}` };
  }

  const data = await res.json();
  return {
    success: true,
    url: data.html_url,
    number: data.number,
  };
}
```

#### New GitManager Methods

```typescript
// src/server/git.ts — additions

/** List remote branches. */
async listRemoteBranches(remote = "origin"): Promise<string[]> {
  const result = await this.git.branch(["-r"]);
  return result.all
    .filter(b => b.startsWith(`${remote}/`))
    .map(b => b.replace(`${remote}/`, ""));
}

/** Parse owner/repo from a GitHub remote URL. */
static parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  // Handle HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // Handle SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/github\.com:([^/]+)\/([^/.]+)/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}
```

#### New Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsGitHubCreatePR {
  type: "github_create_pr";
  title: string;
  body: string;
  base: string;        // target branch
  draft?: boolean;
}

// Server → Client
export interface WsGitHubPRCreated {
  type: "github_pr_created";
  success: boolean;
  url?: string;
  number?: number;
  message?: string;
}

// Client → Server (for branch listing)
export interface WsGitHubListBranches {
  type: "github_list_branches";
}

// Server → Client
export interface WsGitHubBranches {
  type: "github_branches";
  current: string;
  remote: string[];
}
```

#### Handler in `src/server/index.ts`

```typescript
if (msg.type === "github_create_pr") {
  if (!githubAuthManager.authenticated) {
    send({ type: "error", message: "Not authenticated with GitHub" });
    return;
  }

  const title = typeof msg.title === "string" ? msg.title.trim() : "";
  const body = typeof msg.body === "string" ? msg.body.trim() : "";
  const base = typeof msg.base === "string" ? msg.base.trim() : "";

  if (!title) {
    send({ type: "error", message: "PR title is required" });
    return;
  }
  if (title.length > 256) {
    send({ type: "error", message: "PR title too long (max 256 characters)" });
    return;
  }
  if (!base) {
    send({ type: "error", message: "Base branch is required" });
    return;
  }

  try {
    const git = getActiveGitManager();
    const remotes = await git.getRemotes();
    const origin = remotes.find(r => r.name === "origin");
    if (!origin) {
      send({ type: "error", message: "No 'origin' remote configured" });
      return;
    }

    const parsed = GitManager.parseGitHubRemote(origin.url);
    if (!parsed) {
      send({ type: "error", message: "Remote URL is not a GitHub repository" });
      return;
    }

    const head = await git.getCurrentBranch();

    const result = await githubAuthManager.createPullRequest({
      owner: parsed.owner,
      repo: parsed.repo,
      title,
      body,
      head,
      base,
      draft: msg.draft,
    });

    send({
      type: "github_pr_created",
      success: result.success,
      url: result.url,
      number: result.number,
      message: result.message,
    });
  } catch (err) {
    send({ type: "error", message: `Failed to create PR: ${getErrorMessage(err)}` });
  }
}
```

### Client-Side

#### PullRequestModal Component (`src/client/components/PullRequestModal.tsx`)

A modal dialog for creating pull requests:

```
┌─────────────────────────────────────────┐
│  Create Pull Request                 [×]│
├─────────────────────────────────────────┤
│                                         │
│  From: feature-branch (current)         │
│  Into: [main ▼]  (base branch select)   │
│                                         │
│  Title:                                 │
│  ┌─────────────────────────────────────┐│
│  │ Add JWT authentication              ││
│  └─────────────────────────────────────┘│
│                                         │
│  Description:                           │
│  ┌─────────────────────────────────────┐│
│  │ ## Summary                          ││
│  │ - Replaced session-based auth...    ││
│  │ - Added token refresh logic...      ││
│  │                                     ││
│  └─────────────────────────────────────┘│
│                                         │
│  ☐ Create as draft                      │
│                                         │
│  [Cancel]              [Create PR]      │
│                                         │
│  ─── or ───                             │
│  [Ask Claude to write description]      │
└─────────────────────────────────────────┘
```

**Features:**
- **Branch display**: Shows current branch (head) as read-only, base branch as a dropdown populated from remote branches
- **Title**: Pre-populated from the latest commit message or session title
- **Body**: Markdown textarea. Option to auto-generate via Claude ("Ask Claude to write description" button sends a prompt asking Claude to summarize the changes)
- **Draft toggle**: Checkbox for draft PRs
- **Validation**: Title required, base branch required, shows error messages inline
- **Success state**: Shows PR URL as a clickable link after creation

#### Integration Points

**Header button**: Add a "PR" button near the existing GitHub and Deploy buttons in the header. Only visible when GitHub is authenticated and a remote is configured.

**Post-push flow**: After a successful `github_push_result`, show a toast/banner: "Pushed to origin/branch-name. [Create PR]"

**Claude-generated description**: The "Ask Claude" button sends:
```
Summarize the changes in this session for a pull request description.
Include: what was changed, why, and any testing notes.
Format as markdown with ## Summary and ## Changes sections.
```
The response is captured and inserted into the body textarea.

## Testing

### Integration Tests (`src/server/integration_tests/pr-creation.test.ts`)
1. **Happy path**: Authenticated + remote configured → `github_create_pr` → success with URL
2. **Missing auth**: No GitHub token → error message
3. **Missing remote**: No origin remote → error message
4. **Non-GitHub remote**: Remote URL is not GitHub → error message
5. **Empty title**: Validation error
6. **Branch listing**: `github_list_branches` returns current + remote branches

### Component Tests (`src/client/components/PullRequestModal.test.tsx`)
1. Renders with branch and title fields
2. Submit calls handler with correct data
3. Empty title shows validation error
4. Draft checkbox toggles draft state
5. Success state shows PR URL
6. Cancel closes modal

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsGitHubCreatePR`, `WsGitHubPRCreated`, `WsGitHubListBranches`, `WsGitHubBranches` |
| `src/server/github-auth.ts` | Add `createPullRequest()` method |
| `src/server/git.ts` | Add `listRemoteBranches()`, `parseGitHubRemote()` |
| `src/server/index.ts` | Add `github_create_pr` and `github_list_branches` handlers |
| `src/client/components/PullRequestModal.tsx` | New component |
| `src/client/components/PullRequestModal.test.tsx` | Component tests |
| `src/client/App.tsx` | Add PR modal state, trigger after push |
| `src/server/integration_tests/pr-creation.test.ts` | Integration tests |

## Complexity

Low-medium. Mostly API integration (one GitHub endpoint) + a form modal. All prerequisites (auth, git operations) already exist. Estimate: ~400-600 lines of new code.
