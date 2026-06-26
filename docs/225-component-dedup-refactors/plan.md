---
issue: https://linear.app/shipit-ai/issue/SHI-212
title: Component & helper de-duplication refactors
description: A vetted catalog of duplicated UI/logic worth collapsing into shared primitives, ranked by payoff.
---

# Component & helper de-duplication refactors

A catalog of **verified** duplication in the codebase that is worth collapsing into a
single shared component, hook, or helper — the same kind of cleanup that produced the
shared dialog close button. Each entry lists real occurrences (file:line), the proposed
shared API, whether a primitive **already exists** that should simply be adopted, and a
confidence/effort read.

This doc is a **work catalog**, not a single feature. Each refactor is independently
shippable as its own small PR. The intent is that the duplication was found once, vetted
once, and recorded here so the cleanups can be picked up incrementally without re-deriving
the analysis. Remaining work lives in `checklist.md`.

## Guiding rules

1. **Prefer adopting an existing primitive over inventing a new one.** `src/client/components/ui/`
   already holds CVA-based primitives (`Badge`, `Banner`, `Button`, `Tooltip`, `StatusDot`,
   …) and `src/client/utils/cn.ts`. Several "duplications" below are really *under-adoption*
   of a primitive that already exists — the fix is to route ad-hoc sites through it, possibly
   adding a variant.
2. **Only collapse genuine sameness.** Three sites that *look* similar but encode different
   intent should stay separate. Confidence below reflects how sure we are the occurrences are
   the same thing.
3. **Skip refactors that fight the architecture.** Some apparent duplication is deliberate
   (see *Explicitly not doing*).
4. **One refactor = one PR.** Keep diffs reviewable; a 100+ site mechanical sweep is its own
   risk and gets called out as such.

## Refactor catalog

Ranked by payoff (occurrences × duplicated lines, discounted by risk).

### A. Copy-to-clipboard button — **new primitive** · high payoff · 95%

Repeated `useState(copied)` + `navigator.clipboard.writeText()` + `setTimeout` reset + icon
swap (`CopyIcon` → `CheckIcon`) + label swap.

Occurrences:
- `src/client/components/message-markdown.tsx:356-391` (CodeBlock)
- `src/client/components/SessionDiagnosticsPanel.tsx:120-183`
- `src/client/components/CodexAuthCard.tsx:130-139`
- `src/client/components/PrActionsMenu.tsx:50-54` (branch name copy)

Proposed: `ui/copy-button.tsx` → `<CopyButton text label? timeout? className? />`, built on the
existing `Button` (`variant="ghost"`/`size="sm"`) so it inherits styling. Encapsulates the
copied-state timer.

### B. Avatar with initials fallback — **new primitive** · high payoff · 95%

Conditional `<img …rounded-full>` else a styled initials circle, repeated verbatim.

Occurrences:
- `src/client/components/IssueDetail.tsx:362-371` (CommentAvatar)
- `src/client/components/pr-detail/PrConversationSection.tsx:29-45`
- `src/client/components/IssuesFilterBar.tsx:179-186`

Proposed: `ui/avatar.tsx` → `<Avatar name avatarUrl? size? getInitials? />`. Note the initials
logic varies slightly per site (first char vs first-of-each-word) — expose `getInitials` so the
variation is a prop, not a fork.

### C. Worker HTTP response parsing — **extract helper** · high payoff · 95%

Identical response stream → `JSON.parse` → status-code/error handling duplicated across the
three verbs.

Occurrences (all in `src/server/orchestrator/worker-http.ts`):
- `workerPost` `:76-93`
- `workerPut` `:156-173`
- `workerGet` `:209-226`

Proposed: a private `attachWorkerResponseHandler(res, resolve, reject, path)` in `worker-http.ts`.
`resolveTimeout()` is already extracted there — same treatment for response parsing. Single-file,
no call-site churn.

### D. localStorage read + JSON.parse + filter — **extract helper** · high payoff · 90%

`try { localStorage.getItem → JSON.parse → Object.entries(...).filter(...) } catch { fallback }`
repeated 11+ times.

Occurrences (sample):
- `src/client/utils/local-storage.ts:100-113, 290-316, 337-352, 373-386, 407-420, 745-768`
- `src/client/stores/file-store.ts:12-14`
- `src/client/stores/comment-store.ts:13-18`

Proposed: `getLocalStorageObject<T>(key, fallback, transform?)` and `parseJsonWithFallback<T>()`
in `local-storage.ts`. Mostly self-contained to that file plus a couple of store call sites.

### E. Metric/status badge — **adopt existing `Badge`** · medium-high · 90%

Ad-hoc `inline-block … rounded-full … tabular-nums` pills that re-implement what `ui/badge.tsx`
already does — they just predate or bypass it, and need `tabular-nums`.

Occurrences:
- `src/client/components/UptimeBadge.tsx:55`
- `src/client/components/DockerMemoryBadge.tsx:36`
- `src/client/components/SubscriptionLimitsBadge.tsx:86`

Proposed: route these through `<Badge variant=…>`; add a `tabular-nums` affordance (either a
`numeric` boolean or just pass `className="tabular-nums"`). **Adoption, not a new component.**

