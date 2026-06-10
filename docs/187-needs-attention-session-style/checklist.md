# Checklist — needs-attention session styling

- [x] Explore row-border treatments (both-edges, rail, grouped rail, ring, glow, edge dot, pulse)
- [x] Explore row-background treatments + selected-collision rules
- [x] Explore title-fill treatments (deep/token/bar/chip) + cross-theme token analysis
- [x] Explore title-outline treatment (no new tokens)
- [x] Combine all options on one comparison board
- [x] Commit prototypes as static mockups under `docs/187-needs-attention-session-style/`
- [x] Explore creative directions on a faithful real-row replica (reason chip, notification dot, bell, gradient wash, shimmer, dog-ear, wavy underline, marching ants)
- [x] Pick the final treatment — **edge gradient wash** (title treatments disturbed row layout; moved to a row-level background signal)
- [x] Implement in `SessionItem` (`SessionSidebar.tsx`) — right-edge short `linear-gradient` (`transparent 72%` → amber), driven by `--color-attention-wash`
- [x] Iterated gradient geometry: left-edge → center → **right-edge + short** (compact glow on the right, behind the auto-merge/⋮ area)
- [x] Add `--color-attention-wash` token to all 14 theme files — light `0.28`, dark `0.45`, high-contrast `0.55` (dark needed a higher opacity to read on the near-black surface)
- [x] Typecheck + lint pass
- [ ] Verify in the live UI (light + dark, multiple/adjacent flagged sessions, selected+attention row) — pending dev service
