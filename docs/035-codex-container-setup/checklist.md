# Checklist — Codex container setup

- [x] Install the pinned Codex CLI in the shared agent CLI package.
- [x] Put the `codex` binary on `PATH` in dev, prod, dogfood, and session-worker images.
- [x] Add runtime binary detection through the shared agent registry.
- [x] Surface installed/auth-configured state in the agent list.
- [x] Reject unavailable Codex selections with a descriptive error path.
- [x] Add a Codex adapter startup guard for missing CLI binaries.
- [x] Support Codex authentication through `OPENAI_API_KEY` and ChatGPT subscription file auth.
- [x] Add Codex device-auth manager and HTTP routes.
- [x] Wire Codex auth state into Settings and onboarding UI.
- [x] Cover registry, auth, and Codex session flow with unit/integration tests.
