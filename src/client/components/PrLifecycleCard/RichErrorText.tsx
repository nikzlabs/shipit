/**
 * Render error text with backtick-highlighted terms (`word`) and, by default,
 * inline links (https://...).
 *
 * **`links={false}` is for text whose author is not ShipIt.** A plugin
 * repository's activation failure carries git's output and a plugin's own
 * install stderr (docs/262), so linkifying it would let third-party content
 * put a `target="_blank"` link into the ShipIt UI — a link-out ShipIt did not
 * choose, which is the §2/§3 line. The URL still renders, as text.
 */
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
