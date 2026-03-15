import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatusBar, formatTokenCount, getContextLevel } from "./StatusBar.js";

afterEach(() => {
  cleanup();
});

describe("StatusBar", () => {
  it("renders nothing when modelInfo is null", () => {
    render(<StatusBar modelInfo={null} contextTokens={0} />);
    expect(screen.queryByTestId("status-bar")).toBeNull();
  });

it("shows context meter when contextTokens > 0", () => {
    render(
      <StatusBar
        modelInfo={{ model: "claude-opus-4-20250514", contextWindowTokens: 200000 }}
        contextTokens={42000}
      />
    );
    expect(screen.getByTestId("context-meter")).toBeInTheDocument();
  });

  it("hides context meter when contextTokens is 0", () => {
    render(
      <StatusBar
        modelInfo={{ model: "claude-opus-4-20250514", contextWindowTokens: 200000 }}
        contextTokens={0}
      />
    );
    expect(screen.queryByTestId("context-meter")).toBeNull();
  });
});

describe("formatTokenCount", () => {
  it("formats numbers correctly", () => {
    expect(formatTokenCount(500)).toBe("500");
    expect(formatTokenCount(1500)).toBe("1.5K");
    expect(formatTokenCount(42180)).toBe("42.2K");
    expect(formatTokenCount(1500000)).toBe("1.5M");
  });
});

describe("getContextLevel", () => {
  it("returns correct levels", () => {
    expect(getContextLevel(0)).toBe("green");
    expect(getContextLevel(30)).toBe("green");
    expect(getContextLevel(60)).toBe("yellow");
    expect(getContextLevel(80)).toBe("orange");
    expect(getContextLevel(90)).toBe("red");
    expect(getContextLevel(100)).toBe("red");
  });
});
