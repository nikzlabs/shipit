# 060 — Global Notifications: Checklist

## Phase 1: Foundation

- [ ] Define notification types in `src/server/shared/types/notification-types.ts`
- [ ] Add WS message types (`notification`, `notification_snapshot`) to `ws-server-messages.ts`
- [ ] Re-export from `types/index.ts`
- [ ] Implement `NotificationManager` (create, resolve, dismiss, markRead, list, clearForSession, pruneExpired)
- [ ] Add persistence (JSON file, debounced writes, startup pruning)
- [ ] Wire `NotificationManager` into `AppDeps` and `buildApp()`
- [ ] Unit tests for `NotificationManager`

## Phase 2: HTTP + WS endpoints

- [ ] Add notification service functions in `services/notifications.ts`
- [ ] Register HTTP routes: `GET /api/notifications`, `POST .../action`, `POST .../read`, `POST .../dismiss`, `DELETE /api/notifications`
- [ ] Send `notification_snapshot` on WebSocket connect
- [ ] Broadcast `notification` messages on every create/update
- [ ] Integration tests: HTTP endpoints (happy path + error cases)
- [ ] Integration tests: WS broadcast and snapshot delivery
- [ ] Integration tests: cross-tab sync (two clients, action on one updates both)

## Phase 3: Event source hooks

- [ ] Hook Claude `question` event → create `permission_request` notification with resolve callback
- [ ] Hook Claude `result` event → create `session_complete` notification
- [ ] Hook Claude `error`/exit events → create `session_error` notification
- [ ] Hook PR creation flow → create `pr_created` notification
- [ ] Hook deploy success/failure → create `deploy_status` notification
- [ ] Hook message queue → create `queue_update` notification (with replace semantics)
- [ ] Auto-resolve permission notifications when answered via in-session chat UI
- [ ] Auto-resolve notifications when session is deleted (`clearForSession`)
- [ ] Auto-resolve stale permission requests when Claude process exits
- [ ] Integration test: permission request round-trip (Claude event → notification → approve → answer fed back)

## Phase 4: Client UI

- [ ] `NotificationBell` component (icon, badge count, color coding by priority)
- [ ] `NotificationPanel` component (action-needed + recent sections, action buttons, read indicators, timestamps)
- [ ] `PermissionBanner` component (top-of-page banner for high-priority notifications, stacking, overflow)
- [ ] Add notification state to `App.tsx` (state, derived values, WS handler)
- [ ] Handle `notification` and `notification_snapshot` in `useMessageHandler.ts`
- [ ] Wire action buttons to HTTP endpoints via `useApi`
- [ ] Mark-as-read on panel open
- [ ] Navigate to session on notification click
- [ ] Component tests: `NotificationBell` (badge count, colors, toggle)
- [ ] Component tests: `NotificationPanel` (sections, actions, read state)
- [ ] Component tests: `PermissionBanner` (rendering, stacking, auto-dismiss)

## Phase 5: Polish

- [ ] Batch permission requests from same session ("N pending approvals → Approve All")
- [ ] Notification indicator dot on session list sidebar entries
- [ ] Pulse animation on bell for new high-priority notifications
- [ ] Auto-dismiss expired notifications on client render
- [ ] Verify idempotent resolve (approve from chat + notification simultaneously)
- [ ] Verify reconnection hydration (fresh snapshot replaces local state)
