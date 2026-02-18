---
status: in-progress
---
# 032 — AI-Generated PR Description

## Summary

Add an "Ask Claude to write description" button to the `PullRequestModal` that generates a PR description by summarizing the session's changes via Claude.

## Motivation

Writing good PR descriptions is tedious. Claude already knows every change it made during the session — it can summarize them better and faster than the user. This turns a manual chore into a one-click action, matching the Cursor and GitHub Copilot experience of AI-generated PR summaries.

## How It Works

### Approach: One-Shot Claude Prompt

The simplest approach is to send a message to the existing Claude process asking it to summarize changes. The response is captured and inserted into the PR description textarea.

#### User Flow

1. User opens `PullRequestModal`
2. Clicks "Ask Claude to write description"
3. Button shows loading state ("Generating...")
4. Claude receives a prompt asking to summarize the session's changes
5. The response text is inserted into the description textarea
6. User can edit the generated description before submitting

#### Prompt

```
Summarize the changes in this session for a pull request description.
Include: what was changed, why, and any testing notes.
Format as markdown with ## Summary and ## Changes sections.
Keep it concise — 5-10 bullet points maximum.
```

### Implementation Options

#### Option A: Use the Existing Claude Process

Send the prompt through the existing `claudeProcess.run()` and capture the result. This is simple but has a trade-off: the summary prompt becomes part of the conversation history, which may confuse subsequent interactions.

#### Option B: Dedicated Summary Endpoint (Recommended)

Add a new WS message type that spawns a short-lived Claude process specifically for PR description generation. This keeps the summary out of the main conversation.

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsGeneratePRDescription {
  type: "generate_pr_description";
}

// Server → Client
export interface WsGeneratedPRDescription {
  type: "generated_pr_description";
  description: string;
}
```

#### Server Handler

```typescript
if (msg.type === "generate_pr_description") {
  try {
    const git = getActiveGitManager();
    const log = await git.log(20); // Recent commits
    const diff = await git.diffSummary(); // Files changed

    const prompt = [
      "Write a pull request description summarizing these changes.",
      "Format as markdown with ## Summary (1-2 sentences) and ## Changes (bullet points).",
      "Keep it concise.",
      "",
      "Recent commits:",
      ...log.map(c => `- ${c.message}`),
      "",
      "Files changed:",
      ...diff.map(f => `- ${f.file} (+${f.insertions} -${f.deletions})`),
    ].join("\n");

    // Spawn a short-lived Claude process for the summary
    const result = await deps.generateText(prompt);

    send({ type: "generated_pr_description", description: result });
  } catch (err) {
    send({ type: "error", message: `Failed to generate description: ${getErrorMessage(err)}` });
  }
}
```

The `generateText` dependency would be a thin wrapper around a Claude API call or a short-lived CLI invocation. This keeps it isolated from the main conversation.

### Client-Side

#### PullRequestModal Changes

Add a button below the description textarea:

```tsx
<button
  onClick={handleGenerateDescription}
  disabled={isGenerating}
  className="text-sm text-blue-400 hover:text-blue-300"
>
  {isGenerating ? "Generating..." : "Ask Claude to write description"}
</button>
```

```typescript
const [isGenerating, setIsGenerating] = useState(false);

const handleGenerateDescription = () => {
  setIsGenerating(true);
  send({ type: "generate_pr_description" });
};

// In message handler:
if (data.type === "generated_pr_description") {
  setBody(data.description);
  setIsGenerating(false);
}
```

#### UX Details

- Button is disabled while generating (shows "Generating..." with spinner)
- Generated text replaces the current description (not appends)
- If the user already typed something, show a confirmation: "Replace current description?"
- On error, show inline error and re-enable button

## Dependencies

This feature needs either:
- A way to make a standalone Claude API call (not through the session's conversation)
- Or a `git log` + `git diff --stat` based summary (no Claude needed, just structured git data)

The git-based approach is simpler and doesn't require API access beyond the existing CLI. The Claude-based approach produces better descriptions but needs the `generateText` abstraction.

## Testing

### Integration Tests (`src/server/integration_tests/pr-description.test.ts`)
1. `generate_pr_description` → receives `generated_pr_description` with markdown content
2. No git history → graceful error or empty description
3. Error from Claude/text generation → error message

### Component Tests (extend `PullRequestModal.test.tsx`)
1. "Ask Claude" button calls handler
2. Loading state shows while generating
3. Generated text populates description textarea
4. Replace confirmation when description already has content
5. Error state re-enables button

## Key Files

| File | Change |
|---|---|
| `src/server/types.ts` | Add `WsGeneratePRDescription`, `WsGeneratedPRDescription` |
| `src/server/index.ts` | Add `generate_pr_description` handler |
| `src/server/git.ts` | Add `diffSummary()` if not present |
| `src/client/components/PullRequestModal.tsx` | Add generate button, loading state, message handling |
| `src/client/components/PullRequestModal.test.tsx` | Extend with generation tests |
| `src/server/integration_tests/pr-description.test.ts` | Integration tests |

## Complexity

Low-medium. The client changes are small (a button + loading state). The main decision is the generation backend — git log summary (simple) vs. Claude API call (better quality). Estimate: ~200-350 lines of new code.
