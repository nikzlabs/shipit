import { describe, expect, it, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu.js";

function RerenderingMenu({ onSelect }: { onSelect: () => void }) {
  const [, setTick] = useState(0);
  return (
    <>
      <button type="button" onClick={() => setTick((t) => t + 1)}>
        rerender
      </button>
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}

afterEach(() => cleanup());

describe("DropdownMenuContent overflow contract", () => {
  function renderOpenMenu() {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    return screen.getByRole("menu");
  }

  it("caps its height to the space Radix measured and scrolls the overflow", () => {
    const menu = renderOpenMenu();

    expect(menu).toHaveClass("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(menu).toHaveClass("overflow-y-auto");
  });

  it("keeps clipping horizontally so the rounded corners still hold", () => {
    expect(renderOpenMenu()).toHaveClass("overflow-x-hidden");
  });

  it("ignores the click of the gesture that opened it, but not a real one", () => {

    const onSelect = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = screen.getByText("one");

    fireEvent.click(item, { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();

    fireEvent.pointerDown(item, { pointerType: "touch" });
    fireEvent.click(item, { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not let a re-render between pointerdown and click eat the gesture", () => {

    // permission must live on the node and survive re-renders.
    const onSelect = vi.fn();
    render(<RerenderingMenu onSelect={onSelect} />);
    const item = screen.getByText("one");

    fireEvent.pointerDown(item, { pointerType: "touch" });

    fireEvent.click(screen.getByRole("button", { name: "rerender" }));
    fireEvent.click(item, { detail: 1 });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("clears the permission when the next pointerdown begins outside the menu", () => {
    // The opening tap's pointerdown is outside the menu, and it must also clear

    // click could ride on the stale flag and activate a row it never touched.
    const onSelect = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = screen.getByText("one");

    fireEvent.pointerDown(item, { pointerType: "touch" });

    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    // A ghost click at the row's coordinates must not activate it.
    fireEvent.click(item, { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not let one pointerdown authorise a second activation", () => {
    // The permission is consumed by the click it belongs to, so it cannot be
    // left armed for a later stray one — which matters because Radix keeps the

    const onSelect = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={(e) => { e.preventDefault(); onSelect(); }}>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = screen.getByText("one");

    fireEvent.pointerDown(item, { pointerType: "touch" });
    fireEvent.click(item, { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);

    fireEvent.click(item, { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("leaves keyboard selection alone", () => {

    const onSelect = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem onSelect={onSelect}>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    fireEvent.keyDown(screen.getByText("one"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("lets a call site add classes without dropping the overflow guard", () => {
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuItem>one</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass("w-56");
    expect(menu).toHaveClass("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(menu).toHaveClass("overflow-y-auto");
  });
});
