# Checklist — component & helper de-duplication

Each item is an independently shippable PR. Order follows the suggested sequencing in `plan.md`.

## Batch 1 — clean & self-contained
- [ ] A. `<CopyButton>` primitive + adopt at 4 sites (message-markdown, SessionDiagnosticsPanel, CodexAuthCard, PrActionsMenu)
- [ ] B. `<Avatar>` primitive + adopt at 3 sites (IssueDetail, PrConversationSection, IssuesFilterBar)
- [ ] C. `attachWorkerResponseHandler()` in worker-http.ts (collapse POST/PUT/GET)
- [ ] D. `getLocalStorageObject()` / `parseJsonWithFallback()` + adopt in local-storage.ts & stores

## Batch 2 — adopt/extend existing primitives
- [ ] E. Route ad-hoc metric badges through `<Badge>` (UptimeBadge, DockerMemoryBadge, SubscriptionLimitsBadge)
- [ ] G. Add `size="icon"` to `<Button>` + adopt at ~6 icon-button sites
- [ ] F. Add inline/callout variant to `<Banner>` (or sibling `<Alert>`) + adopt at ~6 sites

## Batch 3 — server sweep
- [ ] H. `validateString/Number/StringArray/NonEmptyString` helpers + adopt across services

## Deferred (see plan.md "Explicitly not doing")
- [ ] handleServiceRoute wrapper — only if it emerges naturally
- [ ] usePolling hook — pending a clean API
- [ ] Generic event-listener hook — needs correct cleanup design
