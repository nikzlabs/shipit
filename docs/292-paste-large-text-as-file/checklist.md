# Checklist — large paste becomes a file attachment

- [x] `large-paste.ts` — threshold, filename, `isLargePaste`, `buildPastedTextFile`
- [x] `handlePaste` branch in `MessageInput.tsx`, ordered after the image branch
- [x] Unit tests for the boundary and the `File` construction
- [x] Composer tests: chip + name, `preventDefault`, sub-threshold, dead composer, image-beats-text
- [x] Each composer guard proved red on its own against a targeted mutation
- [x] Existing paste fixture given a `getData` so it matches a real `ClipboardEvent`
- [x] `npm run typecheck` and `npm run lint:dev` clean
- [ ] Independent review of the branch against the requirements
