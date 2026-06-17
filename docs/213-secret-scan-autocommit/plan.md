---
issue: https://linear.app/shipit-ai/issue/SHI-169
title: Secret-scan guard in post-turn auto-commit
description: Block agent commits that introduce a credential, at commit time, with a persisted redacted warning.
---

# Secret-scan guard in post-turn auto-commit

## Why

ShipIt auto-commits the agent's working-tree changes after every turn. During a
public-readiness review we found a real (now-revoked) GitHub PAT had been
committed historically — it spread into two commit messages and a `docs/*.md`
file across hundreds of PR refs and could not be fully scrubbed from history.
**The durable fix is prevention at commit time, not cleanup.**

A diff-only `gitleaks` CI check is the backstop. Its config — `.gitleaks.toml`,
mirroring this guard's rules + path allowlist — ships **in this PR**; the CI
workflow that runs it (`.github/workflows/secret-scan.yml`) is the companion
piece. This feature is the stronger, earlier net: it blocks the commit *before*
it happens, server-side, so a credential never enters a commit or a push in the
first place.

## What it does

Before the post-turn auto-commit lands, ShipIt scans the **staged diff** for a
small set of high-signal credential patterns. If any are found:

1. **The whole commit is refused.** Nothing is committed, nothing is pushed, and
   the secret-bearing change is left in the working tree for the agent to fix.
2. A **persisted** `warn` system-notice is surfaced in the transcript, listing
   each finding (file, line, rule, **redacted** match) and how to proceed.

Because no commit hash comes back, the downstream auto-push and PR-lifecycle
flow short-circuit naturally (they only run on a non-null commit).

## Design decisions

### Block the whole commit (vs. redact, vs. commit-but-warn)

We **block the entire commit** and leave the working tree untouched. This mirrors
the existing unresolved-conflict / mid-rebase refusal in `GitManager.autoCommit`
exactly — same posture, same return shape, same "the next turn commits the whole
tree once it's fixed" recovery. Rejected alternatives:

- **Commit the rest, drop the secret-bearing file.** Requires path-scoped
  partial staging, produces confusing half-commits, and a single file often mixes
  a secret with legitimate edits — you'd either lose good work or keep the secret.
- **Commit but warn.** Defeats the entire goal; the secret is already in history
  the instant it's committed, which is the exact failure mode we're preventing.

Blocking is the safest default and the least surprising, given the conflict
refusal already trains both the agent and the user on "fix it, the next turn
commits." It also composes cleanly with auto-push and the PR card: a refused
commit returns `null`, so neither fires.

### Scan at the single chokepoint (`GitManager.autoCommit`)

The scan lives **inside `GitManager.autoCommit`**, not in one turn handler. Every
auto-commit path — the WS post-turn flow, dispatched/system turns, the CI-fix
commit, template scaffolding, manual file edits — funnels through `autoCommit`,
so putting the guard there gives the strongest "can never commit a credential"
guarantee with one edit. `autoCommit` runs `git add -A` then scans `git diff
--cached`, so **new untracked files are covered too** (that's where a leaked
`.env`-style credential file would appear). On a finding it `git reset`s to
unstage and returns the findings; callers surface the notice.

The user-facing **warning** is wired into the turn paths that already handle the
conflict notice: `postTurnCommit` (WS), the `turn-executor` fallback, and the
CI-fix commit in `services/github.ts`. Other direct callers (templates, manual
edits) still get the *block* for free; they just don't render the rich notice
(template scaffolding and single-file manual edits are low-risk for secrets).

### Persisted notice, not a bespoke card

The warning is **transcript content**, so it must survive a reload — not be
emit-only (`CLAUDE.md` → "Chat transcript content MUST be persisted"). We reuse
the **`emitNoticePostTurn` → persisted `system_notice`** mechanism that the
sibling unresolved-conflict refusal already uses. This is the project's
established idiom for an *informational, post-turn, auto-commit-refused* warning:
it's appended to chat history with a stable `noticeId`, rehydrates on switch/
reload, and dedupes against the turn-event replay on reconnect. A bespoke
interactive card (new `PersistedMessage` field + DB column + client component)
is reserved for cards with a **lifecycle** (buttons, filed/failed, undo); this
warning has none — the user fixes the code and re-runs. Choosing the notice keeps
the change small, consistent with its sibling, and fully reload-safe. A future
"commit anyway" button would justify upgrading to a dedicated card.

### False positives & overrides

High-signal patterns rarely false-positive because each requires a realistic
token *body*, not just a public prefix (`ghp_`, `sk-ant-`, `AKIA` in prose do
**not** match). For the residual cases there are two overrides:

- **Inline marker** — a line containing `gitleaks:allow` (the gitleaks
  convention, so one marker silences both this guard and the CI backstop) or the
  explicit `shipit:allow-secret` alias is skipped. This is the per-line escape
  hatch: add the comment and re-run.
