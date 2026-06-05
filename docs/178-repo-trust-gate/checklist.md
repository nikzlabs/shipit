# Repo trust gate — checklist

Design only so far. No implementation yet.

## Decisions to lock before building
- [x] Agent-while-untrusted: **option (a)** — allow chat, gate only auto-exec (install + compose)
- [ ] Trust key: reuse `canonicalRepoKey()` (git-utils.ts); do NOT use raw URL or `parseGitHubRemote()` (null for non-GitHub remotes → shared key)
- [ ] Persistence home: `RepoStore` trusted-remotes set vs dedicated store
- [ ] No-remote local sessions: trusted by construction?
- [ ] Re-prompt policy on remote change / `shipit.yaml` rewrite (likely: don't, document limitation)

## Server
- [ ] Trusted-remotes persistence (read/write/list) keyed by `canonicalRepoKey(url)`
- [ ] Verify non-GitHub remotes (GitLab/Bitbucket/self-hosted/SSH) each get a distinct trust key
- [ ] Mark ShipIt template-created repos trusted at creation
- [ ] Gate warm pre-install (`runPreInstall`/`warmSessionForRepo`) behind trust — the pre-open path
- [ ] Gate `runInstall()` (on-activation) behind trust; defer until acceptance
- [ ] Gate auto-preview compose `command:`/`build:` startup behind trust
- [ ] Accept-trust action (HTTP route or WS message) that unblocks + runs deferred startup
- [ ] On acceptance: warm/pre-install, re-run deferred `agent.install`, start auto-preview services

## Client
- [ ] Inline trust consent card/banner for untrusted remotes (no link-out, no modal escape)
- [ ] Wire accept action; reflect trusted state; persist so it doesn't recur per session

## Tests
- [ ] Untrusted repo *added* (warm pool) does NOT pre-run `agent.install` (the pre-open RCE path)
- [ ] Untrusted clone does NOT run `agent.install` on activation (regression for the RCE-on-open path)
- [ ] Untrusted clone does NOT start auto-preview services
- [ ] Acceptance runs deferred install + previews
- [ ] Trust cached per remote — second session from same remote does not re-prompt
- [ ] Template-created repos trusted by construction (never prompt)

## Docs
- [ ] Add a tracker `issue:` pointer to frontmatter once filed
- [ ] Cross-link from `docs/172` Gap 3 to this doc
- [ ] Update `src/server/shipit-docs/` if trust changes agent-visible startup behavior
