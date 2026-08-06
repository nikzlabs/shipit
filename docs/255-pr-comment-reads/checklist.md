# 255 — Reading PR comments through the `gh` shim: checklist

- [x] `requirements.md` written, open questions asked and answered with receipts
- [x] `viewPullRequestConversation()` — one GraphQL query for issue comments, reviews, inline threads
- [x] `viewPullRequest()` widened with `author`, `labels`, timestamps, `headRefName`/`baseRefName`
- [x] `GitHubAuthManager` wrapper + service merge (`comments: true`), best-effort with `conversationError`
- [x] `GET /pr/view?comments=true` on the orchestrator route + the `/agent-ops` relay
- [x] `gh pr view --comments` / `-c` plain rendering (comments, reviews, threads with path/line/diff)
- [x] Plain `gh pr view` conversation summary line, explicit in the empty case
- [x] `--json comments,reviews,reviewThreads,reviewDecision`, fetched only when named
- [x] Unknown/empty `--json` field is an error naming the supported set, before any network call
- [x] Same validation on `gh pr list`, `gh run list|view`, `gh workflow list|view`
- [x] Tests: shim (`gh.test.ts`), fetch layer (`github-auth-prs.test.ts`), service (`github-pr-conversation.test.ts`)
- [x] `/shipit-docs/github.md` updated: subcommand table, "Reading review feedback", field lists, exit codes
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Cross-backend review (Codex), findings addressed
