# Checklist — Gated `gh pr merge`

- [x] `SessionCapabilities.dangerousGitHubOps` (type + default + normalize)
- [x] `mergeDisposition(session)` gate helper (pr-target.ts)
- [x] `agentMergePullRequest()` service with guardrails (github.ts)
- [x] `POST /api/sessions/:id/pr/:number/merge` agent route + gate (api-routes-github.ts)
- [x] `POST /agent-ops/pr/:number/merge` worker relay (agent-ops-routes.ts)
- [x] `handlePrMerge` + `PR_HANDLERS.merge` + HELP (gh.ts)
- [x] Sandbox-create body type carries `dangerousGitHubOps`
- [x] "Allow merging PRs" nested sub-toggle (SandboxDialog.tsx)
- [x] Agent-facing docs updated (shipit-docs/github.md)
- [x] Unit tests: shim, service, gate, capability round-trip
- [x] Integration tests: route gate (403s) + happy path + draft refusal
- [x] typecheck + lint:dev green
