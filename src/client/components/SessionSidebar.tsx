// Re-export shim: SessionSidebar was promoted to a directory (docs/201 P17).
// Importers use `./components/SessionSidebar.js`, which resolves to this file;
// the real implementation lives in `./SessionSidebar/`.
export { SessionSidebar, SessionItem } from "./SessionSidebar/index.js";
