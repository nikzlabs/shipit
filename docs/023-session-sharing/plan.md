---
status: planned
---
# 023 — Session Sharing

## Summary

Add the ability to export and share ShipIt sessions as self-contained HTML snapshots or JSON bundles. Recipients can view the conversation, file changes, and final state without needing a running ShipIt instance. This is the pragmatic alternative to real-time session sharing (which requires multi-user infrastructure).

## Motivation

Developers often want to share their work:
- Show a teammate how they built a feature (the conversation + code changes)
- Create a tutorial or demonstration of a development workflow
- Archive a session for future reference
- Get code review on a session before merging

The Claude Code App supports session sharing via links (private/team/public). ShipIt runs as a single-user local server, so real-time sharing would require adding auth, access control, and hosting infrastructure — too complex for the current scope.

Instead, ShipIt takes an export-based approach: generate a shareable artifact (HTML or JSON) that captures the full session state.

## How It Works

### Export Formats

#### 1. HTML Snapshot (Primary)

A single self-contained HTML file that includes:
- The full conversation (user messages + assistant responses)
- Inline diffs for all file changes (from tool_use events)
- Session metadata (title, date, duration, cost)
- A lightweight CSS theme matching ShipIt's look
- No external dependencies (all styles inlined)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ShipIt Session: Build JWT Auth</title>
  <style>/* Inlined Tailwind subset + ShipIt styles */</style>
</head>
<body>
  <header>
    <h1>Build JWT Auth</h1>
    <div class="meta">Feb 18, 2026 · 12 turns · $0.42 · 8m 23s</div>
  </header>
  <div class="conversation">
    <div class="message user">Build a JWT authentication system...</div>
    <div class="message assistant">
      I'll create a JWT auth module...
      <div class="tool-use">
        <div class="tool-name">Edit: src/auth/jwt.ts</div>
        <div class="diff">
          <span class="add">+ import jwt from 'jsonwebtoken';</span>
          ...
        </div>
      </div>
    </div>
    <!-- ... more messages ... -->
  </div>
</body>
</html>
```

This can be opened in any browser, shared via email/Slack, or hosted as a static page.

#### 2. JSON Bundle (Secondary)

A structured JSON file containing the raw session data, useful for:
- Importing into another ShipIt instance
- Programmatic analysis of sessions
- Integration with other tools

```json
{
  "version": 1,
  "exportedAt": "2026-02-18T15:30:00Z",
  "session": {
    "id": "abc-123",
    "title": "Build JWT Auth",
    "createdAt": "2026-02-18T14:00:00Z",
    "lastUsedAt": "2026-02-18T15:30:00Z"
  },
  "messages": [
    {
      "role": "user",
      "text": "Build a JWT authentication system...",
      "timestamp": "2026-02-18T14:00:05Z"
    },
    {
      "role": "assistant",
      "text": "I'll create a JWT auth module...",
      "toolUse": [
        {
          "type": "tool_use",
          "name": "Edit",
          "input": { "file_path": "src/auth/jwt.ts", "old_string": "...", "new_string": "..." }
        }
      ]
    }
  ],
  "usage": {
    "totalCostUsd": 0.42,
    "totalDurationMs": 503000,
    "turnCount": 12
  },
  "threads": [],
  "gitLog": [
    { "hash": "abc123", "message": "Add JWT module", "date": "...", "author": "ShipIt" }
  ]
}
```

### Server-Side

#### Session Exporter Module (`src/server/session-export.ts`)

```typescript
export interface ExportOptions {
  format: "html" | "json";
  /** Include tool use details (file diffs, bash commands). Default: true. */
  includeToolUse?: boolean;
  /** Include full file contents (not just diffs). Default: false. */
  includeFileContents?: boolean;
  /** Redact sensitive data (API keys, tokens in bash output). Default: true. */
  redactSecrets?: boolean;
}

export interface ExportResult {
  content: string;
  filename: string;
  mimeType: string;
}

/**
 * Export a session as a self-contained artifact.
 */
export async function exportSession(
  sessionId: string,
  chatHistoryManager: ChatHistoryManager,
  sessionManager: SessionManager,
  usageManager: UsageManager,
  threadManager: ThreadManager,
  gitManager: GitManager,
  options: ExportOptions,
): Promise<ExportResult>;
```

**HTML generation**: Template-based. A minimal HTML template with inlined CSS (extracted subset of Tailwind utilities used by ShipIt). Messages are rendered as HTML elements. Tool use blocks are rendered as collapsible diffs. No JavaScript needed (pure static HTML).

**Secret redaction**: Scan tool_use inputs and outputs for patterns like `sk-`, `ghp_`, `Bearer `, API keys, tokens. Replace with `[REDACTED]`.

#### New Types

```typescript
// src/server/types.ts — additions

// Client → Server
export interface WsExportSession {
  type: "export_session";
  sessionId: string;
  format: "html" | "json";
  includeToolUse?: boolean;
  redactSecrets?: boolean;
}

