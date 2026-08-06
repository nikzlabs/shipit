---
issue: roadmap#SHI-328
title: Reading PR comments through the gh shim — design
description: How the shim, the agent-ops broker, and the orchestrator surface PR conversation reads.
---

# 255 — Reading PR comments through the `gh` shim: design

Implements [`requirements.md`](./requirements.md).

## Shape

Three concepts, three `--json` fields, named as the real `gh` CLI names them
(req 7):

| Field | GitHub concept |
|---|---|
| `comments` | issue-style conversation comments on the PR |
| `reviews` | review-level summaries + their state (`APPROVED` / `CHANGES_REQUESTED` / `COMMENTED` / `DISMISSED`) |
| `reviewThreads` | inline code-review threads: `path`, `line`, `diffHunk`, and every comment on the thread |
| `reviewDecision` | the PR's rolled-up review verdict |

`reviewThreads` is the one name real `gh` does not have (real `gh` reaches
inline comments only through `gh api`, which the shim blocks). It matches the
name ShipIt already uses internally (`PrReviewThread`, `pr-status-parser.ts`),
so there is one vocabulary across the product.

Two surfaces on top of that data (reqs 1–3, 8):

- **`gh pr view <n> --comments`** (`-c`) — plain-text rendering of all three.
  These flags were already *parsed* by the shim and silently ignored; now they
  do what real `gh` does with them.
- **`gh pr view <n> --json comments,reviews,reviewThreads[,reviewDecision]`** —
  the same data as JSON, `-q`/`--jq`-filterable like every other field.

Plain `gh pr view` with neither flag prints a one-line conversation summary
(`2 comments · 1 review · 3 review threads (1 unresolved)`) and how to read
them — or an explicit `No comments, reviews, or review threads.` (req 8).

## Fetch policy — who pays for the extra round-trip

The conversation is one extra GraphQL request, so it is fetched only when it
will be used. The shim decides and signals with `?comments=true`:

| Invocation | Fetches conversation |
|---|---|
| `gh pr view` (plain) | yes — for the summary line |
| `gh pr view --comments` | yes |
| `gh pr view --json comments,…` (any conversation field) | yes |
| `gh pr view --json state -q .state` | **no** — the merge-read path stays a single REST call |

## Failure is never silence

A conversation fetch that fails must not look like "no comments" — that
confusion is the whole bug (req 5). The orchestrator returns the conversation
best-effort and, on failure, sets `conversationError` on the PR payload instead
of empty arrays. The shim then:

- plain view → prints the PR plus a stderr note that the conversation could not
  be read (exit 0 — the PR itself is fine);
- `--comments` / `--json` with conversation fields → fails with exit 1. An
  explicit request never resolves to a plausible-looking empty array.

## Unknown `--json` fields are an error (reqs 5, 6)

`filterJson` silently drops names it doesn't recognise, which made
`--json totallyBogusField` and `--json comments` both print `{}`. Each
subcommand now declares its supported field list, and `--json` is validated
against it before any network call:

```
gh pr view: unknown --json field: "totallyBogusField"
Supported fields for gh pr view: additions, author, base, baseRefName, body, …
```

Exit code **2** — an ordinary usage error, matching `-q` without `--json`, and
distinct from **1** (the request ran and failed) and **3** (unsupported jq
expression). An empty `--json` value is the same class of error.

Applied consistently to every `--json` subcommand (req 6): `gh pr view`,
`gh pr list`, `gh run list`, `gh run view`, `gh workflow list`,
`gh workflow view`.

Because the validation is strict, `gh pr view` also gains the common real-`gh`
fields it lacked — `author`, `createdAt`, `updatedAt`, `mergedAt`, `labels`,
`headRefName`, `baseRefName` — so the new error fires on genuinely unsupported
names rather than on ordinary habits (req 7, resolved question 2).

## Key files

| File | Role |
|---|---|
| `src/server/orchestrator/github-auth-prs.ts` | `viewPullRequestConversation()` — one GraphQL query for comments + reviews + review threads. `viewPullRequest()` widened with author/labels/timestamps. |
| `src/server/orchestrator/github-auth.ts` | `GitHubAuthManager` wrapper method. |
| `src/server/orchestrator/services/github.ts` | `viewPullRequest(..., { comments })` merges the conversation onto the PR, best-effort. |
| `src/server/orchestrator/api-routes-github.ts` | `GET /api/sessions/:id/pr/view?comments=true`. |
| `src/server/session/agent-ops-routes.ts` | forwards `comments` on `/agent-ops/pr/view`. |
| `src/server/session/agent-shim/gh.ts` | `--comments` rendering, conversation-aware fetch policy, per-subcommand `--json` field validation. |
| `src/server/session/agent-shim/shim-common.ts` | `validateJsonFields()` helper shared by every `--json` subcommand. |
| `src/server/shipit-docs/github.md` | agent-facing docs — supported-subcommand table, field lists, exit codes. |

## Non-goals

- **Writing** review replies or resolving threads from the shim. ShipIt already
  owns that from the PR panel (`services/github-pr-comments.ts`); the shim stays
  read-only for review data (req 4).
- Changing `state`'s casing (`open`/`closed`, not real `gh`'s
  `OPEN`/`CLOSED`/`MERGED`). The `merged` boolean already distinguishes a merged
  PR and the orchestrator's merge guardrails read the current values; only the
  agent-facing doc's wrong `# → MERGED` example is corrected.
