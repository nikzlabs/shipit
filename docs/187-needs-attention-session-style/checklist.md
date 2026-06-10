# Checklist — needs-attention session styling

- [x] Explore row-border treatments (both-edges, rail, grouped rail, ring, glow, edge dot, pulse)
- [x] Explore row-background treatments + selected-collision rules
- [x] Explore title-fill treatments (deep/token/bar/chip) + cross-theme token analysis
- [x] Explore title-outline treatment (no new tokens)
- [x] Combine all options on one comparison board
- [x] Commit prototypes as static mockups under `docs/187-needs-attention-session-style/`
- [x] Explore creative directions on a faithful real-row replica (reason chip, notification dot, bell, gradient wash, shimmer, dog-ear, wavy underline, marching ants)
- [x] Tested gradient washes (left-edge → center → right-edge short) — all rejected: a soft gradient reads as ambient texture, not a glanceable marker, and gets noisy at scale
- [x] Validated requirements against a live screenshot: signal must be **peripherally glanceable** and stay legible when **many rows are flagged at once**
- [x] Pick the final treatment — **attention rail** (solid amber left bar)
- [x] Implement in `SessionItem` (`SessionSidebar.tsx`) — `box-shadow: inset 3px 0 0 var(--color-attention)` (zero layout shift, reuses the solid per-theme token)
- [x] Verify peripheral glance + many-at-once on a full-sidebar mock in warm-light + dark ([mocks/rail-at-scale.html](./mocks/rail-at-scale.html))
- [x] Remove the interim `--color-attention-wash` token from all 14 theme files (no longer used)
- [x] Typecheck + lint pass
- [ ] Verify on the live UI (light + dark, several flagged + selected+attention row) — pending dev service
