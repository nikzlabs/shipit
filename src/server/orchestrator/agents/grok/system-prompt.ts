import { loadPrompt } from "../../load-prompt.js";

export const GROK_PARALLEL_SESSIONS_SECTION = loadPrompt(
  import.meta.url,
  "./system-prompt.md",
);
