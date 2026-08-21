# Preview viewport resize — checklist

Scope is the delta over `docs/066-mobile-preview`; see [plan.md](./plan.md) for
what was already shipped.

## Drag to resize (req 8)

- [x] Pure drag arithmetic in `viewport-drag.ts` (centred-edge factor, start-scale anchor, clamping)
- [x] `toStoredSize` so a landscape drag is not transposed by a later rotate
- [x] Right, bottom and corner handles positioned on the frame's rendered edges
- [x] Pointer capture so the drag survives crossing the cross-origin iframe
- [x] Cursor shield while a drag is live
- [x] Arrow-key resize on each handle's own axis, without the centred doubling
- [x] `role="slider"` + live `aria-valuenow` on the single-axis handles
- [x] Handles hidden when the preview fills the panel, is off screen, or is behind an overlay

## Remembering the choice (req 9)

- [x] `shipit:preview-viewports` localStorage map, per session, capped and validated
- [x] Responsive stored as absence rather than as a default row
- [x] Unknown preset id degrades to Responsive instead of restoring stale dimensions
- [x] Restore on session switch (`restoreSession`, only without an in-memory snapshot)
- [x] Restore on first load / reload (`useSessionActivation` mount effect)
- [x] Writes no-op until a session is active

## Size readout (req 7)

- [x] `setViewportSize` sets size and preset atomically
- [x] Freeform preset labelled `Custom`, so dimensions appear once and cannot go stale on rotate

## Tests

- [x] `viewport-drag.test.ts` — factor, scale, clamping, axis isolation, landscape round-trip, arrow keys
- [x] `ViewportResizeHandles.test.tsx` — drag commits, deltas measured from drag start, release/cancel, right-click ignored, landscape, keyboard, a11y value
- [x] `preview-store.test.ts` — atomic size, reload round-trip, per-session isolation, corrupt/unknown/out-of-range stored values
- [x] `useSessionActivation.test.ts` — the reload path restores, and claims nothing without a session
- [x] `PreviewFrame.test.tsx` — handles present only when framed and visible; drag moves the frame and the readout; `Custom` printed once

## Checks

- [x] `npm run typecheck`
- [x] `npm run lint:dev`
- [x] `npm run test:dev`
- [x] Driven in a real browser against a real cross-origin iframe (see plan.md → Verification)
