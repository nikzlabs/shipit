// Settings was split into per-tab modules under ./Settings/ (P15 of the
// docs/201 large-file refactor). This one-line shim preserves the original
// import path (`./components/Settings`) so existing importers are unchanged.
export { Settings } from "./Settings/index.js";
export type { SettingsProps } from "./Settings/index.js";
