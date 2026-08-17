# Checklist — installer checkbox prompts

- [x] Dependency-free checkbox picker in `deployment/vps/setup.sh` (arrow keys, space, Enter)
- [x] Terminal left echoing on the normal path and on Ctrl-C (no hand-set `stty`)
- [x] Access question converted from the 1/2/3/4 menu to two checkboxes
- [x] `SHIPIT_ACCESS` pre-answer for scripted/non-interactive installs
- [x] Harness question converted to a three-row checklist
- [x] `SHIPIT_HARNESSES` from the environment validated at the question, not at the image build
- [x] Validators normalize like `install-agent-clis.sh` and reject separator-only values
- [x] Empty harness selection falls back to `claude,codex` with a message
- [x] `deployment/vps/preview-prompts.sh` dry run, with a test pinning its options to the installer's
- [x] pty-driven test over the extracted picker block
- [x] `deployment/README.md` updated for both questions
