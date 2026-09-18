import { catalogueModelLabels } from "../../server/shared/catalogue/index.js";

const LEGACY_DISPLAY_NAMES: Record<string, string> = {

  sonnet: "Sonnet 5",
  "claude-opus-4-8": "Opus 4.8",

  "gpt-5.6": "GPT-5.6 Sol",
};

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  ...LEGACY_DISPLAY_NAMES,
  ...catalogueModelLabels(),
};

const CLAUDE_FAMILIES = ["sonnet", "opus", "haiku"];

export function resolveModelAlias(modelId: string): string {

  if (CLAUDE_FAMILIES.includes(modelId)) return modelId;

  const match = /^claude-(\w+)-/.exec(modelId);
  if (match) {
    const family = match[1].toLowerCase();
    if (CLAUDE_FAMILIES.includes(family)) return family;
  }

  return modelId;
}

export function formatModelName(modelId: string): string {

  if (MODEL_DISPLAY_NAMES[modelId]) return MODEL_DISPLAY_NAMES[modelId];

  const alias = resolveModelAlias(modelId);
  if (alias !== modelId && MODEL_DISPLAY_NAMES[alias]) return MODEL_DISPLAY_NAMES[alias];

  const match = /claude-(\w+)-(\d[\w.]*)/.exec(modelId);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const version = match[2].replace(/-\d{8}$/, "");
    return `${family} ${version}`;
  }
  return modelId;
}
