import fs from "node:fs";
import cl100k from "js-tiktoken/ranks/cl100k_base";
import o200k from "js-tiktoken/ranks/o200k_base";
import crypto from "node:crypto";

const OUT = "/persist/tkcache";
fs.mkdirSync(OUT, { recursive: true });

for (const [name, ranks] of [["cl100k_base", cl100k], ["o200k_base", o200k]]) {
  const lines = [];
  for (const line of ranks.bpe_ranks.split("\n")) {
    if (!line) continue;
    const [, offsetStr, ...tokens] = line.split(" ");
    const offset = Number.parseInt(offsetStr, 10);
    tokens.forEach((tok, i) => lines.push(`${tok} ${offset + i}`));
  }
  const url = `https://openaipublic.blob.core.windows.net/encodings/${name}.tiktoken`;
  const key = crypto.createHash("sha1").update(url).digest("hex");
  fs.writeFileSync(`${OUT}/${key}`, lines.join("\n") + "\n");
  console.log(name, lines.length, "->", key);
}
