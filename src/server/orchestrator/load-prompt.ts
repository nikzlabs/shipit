import fs from "node:fs";

// Call at module initialization with the caller's import.meta.url; missing files fail at startup.
export function loadPrompt(metaUrl: string, relativePath: string): string {
  return fs.readFileSync(new URL(relativePath, metaUrl), "utf8");
}

export function fillPromptTokens(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  // A function replacer preserves literal dollar sequences in prompt fragments.
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      throw new Error(`Unfilled prompt token {{${key}}} in skeleton`);
    }
    return value;
  });
}
