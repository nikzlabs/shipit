// Re-export shim: PreviewFrame was promoted to a directory (docs/201 P20).
// Importers use `./components/PreviewFrame.js`, which resolves to this file;
// the real implementation lives in `./PreviewFrame/`.
export { PreviewFrame, formatErrorForMessage, type PreviewStatus } from "./PreviewFrame/index.js";
