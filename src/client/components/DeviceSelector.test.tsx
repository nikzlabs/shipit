import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeviceSelector } from "./DeviceSelector.js";
import { DEVICE_PRESETS, findPresetById } from "./device-presets.js";

afterEach(() => {
  cleanup();
});

const baseProps = {
  activePreset: null,
  isLandscape: false,
  customSize: null,
  onSelectPreset: vi.fn(),
  onToggleLandscape: vi.fn(),
  onCustomSize: vi.fn(),
};

describe("DeviceSelector", () => {
  it("shows 'Responsive' label by default", () => {
    render(<DeviceSelector {...baseProps} />);
    expect(screen.getByLabelText("Select device viewport")).toHaveTextContent("Responsive");
  });

  it("shows the active preset label when one is selected", () => {
    const preset = findPresetById("iphone-14")!;
    render(<DeviceSelector {...baseProps} activePreset={preset} />);
    expect(screen.getByLabelText("Select device viewport")).toHaveTextContent("iPhone 14");
  });

  it("opens dropdown and lists phones and tablets", async () => {
    const user = userEvent.setup();
    render(<DeviceSelector {...baseProps} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    // Should include all phone presets
    for (const p of DEVICE_PRESETS.filter((p) => p.category === "phone")) {
      expect(screen.getByText(p.label)).toBeInTheDocument();
    }
    // Should include all tablet presets
    for (const p of DEVICE_PRESETS.filter((p) => p.category === "tablet")) {
      expect(screen.getByText(p.label)).toBeInTheDocument();
    }
    expect(screen.getByText("Phones")).toBeInTheDocument();
    expect(screen.getByText("Tablets")).toBeInTheDocument();
    expect(screen.getByText("Custom")).toBeInTheDocument();
  });

  it("calls onSelectPreset with null when Responsive is chosen", async () => {
    const user = userEvent.setup();
    const onSelectPreset = vi.fn();
    const preset = findPresetById("iphone-14")!;
    render(<DeviceSelector {...baseProps} activePreset={preset} onSelectPreset={onSelectPreset} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    await user.click(screen.getByText("Responsive"));
    expect(onSelectPreset).toHaveBeenCalledWith(null);
  });

  it("calls onSelectPreset with the chosen preset", async () => {
    const user = userEvent.setup();
    const onSelectPreset = vi.fn();
    render(<DeviceSelector {...baseProps} onSelectPreset={onSelectPreset} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    await user.click(screen.getByText("iPhone SE"));
    expect(onSelectPreset).toHaveBeenCalledWith(findPresetById("iphone-se"));
  });

  it("does not show rotate button when no preset is active", () => {
    render(<DeviceSelector {...baseProps} />);
    expect(screen.queryByLabelText(/Switch to/)).not.toBeInTheDocument();
  });

  it("shows rotate button when a preset is active", () => {
    const preset = findPresetById("iphone-14")!;
    render(<DeviceSelector {...baseProps} activePreset={preset} />);
    expect(screen.getByLabelText("Switch to landscape")).toBeInTheDocument();
  });

  it("toggles landscape label based on isLandscape prop", () => {
    const preset = findPresetById("iphone-14")!;
    const { rerender } = render(<DeviceSelector {...baseProps} activePreset={preset} />);
    expect(screen.getByLabelText("Switch to landscape")).toBeInTheDocument();
    rerender(<DeviceSelector {...baseProps} activePreset={preset} isLandscape={true} />);
    expect(screen.getByLabelText("Switch to portrait")).toBeInTheDocument();
  });

  it("calls onToggleLandscape when rotate button is clicked", async () => {
    const user = userEvent.setup();
    const onToggleLandscape = vi.fn();
    const preset = findPresetById("iphone-14")!;
    render(
      <DeviceSelector
        {...baseProps}
        activePreset={preset}
        onToggleLandscape={onToggleLandscape}
      />,
    );
    await user.click(screen.getByLabelText("Switch to landscape"));
    expect(onToggleLandscape).toHaveBeenCalled();
  });

  it("calls onCustomSize with width and height when Apply is clicked", async () => {
    const user = userEvent.setup();
    const onCustomSize = vi.fn();
    render(<DeviceSelector {...baseProps} onCustomSize={onCustomSize} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    const widthInput = screen.getByLabelText("Custom width") as HTMLInputElement;
    const heightInput = screen.getByLabelText("Custom height") as HTMLInputElement;
    await user.clear(widthInput);
    await user.type(widthInput, "500");
    await user.clear(heightInput);
    await user.type(heightInput, "900");
    await user.click(screen.getByTitle("Apply custom size"));
    expect(onCustomSize).toHaveBeenCalledWith(500, 900);
  });

  it("ignores invalid custom size", async () => {
    const user = userEvent.setup();
    const onCustomSize = vi.fn();
    render(<DeviceSelector {...baseProps} onCustomSize={onCustomSize} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    const widthInput = screen.getByLabelText("Custom width") as HTMLInputElement;
    await user.clear(widthInput);
    await user.click(screen.getByTitle("Apply custom size"));
    expect(onCustomSize).not.toHaveBeenCalled();
  });

  it("renders preset dimensions in the menu", async () => {
    const user = userEvent.setup();
    render(<DeviceSelector {...baseProps} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    expect(screen.getByText("390×844")).toBeInTheDocument();
    expect(screen.getByText("768×1024")).toBeInTheDocument();
  });
});
