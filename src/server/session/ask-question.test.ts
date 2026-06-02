import { describe, it, expect } from "vitest";
import { normalizeAskQuestions } from "./ask-question.js";

describe("normalizeAskQuestions", () => {
  it("passes through a well-formed question unchanged", () => {
    expect(
      normalizeAskQuestions([
        {
          question: "Which database should we use?",
          header: "Database",
          multiSelect: false,
          options: [
            { label: "Postgres", description: "Relational" },
            { label: "Redis", description: "In-memory" },
          ],
        },
      ]),
    ).toEqual([
      {
        question: "Which database should we use?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "Postgres", description: "Relational" },
          { label: "Redis", description: "In-memory" },
        ],
      },
    ]);
  });

  it("synthesizes multiSelect=false and description fallbacks", () => {
    expect(
      normalizeAskQuestions([
        {
          question: "Pick a framework",
          header: "Framework",
          // multiSelect omitted; options missing descriptions
          options: [{ label: "React" }, { label: "Vue" }],
        },
      ]),
    ).toEqual([
      {
        question: "Pick a framework",
        header: "Framework",
        multiSelect: false,
        options: [
          { label: "React", description: "" },
          { label: "Vue", description: "" },
        ],
      },
    ]);
  });

  it("drops options without a label and questions left with none", () => {
    expect(
      normalizeAskQuestions([
        { question: "Q1", header: "H1", options: [{ description: "no label" }] },
        { question: "Q2", header: "H2", options: [{ label: "Keep" }] },
      ]),
    ).toEqual([
      { question: "Q2", header: "H2", multiSelect: false, options: [{ label: "Keep", description: "" }] },
    ]);
  });

  it("returns [] for non-array, empty, or unusable input", () => {
    expect(normalizeAskQuestions(undefined)).toEqual([]);
    expect(normalizeAskQuestions("nope")).toEqual([]);
    expect(normalizeAskQuestions([])).toEqual([]);
    expect(normalizeAskQuestions([{ question: "Q", header: "H", options: [] }])).toEqual([]);
  });
});
