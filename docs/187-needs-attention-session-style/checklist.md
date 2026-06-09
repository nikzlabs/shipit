# Checklist — needs-attention session styling

- [x] Explore row-border treatments (both-edges, rail, grouped rail, ring, glow, edge dot, pulse)
- [x] Explore row-background treatments + selected-collision rules
- [x] Explore title-fill treatments (deep/token/bar/chip) + cross-theme token analysis
- [x] Explore title-outline treatment (no new tokens)
- [x] Combine all options on one comparison board
- [x] Commit prototypes as static mockups under `docs/187-needs-attention-session-style/`
- [x] Explore creative directions on a faithful real-row replica (reason chip, notification dot, bell, gradient wash, shimmer, dog-ear, wavy underline, marching ants)
- [x] Pick the final treatment — **edge gradient wash** (title treatments disturbed row layout; moved to a row-level background signal)
- [x] Implement in `SessionItem` (`SessionSidebar.tsx`) — amber left-edge `linear-gradient` via `color-mix` on `--color-attention`; far stop = selected gray when current, else transparent
- [x] ~~Add `--color-attention-fill` / `--color-attention-on-fill` to all 14 theme files~~ — N/A, the wash reuses `--color-attention` via `color-mix`, no new tokens
- [x] Typecheck + lint pass
- [ ] Verify in the live UI (light + dark, multiple/adjacent flagged sessions, selected+attention row) — pending dev service
