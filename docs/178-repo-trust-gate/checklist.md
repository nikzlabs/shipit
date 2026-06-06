# Repo trust gate — checklist

## Decisions locked
- [x] Agent-while-untrusted: **option (a)** — allow chat, gate only auto-exec (install + compose)
- [x] Trust key: reuse `canonicalRepoKey()` (git-utils.ts); do NOT use raw URL or `parseGitHubRemote()` (null for non-GitHub remotes → shared key)
- [x] Persistence home: `RepoStore` `trusted` column (no dedicated store)
- [x] No-remote local sessions: **trusted by construction** (locally authored)
- [x] Re-prompt policy on remote change / `shipit.yaml` rewrite: **don't** — TOFU trusts the remote identity; documented as a known limitation

## Server
- [x] Trusted-remotes persistence (`isTrusted`/`setTrusted`, `trusted` column) keyed by `canonicalRepoKey(url)`
- [x] Non-GitHub remotes get a distinct trust key (`canonicalRepoKey` is defined for every remote, unlike `parseGitHubRemote`) — covered by the per-remote isolation unit test
- [x] Mark ShipIt template-created repos trusted at creation
- [x] Gate warm pre-install (`runPreInstall`) behind trust — the pre-open path
- [x] Gate `runInstall()` (on-activation, via `setupServiceManager`) behind trust; defer until acceptance
- [x] Gate auto-preview compose `command:`/`build:` startup behind trust (same `setupServiceManager` early-return)
- [x] Accept-trust action: `POST /api/repos/trust` that unblocks + runs deferred startup
- [x] On acceptance: warm/pre-install (`warmSessionForRepo`), re-run deferred setup for open sessions (`runner.rerunServiceSetup`), broadcast updated repo list

## Client
- [x] Inline trust consent (`RepoTrustBanner`) for untrusted remotes (no link-out, no modal escape) — rendered as the Preview tab's restricted empty state: a centered card overlaying the (empty) preview frame, visible only on the Preview tab
- [x] Wire accept action (`trustRepo` store action); reflect trusted state from the repo's `trusted` flag; persists in RepoStore so it doesn't recur per session

## Tests
- [x] Untrusted clone does NOT run `agent.install` / start compose on activation (`setupServiceManager` gate unit test)
- [x] Acceptance lets setup proceed (trusted control case in the same test)
- [x] Trust cached per remote — `RepoStore` unit tests (canonical identity, per-remote isolation, persistence across instances)
- [x] Repo added by URL is untrusted by default; `POST /api/repos/trust` trusts it (repos integration test)
- [x] Client banner shows for untrusted / hides for trusted / accept clears it
- [ ] End-to-end "untrusted *added* repo skips warm pre-install" assertion — covered structurally by the `runPreInstall` guard + warm tests staying green; a dedicated worker-install-call assertion is deferred (would need the full standby+worker harness)

## Docs
- [ ] Add a tracker `issue:` pointer to frontmatter once filed
- [x] Note the trust gate in `src/server/shipit-docs/preview.md` (agent-visible startup behavior)
