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

This commit-time guard is the **primary** net: it blocks the commit *before* it
happens, server-side, free, on every repo edited in ShipIt, so a credential
never enters a commit or a push in the first place. The **backstop** for the
ShipIt repo itself is **GitHub's native secret scanning + push protection** (free
for public repos; enable in repo Settings → Code security), which push-protects
GitHub's partner patterns and is maintained upstream — no CI workflow to run or
keep in sync. We deliberately do *not* ship a custom gitleaks CI workflow: it's
extra maintenance for the same backstop role, and native push protection blocks
even earlier (at push, not at PR-CI time). The one gap — GitHub's free tier
doesn't push-protect *custom* patterns like `sk-ant-` — is covered by this
commit-time guard anyway.

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

- **Inline marker** — a line containing `gitleaks:allow` (the de-facto gitleaks
  convention, so the same marker also works if anyone runs gitleaks locally) or
  the explicit `shipit:allow-secret` alias is skipped. This is the per-line
  escape hatch: add the comment and re-run.
- **Path allowlist** — `secret-scan.ts` carries a narrow `ALLOWLIST_PATH_PATTERNS`
  list anchored to EXACT repo-relative paths (the detector + its tests, this
  feature's doc dir). Deliberately narrow: the historical leak was in a generic
  `docs/*.md`, so docs are **not** allowlisted broadly — only this feature's own
  directory. Anchored, not basename-matched, so a stray same-named file (or one
  in a user's repo) can't bypass the scan.

### Performance

The scan is one synchronous regex pass over the **staged diff only** (added lines
only), run once per commit. No full-tree walk, no network, no extra git
round-trips beyond a single `git diff --cached`. It does not stall a turn.

## Key files

- `src/server/shared/secret-scan.ts` — the detector and **single source of truth
  for patterns**: `SECRET_RULES`, `scanDiffForSecrets`, `redactSecret`,
  `redactSecretsInText`, `isAllowlistedPath`, inline-allow markers.
- `src/server/shared/git.ts` — `GitManager.autoCommit` runs the scan on the
  staged diff and refuses the commit on a finding (also scrubs the commit
  message); `commitPaths` runs the same guard; `stagedDiff()` / `diffRange()`
  helpers; `AutoCommitResult.secretFindings`.
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
- **The backstop tracks upstream.** A brand-new prefix/alphabet still needs an
  edit here; GitHub's native secret scanning (the push-time backstop) picks up
  the ecosystem's partner-pattern updates without any change on our side. The
  inline guard is the *early* net; GitHub native is the *current-patterns* net.

## Tests

- `src/server/shared/secret-scan.test.ts` — detection per rule, no-false-positive
  on bare prefixes / removed+context lines, anchored path allowlist (incl. the
  no-bypass case), inline-allow markers, redaction, `redactSecretsInText`,
  file-name detection, dedupe, line-number derivation.
- `src/server/shared/git-secret-scan.test.ts` — real-git temp-repo: commit refused
  + tree preserved on a finding, commits once the secret is removed, untracked
  file caught via `git add -A`, commit-message scrub, `commitPaths` refusal,
  inline `gitleaks:allow` honored.
- `src/server/orchestrator/services/secret-scan-notice.test.ts` — notice content,
  no raw-token echo, pluralization, empty-guard.

## What else is covered (review hardening)

A Codex review (SHI-169) surfaced additional vectors, now closed:

- **Commit messages.** The commit message is derived from agent-authored turn
  text, and the historical leak spread into commit messages too. `autoCommit`
  (and `commitPaths`) run the message through `redactSecretsInText` before
  writing it — clean code still commits, just with a redacted summary.
- **File names.** `scanDiffForSecrets` also scans each added file's *path*; a
  secret in a file name is detected and reported under a `(file name)`
  placeholder so the raw path is never echoed into a finding/notice/log.
- **`commitPaths`.** The path-scoped marketplace-install commit now runs the same
  staged-diff scan and refuses (unstage + return null) on a finding.
- **Anchored allowlist.** `ALLOWLIST_PATH_PATTERNS` is anchored to EXACT
  repo-relative paths, not a basename match — a stray `secret-scan.test.ts`
  elsewhere (or in a user repo) can't bypass the scan.
- **Agent self-commits (moved HEAD).** When the agent moves HEAD itself this turn
  (its own `git commit`), `autoCommit` makes no commit but post-turn auto-pushes
  the moved HEAD — content `autoCommit` never scanned. `post-turn.ts` now scans
  the added commits (`git.diffRange`) before that push and refuses on a finding.
  It only does so when HEAD is a pure ADDITION (`turnStartHead` is an ancestor of
  HEAD); a rewritten history (rebase/amend/reset) skips the scan, because those
  commits replay pre-existing history and re-flagging them would false-block a
  legitimate rebase. The refused commit stays local (never pushed); the agent
  must amend/scrub it. (GitHub push protection, if enabled, is a further net here.)
- **Agent-driven PR after a refusal.** `flushPendingTurnCommit` returns a typed
  `secretBlocked`; `agentCreatePr` aborts with a 422 when the just-made edit was
  refused for a secret, instead of silently opening/updating the PR from the
  prior (stale) commits. The redacted warning is surfaced by the flush.

## Backstop: GitHub native secret scanning (not a custom CI job)

The push-time backstop is **GitHub's native secret scanning + push protection**,
not a custom gitleaks workflow. Rationale:

- **Free for public repos**, always-on; push protection blocks GitHub's partner
  patterns by default — at *push* time, earlier than a PR-CI job.
- **Zero maintenance** — patterns are updated upstream; nothing to keep in sync.
- A custom gitleaks CI job would be extra maintenance for the same backstop role
  (and `gitleaks-action` needs a paid license for org-owned repos; running the
  binary directly avoids that but still adds a workflow to own).

**Action:** enable it in the ShipIt repo's Settings → Code security & analysis
(Secret scanning + Push protection). It's a settings toggle, not code.

Coverage note: GitHub's free tier does **not** push-protect *custom* patterns
(e.g. `sk-ant-`, generic JWTs) — those need paid GitHub Secret Protection. That
gap is covered by the commit-time guard (which scans them for free, before
commit, on every repo), so the combination is still strong.

## Known limitations / future

- **A "commit anyway" override** would upgrade the notice to a dedicated
  lifecycle card.
- **Private repos / non-GitHub remotes** get no push-time backstop (native push
  protection needs GHAS for private; it's GitHub-only). The commit-time guard
  still applies everywhere. A custom gitleaks job could be reinstated if a
  visibility-/host-agnostic CI backstop is ever wanted.
