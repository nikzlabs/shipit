# Checklist — agent-driven install

## Harness selection on the local install
- [x] Shared block (`shipit-installer-common`) carrying the picker, the harness rows, the validator and `resolve_harnesses`, byte-identical in both installers
- [x] `deployment/local/setup.sh` asks the question after the clone and before the build
- [x] `shipit_persist_env` in `deployment/local/lib.sh`; the answer lands in `~/.shipit/.shipit.env`
- [x] `disable_egress_containment` reuses the same helper
- [x] An unanswered question persists nothing, so the image build's own default still applies

## Self-description
- [x] `--describe` and `SHIPIT_DESCRIBE=1` on both installers, before any host-touching step
- [x] `--dry-run` on the local installer, matching the VPS one
- [x] Discovery of `--describe`: `--help` on both installers, the same names in the unknown-argument error, and a notice when a blind run is about to skip the questions
- [x] One schema (`shipit.installer/1`) for both, with `askedWhen`, `secret`, options and defaults
- [x] `instructions` telling the agent to ask the person and to protect secrets
- [x] `parameters` and `followUps` (local Tailscale access)

## Every question answerable in advance
- [x] `SHIPIT_EGRESS=on|off` on both installers; unset keeps containment on
- [x] The VPS egress `read` no longer runs without a terminal
- [x] `SHIPIT_CF_DOMAIN`, `SHIPIT_CF_API_TOKEN`, `SHIPIT_CF_ACCOUNT_ID`, `SHIPIT_CF_ALLOWED_EMAIL`
- [x] Pre-answers validated before anything on the host changes

## Documentation
- [x] "Installing with an agent" in `deployment/README.md`, with the full variable table
- [x] Harness section rewritten — both installers ask
- [x] Root `README.md` quickstart entry

## Tests
- [x] `installer-describe.test.ts` — schema, block identity, no writes, early validation, secret handling
- [x] `agent-cli-install.test.ts` — harness lists guarded in both installers
- [x] `local-install-bind.test.ts` — `shipit_persist_env` writes, replaces, and is read back

## Verification
- [x] `bash -n` on every changed script
- [x] `npm run typecheck`, `npm run lint:dev`
- [x] Independent review against every numbered requirement
- [ ] End-to-end on a real machine: one local install answering the picker, one with `SHIPIT_HARNESSES` preset, and one VPS install driven entirely by an agent
