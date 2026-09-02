import {
  forwardRef,
  useCallback,
  // eslint-disable-next-line no-restricted-imports -- useEffect: document pointerdown subscription with cleanup (browser API subscription)
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type ReactNode,
  type Ref,
} from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "../../utils/cn.js";

const DropdownMenu = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Root>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Root>
>(({ modal = false, ...props }, _ref) => (
  <DropdownMenuPrimitive.Root modal={modal} {...props} />
));
DropdownMenu.displayName = DropdownMenuPrimitive.Root.displayName;

const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;

const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

type DropdownMenuContentProps = ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
  /** Render through Radix Portal by default; disable inside modal dialogs. */
  portaled?: boolean;
};

/** Forward a ref of either shape, so a wrapper can also use the node itself. */
function assignRef<T>(ref: Ref<T> | undefined, node: T | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as { current: T | null }).current = node;
}

const DropdownMenuContent = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>((
  {
    className,
    sideOffset = 4,
    collisionPadding = 8,
    portaled = true,
    // Pulled out of the spread so the guards below cannot be overwritten by a
    // caller's own capture handler — they compose with it instead.
    onPointerDownCapture,
    onPointerUpCapture,
    onClickCapture,
    ...props
  },
  ref,
) => {
  // ── The tap that OPENS a menu must never also activate a row ──────────────
  //
  // The trigger opens on `pointerdown`, but a touch produces its `click` a
  // moment later — and that click is dispatched at the touch COORDINATES, at
  // whatever is under them by then. On a phone that is routinely a menu row:
  // tapping the composer's settings anchor moves focus off the textarea, the
  // on-screen keyboard retracts, the layout grows back, and the menu — anchored
  // above the trigger — slides DOWN across the point the finger touched. The
  // ghost click then lands on the menu's bottom row and the menu appears to
  // open already inside a sub-panel (measured in Quick Capture: the Reasoning
  // row, every time). Radix has the same hole one layer down: `MenuItem`
  // synthesizes a click on any `pointerup` it receives without a matching
  // `pointerdown`.
  //
  // So a row is activated only by a gesture that BEGAN inside this menu.
  // Anything else — a click with pointer coordinates (`detail > 0`) whose
  // pointerdown we never saw — is the opening gesture spilling over, and is
  // swallowed. Keyboard activation is unaffected: `element.click()` carries
  // `detail === 0`.
  //
  // Press-drag-release from the trigger onto a row still works with a MOUSE,
  // which is where that idiom comes from: a mouse drag ends with a real
  // `pointerup` INSIDE the menu, and we accept that as "the gesture is here
  // now". A touch never delivers one (the pointer is implicitly captured by the
  // trigger), which is exactly the difference this leans on.
  //
  // The flag is armed by a pointerdown inside and CONSUMED by the click it
  // belongs to, rather than cleared per opening: Radix keeps the same content
  // node alive through the close animation, so a menu closed and reopened
  // quickly is not guaranteed a remount (and `forceMount`, which no call site
  // uses today, would never remount at all). One pointerdown authorises exactly
  // one activation, which needs no notion of "this opening" to be correct.
  const gestureStartedInside = useRef(false);
  const contentNodeRef = useRef<ComponentRef<typeof DropdownMenuPrimitive.Content> | null>(null);
  const setContentRef = useCallback(
    (node: ComponentRef<typeof DropdownMenuPrimitive.Content> | null) => {
      contentNodeRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  // The flag is armed by a pointerdown INSIDE the menu and consumed by the
  // click it belongs to. It must survive every re-render of the content:
  // Radix's composed refs make React re-apply this ref (and therefore any
  // reset in the callback above) on each render, and a touch tap re-renders
  // the content between `pointerup` and `click` (the tap focuses the row). A
  // reset there used to wipe a legitimate in-progress gesture, so the click
  // looked like a ghost and was swallowed — the "two taps to close" bug. The
  // clear belongs on the gesture this guard actually exists for: a pointerdown
  // OUTSIDE the menu (the opening tap), which also clears a stale flag left
  // by an aborted gesture across a quick close+reopen on the same node.
  // eslint-disable-next-line no-restricted-syntax -- document pointerdown subscription with cleanup (browser API subscription)
  useEffect(() => {
    const clearOnOutsidePointerDown = (event: PointerEvent) => {
      const node = contentNodeRef.current;
      if (!node || !(event.target instanceof Node) || !node.contains(event.target)) {
        gestureStartedInside.current = false;
      }
    };
    document.addEventListener("pointerdown", clearOnOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", clearOnOutsidePointerDown, true);
  }, []);

  const content: ReactNode = (
    <DropdownMenuPrimitive.Content
      ref={setContentRef}
      onPointerDownCapture={(e) => {
        gestureStartedInside.current = true;
        onPointerDownCapture?.(e);
      }}
      onPointerUpCapture={(e) => {
        if (e.pointerType !== "touch") gestureStartedInside.current = true;
        else if (!gestureStartedInside.current) e.stopPropagation();
        onPointerUpCapture?.(e);
      }}
      onClickCapture={(e) => {
        if (e.detail > 0 && !gestureStartedInside.current) {
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        gestureStartedInside.current = false;
        onClickCapture?.(e);
      }}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        "z-50 min-w-32 rounded-lg border border-(--color-border-primary) bg-(--color-bg-elevated) py-1 shadow-xl",
        // A menu with more items than the viewport can hold used to grow off
        // the top of the screen: Radix anchors it to the trigger and expands
        // upward, and with no cap the overflowing rows were simply unreachable
        // — silently, because `overflow-hidden` shows no scrollbar. The rows
        // lost are the ones at the TOP of the list, so e.g. a repo picker would
        // hide its own checkmarked current repo. Cap at the space Radix
        // measured on the chosen side and scroll the remainder; menus that
        // already fit are unaffected (a max-height never shrinks them).
        // `overflow-x-hidden` preserves the horizontal clip the rounded
        // corners rely on.
        "max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto overflow-x-hidden",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
        className,
      )}
      {...props}
    />
  );
  return portaled ? <DropdownMenuPrimitive.Portal>{content}</DropdownMenuPrimitive.Portal> : content;
});
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Item>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-xs text-(--color-text-secondary) outline-none transition-colors",
      "hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
      "focus:bg-(--color-bg-hover) focus:text-(--color-text-primary)",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm outline-none transition-colors",
      "hover:bg-(--color-bg-hover) focus:bg-(--color-bg-hover)",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    checked={checked}
    {...props}
  >
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.RadioItem>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      "relative flex cursor-pointer select-none items-center gap-2 px-3 py-2 text-sm outline-none transition-colors",
      "hover:bg-(--color-bg-hover) focus:bg-(--color-bg-hover)",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className,
    )}
    {...props}
  >
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Label>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(
      "px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-tertiary)",
      className,
    )}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = forwardRef<
  ComponentRef<typeof DropdownMenuPrimitive.Separator>,
  ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn("my-1 h-px bg-(--color-border-primary)", className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
};
