# Design Doc 002: Project-Level System Prompt

## Status: Proposed

## Problem

Users cannot customize Claude's behavior for their project. Every Claude invocation starts from scratch with no project-specific context. In practice, users repeat the same instructions in every prompt ("always use TypeScript strict mode", "use Tailwind for styling", "follow our REST API conventions"). Claude CLI supports `--system-prompt` but ShipIt does not expose it.

This is especially painful because:
- Users lose context between sessions — they re-explain their stack every time.
- There's no way to encode project conventions or constraints.
- CLAUDE.md in the workspace is read by Claude CLI automatically, but users have no visibility into or control over this from the ShipIt UI.

## Goals

1. Let users view and edit a persistent system prompt via the ShipIt UI.
2. Pass the system prompt to every Claude CLI invocation.
3. Persist the prompt as a file in the workspace so it's version-controlled alongside the project.
4. Support viewing the existing CLAUDE.md file if one exists.

## Non-Goals

- Per-session system prompts (all sessions share the same project prompt).
- Prompt templates or a library of system prompts — users write their own.
- Automatic system prompt generation from codebase analysis.

## Design

### Storage

The system prompt is stored at `/workspace/.shipit/system-prompt.md`. This location:
- Keeps ShipIt config separate from user code.
- Is git-trackable (not in `.gitignore` by default).
- Uses markdown for familiarity and flexibility.

If the file doesn't exist, the system prompt is empty (Claude CLI uses its default behavior, still picking up any top-level `CLAUDE.md`).

### Server Changes

#### `claude.ts` changes

Add `--system-prompt` argument when spawning the Claude CLI, if a system prompt file exists:

```typescript
run(prompt: string, sessionId?: string, systemPrompt?: string): void {
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--allowedTools", "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion",
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  // ... rest unchanged
}
```

#### `index.ts` changes

1. Read the system prompt file before each Claude invocation:
   ```typescript
   const systemPromptPath = path.join(workspaceDir, ".shipit", "system-prompt.md");
   let systemPrompt: string | undefined;
   try {
     systemPrompt = await fs.readFile(systemPromptPath, "utf-8");
     if (!systemPrompt.trim()) systemPrompt = undefined;
   } catch {
     // File doesn't exist — no system prompt
   }
   claude.run(msg.text, msg.sessionId, systemPrompt);
   ```

2. Handle new WebSocket messages for reading/writing the system prompt.

#### New WebSocket messages

| Direction | Type | Payload |
|-----------|------|---------|
| Client → Server | `get_system_prompt` | (none) |
| Server → Client | `system_prompt` | `{ content: string }` — current prompt text (empty string if not set) |
| Client → Server | `set_system_prompt` | `{ content: string }` — new prompt text |
| Server → Client | `system_prompt_saved` | `{ content: string }` — confirmation with saved content |

#### Server-side handler for `set_system_prompt`

```typescript
if (msg.type === "set_system_prompt") {
  const content = msg.content;
  if (typeof content !== "string") {
    send({ type: "error", message: "System prompt must be a string" });
    return;
  }
  if (content.length > 50_000) {
    send({ type: "error", message: "System prompt too long (max 50,000 characters)" });
    return;
  }
  const dir = path.join(workspaceDir, ".shipit");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, "system-prompt.md");
  const trimmed = content.trim();
  if (trimmed) {
    await fs.writeFile(filePath, trimmed + "\n", "utf-8");
  } else {
    // Empty prompt — delete the file
    try { await fs.unlink(filePath); } catch { /* ok if missing */ }
  }
  send({ type: "system_prompt_saved", content: trimmed });
}
```

### Client Changes

#### New component: `SystemPromptEditor` (`src/client/components/SystemPromptEditor.tsx`)

A modal dialog accessible from the header (gear icon or "Settings" button):

```
┌──────────────────────────────────────────────┐
│  Project Instructions                     ✕  │
│                                              │
│  These instructions are sent to Claude with  │
│  every message. Use them to define project   │
│  conventions, preferred libraries, or style  │
│  guidelines.                                 │
│                                              │
│  ┌──────────────────────────────────────────┐│
│  │ Always use TypeScript with strict mode.  ││
│  │ Use Tailwind CSS for styling.            ││
│  │ Follow REST conventions for API routes.  ││
│  │ Write tests for all new components.      ││
│  │                                          ││
│  └──────────────────────────────────────────┘│
│                                              │
│  Note: Claude also reads CLAUDE.md from      │
│  your workspace root automatically.          │
│                                              │
│              [Cancel]  [Save]                │
└──────────────────────────────────────────────┘
```

Key behaviors:
- Loads current system prompt on open (`get_system_prompt`).
- Saves on submit (`set_system_prompt`).
- Shows character count and limit.
- Indicates when prompt is empty vs. populated (e.g., filled/unfilled gear icon in header).

#### State additions in `App.tsx`

```typescript
const [systemPromptOpen, setSystemPromptOpen] = useState(false);
const [hasSystemPrompt, setHasSystemPrompt] = useState(false);
```

#### Header addition

A settings/gear button in the header bar, with a visual indicator (dot or different color) when a system prompt is active:

```tsx
<button
  onClick={() => setSystemPromptOpen(true)}
  className={`p-1.5 rounded ${hasSystemPrompt ? "text-blue-400" : "text-gray-500"}`}
  title="Project instructions"
>
  <GearIcon />
</button>
```

### File Layout

| File | Change |
|------|--------|
| `src/server/claude.ts` | Accept optional `systemPrompt` parameter in `run()` |
| `src/server/types.ts` | Add 4 new message types |
| `src/server/index.ts` | Read system prompt file before Claude spawn, handle get/set messages |
| `src/server/integration.test.ts` | Test get/set system prompt, test that empty/whitespace prompts are rejected appropriately |
| `src/client/App.tsx` | Add state, handlers, gear button in header |
| `src/client/components/SystemPromptEditor.tsx` | New — modal editor component |
| `src/client/components/SystemPromptEditor.test.tsx` | New — component tests |

### Quality Checklist

- [ ] Input validation: Validate `content` is a string, enforce 50KB max, trim whitespace. Empty content deletes the file.
- [ ] Component tests: render empty state, render with existing prompt, save/cancel, character count.
- [ ] Integration tests: `get_system_prompt` returns empty for new workspace, `set_system_prompt` persists and confirms, subsequent Claude invocations include the prompt.
- [ ] Blur/focus edge cases: modal close during save should not lose data — save completes first.
- [ ] Security: system prompt is rendered as plaintext (not HTML) to prevent injection.
