import { describe, it, expect } from "vitest";
import { sessionRelativePath } from "./path-utils.js";

describe("sessionRelativePath", () => {
  it("strips direct-mode prefix (with sessions/{uuid})", () => {
    expect(sessionRelativePath("/workspace/sessions/28e2fa34-abc/src/App.tsx"))
      .toBe("src/App.tsx");
  });

  it("strips container-mode prefix (/workspace/)", () => {
    expect(sessionRelativePath("/workspace/src/App.tsx"))
      .toBe("src/App.tsx");
  });

  it("handles root-level files in direct mode", () => {
    expect(sessionRelativePath("/workspace/sessions/abc-123/package.json"))
      .toBe("package.json");
  });

  it("handles root-level files in container mode", () => {
    expect(sessionRelativePath("/workspace/package.json"))
      .toBe("package.json");
  });

  it("returns 'file' for non-string input", () => {
    expect(sessionRelativePath(42)).toBe("file");
    expect(sessionRelativePath(null)).toBe("file");
    expect(sessionRelativePath(undefined)).toBe("file");
  });

  it("returns unchanged for non-matching paths", () => {
    expect(sessionRelativePath("src/App.tsx")).toBe("src/App.tsx");
  });

  it("handles deeply nested paths", () => {
    expect(sessionRelativePath("/workspace/sessions/test-1/src/components/Header.tsx"))
      .toBe("src/components/Header.tsx");
    expect(sessionRelativePath("/workspace/src/components/Header.tsx"))
      .toBe("src/components/Header.tsx");
  });
});
