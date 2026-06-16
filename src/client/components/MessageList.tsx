// MessageList was promoted to a directory (docs/201 large-file refactor, P18).
// This shim preserves the historical `./components/MessageList` import path —
// used with a `.js` extension across the client and by `visual-elements.ts` —
// re-exporting the public surface from the directory barrel so no importer
// needs to change. The implementation lives in `./MessageList/`.
export * from "./MessageList/index.js";
