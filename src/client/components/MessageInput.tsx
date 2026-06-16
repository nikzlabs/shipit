// Re-export shim: MessageInput was promoted to a directory (docs/201 P19).
// Importers use `./components/MessageInput.js`, which resolves to this file;
// the real implementation lives in `./MessageInput/`.
export { MessageInput, type SendPayload } from "./MessageInput/index.js";
