# Repo trust gate — checklist

Design only so far. No implementation yet.

## Decisions to lock before building
- [x] Agent-while-untrusted: **option (a)** — allow chat, gate only auto-exec (install + compose)
- [ ] Trust key: confirm remote-URL normalization (reuse `parseGitHubRemote()`)
- [ ] Persistence home: `RepoStore` trusted-remotes set vs dedicated store
- [ ] No-remote local sessions: trusted by construction?
- [ ] Re-prompt policy on remote change / `shipit.yaml` rewrite (likely: don't, document limitation)

## Server
- [ ] Trusted-remotes persistence (read/write/list) keyed by normalized remote
- [ ] Mark ShipIt template-created repos trusted at creation
- [ ] Gate `runInstall()` behind trust; defer until acceptance
- [ ] Gate auto-preview compose `command:`/`build:` startup behind trust
- [ ] Accept-trust action (HTTP route or WS message) that unblocks + runs deferred startup
- [ ] Re-run deferred `agent.install` + start auto-preview services on acceptance

## Client
- [ ] Inline trust consent card/banner for untrusted remotes (no link-out, no modal escape)
- [ ] Wire accept action; reflect trusted state; persist so it doesn't recur per session

## Tests
- [ ] Untrusted clone does NOT run `agent.install` (regression for the RCE-on-clone path)
- [ ] Untrusted clone does NOT start auto-preview services
- [ ] Acceptance runs deferred install + previews
- [ ] Trust cached per remote — second session from same remote does not re-prompt
- [ ] Template-created repos trusted by construction (never prompt)

## Docs
- [ ] Add a tracker `issue:` pointer to frontmatter once filed
- [ ] Cross-link from `docs/172` Gap 3 to this doc
- [ ] Update `src/server/shipit-docs/` if trust changes agent-visible startup behavior
