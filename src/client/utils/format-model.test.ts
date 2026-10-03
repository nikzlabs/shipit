import { afterEach, describe, expect, it } from "vitest";
import { formatModelName } from "./format-model.js";
import {
  applyModelList,
  exportModelList,
  parseModelList,
  serializeModelList,
} from "../../server/shared/catalogue/index.js";

afterEach(() => applyModelList(undefined));

describe("formatModelName", () => {
  // docs/318 req 5 — the picker's trigger names the model the menu offers.
  it("follows a relabel in the model list the server sends", () => {
    expect(formatModelName("claude-sonnet-5")).toBe("Sonnet 5");

    const doc = exportModelList();
    const row = doc.services.anthropic?.sub?.models.find((m) => m.id === "claude-sonnet-5");
    if (row) row.label = "Sonnet 5 (new)";
    applyModelList(parseModelList(JSON.parse(serializeModelList(doc)))?.doc);

    expect(formatModelName("claude-sonnet-5")).toBe("Sonnet 5 (new)");
  });
});
