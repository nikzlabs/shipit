# 260 — Sidebar "Needs you" view: checklist

- [x] `requirements.md` — 16 numbered requirements, all open questions resolved with dated receipts.
- [x] `mockup.html` + `build-mockup.py` — placement, glyph candidates, switch states, both views, list states, measured light-theme contrast.
- [x] `plan.md` — the design that implements the requirements.
- [x] `--color-attention-text` in all 14 themes, derived per theme to clear AA.
- [x] `useAttentionSessions` — one pass of the shared attention derivation over every session.
- [x] `AttentionViewToggle` — pill switch with count, left slot beside the collapse control.
- [x] `AttentionSessionList` — flat append-only list, sticky membership, inbox-zero state.
- [x] `SessionSidebar` — header slot and body swap.
- [x] `sidebarView` in `ui-store` + localStorage persistence.
- [x] Keybinding `toggle-attention-view` (`mod+alt+a`) in the registry and wired in `useAppKeyboardShortcuts`.
- [x] Tests — list behaviour, hook membership, sidebar wiring, theme contrast guard.
- [x] Browser check of both views in a light and a dark theme.
- [x] Cross-backend review (Codex) of the branch diff against every numbered requirement.

## Follow-up — req 17, the mis-pressed collapse control (2026-09-01)

- [x] `requirements.md` — requirement 17 plus a dated receipt for the decision.
- [x] `plan.md` — why one control carries two meanings here, and the two rejected alternatives.
- [x] `SessionSidebar` — the header button's press and label follow the view.
- [x] Tests — first press leaves the view, next press collapses, label and tooltip follow, no name collision at inbox zero, and the expand-into-the-remembered-view path; all four proven red without the fix.
- [x] Browser check in both views.
- [x] Independent review (Codex) — no severe finding; its name-collision and test-gap findings are folded in above.
