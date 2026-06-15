# Checklist — self-update resilient to an SSH origin

- [x] Add github.com SSH→HTTPS `insteadOf` rewrite to `initGlobalGitConfig`
- [x] Make it unconditional + idempotent (`--replace-all` with per-entry value regex)
- [x] Unit tests: both URL forms rewritten, unconditional, idempotent
- [x] Functional test: `ls-remote --get-url` proves an SSH remote resolves to HTTPS
- [x] Cross-link the self-update doc (083) to this hardening
- [x] Create + link Linear tracking issue
</content>
