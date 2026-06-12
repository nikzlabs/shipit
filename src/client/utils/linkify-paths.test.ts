import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes, Link } from "mdast";
import { remarkLinkifyPaths } from "./linkify-paths.js";

/** Parse markdown through the same plugin chain the app uses, return the tree. */
function run(md: string): Nodes {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkLinkifyPaths);
  return processor.runSync(processor.parse(md)) as Nodes;
}

/** Collect every link node's `{ url, text }` from a tree, depth-first. */
function links(tree: Nodes): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "link") {
      const link = node as Link;
      const text = link.children
        .map((c) => (c.type === "text" ? c.value : ""))
        .join("");
      out.push({ url: link.url, text });
    }
    if ("children" in node && Array.isArray(node.children)) {
      for (const child of node.children) walk(child as Nodes);
    }
  };
  walk(tree);
  return out;
}

describe("remarkLinkifyPaths", () => {
  it("links a bare doc path in prose (the motivating case)", () => {
    const found = links(run("Design doc: docs/155-claude-memory-per-repo/plan.md for details"));
    expect(found).toEqual([
      { url: "docs/155-claude-memory-per-repo/plan.md", text: "docs/155-claude-memory-per-repo/plan.md" },
    ]);
  });

  it("keeps a :line suffix so the preview can jump to the line", () => {
    expect(links(run("see src/server/git.ts:42"))).toEqual([
      { url: "src/server/git.ts:42", text: "src/server/git.ts:42" },
    ]);
  });

  it("keeps a :line:col and a #L fragment", () => {
    expect(links(run("a src/a.ts:12:5 and b docs/b.md#L7"))).toEqual([
      { url: "src/a.ts:12:5", text: "src/a.ts:12:5" },
      { url: "docs/b.md#L7", text: "docs/b.md#L7" },
    ]);
  });

  it("links multiple paths in one paragraph", () => {
    const found = links(run("touch src/foo.ts then src/bar.tsx"));
    expect(found.map((l) => l.url)).toEqual(["src/foo.ts", "src/bar.tsx"]);
  });

  it("links a ./-prefixed path verbatim (parseRepoFileLink strips ./ on click)", () => {
    expect(links(run("open ./docs/plan.md"))).toEqual([
      { url: "./docs/plan.md", text: "./docs/plan.md" },
    ]);
  });

  it("does NOT linkify paths inside inline code", () => {
    expect(links(run("run `docs/foo/plan.md` verbatim"))).toEqual([]);
  });

  it("does NOT linkify paths inside fenced code blocks", () => {
    expect(links(run("```\nsrc/server/git.ts\n```"))).toEqual([]);
  });

  it("leaves an existing markdown link untouched (no double-wrap)", () => {
    const found = links(run("[the plan](docs/foo/plan.md)"));
    expect(found).toEqual([{ url: "docs/foo/plan.md", text: "the plan" }]);
  });

  it("does not re-link a path inside a GFM-autolinked URL", () => {
    // remark-gfm autolinks the literal URL first; we must skip it.
    const found = links(run("https://example.com/a/b.md"));
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe("https://example.com/a/b.md");
  });

  it("ignores everyday prose that is not a path", () => {
    expect(links(run("this and/or that, TCP/IP, version 1.2.3"))).toEqual([]);
  });

  it("ignores a bare filename with no directory segment", () => {
    expect(links(run("edit package.json now"))).toEqual([]);
  });

  it("does not match inside an email address", () => {
    expect(links(run("mail a.b/c@host.com please"))).toEqual([]);
  });
});
