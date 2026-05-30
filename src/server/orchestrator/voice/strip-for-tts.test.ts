import { describe, it, expect } from "vitest";
import { stripForTts } from "./strip-for-tts.js";

describe("stripForTts", () => {
  it("returns plain prose unchanged (modulo trim)", () => {
    expect(stripForTts("Hello there, this is fine.")).toBe("Hello there, this is fine.");
  });

  it("removes fenced code blocks entirely", () => {
    const input = "Here is the fix:\n\n```ts\nconst x = 1;\n```\n\nDone.";
    const out = stripForTts(input);
    expect(out).not.toContain("const x");
    expect(out).toContain("Here is the fix");
    expect(out).toContain("Done.");
  });

  it("removes a dangling unclosed fence to end of string", () => {
    const out = stripForTts("Run this:\n```bash\nnpm test");
    expect(out).not.toContain("npm test");
    expect(out).toContain("Run this");
  });

  it("strips heading markers but keeps the text", () => {
    expect(stripForTts("# Title\n\nBody.")).toBe("Title. Body.");
  });

  it("strips blockquote and list markers", () => {
    expect(stripForTts("> quoted line")).toBe("quoted line");
    const list = stripForTts("- one\n- two\n- three");
    expect(list).toContain("one");
    expect(list).toContain("two");
    expect(list).toContain("three");
  });

  it("drops horizontal rules", () => {
    const out = stripForTts("Above.\n\n---\n\nBelow.");
    expect(out).toContain("Above.");
    expect(out).toContain("Below.");
    expect(out).not.toContain("---");
  });

  it("keeps link text and drops the URL", () => {
    expect(stripForTts("See [the docs](https://example.com/x) now.")).toBe("See the docs now.");
  });

  it("drops images entirely", () => {
    expect(stripForTts("Look ![alt](http://img/x.png) here.")).toBe("Look here.");
  });

  it("strips inline code backticks but keeps the token", () => {
    expect(stripForTts("Call `useEffect` carefully.")).toBe("Call useEffect carefully.");
  });

  it("strips bold, italic, and strikethrough markers", () => {
    expect(stripForTts("This is **bold** and _italic_ and ~~gone~~.")).toBe(
      "This is bold and italic and gone.",
    );
  });

  it("returns empty string for an all-code turn", () => {
    expect(stripForTts("```js\nconsole.log(1);\n```")).toBe("");
  });

  it("collapses blank lines into sentence breaks", () => {
    expect(stripForTts("First para.\n\nSecond para.")).toBe("First para. Second para.");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(stripForTts("    ")).toBe("");
  });
});
