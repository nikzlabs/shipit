# Checklist — component & helper de-duplication

Each item shipped as its own PR. All merged into `main`.

## Batch 1 — clean & self-contained
- [x] A. `<CopyButton>` primitive + adopt at 4 sites (message-markdown, SessionDiagnosticsPanel, CodexAuthCard, PrActionsMenu)
- [x] B. `<Avatar>` primitive + adopt at 3 sites (IssueDetail, PrConversationSection, IssuesFilterBar)
- [x] C. `attachWorkerResponseHandler()` in worker-http.ts (collapse POST/PUT/GET)
- [x] D. `getLocalStorageObject()` / `parseJsonWithFallback()` + adopt in local-storage.ts & stores

## Batch 2 — adopt/extend existing primitives
- [x] E. Route ad-hoc metric badges through `<Badge>` (UptimeBadge, DockerMemoryBadge, SubscriptionLimitsBadge)
- [x] G. Add `size="icon"` to `<Button>` + adopt at icon-button sites
- [x] F. Add inline/callout variant to `<Banner>` + adopt at 6 sites

## Batch 3 — server sweep
- [x] H. `validateString/Number/StringArray/NonEmptyString` helpers (`services/validation.ts`) + adopt across services

## Deferred — not committed work
The catalog's "Explicitly not doing" items (the `handleServiceRoute` wrapper, `usePolling`, a
generic event-listener hook, and the intentional `store.getState()` cross-refs) are decisions,
not pending tasks — they live in `plan.md` and are revisited only if a concrete need emerges.
All planned refactors (A–H) are complete.
