import { activeModelList, catalogueModelLabels, type ModelListDoc } from "../../server/shared/catalogue/index.js";

const LEGACY_DISPLAY_NAMES: Record<string, string> = {

  sonnet: "Sonnet 5",
  "claude-opus-4-8": "Opus 4.8",

  "gpt-5.6": "GPT-5.6 Sol",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "openai/gpt-5.6-sol": "GPT-5.6 Sol",
  "openai/gpt-5.6-terra": "GPT-5.6 Terra",
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.3-codex": "GPT-5.3 Codex",
  "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
  "gpt-5.2": "GPT-5.2",
};

// Rebuilt when the server's published model list replaces the one in effect (docs/318).
let displayNames: { list: ModelListDoc | undefined; names: Record<string, string> } | undefined;

function modelDisplayNames(): Record<string, string> {
  const list = activeModelList();
  if (!displayNames || displayNames.list !== list) {
    displayNames = { list, names: { ...LEGACY_DISPLAY_NAMES, ...catalogueModelLabels() } };
  }
  return displayNames.names;
}

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
  const names = modelDisplayNames();
  if (names[modelId]) return names[modelId];

  const alias = resolveModelAlias(modelId);
  if (alias !== modelId && names[alias]) return names[alias];

  const match = /claude-(\w+)-(\d[\w.]*)/.exec(modelId);
  if (match) {
    const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    const version = match[2].replace(/-\d{8}$/, "");
    return `${family} ${version}`;
  }
  return modelId;
}