### F. Inline alert banner — **extend existing `Banner`** · medium · 85%

Left-aligned, icon + text alert box (`flex items-start gap-2 rounded-md border px-3 py-2 text-xs`
+ error/warning tokens). Distinct from the existing `ui/banner.tsx`, which is a full-width,
**centered**, borderless strip — same color tokens, different layout.

Occurrences:
- `src/client/components/Settings/tabs/AdvancedTab.tsx:433`
- `src/client/components/SkillsTab.tsx:204, 224`
- `src/client/components/QuickCaptureOverlay.tsx:217, 222`
- `src/client/components/SessionSidebar/SessionSettingsDialog.tsx:251`
- `src/client/components/AddRepoDialog.tsx:138`
- `src/client/components/SettingsEgress.tsx:267`

Proposed: add an **inline/callout** layout to `Banner` (e.g. a `layout: "strip" | "inline"`
variant, or a sibling `Alert` in the same file sharing the color tokens). Reuse `Banner`'s
existing CVA color variants so we don't duplicate the token mapping.

### G. Icon-only button — **add `Button` variant** · medium · 85%

Square/compact icon buttons with the same tertiary→secondary hover + `hover:bg` transition,
re-implemented inline ~8 times.

Occurrences:
- `src/client/components/pr-detail/PrDetailHeader.tsx:165, 185`
- `src/client/components/pr-detail/PrDescriptionSection.tsx:69`
- `src/client/components/PrLifecycleCard/PrLifecycleCard.tsx:213`
- `src/client/components/DocsViewer.tsx:371`
- `src/client/components/IssueDetail.tsx:304`
- `src/client/components/message-tools.tsx:242`

Proposed: an `icon` size (square padding, e.g. `size="icon"`) on `ui/button.tsx` rather than a
separate `IconButton`. `Button` already owns the hover/transition tokens; this is the smallest
addition that covers the sites.

### H. Param type validation helpers — **extract helpers** · medium · 90%

`if (typeof x !== "string") throw new ServiceError(400, "x must be a string")` and the
array-of-strings variant, repeated 20+ times across services.

Occurrences (sample):
- `src/server/orchestrator/services/session.ts:445-447`
- `src/server/orchestrator/services/repos.ts:102-110`
- `src/server/orchestrator/services/github.ts:954-964, 1006-1010, 1047-1051`
- `src/server/orchestrator/services/templates.ts:110-115`

Proposed: `validateString / validateNumber / validateStringArray / validateNonEmptyString(value,
fieldName)` returning the narrowed value, co-located with `ServiceError` (likely `validation.ts`).
Each returns the typed value so call sites stay one line.

## Explicitly not doing

- **Route-handler `try/catch` → `ServiceError` wrapper (`handleServiceRoute`).** ~128 call sites.
  Very real duplication, but a mechanical sweep that large is high-risk/low-reward and would
  obscure each route's specific fallback message. Not worth it now; revisit only if a wrapper
  emerges naturally.
- **`store.getState()` cross-reference "duplication."** Intentional per `CLAUDE.md` — stores
  cross-reference via `getState()` (not subscriptions) to avoid cycles. Collapsing it fights the
  architecture.
- **Generic SSE/event-listener abstraction.** The proposed sketches had broken cleanup
  (`removeEventListener` with a fresh closure removes nothing). A correct version is possible but
  is careful work, not a quick win — deferred until someone needs it.
- **`usePolling` hook.** Real (`HostPanel`, `SessionDiagnosticsPanel`, `useContainerHealthPoll`,
  `usePreviewHealthPoller` all repeat `[data/error/loading]` + `setInterval` + cleanup), but the
  poll bodies differ enough that the shared hook risks an awkward API. Medium confidence — left in
  the backlog, not the active set.

## Already solved (verified during analysis)

These came up as "duplication" but already route through a shared abstraction — no action:
`resolveSessionDir()` (api-routes.ts), `perSessionCredentialsDir()` (session-credentials-scaffold.ts),
`emitChatCard()` (chat-card-persistence.ts), `resolveTimeout()` (worker-http.ts).

## Suggested sequencing

1. **Batch 1 — clean, self-contained, highest confidence:** A (CopyButton), B (Avatar),
   C (worker-http), D (localStorage). Each a tidy PR with little cross-file churn.
2. **Batch 2 — adopt/extend existing primitives:** E (Badge adoption), G (Button icon size),
   F (Banner inline variant).
3. **Batch 3 — broader server sweep:** H (validation helpers).

## Key files

- `src/client/components/ui/` — existing primitives (`badge.tsx`, `banner.tsx`, `button.tsx`,
  `tooltip.tsx`, `status-dot.tsx`); new `copy-button.tsx` / `avatar.tsx` land here.
- `src/client/utils/cn.ts` — className merge helper (use in any new primitive).
- `src/client/utils/local-storage.ts` — refactor D target.
- `src/server/orchestrator/worker-http.ts` — refactor C target.
- `src/server/orchestrator/validation.ts` — refactor H helpers target.
