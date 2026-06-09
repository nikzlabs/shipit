# Checklist — needs-attention session styling

- [x] Explore row-border treatments (both-edges, rail, grouped rail, ring, glow, edge dot, pulse)
- [x] Explore row-background treatments + selected-collision rules
- [x] Explore title-fill treatments (deep/token/bar/chip) + cross-theme token analysis
- [x] Explore title-outline treatment (no new tokens)
- [x] Combine all options on one comparison board
- [x] Commit prototypes as static mockups under `docs/187-needs-attention-session-style/`
- [ ] Pick the final treatment
- [ ] Implement in `SessionItem` (`SessionSidebar.tsx`)
- [ ] If title-fill chosen: add `--color-attention-fill` / `--color-attention-on-fill` to all 14 theme files
- [ ] Verify in light + dark themes, with multiple and adjacent flagged sessions
