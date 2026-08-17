# Checklist — installer checkbox prompts

- [x] Dependency-free checkbox picker in `deployment/vps/setup.sh` (arrow keys, space, Enter)
- [x] Terminal left echoing on the normal path and on Ctrl-C (no hand-set `stty`)
- [x] Access question converted from the 1/2/3/4 menu to two checkboxes
- [x] `SHIPIT_ACCESS` pre-answer for scripted/non-interactive installs
- [x] Harness question converted to a three-row checklist
- [x] `SHIPIT_HARNESSES` from the environment validated at the question, not at the image build
- [x] Validators normalize like `install-agent-clis.sh` and reject separator-only values
- [x] Defaults: Tailscale alone for access; Claude Code + Codex + OpenCode for harnesses
- [x] The default harness set is hand-approved, not derived — a new harness is offered but unchecked
- [x] Tests pin offered-set to the catalogue and the two default lists to each other
- [x] Empty harness selection falls back to the approved default set, with a message
- [x] `--dry-run` / `SHIPIT_DRY_RUN=1` in the installer itself — asks both questions, changes nothing, needs no root
- [x] pty-driven test over the extracted picker block, and over the real installer in dry mode
- [x] `deployment/README.md` updated for both questions
