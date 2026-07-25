# Checklist — Git LFS support

- [x] Install `git-lfs` in the session-worker images (`prod`, `dev`) with a full
      `git lfs install --system --skip-repo`
- [x] Install `git-lfs` in the orchestrator images (`prod`, `dev`, `dogfood`) with
      `--skip-smudge`, so the clean filter protects orchestrator-side auto-commit
      without letting smudge fail `git clone --local` from the bare cache
- [x] `git-lfs.ts`: binary probe, committed-`.gitattributes` LFS detection,
      batched `git lfs pull` with a timeout, and a warning on every non-materialized
      outcome
- [x] Materialize LFS content in warm-pool provisioning
- [x] Materialize LFS content in the claim slow-clone path
- [x] Re-materialize on warm-session reuse (the `reset --hard` there re-writes stubs)
- [x] Materialize on unarchive and workspace restore, re-chowning after the
      root-written pull
- [x] `SHIPIT_GIT_LFS=off` escape hatch — detect and warn without spending the
      bandwidth (the issue's minimum-acceptable fallback)
- [x] Allow the GitHub LFS transfer host in the default and git-lifeline egress lists
- [x] Agent-facing guidance in `shipit-docs/environment.md`: check for the
      `git-lfs.github.com/spec/v1` header before blaming networking or codecs
- [x] Unit tests for detection + the status/warning contract
- [x] Dockerfile guard test for the per-role smudge asymmetry
