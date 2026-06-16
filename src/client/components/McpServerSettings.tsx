// Re-export shim: McpServerSettings was promoted to a directory (docs/201 P24).
// Importers use `./components/McpServerSettings.js`, which resolves to this file;
// the real implementation lives in `./McpServerSettings/`.
export { McpServerSettings } from "./McpServerSettings/index.js";
