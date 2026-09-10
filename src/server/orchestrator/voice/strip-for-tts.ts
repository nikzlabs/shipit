export function stripForTts(input: string): string {
  let text = input;

  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/```[\s\S]*$/g, " ");

  text = text.replace(/^---\n[\s\S]*?\n---\n/, "");

  const lines = text.split("\n").map((line) => {
    let l = line;
    l = l.replace(/^\s{0,3}#{1,6}\s+/, "");
    l = l.replace(/^\s{0,3}>\s?/, "");
    l = l.replace(/^\s*([-*+]|\d+\.)\s+/, "");
    if (/^\s*([-*_])\1{2,}\s*$/.test(l)) return "";
    return l;
  });
  text = lines.join("\n");

  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  text = text
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\.\s*\.\s/g, ". ")
    .trim();

  return text;
}
