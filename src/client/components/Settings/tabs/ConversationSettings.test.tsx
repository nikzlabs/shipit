import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConversationSettings } from "./AdvancedTab.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { getSavedCompactConversation, saveCompactConversation } from "../../../utils/local-storage.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); useSettingsStore.setState({ compactConversation: false }); });
it("starts off and saves the setting for the next load", () => {
  expect(getSavedCompactConversation()).toBe(false);
  render(<ConversationSettings />);
  const toggle = screen.getByRole("switch", { name: "Compact completed turns" });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  fireEvent.click(toggle);
  expect(getSavedCompactConversation()).toBe(true);
  expect(toggle).toHaveAttribute("aria-checked", "true");
});
it("falls back safely for invalid or unavailable storage", () => {
  localStorage.setItem("shipit-compact-conversation", "invalid");
  expect(getSavedCompactConversation()).toBe(false);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
  expect(getSavedCompactConversation()).toBe(false);
  expect(() => saveCompactConversation(true)).not.toThrow();
});
