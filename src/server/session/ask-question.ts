
export interface NormalizedAskOption {
  label: string;
  description: string;
}

export interface NormalizedAskQuestion {
  question: string;
  header: string;
  options: NormalizedAskOption[];
  multiSelect: boolean;
}

export function normalizeAskQuestions(raw: unknown): NormalizedAskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedAskQuestion[] = [];
  for (const q of raw) {
    if (typeof q !== "object" || q === null) continue;
    const obj = q as Record<string, unknown>;
    const rawOptions = Array.isArray(obj.options) ? obj.options : [];
    const options = rawOptions
      .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
      .map((o) => ({
        label: typeof o.label === "string" ? o.label : "",
        description: typeof o.description === "string" ? o.description : "",
      }))
      .filter((o) => o.label.length > 0);
    if (options.length === 0) continue;
    out.push({
      question: typeof obj.question === "string" ? obj.question : "",
      header: typeof obj.header === "string" ? obj.header : "",
      options,
      multiSelect: obj.multiSelect === true,
    });
  }
  return out;
}
