---
description: Unified notification center surfacing tool approvals, session errors, PR events, and deploy results across all sessions with inline actions.
issue: https://linear.app/shipit-ai/issue/SHI-33/global-notification-system
---

# 060 — Global Notification System

A unified, always-visible notification center that surfaces actionable items (tool approvals, PR reviews, deploy results, session errors) regardless of which session the user is viewing. Decouples user attention from session focus so multiple Claude sessions can run in parallel without blocking on missed permission prompts.

## Motivation

Today, every actionable event in ShipIt is embedded inside a specific session's chat stream. If Claude needs tool approval in session A and the user is reading session B, Claude sits idle — the user has no idea anything is waiting. This gets worse as users run more concurrent sessions.

The notification system solves three problems:

1. **Visibility** — surface blocked/waiting states globally so the user never misses an action item.
2. **Speed** — allow inline actions (approve/deny) directly from the notification, without navigating to the session first.
3. **Awareness** — give a persistent, at-a-glance view of what's happening across all sessions (completed tasks, errors, deploy results).

## Design overview

### Notification lifecycle

```
Event source (Claude, deploy, git, etc.)
  │
  ▼
NotificationManager.create(notification)
  │
  ├──▶ Persist to disk (per-user JSON)
  │
  └──▶ Broadcast via WebSocket ──▶ All connected tabs
                                       │
                                       ▼
                                 Notification UI
                                 (bell badge + panel + banners)
                                       │
                                       ▼
                              User takes action (approve, dismiss, navigate)
                                       │
                                       ▼
                              POST /api/notifications/:id/action
                                       │
                                       ▼
                              NotificationManager.resolve()
                                       │
                                       ├──▶ Execute side-effect (e.g. answer permission question)
                                       └──▶ Broadcast updated notification to all tabs
```

### Core types

```typescript
type NotificationType =
  | "permission_request"   // Claude needs tool approval — blocks progress
  | "session_complete"     // Claude finished its turn in a session
  | "session_error"        // Claude crashed or hit an unrecoverable error
  | "pr_created"           // A PR was created via git push / gh CLI
  | "deploy_status"        // Deploy succeeded or failed
  | "queue_update";        // User's message moved in the queue

type NotificationPriority = "high" | "medium" | "low";

interface NotificationAction {
  id: string;              // stable identifier for this action
  label: string;           // display text: "Approve", "Deny", "View PR"
  actionType: string;      // machine-readable: "approve_tool", "deny_tool", "navigate", "dismiss"
  variant: "primary" | "secondary" | "danger";
  payload?: Record<string, unknown>;  // context passed back to server on action
}

interface AppNotification {
  id: string;                          // unique ID (nanoid)
  type: NotificationType;
  sessionId: string;
  sessionName: string;                 // human-readable, so the user knows context without navigating
  title: string;                       // short: "Tool approval needed"
  body: string;                        // detail: "Claude wants to run: npm test"
  priority: NotificationPriority;
  actions: NotificationAction[];       // inline action buttons
  createdAt: string;                   // ISO 8601
  read: boolean;                       // user has seen it (panel was open, or banner was visible)
  resolved: boolean;                   // action was taken or notification was dismissed
  resolvedAction?: string;             // which action was taken (action id)
  resolvedAt?: string;                 // ISO 8601
  expiresAt?: string;                  // optional auto-dismiss (e.g. queue updates)
  metadata?: Record<string, unknown>;  // type-specific data (PR URL, deploy ID, tool name, etc.)
}
```

### Notification types in detail

#### Permission requests (high priority)

The highest-value notification type. When Claude emits a permission question event (already parsed from the NDJSON stream in `claude.ts`), the system creates a notification with Approve/Deny actions. Resolving the notification feeds the answer back to the Claude process via the existing `answer_question` mechanism.

- **Title**: "Tool approval needed"
- **Body**: tool name + truncated input (e.g., `Bash: npm test`)
- **Actions**: Approve (primary), Deny (danger)
- **Auto-resolve**: if the user answers via the in-session chat UI (the existing flow), the notification should resolve automatically to stay in sync
- **Expiry**: none — persists until resolved or session ends

