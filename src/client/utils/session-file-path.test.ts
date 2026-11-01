import { describe, it, expect } from "vitest";
import { isPersistPath, sessionFileUrlPath } from "./session-file-path.js";
import { isEditableFilePath } from "./file-preview-type.js";

describe("sessionFileUrlPath", () => {
  it("leaves workspace paths as they were", () => {
    expect(sessionFileUrlPath("src/app.ts")).toBe("src/app.ts");
    expect(sessionFileUrlPath("persist/app.ts")).toBe("persist/app.ts");
    expect(sessionFileUrlPath("/uploads/a.png")).toBe("uploads/a.png");
  });

  it("keeps the leading slash of a /persist path, encoded", () => {
    expect(sessionFileUrlPath("/persist/notes/a b#1.md")).toBe("%2Fpersist/notes/a%20b%231.md");
  });
});

describe("isPersistPath", () => {
  it("matches only paths inside /persist", () => {
    expect(isPersistPath("/persist/a.md")).toBe(true);
    expect(isPersistPath("persist/a.md")).toBe(false);
    expect(isPersistPath("/persistent/a.md")).toBe(false);
  });
});

describe("isEditableFilePath", () => {
  it("does not offer editing for /persist files", () => {
    expect(isEditableFilePath("/persist/a.md")).toBe(false);
    expect(isEditableFilePath("persist/a.md")).toBe(true);
  });
});
