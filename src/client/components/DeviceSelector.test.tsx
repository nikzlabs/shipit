import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
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

  it("ignores invalid custom size (empty)", async () => {
    const user = userEvent.setup();
    const onCustomSize = vi.fn();
    render(<DeviceSelector {...baseProps} onCustomSize={onCustomSize} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    const widthInput = screen.getByLabelText("Custom width") as HTMLInputElement;
    await user.clear(widthInput);
    const applyBtn = screen.getByRole("button", { name: "Apply" });
    expect(applyBtn).toBeDisabled();
    await user.click(applyBtn);
    expect(onCustomSize).not.toHaveBeenCalled();
  });

  it("rejects custom size below minimum", async () => {
    const user = userEvent.setup();
    const onCustomSize = vi.fn();
    render(<DeviceSelector {...baseProps} onCustomSize={onCustomSize} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    const widthInput = screen.getByLabelText("Custom width") as HTMLInputElement;
    await user.clear(widthInput);
    await user.type(widthInput, "50");
    expect(widthInput).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Must be 100–2560 px/)).toBeInTheDocument();
    const applyBtn = screen.getByRole("button", { name: "Apply" });
    expect(applyBtn).toBeDisabled();
    await user.click(applyBtn);
    expect(onCustomSize).not.toHaveBeenCalled();
  });

  it("rejects custom size above maximum", async () => {
    const user = userEvent.setup();
    const onCustomSize = vi.fn();
    render(<DeviceSelector {...baseProps} onCustomSize={onCustomSize} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    const heightInput = screen.getByLabelText("Custom height") as HTMLInputElement;
    await user.clear(heightInput);
    await user.type(heightInput, "9999");
    expect(heightInput).toHaveAttribute("aria-invalid", "true");
    const applyBtn = screen.getByRole("button", { name: "Apply" });
    expect(applyBtn).toBeDisabled();
    await user.click(applyBtn);
    expect(onCustomSize).not.toHaveBeenCalled();
  });

  it("accepts custom size at the boundaries", async () => {
    const user = userEvent.setup();
    const onCustomSize = vi.fn();
    render(<DeviceSelector {...baseProps} onCustomSize={onCustomSize} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    const widthInput = screen.getByLabelText("Custom width") as HTMLInputElement;
    const heightInput = screen.getByLabelText("Custom height") as HTMLInputElement;
    await user.clear(widthInput);
    await user.type(widthInput, "100");
    await user.clear(heightInput);
    await user.type(heightInput, "2560");
    await user.click(screen.getByTitle("Apply custom size"));
    expect(onCustomSize).toHaveBeenCalledWith(100, 2560);
  });

  it("renders preset dimensions in the menu", async () => {
    const user = userEvent.setup();
    render(<DeviceSelector {...baseProps} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    expect(screen.getByText("390×844")).toBeInTheDocument();
    expect(screen.getByText("768×1024")).toBeInTheDocument();
  });

  it("closes dropdown when clicking outside", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <DeviceSelector {...baseProps} />
        <button data-testid="outside">outside</button>
      </div>,
    );
    await user.click(screen.getByLabelText("Select device viewport"));
    expect(screen.getByText("Phones")).toBeInTheDocument();
    // Radix listens for pointerdown outside the menu to close it.
    // userEvent.click won't fire on elements with pointer-events: none (Radix's
    // outside-overlay), so we dispatch the pointerdown directly.
    fireEvent.pointerDown(screen.getByTestId("outside"));
    await waitFor(() => {
      expect(screen.queryByText("Phones")).not.toBeInTheDocument();
    });
  });

  it("closes dropdown when Escape is pressed", async () => {
    const user = userEvent.setup();
    render(<DeviceSelector {...baseProps} />);
    await user.click(screen.getByLabelText("Select device viewport"));
    expect(screen.getByText("Phones")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByText("Phones")).not.toBeInTheDocument();
    });
  });
});
