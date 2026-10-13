import { describe, it, expect } from "vitest";
import { createRedactedTail } from "./redacted-tail.js";

// Credential shapes that are put together here, so that no secret scan reads one in this file.
const FAKE_KEY = ["sk", "proj", "k".repeat(28)].join("-");
const KEY_BODY = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "BKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj"];
const PEM_LINES = [
  ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
  ...KEY_BODY,
  ["-----END", "PRIVATE KEY-----"].join(" "),
];

function tailOf(pieces: string[], maxChars = 300): string {
  const tail = createRedactedTail();
  for (const piece of pieces) tail.add(piece);
  return tail.read(maxChars);
}

describe("createRedactedTail", () => {
  it("puts the pieces on one line", () => {
    expect(tailOf(["error: bad argument\n", "", "  Usage: codex [OPTIONS]"])).toBe(
      "error: bad argument Usage: codex [OPTIONS]",
    );
  });

  it("keeps the end and marks the cut", () => {
    const tail = tailOf([...Array.from({ length: 200 }, (_, i) => `retry ${i}`), "fatal: the last line"], 40);
    expect(tail).toHaveLength(41);
    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("fatal: the last line")).toBe(true);
  });

  it("redacts a credential, and keeps the text around it", () => {
    expect(tailOf([`401 for key ${FAKE_KEY} at https://api.example.test/v1`])).toBe(
      "401 for key [REDACTED] at https://api.example.test/v1",
    );
  });

  it("redacts a value whose name is on the line before it", () => {
    const opaque = "q7".repeat(9);
    expect(tailOf(["Authorization: Bearer", `${opaque} was refused`])).toBe(
      "Authorization: Bearer [REDACTED] was refused",
    );
  });

  it("redacts a private key block that came as lines", () => {
    const tail = tailOf(["loading the key", ...PEM_LINES, "fatal: the key was refused"]);
    expect(tail).toBe("loading the key [REDACTED] fatal: the key was refused");
  });

  it("redacts before it removes white space and cuts the length", () => {
    // With the white space gone first, the key is in the last characters and the cut goes through it.
    const tail = tailOf([`${FAKE_KEY}${" ".repeat(7_970)}fatal`], 20);
    expect(tail).toBe("[REDACTED] fatal");
  });

  it("does not show the rest of a credential that the budget cut", () => {
    const opaque = "q7".repeat(40);
    // The cut removes the name and the start of the value. No pattern knows the rest.
    const tail = tailOf([`OPENAI_API_KEY="${"a".repeat(1_000)}`, `${opaque}"`, "x".repeat(63_900)], 100_000);
    expect(tail).not.toContain(opaque);
    expect(tail).toHaveLength(64_000 - 8_000);
  });

  it("does not show the part of a key at the cut when the redaction makes the text after it short", () => {
    const longKey = ["sk", "proj", "k".repeat(2_000)].join("-");
    const tail = tailOf(Array.from({ length: 40 }, () => longKey), 100_000);
    expect(tail).toMatch(/^\[REDACTED\]( \[REDACTED\])+$/);
  });

  it("does not show the rest of a credential when the redaction makes the text before it longer", () => {
    // Each `a` becomes a placeholder of 10 characters: 7,215 characters become more than 8,000.
    const rest = `${"TOKEN=a\n".repeat(900)}LEAKED_SUFFIX"\n`;
    const tail = tailOf([`API_KEY="${"x".repeat(1_000)}\n${rest}${" ".repeat(64_000 - rest.length)}`]);
    expect(tail).toBe("");
  });

  it("does not show the end of a credential that goes across the guard", () => {
    const opaque = "q7".repeat(40);
    const tail = tailOf(["a".repeat(1_100), `${"b".repeat(7_890)} OPENAI_API_KEY="${"c".repeat(200)}${opaque}" fatal`, "x".repeat(55_900)], 100_000);
    expect(tail).not.toContain(opaque);
    expect(tail.startsWith("fatal xxx")).toBe(true);
  });

  it("shows the end of a long text that the budget cut", () => {
    const tail = tailOf([...Array.from({ length: 5_000 }, (_, i) => `retry ${i} of the upstream call`), "fatal: gave up"]);
    expect(tail.endsWith("retry 4999 of the upstream call fatal: gave up")).toBe(true);
  });
});
