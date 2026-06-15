import { describe, it, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes, Link } from "mdast";
import { remarkLinkifyPaths } from "./linkify-paths.js";
import { remarkLinkifyIssues, ISSUE_LINK_SCHEME } from "./linkify-issues.js";

/** Parse markdown through the same plugin chain the app uses, return the tree. */
function run(md: string): Nodes {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkLinkifyPaths)
    .use(remarkLinkifyIssues);
  return processor.runSync(processor.parse(md)) as Nodes;
}

/** Collect every link node's `{ url, text }` from a tree, depth-first. */
function links(tree: Nodes): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const walk = (node: Nodes): void => {
    if (node.type === "link") {
      const link = node as Link;
      const text = link.children
        .map((c) => (c.type === "text" || c.type === "inlineCode" ? c.value : ""))
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

const ISSUE = (key: string) => ({ url: `${ISSUE_LINK_SCHEME}${key}`, text: key });

describe("remarkLinkifyIssues", () => {
  it("wraps a bare Linear key in prose (the motivating case)", () => {
    expect(links(run("This is tracked in TRACKER-43 now"))).toEqual([ISSUE("TRACKER-43")]);
  });

  it("wraps multiple keys in one paragraph", () => {
    expect(links(run("blocked on TRACKER-79, see TRACKER-90"))).toEqual([ISSUE("TRACKER-79"), ISSUE("TRACKER-90")]);
  });

  it("wraps a key inside an inline-code span", () => {
    expect(links(run("ref `TRACKER-1` here"))).toEqual([ISSUE("TRACKER-1")]);
  });

  it("does NOT wrap keys inside fenced code blocks", () => {
    expect(links(run("```\nTRACKER-43\n```"))).toEqual([]);
  });

  it("does not touch a key inside an existing markdown link", () => {
    // The path/URL already owns the link; we must not double-wrap its text.
    const found = links(run("[TRACKER-43](https://linear.app/acme/issue/TRACKER-43)"));
    expect(found).toEqual([{ url: "https://linear.app/acme/issue/TRACKER-43", text: "TRACKER-43" }]);
  });

  it("does not re-wrap a key inside a GFM-autolinked Linear URL", () => {
    const found = links(run("https://linear.app/acme/issue/TRACKER-43"));
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe("https://linear.app/acme/issue/TRACKER-43");
  });

  it("ignores lowercase tokens (real Linear keys are uppercase)", () => {
    expect(links(run("the utf-8 encoding and gpt-4 model"))).toEqual([]);
  });

  it("does not match mid-token (inside a longer hyphenated identifier)", () => {
    expect(links(run("build X-TRACKER-43-Y artifact"))).toEqual([]);
  });

  it("matches key-shaped noise too (the team-key gate at render filters these)", () => {
    // The plugin is intentionally liberal — `GPT-4`/`UTF-8` parse as candidates;
    // IssueBadge renders them as plain text unless the team prefix is connected.
    expect(links(run("GPT-4 and UTF-8")).map((l) => l.text)).toEqual(["GPT-4", "UTF-8"]);
  });
});
