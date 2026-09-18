

export function formatBlockquote(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (trimmed === "") return "";
  return trimmed
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`))
    .join("\n");
}