#### Session complete (low priority)

Fires when Claude's turn ends (the `result` event from the NDJSON stream). Useful when the user kicked off work in a session and moved elsewhere.

- **Title**: "Session finished"
- **Body**: first ~100 chars of Claude's final message, or a summary
- **Actions**: View (navigate to session)
- **Auto-dismiss**: after 5 minutes if unread, or immediately if the user is already viewing that session

#### Session error (high priority)

Fires on `claude_error` events or unexpected process exits.

- **Title**: "Session error"
- **Body**: error message
- **Actions**: View (navigate to session), Dismiss
- **Auto-dismiss**: none

#### PR created (medium priority)

Fires when a git push results in a PR (detected from Claude's output or from the explicit `create_pr` service flow).

- **Title**: "PR created"
- **Body**: PR title + number
- **Actions**: View PR (opens GitHub URL), Dismiss
- **Metadata**: `{ prUrl, prNumber, repoFullName }`
- **Auto-dismiss**: after 30 minutes if unread

#### Deploy status (medium priority)

Fires on deploy success or failure.

- **Title**: "Deploy succeeded" / "Deploy failed"
- **Body**: target name + URL (success) or error summary (failure)
- **Actions**: View Site (on success), View Logs (on failure), Dismiss
- **Metadata**: `{ deployId, targetType, siteUrl }`

#### Queue update (low priority)

Fires when the user's queued message changes position or starts executing. These are ephemeral — they replace previous queue notifications for the same session.

- **Title**: "Message queued" / "Your turn"
- **Body**: position or "Claude is working on your message"
- **Actions**: Cancel (cancels queued message), View
- **Replaces**: previous queue notification for the same session
- **Auto-dismiss**: immediately on resolution

## Server-side design

### NotificationManager

A new manager class following existing patterns (injectable via `AppDeps`, stores state in memory + persists to JSON on disk).

**Responsibilities:**

- `create(notification)` — validate, assign ID + timestamps, persist, broadcast
- `resolve(notificationId, actionId)` — mark resolved, execute side-effect callback, persist, broadcast
- `markRead(notificationIds)` — mark notifications as read, broadcast
- `dismiss(notificationId)` — mark resolved with "dismissed" action, broadcast
- `list(filters?)` — return notifications with optional filtering (unresolved, by type, by session)
- `clearForSession(sessionId)` — resolve all notifications when a session is deleted
- `pruneExpired()` — periodic cleanup of expired/old resolved notifications

**Side-effect callbacks:** When a notification is created, the caller can attach a `resolve` callback. For permission requests, this callback calls the existing `answer_question` plumbing to feed the answer back to the Claude process. This keeps the notification system generic — it doesn't know about Claude internals.

**Persistence:** JSON file at a known path (similar to `SessionManager`). Notifications older than 24 hours and resolved are pruned on startup. In-memory map of `id → AppNotification` for fast access. Writes are debounced (not every notification triggers a disk write).

**Cross-tab sync:** The manager holds a reference to the broadcast function (or emits events that the WS layer picks up). Every mutation broadcasts the delta (created/updated notification) to all connected WebSocket clients, not just the one that triggered the action.

### HTTP endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/notifications` | List notifications (query params: `unresolved`, `sessionId`, `type`, `limit`) |
| `POST` | `/api/notifications/:id/action` | Execute an action on a notification (body: `{ actionId }`) |
| `POST` | `/api/notifications/:id/read` | Mark a notification as read |
| `POST` | `/api/notifications/read` | Batch mark-as-read (body: `{ ids: string[] }`) |
| `POST` | `/api/notifications/:id/dismiss` | Dismiss a notification |
| `DELETE` | `/api/notifications` | Clear all resolved notifications |

Actions are HTTP (not WS) because they're simple mutations — the result is a standard request/response, and the WS layer handles broadcasting the state change to other tabs.

### WebSocket messages

Server → Client only. Notifications are pushed; actions come back over HTTP.

```typescript
// Sent when a notification is created or updated
interface WsNotification {
  type: "notification";
  notification: AppNotification;
}

// Sent on connect or reconnect — full snapshot for hydration
interface WsNotificationSnapshot {
  type: "notification_snapshot";
  notifications: AppNotification[];
}
```

The snapshot message is sent when a WebSocket connection is established, so new tabs or reconnecting tabs get the full current state without a separate HTTP fetch.

### Integration with existing event sources

Notification creation is wired into existing event flows — no new event sources needed:

| Event source | Where to hook | Notification type |
|---|---|---|
| Claude permission question | `claude.ts` `question` event handler in session runner | `permission_request` |
| Claude turn complete | `claude.ts` `result` event handler in session runner | `session_complete` |
| Claude process error | `claude.ts` `error`/`exit` event handler in session runner | `session_error` |
| PR created | `services/github.ts` after successful PR creation | `pr_created` |
| Deploy result | `deploy-handlers.ts` on deploy success/failure events | `deploy_status` |
| Message queued | `send-message.ts` queue logic | `queue_update` |

Each hook calls `notificationManager.create(...)` with the appropriate type and an optional resolve callback. The notification system is a consumer of existing events, not a new event source.

## Client-side design

### UI components

#### NotificationBell

Persistent icon in the top bar (header area). Shows a badge with the count of unresolved notifications. Badge uses color coding:

- **Red badge** — at least one high-priority unresolved notification (permission request, error)
- **Yellow badge** — medium-priority unresolved notifications only
- **Gray badge** — low-priority only
- **No badge** — everything resolved or dismissed

Clicking the bell toggles the notification panel.

Optional: gentle pulse animation on the bell when a new high-priority notification arrives.

#### NotificationPanel

Slide-out panel (or dropdown anchored to the bell icon) listing all recent notifications. Sections:

- **Action needed** — unresolved notifications, sorted by priority then recency
- **Recent** — resolved notifications from the last hour, faded styling

Each notification row shows:
- Session name (as a subtle label/chip)
- Title + body (truncated)
- Relative timestamp ("2m ago")
- Action buttons (inline, right-aligned)
- Read/unread indicator (dot or bold styling)

Clicking a notification row (outside action buttons) navigates to the relevant session.

Panel auto-marks notifications as read when they become visible (intersection observer or on-open).

#### PermissionBanner

For high-priority `permission_request` notifications, a persistent banner appears at the top of the main content area (below the header, above the chat). This ensures the user sees blocked sessions even without opening the panel.

- Shows the session name, tool name, and Approve/Deny buttons inline
- Stacks if multiple sessions are blocked (max 3 visible, "+N more" overflow)
- Dismisses automatically when the notification is resolved (from any source)

### State management

Notification state lives in `App.tsx` (consistent with the rest of the app). Hydrated from the `notification_snapshot` WS message on connect, then incrementally updated via `notification` WS messages.

```typescript
// App.tsx state
const [notifications, setNotifications] = useState<AppNotification[]>([]);
const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);

// Derived
const unresolvedCount = notifications.filter(n => !n.resolved).length;
const hasHighPriority = notifications.some(n => !n.resolved && n.priority === "high");
```

Actions (approve, dismiss, etc.) call the HTTP endpoints via `useApi`, and the server broadcasts the updated notification back over WS to all tabs — so the local state updates via the WS handler, not from the HTTP response. This keeps multi-tab sync simple and avoids race conditions.

### Interaction with existing UI

- **Permission questions in chat**: The existing in-session permission UI should continue to work. When the user answers a permission question via the chat UI, the session runner resolves the corresponding notification (by callback). Conversely, when the user approves via the notification system, the chat UI should show the answer was provided (the existing `answer_question` WS flow handles this).
- **Session list sidebar**: Could optionally show a small notification indicator per session (a dot for sessions with unresolved notifications), but this is a polish item, not required for v1.
- **Sound/vibration**: Not in v1. Could be added later behind a setting.

## Edge cases

1. **Race condition: approve from chat and notification simultaneously** — The resolve callback should be idempotent. If the permission question has already been answered, the second answer is a no-op. The notification resolves either way.

2. **Session deleted while notifications pending** — `clearForSession()` resolves all notifications for that session with a "session_deleted" action. The notification shows as "Session no longer exists" if the user tries to navigate.

3. **Reconnection** — On WS reconnect, the server sends a fresh `notification_snapshot`. The client replaces its local state entirely. No merge logic needed.

4. **Notification volume** — If Claude is processing many tool calls with auto-approve off, this could generate many permission notifications rapidly. Mitigation: batch permission requests from the same session into a single notification that updates in-place (replace semantics), or group them in the panel with "N pending approvals in Session X → Approve All / View".

5. **Expired notifications** — Notifications with `expiresAt` in the past are filtered out on the client. The server prunes them periodically. The client doesn't need to run timers — just filter on render.

6. **Tab focus** — When the user has multiple tabs open, all tabs receive WS broadcasts. Only the focused tab should play sound or show browser-level notifications (future enhancement). For v1, all tabs update their in-app UI identically, which is correct.

7. **Stale permission requests** — If a Claude process exits (crash, timeout) before a permission request is resolved, the notification should auto-resolve with a "session_ended" status so it doesn't linger as actionable.

## Testing strategy

### Integration tests

- NotificationManager unit tests: create, resolve, dismiss, markRead, clearForSession, pruneExpired, persistence round-trip
- HTTP endpoint tests via `app.inject()`: list with filters, action execution, batch read, dismiss, clear
- WS broadcast tests via `TestClient`: verify `notification` and `notification_snapshot` messages are sent at the right times
- Cross-tab simulation: two `TestClient` instances, action on one produces update on both
- Permission request round-trip: simulate Claude question event → notification created → approve via HTTP → answer fed back to Claude process

### Component tests

- `NotificationBell`: badge count, color coding, click toggles panel
- `NotificationPanel`: renders action-needed and recent sections, fires action callbacks, marks as read on open
- `PermissionBanner`: renders for high-priority notifications, stacks correctly, dismiss on resolve

## Key files

| File | Change |
|------|--------|
| `src/server/shared/types/notification-types.ts` | Create — `AppNotification`, `NotificationAction`, `NotificationType`, etc. |
| `src/server/shared/types/index.ts` | Edit — re-export notification types |
| `src/server/shared/types/ws-server-messages.ts` | Edit — add `WsNotification`, `WsNotificationSnapshot` |
| `src/server/orchestrator/notification-manager.ts` | Create — `NotificationManager` class |
| `src/server/orchestrator/services/notifications.ts` | Create — service functions for notification actions |
| `src/server/orchestrator/api-routes.ts` | Edit — register notification HTTP endpoints |
| `src/server/orchestrator/index.ts` | Edit — instantiate `NotificationManager`, add to `AppDeps`, wire WS snapshot on connect |
| `src/server/orchestrator/session-runner.ts` | Edit — hook Claude events to create notifications |
| `src/server/orchestrator/ws-handlers/misc-handlers.ts` | Edit — or new `notification-handlers.ts` if scope warrants |
| `src/client/components/NotificationBell.tsx` | Create — bell icon + badge |
| `src/client/components/NotificationPanel.tsx` | Create — slide-out notification list |
| `src/client/components/PermissionBanner.tsx` | Create — top-of-page banner for high-priority items |
| `src/client/App.tsx` | Edit — notification state, WS handler, render bell + banner |
| `src/client/hooks/useMessageHandler.ts` | Edit — handle `notification` and `notification_snapshot` messages |
| `src/server/orchestrator/integration_tests/notifications.test.ts` | Create — integration tests |
| `src/client/components/NotificationBell.test.tsx` | Create — component tests |
| `src/client/components/NotificationPanel.test.tsx` | Create — component tests |
| `src/client/components/PermissionBanner.test.tsx` | Create — component tests |
