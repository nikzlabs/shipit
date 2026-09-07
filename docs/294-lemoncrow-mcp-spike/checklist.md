# LemonCrow MCP-only spike — checklist

- [x] Verify the global-mode premise against `scripts/install_claude.sh` before
      building on it (req 2).
- [x] Re-test blocker 1 (branch guard) against the additive shape (req 3).
- [x] Re-test blocker 2 (transcript rendering) against the additive shape (req 3).
- [x] Re-test blocker 3 (writes into the clone) empirically, with
      `git add -A --dry-run` (req 3).
- [x] Build the tokenizer cache offline so tiktoken works without egress.
- [x] Port docs/291's six tasks, gold sets and keywords into a three-arm harness
      (req 4).
- [x] Reproduce docs/291's ripwire totals as a check that the method matches.
- [x] Fix the brace-notation recall bug and re-score both arms symmetrically.
- [x] Charge LemonCrow for the follow-up read its pointers imply (req 4).
- [x] Confirm the fresh-daemon numbers are stable across repeated runs.
- [x] Measure process shape, memory, disk, latency, egress and telemetry (req 7).
- [x] Re-check project age, contributors and licence.
- [x] Write `requirements.md` before `plan.md`, and cite requirements from it.
- [x] Cross-link planning#332 and create a tracker issue for this doc.
- [ ] **Blocked on the open question in `requirements.md`** — decide whether
      ShipIt gains a per-server MCP tool restriction. No implementation code is
      written until that is answered (req 6, req 8).
