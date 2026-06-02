# Message Editing & Retry

Users can edit or retry any previous user message. Hover over a user message to reveal edit (pencil) and retry (refresh) buttons.

## How it works

1. **Edit**: Pencil icon → inline `MessageEditor` textarea pre-filled with original text. Submit via "Save & Send" or Enter. Escape or "Cancel" dismisses.
2. **Retry**: Refresh icon → immediately resends the same message text.
3. **On submit**: `App.tsx` `handleEditMessage(index, newText)` truncates `messages` array to before the edited message, appends new user message, sends via `send_message`. All messages after the edited one are removed from UI.

## Context behavior

Since the CLI uses `--resume`, Claude retains its full conversation history server-side. The edited/retried message is sent as a new turn. Claude sees the full prior conversation plus the new message — it doesn't "forget" earlier messages removed from the UI. Claude may reference content from messages no longer visible.

## Key design decisions

- **No server changes**: Editing is purely client-side. No new WebSocket message types needed.
- **Truncation, not replacement**: Rather than modifying Claude's conversation history, we truncate the UI and send a new message. Same approach as ChatGPT.
- **Buttons hidden during loading**: Edit/retry buttons suppressed while Claude is responding.
- **Hover reveal**: Buttons use `group-hover:flex`.

## Key files

- `src/client/components/MessageList.tsx` — `MessageEditor` component, edit/retry buttons, `editingIndex` state
- `src/client/App.tsx` — `handleEditMessage` callback
