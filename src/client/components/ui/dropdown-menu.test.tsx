import { describe, expect, it, afterEach, vi } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu.js";

/** Re-renders on the press of the button, exactly like a state update that lands mid-gesture. */
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

/**
 * jsdom has no layout engine, so the *geometry* of the overflow fix can't be
 * asserted here — it was verified in a real browser across viewport sizes (see
 * `docs/236-issue-session-repo-picker/plan.md` → "Long menus"). What this file
 * guards is the class contract that produces that geometry, so removing the cap
 * fails loudly instead of silently reintroducing an unreachable menu.
 */
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
    // Without the cap the menu is anchored to its trigger and grows upward off
    // the top of the viewport — the rows lost are the ones at the TOP of the
    // list (for the repo picker, its own checkmarked current repo), and
    // `overflow-hidden` means there's no scrollbar hinting anything is missing.
    expect(menu).toHaveClass("max-h-(--radix-dropdown-menu-content-available-height)");
    expect(menu).toHaveClass("overflow-y-auto");
  });

  it("keeps clipping horizontally so the rounded corners still hold", () => {
    expect(renderOpenMenu()).toHaveClass("overflow-x-hidden");
  });

  it("ignores the click of the gesture that opened it, but not a real one", () => {
    // On a phone the tap that opens a menu can activate a row: the browser
    // sends its `click` at the touch COORDINATES a moment later, and the menu
    // moves under them in between (in Quick Capture, the on-screen keyboard
    // retracting grows the layout and slides the menu down across the finger).
    // Only a gesture that BEGAN inside the menu may select. jsdom has no
    // layout, so what is asserted here is that rule, not the geometry that
    // provokes it — the geometry was measured in a real browser at 390px.
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

    // The stray click: pointer coordinates (`detail: 1`), no pointerdown of its own.
    fireEvent.click(item, { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();

    // A tap that starts on the row does select it.
    fireEvent.pointerDown(item, { pointerType: "touch" });
    fireEvent.click(item, { detail: 1 });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("does not let a re-render between pointerdown and click eat the gesture", () => {
    // A touch tap re-renders the menu between its `pointerup` and `click` (the
    // tap focuses the row). Radix re-applies composed refs on every render, so
    // a flag reset in the content's ref callback used to be wiped mid-gesture:
    // the click then looked like a ghost (no pointerdown seen) and was
    // swallowed — the menu selected nothing and needed a second tap. The
    // permission must live on the node and survive re-renders.
    const onSelect = vi.fn();
    render(<RerenderingMenu onSelect={onSelect} />);
    const item = screen.getByText("one");

    fireEvent.pointerDown(item, { pointerType: "touch" });
    // Force the content to re-render before the click arrives.
    fireEvent.click(screen.getByRole("button", { name: "rerender" }));
    fireEvent.click(item, { detail: 1 });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("clears the permission when the next pointerdown begins outside the menu", () => {
    // The opening tap's pointerdown is outside the menu, and it must also clear
    // a permission left armed by an aborted gesture — otherwise a later ghost
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

    // A gesture begins inside the menu and is aborted without a click...
    fireEvent.pointerDown(item, { pointerType: "touch" });
    // ...then the next pointerdown is the opening tap, outside the menu.
    fireEvent.pointerDown(document.body, { pointerType: "touch" });
    // A ghost click at the row's coordinates must not activate it.
    fireEvent.click(item, { detail: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not let one pointerdown authorise a second activation", () => {
    // The permission is consumed by the click it belongs to, so it cannot be
    // left armed for a later stray one — which matters because Radix keeps the
    // content node alive through the close animation, so a quick close/reopen
    // is not guaranteed the remount a per-opening reset would rely on.
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
    // Radix synthesizes the keyboard's click from `keydown`, and
    // `element.click()` carries `detail: 0` — no pointer, nothing to guard.
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