// Server → Client
export interface WsSessionExported {
  type: "session_exported";
  /** Base64-encoded content of the exported file. */
  content: string;
  filename: string;
  mimeType: string;
}
```

#### HTTP Endpoint (Alternative)

Instead of sending the export over WebSocket (which would be large), add an HTTP GET endpoint:

```
GET /api/export/{sessionId}?format=html&redact=true
```

Returns the file directly with appropriate `Content-Type` and `Content-Disposition` headers. This allows the browser to download the file natively.

```typescript
// In buildApp():
app.get("/api/export/:sessionId", async (request, reply) => {
  const { sessionId } = request.params as { sessionId: string };
  const format = (request.query as { format?: string }).format || "html";
  const redact = (request.query as { redact?: string }).redact !== "false";

  const result = await exportSession(sessionId, chatHistoryManager, sessionManager, usageManager, threadManager, createGitManager(session.workspaceDir!), {
    format: format as "html" | "json",
    redactSecrets: redact,
  });

  reply
    .header("Content-Type", result.mimeType)
    .header("Content-Disposition", `attachment; filename="${result.filename}"`)
    .send(result.content);
});
```

**Recommended: HTTP endpoint.** WebSocket is wrong for large binary payloads. The HTTP endpoint is simpler and lets the browser handle the download.

### Client-Side

#### Share/Export Button

Add to the session context menu (right-click or dropdown in SessionSelector):

```
Session: Build JWT Auth
├── Resume
├── Rename
├── Export as HTML
├── Export as JSON
├── Delete
```

Or as a dedicated "Share" button in the header when a session is active:

```
┌──────────────────────────────────────────────┐
│ ShipIt   [Build JWT Auth ▼]   [Share]  ...   │
└──────────────────────────────────────────────┘
```

Clicking "Share" opens a small dropdown:
```
┌─────────────────────────┐
│ Export session as:       │
│                         │
│ 📄 HTML (viewable)      │
│ 📦 JSON (data)          │
│                         │
│ ☑ Include tool details  │
│ ☑ Redact secrets        │
└─────────────────────────┘
```

#### Download Flow

1. User clicks export option
2. Client triggers browser download:
   ```typescript
   const url = `/api/export/${sessionId}?format=html&redact=true`;
   const a = document.createElement('a');
   a.href = url;
   a.download = `shipit-session-${title}.html`;
   a.click();
   ```
3. Browser downloads the file

No modal, no loading state — it's a direct download via the HTTP endpoint.

### HTML Template Design

The exported HTML should look like a clean, readable document:

```
┌──────────────────────────────────────────────┐
│ ShipIt Session Export                        │
│                                              │
│ Build JWT Auth                               │
│ Feb 18, 2026 · 12 turns · $0.42 · 8m 23s    │
│                                              │
│ ─────────────────────────────────────────── │
│                                              │
│ 👤 User                                     │
│ Build a JWT authentication system for my     │
│ Express app...                               │
│                                              │
│ 🤖 Claude                                   │
│ I'll create a JWT auth module with login,    │
│ refresh, and middleware. Let me start by...  │
│                                              │
│ ┌─ Edit: src/auth/jwt.ts ──────────────────┐│
│ │ + import jwt from 'jsonwebtoken';        ││
│ │ + import { User } from '../models';      ││
│ │ +                                        ││
│ │ + export function generateToken(user) {  ││
│ │ +   return jwt.sign(...)                 ││
│ │ + }                                      ││
│ └──────────────────────────────────────────┘│
│                                              │
│ 👤 User                                     │
│ Add token refresh logic too                  │
│                                              │
│ ...                                          │
│                                              │
│ ─────────────────────────────────────────── │
│ Generated by ShipIt · shipit.dev             │
└──────────────────────────────────────────────┘
```

### Import (Future Enhancement)

A future enhancement could allow importing JSON bundles to recreate sessions:
- Upload the JSON file
- Create a new session with the imported metadata
- Populate chat history
- Optionally replay the file changes

This is out of scope for the initial implementation but the JSON format is designed to support it.

## Testing

### Unit Tests (`src/server/session-export.test.ts`)
1. **HTML export**: Export a session with messages → verify valid HTML output with correct content
2. **JSON export**: Export → verify JSON structure matches schema
3. **Secret redaction**: Include messages with API keys → verify they're replaced with `[REDACTED]`
4. **Empty session**: Export session with no messages → verify graceful output
5. **Tool use rendering**: Messages with tool_use → verify diffs appear in HTML
6. **Large session**: Export 100+ messages → verify no crashes or truncation

### Integration Tests (`src/server/integration_tests/session-sharing.test.ts`)
1. **HTTP endpoint**: `GET /api/export/{id}?format=html` → 200 with correct headers
2. **Unknown session**: `GET /api/export/nonexistent` → 404
3. **JSON format**: `GET /api/export/{id}?format=json` → valid JSON
4. **Content-Disposition**: Verify filename header is correct

### Component Tests
1. Export button appears in session context menu
2. Clicking export triggers download
3. Options (format, redact) are passed correctly

## Key Files

| File | Change |
|---|---|
| `src/server/session-export.ts` | New module: `exportSession()` function |
| `src/server/session-export.test.ts` | Unit tests for export logic |
| `src/server/index.ts` | Add `/api/export/:sessionId` HTTP route |
| `src/client/components/SessionSelector.tsx` | Add export options to session context menu |
| `src/client/components/ExportDropdown.tsx` | New component (optional — could be inline) |
| `src/server/integration_tests/session-sharing.test.ts` | Integration tests |

## Complexity

Medium. The core work is the HTML template generation and secret redaction logic. No new infrastructure needed — it's a read-only operation over existing data (chat history, session metadata, usage stats). Estimate: ~500-700 lines of new code.

The HTML template needs careful design to look good without external CSS/JS frameworks, but it's a one-time effort. Using a minimal subset of Tailwind utilities (inlined) keeps it maintainable.
