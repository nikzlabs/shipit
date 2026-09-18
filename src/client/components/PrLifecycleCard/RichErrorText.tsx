

export function RichErrorText({ text, links = true }: { text: string; links?: boolean }) {
  const parts = text.split(links ? /(https:\/\/\S+|`[^`]+`)/ : /(`[^`]+`)/).map((part, i) => {
    if (links && part.startsWith("https://")) {
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-(--color-text-link) hover:opacity-80 underline">{part}</a>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="text-xs bg-(--color-bg-tertiary) px-1 py-0.5 rounded text-(--color-text-primary)">{part.slice(1, -1)}</code>;
    }
    return part;
  });
  return <>{parts}</>;
}
