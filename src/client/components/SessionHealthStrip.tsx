// SessionHealthStrip was promoted to a directory (docs/201 large-file
// refactor, P22). This shim preserves the historical
// `./components/SessionHealthStrip` import path — used with a `.js` extension
// by TerminalPanel and its test mock — re-exporting the public surface from
// the directory barrel so no importer needs to change. The implementation
// lives in `./SessionHealthStrip/`.
export * from "./SessionHealthStrip/index.js";
