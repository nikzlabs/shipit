import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryBudget } from "./MemoryBudget.js";
import { useSettingsStore } from "../../../stores/settings-store.js";
import { initialSettingValues } from "../../../stores/setting-values.js";
import { useUiStore } from "../../../stores/ui-store.js";
import { findSetting } from "../../../../server/shared/settings-catalogue/index.js";
import { resetDeclaredSaves } from "../declared-setting.js";

const KEY = "advanced.memoryBudgetMb" as const;

function seed(mb: number | null): void {
  act(() => { useSettingsStore.getState().setSettingValue(KEY, mb); });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settingValues: initialSettingValues(), memoryBudgetMb: null });
  useUiStore.getState().setDockerMemory(null as never);
  useUiStore.getState().setToast(null);
  resetDeclaredSaves();
});

/**
 * docs/308-data-driven-settings req 3 — custom is how it LOOKS. The unit and the
 * explicit Save are this component's; where the value goes is the declaration's,
 * which is what these tests check alongside the conversion.
 */
describe("MemoryBudget", () => {
  it("shows the stored MB value in GB", () => {
    seed(8192);
    render(<MemoryBudget settingKey={KEY} />);
    expect(screen.getByTestId("settings-memory-budget")).toHaveValue(8);
  });

  it("is empty when no budget is stored", () => {
    render(<MemoryBudget settingKey={KEY} />);
    expect(screen.getByTestId("settings-memory-budget")).toHaveValue(null);
  });

  it("saves GB back as MB, through the store the declaration names", async () => {
    seed(8192);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<MemoryBudget settingKey={KEY} />);
    fireEvent.change(screen.getByTestId("settings-memory-budget"), { target: { value: "16" } });
    await userEvent.click(screen.getByTestId("settings-memory-budget-save"));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({ method: "PUT", body: JSON.stringify({ memoryBudgetMb: 16384 }) }),
      );
    });
  });

  it("saves null when the field is cleared", async () => {
    seed(8192);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<MemoryBudget settingKey={KEY} />);
    fireEvent.change(screen.getByTestId("settings-memory-budget"), { target: { value: "" } });
    await userEvent.click(screen.getByTestId("settings-memory-budget-save"));
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({ body: JSON.stringify({ memoryBudgetMb: null }) }),
      );
    });
  });

  it("does not report a save the server refused", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    render(<MemoryBudget settingKey={KEY} />);
    fireEvent.change(screen.getByTestId("settings-memory-budget"), { target: { value: "4" } });

    await userEvent.click(screen.getByTestId("settings-memory-budget-save"));

    await waitFor(() => {
      expect(useUiStore.getState().toast?.message).toBe(
        `Failed to update ${findSetting(KEY)!.label}`,
      );
    });
    expect(screen.getByTestId("settings-memory-budget-save").textContent).toBe("Save");
  });

  // One write at a time, and "Saved" is about the value that was SENT: the
  // button is out of use while the request is, the box is not, so typing since
  // the send is unsaved work (slices 3, 4 and 7).
  it("takes one write at a time, and reports only the value it sent", async () => {
    let land: (() => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockReturnValue(new Promise((resolve) => {
      land = () => { resolve(new Response("{}", { status: 200 })); };
    }));
    render(<MemoryBudget settingKey={KEY} />);
    fireEvent.change(screen.getByTestId("settings-memory-budget"), { target: { value: "4" } });
    await userEvent.click(screen.getByTestId("settings-memory-budget-save"));

    expect(screen.getByTestId("settings-memory-budget-save").textContent).toBe("Saving…");
    await userEvent.click(screen.getByTestId("settings-memory-budget-save"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByTestId("settings-memory-budget"), { target: { value: "6" } });
    await act(async () => { land!(); await Promise.resolve(); });

    expect(screen.getByTestId("settings-memory-budget-save").textContent).toBe("Save");
  });

  it("reports the save, and stops reporting it once the field is edited again", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(<MemoryBudget settingKey={KEY} />);
    fireEvent.change(screen.getByTestId("settings-memory-budget"), { target: { value: "4" } });
    await userEvent.click(screen.getByTestId("settings-memory-budget-save"));
    // Exact, because `toHaveTextContent("Save")` accepts "Saved" too.
    expect(screen.getByTestId("settings-memory-budget-save").textContent).toBe("Saved");
    fireEvent.change(screen.getByTestId("settings-memory-budget"), { target: { value: "6" } });
    expect(screen.getByTestId("settings-memory-budget-save").textContent).toBe("Save");
  });

  // docs/284 req 13 — an install default is not this setting's value, so it is
  // said beneath the description rather than filled into the field.
  it("names the install default only while nothing is stored", () => {
    act(() => {
      useUiStore.getState().setDockerMemory({ budgetBytes: 8 * 1024 ** 3 } as never);
    });
    const { rerender } = render(<MemoryBudget settingKey={KEY} />);
    expect(screen.getByTestId("settings-memory-budget-effective")).toHaveTextContent("8 GB");
    seed(4096);
    rerender(<MemoryBudget settingKey={KEY} />);
    expect(screen.queryByTestId("settings-memory-budget-effective")).toBeNull();
  });
});
