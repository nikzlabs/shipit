/**
 * Strip markdown/code from assistant prose for TTS (docs/144).
 *
 * Pure function shared by the route and its tests. Returns the natural-language
 * prose that should be read aloud; returns "" when nothing readable remains
 * (e.g. a turn that was entirely a code block), in which case the route
 * returns 204 and the client suppresses the Play button.
 *
 * Deliberately conservative: this is a reader aid, not a markdown parser. It
 * removes the noise that reads badly (fences, inline-code backticks, heading
 * markers, emphasis stars, list bullets, link URLs) and leaves the words.
 */

export function stripForTts(input: string): string {
  let text = input;

  // Remove fenced code blocks entirely (```lang ... ```), including the fences.
  text = text.replace(/```[\s\S]*?```/g, " ");
  // Remove any dangling unclosed fence to the end of the string.
  text = text.replace(/```[\s\S]*$/g, " ");

  // Drop front-matter if the prose somehow starts with a YAML block.
  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");

  const lines = text.split("\n").map((line) => {
    let l = line;
    // Headings: strip leading # markers, keep the text.
    l = l.replace(/^\s{0,3}#{1,6}\s+/, "");
    // Blockquote markers.
    l = l.replace(/^\s{0,3}>\s?/, "");
    // List markers (-, *, +, or "1.") become a short pause.
    l = l.replace(/^\s*([-*+]|\d+\.)\s+/, "");
    // Horizontal rules read as nothing.
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) return "";
    return l;
  });
  text = lines.join("\n");

  // Images: drop entirely (alt text is rarely worth reading).
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  // Links: keep the link text, drop the URL.
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Inline code: keep the token text, drop the backticks.
  text = text.replace(/`([^`]+)`/g, "$1");
  // Bold / italic / strikethrough markers.
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  // Collapse runs of blank lines into a single sentence break, and trim
  // trailing whitespace on each line.
  text = text
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    // Avoid ".. " artefacts from a list item ending a paragraph.
    .replace(/\.\s*\.\s/g, ". ")
    .trim();

  return text;
}
