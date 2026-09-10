import { describe, it, expect } from "vitest";
import { installSkipOutputWarning, nonDependencyInstallSteps } from "./install-skip-warning.js";


describe("nonDependencyInstallSteps", () => {
  it("passes recognized pure dependency installs", () => {
    expect(nonDependencyInstallSteps(["npm ci", "pip install -r requirements.txt", "uv sync"]))
      .toEqual([]);
  });

  it("returns the steps that build or generate", () => {
    expect(nonDependencyInstallSteps(["npm ci", "npm run build", "npx prisma generate"]))
      .toEqual(["npm run build", "npx prisma generate"]);
  });
});

describe("installSkipOutputWarning", () => {
  it("warns when a build step meets default dep-dirs", () => {
    const warning = installSkipOutputWarning(["npm ci", "npm run build"], ["node_modules"]);
    expect(warning).not.toBeNull();
    expect(warning).toContain("npm run build");
    expect(warning).toContain("agent.dep-dirs");
  });

  it("stays quiet for a pure dependency install", () => {
    expect(installSkipOutputWarning(["npm ci"], ["node_modules"])).toBeNull();
    expect(installSkipOutputWarning([], ["node_modules"])).toBeNull();
  });

  it("stays quiet once dep-dirs is declared beyond the default", () => {
    expect(installSkipOutputWarning(["npm ci", "npm run build"], ["node_modules", "dist"]))
      .toBeNull();
    expect(installSkipOutputWarning(["npm run build"], ["dist"])).toBeNull();
  });

  it("stays quiet on an explicit opt-out", () => {
    expect(installSkipOutputWarning(["npm run build"], [])).toBeNull();
  });
});
