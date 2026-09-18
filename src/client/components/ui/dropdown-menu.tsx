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

  portaled?: boolean;
};

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

    onPointerDownCapture,
    onPointerUpCapture,
    onClickCapture,
    ...props
  },
  ref,
) => {
  // ── The tap that OPENS a menu must never also activate a row ──────────────

  // pointerdown we never saw — is the opening gesture spilling over, and is

  // now". A touch never delivers one (the pointer is implicitly captured by the

  // uses today, would never remount at all). One pointerdown authorises exactly

  const gestureStartedInside = useRef(false);
  const contentNodeRef = useRef<ComponentRef<typeof DropdownMenuPrimitive.Content> | null>(null);
  const setContentRef = useCallback(
    (node: ComponentRef<typeof DropdownMenuPrimitive.Content> | null) => {
      contentNodeRef.current = node;
      assignRef(ref, node);
    },
    [ref],
  );

  // click it belongs to. It must survive every re-render of the content:

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

        // — silently, because `overflow-hidden` shows no scrollbar. The rows

        // already fit are unaffected (a max-height never shrinks them).

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
