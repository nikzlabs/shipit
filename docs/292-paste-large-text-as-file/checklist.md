# Checklist — large paste becomes a file attachment

- [x] `large-paste.ts` — threshold, filename, `isLargePaste`, `buildPastedTextFile`
- [x] `handlePaste` branch in `MessageInput.tsx`, ordered after the image branch
- [x] Count characters, not UTF-16 code units, with the scan bounded at the threshold
- [x] Unit tests for the boundary, astral characters, and the `File` construction
- [x] Composer tests: chip + name, `preventDefault`, sub-threshold, dead composer, image-beats-text
- [x] Each guard proved red on its own against a targeted mutation
- [x] One test pins the approved literals (2000, `pasted-text.txt`), not just the boundary
- [x] Existing paste fixture given a `getData` so it matches a real `ClipboardEvent`
- [x] `npm run typecheck` and `npm run lint:dev` clean
- [x] Independent review of the branch against the requirements
- [x] Verified in a real browser on the dogfood instance, not only in jsdom
- [x] Inherited upload-path defects the review surfaced filed as planning#518
