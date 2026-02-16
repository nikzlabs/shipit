import { describe, it, expect } from "vitest";
import { shipitErrorCapturePlugin, ERROR_CAPTURE_SCRIPT } from "./vite-error-plugin.js";

describe("shipitErrorCapturePlugin", () => {
  it("returns a plugin with the correct name", () => {
    const plugin = shipitErrorCapturePlugin();
    expect(plugin.name).toBe("shipit-error-capture");
  });

  it("injects the script after <head>", () => {
    const plugin = shipitErrorCapturePlugin();
    const html = "<!DOCTYPE html><html><head><title>App</title></head><body></body></html>";
    const result = plugin.transformIndexHtml(html);
    const headIndex = result.indexOf("<head>");
    const scriptIndex = result.indexOf(ERROR_CAPTURE_SCRIPT);
    expect(scriptIndex).toBeGreaterThan(headIndex);
    expect(scriptIndex).toBeLessThan(result.indexOf("<title>"));
  });

  it("prepends the script when no <head> tag exists", () => {
    const plugin = shipitErrorCapturePlugin();
    const html = "<!DOCTYPE html><html><body></body></html>";
    const result = plugin.transformIndexHtml(html);
    expect(result.startsWith(ERROR_CAPTURE_SCRIPT)).toBe(true);
  });

  it("preserves the rest of the HTML content", () => {
    const plugin = shipitErrorCapturePlugin();
    const html = "<!DOCTYPE html><html><head><title>My App</title></head><body><div id='root'></div></body></html>";
    const result = plugin.transformIndexHtml(html);
    expect(result).toContain("<title>My App</title>");
    expect(result).toContain("<div id='root'></div>");
  });

  it("injects a script that posts messages to parent window", () => {
    expect(ERROR_CAPTURE_SCRIPT).toContain("window.parent.postMessage");
    expect(ERROR_CAPTURE_SCRIPT).toContain("shipit-preview");
    expect(ERROR_CAPTURE_SCRIPT).toContain("window.onerror");
    expect(ERROR_CAPTURE_SCRIPT).toContain("unhandledrejection");
    expect(ERROR_CAPTURE_SCRIPT).toContain("console.error");
    expect(ERROR_CAPTURE_SCRIPT).toContain("console.warn");
  });
});