- **Path allowlist** — `secret-scan.ts` carries a narrow `ALLOWLIST_PATH_PATTERNS`
  list (the detector + its tests, `.gitleaks.toml`, this feature's doc dir) that
  **mirrors** `.gitleaks.toml`'s `[allowlist] paths`. Deliberately narrow: the
  historical leak was in a generic `docs/*.md`, so docs are **not** allowlisted
  broadly — only this feature's own directory.

### Performance

The scan is one synchronous regex pass over the **staged diff only** (added lines
only), run once per commit. No full-tree walk, no network, no extra git
round-trips beyond a single `git diff --cached`. It does not stall a turn.

## Key files

- `src/server/shared/secret-scan.ts` — the detector: `SECRET_RULES`,
  `scanDiffForSecrets`, `redactSecret`, `isAllowlistedPath`, inline-allow markers.
  **The source of truth for patterns; mirror into `.gitleaks.toml`.**
- `.gitleaks.toml` — the CI backstop's config, a faithful mirror of `SECRET_RULES`
  + the path allowlist (`useDefault = true` layers our rules over gitleaks'
  built-ins). Edit it in lockstep with `secret-scan.ts`.
- `src/server/shared/git.ts` — `GitManager.autoCommit` runs the scan on the
  staged diff and refuses the commit on a finding; `stagedDiff()` helper;
  `AutoCommitResult.secretFindings`.
- `src/server/orchestrator/services/secret-scan-notice.ts` —
  `formatSecretScanNotice` builds the redacted, persisted warning text.
- `src/server/orchestrator/ws-handlers/post-turn.ts` — surfaces the notice on the
  WS post-turn path.
- `src/server/orchestrator/turn-executor.ts`,
  `src/server/orchestrator/services/github.ts` — surface the notice on the
  dispatched/system-turn fallback and the CI-fix commit.
- `src/server/orchestrator/session-runner.ts` — `SystemTurnDeps.autoCommit`
  return type carries `secretFindings`.

## Detected patterns

| Rule | Matches |
|---|---|
| `anthropic-api-key` | `sk-ant-` + ≥20-char body |
| `github-pat` | `gh[pousr]_` + ≥36 base62 (open-ended length) |
| `github-fine-grained-pat` | `github_pat_` + ≥40-char body |
| `github-app-token-stateless` | `ghs_<appid>_<JWT>` — GitHub's 2026 stateless installation/Actions token |
| `aws-access-key-id` | `AKIA`/`ASIA` + 16 upper-alnum |
| `private-key-block` | `-----BEGIN … PRIVATE KEY-----` |
| `slack-token` | `xox[baprs]-` + body |
| `jwt` | `eyJ…` three base64url segments |
| `git-credential-url` | `https://x-access-token:<token>@` / `user:<token>@host` |

## Keeping up with token-format changes

Token formats drift, so the rules are built to absorb the common case and flag
the rest:

- **Length drift is absorbed.** Every token-body length is open-ended (`{36,}`,
  `{40,}`, …), never a hard count — GitHub explicitly told integrators to drop
  fixed-length checks like `ghs_[A-Za-z0-9]{36}`
  ([changelog](https://github.blog/changelog/2026-04-24-notice-about-upcoming-new-format-for-github-app-installation-tokens/)).
- **Structural changes need a rule.** The 2026 stateless GitHub App / Actions
  token (`ghs_<appid>_<JWT>`, ~520 chars, rolling out Apr–Jun 2026) is a
  *structural* change the classic `gh[pousr]_…` rule can't match (the underscore
  after the app id breaks the base62 run), so it gets its own
  `github-app-token-stateless` rule.
- **The CI backstop tracks upstream.** A brand-new prefix/alphabet still needs an
  edit here; the companion diff-only `gitleaks` CI check picks up the
  ecosystem's pattern updates even before this inline set is touched. The inline
  guard is the *early* net; gitleaks is the *current-patterns* net.

## Tests

- `src/server/shared/secret-scan.test.ts` — detection per rule, no-false-positive
  on bare prefixes / removed+context lines, path allowlist, inline-allow markers,
  redaction, dedupe, line-number derivation.
- `src/server/shared/git-secret-scan.test.ts` — real-git temp-repo: commit refused
  + tree preserved on a finding, commits once the secret is removed, untracked
  file caught via `git add -A`, inline `gitleaks:allow` honored.
- `src/server/orchestrator/services/secret-scan-notice.test.ts` — notice content,
  no raw-token echo, pluralization, empty-guard.

## Out of scope / future

- `GitManager.commitPaths` (user-driven marketplace skill install) is not scanned
  — narrow, user-initiated path; can be extended if needed.
- A "commit anyway" override button would upgrade the notice to a dedicated
  lifecycle card.
- Keeping `.gitleaks.toml` in sync with `SECRET_RULES` is manual; a shared
  generator could enforce it.
