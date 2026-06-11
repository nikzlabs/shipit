# Checklist

- [x] Add `account_reauthenticated` event to the Claude OAuth refresher, emitted on revoked → recovered.
- [x] Mirror the event in the Codex OAuth refresher.
- [x] Add `markProviderAccountReauthenticated` (idempotent) in `app-lifecycle.ts`.
- [x] Wire the event → helper in `index.ts` for both Claude and Codex.
- [x] Unit tests: refresher emits on recovery (not on healthy rotation); helper flips `auth_failed` → `ready` and is a no-op when already `ready`.
- [x] Typecheck + lint clean.
