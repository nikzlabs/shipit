import {
  forwardRef,
  // eslint-disable-next-line no-restricted-imports -- useEffect powers the Back-button history subscription (pushState + popstate, with cleanup) in useBackDismiss below
  useEffect,
  useRef,
  type ComponentPropsWithoutRef,
  type ComponentRef,
  type HTMLAttributes,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "@phosphor-icons/react";
import { cn } from "../../utils/cn.js";
import { ICON_SIZE } from "../../design-tokens.js";

// history entry (react-router sees no location change, so it never navigates);

// below, so a dialog cannot ship without a way out (X, Esc, backdrop, or Back).

interface DismissEntry {
  close: () => void;
}
const dismissStack: DismissEntry[] = [];
let popListenerInstalled = false;

// must NOT be treated as a user pressing Back (they're our own cleanup).
let suppressPops = 0;

function handleGlobalPop() {
  if (suppressPops > 0) {
    suppressPops--;
    return;
  }

  const top = dismissStack.pop();
  if (top) top.close();

}

function ensurePopListener() {
  if (popListenerInstalled || typeof window === "undefined") return;
  window.addEventListener("popstate", handleGlobalPop);
  popListenerInstalled = true;
}

function useBackDismiss(
  open: boolean | undefined,
  onOpenChange?: (open: boolean) => void,
) {

  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  // eslint-disable-next-line no-restricted-syntax -- browser API subscription: pushes a history entry and listens for popstate (Back) to dismiss, with cleanup
  useEffect(() => {

    if (!open || !onOpenChangeRef.current || typeof window === "undefined") return;

    ensurePopListener();
    const entry: DismissEntry = { close: () => onOpenChangeRef.current?.(false) };
    dismissStack.push(entry);
    window.history.pushState({ ...window.history.state, __shipitDialog: true }, "");

    return () => {
      const idx = dismissStack.indexOf(entry);
      if (idx === -1) {

        return;
      }

      dismissStack.splice(idx, 1);

      const state = window.history.state as { __shipitDialog?: boolean } | null;
      if (!state?.__shipitDialog) return;
      suppressPops++;
      window.history.back();
    };
  }, [open]);
}

function Dialog({
  open,
  onOpenChange,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Root>, "onOpenChange"> & {

  // destructured handler doesn't trip @typescript-eslint/unbound-method.
  onOpenChange?: (open: boolean) => void;
}) {
  useBackDismiss(open, onOpenChange);
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />;
}

const DialogPortal = DialogPrimitive.Portal;

const DialogOverlay = forwardRef<
  ComponentRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-(--color-bg-overlay)",
      "data-[state=open]:animate-in data-[state=open]:fade-in-0",
      "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = forwardRef<
  ComponentRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
        "bg-(--color-bg-elevated) border border-(--color-border-primary) shadow-xl overflow-auto",
        "max-md:fixed max-md:inset-0 max-md:w-full max-md:h-full max-md:max-w-full! max-md:max-h-full! max-md:m-0! max-md:rounded-none max-md:border-0 max-md:translate-x-0 max-md:translate-y-0 max-md:left-0 max-md:top-0",

        "max-md:[padding-bottom:env(safe-area-inset-bottom)]",
        "md:rounded-xl md:max-h-[90vh]",

        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
        className,
      )}
      {...props}
    >
      {children}
      {/* The single, canonical close button for every dialog. Defined here so no
          dialog can ship without a way out — critical on mobile, where the dialog
          is fullscreen with no tappable backdrop and no Esc key. Closing routes
          through onOpenChange, the same path Esc / backdrop / Back already use. */}
      <DialogPrimitive.Close
        className={cn(
          // The vertical inset is a variable because the button is a fixed 28px
          // box (20px icon + p-1) while header rows are not: at the default
          // 0.75rem it centres on a ~52px row, so on a SHORTER header it sits
          // low and grazes the bottom border. A dialog with a compact header
          // row sets `--dialog-close-top` on its DialogContent to
          // `(rowHeight - 28px) / 2` and the button centres on that row's text.
          "absolute right-3 top-[var(--dialog-close-top,0.75rem)] z-10 rounded-md p-1 transition-colors",
          "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)",
          // Keep fullscreen dialogs below the mobile safe area.
          "max-md:top-[max(var(--dialog-close-top,0.75rem),env(safe-area-inset-top))]",
        )}
        aria-label="Close"
        data-testid="dialog-close"
      >
        <XIcon size={ICON_SIZE.MD} />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

/**
 * The raw Radix content node: focus trap, focus restoration to the trigger on
 * close, Escape, outside-pointer dismissal and `aria-hidden` on the background —
 * with no layout, no close button and no styling of its own.
 *
 * `DialogContent` is the default and stays the default. Reach for this only
 * when a surface genuinely is not "centered card, fullscreen on mobile" —
 * `NewSessionRepoBar`'s bottom sheet is the case it exists for. The point is
 * that a bespoke SHAPE must not also mean hand-rolling the focus behaviour:
 * doing that produced a surface claiming `aria-modal` that Tab could walk out
 * of, and that dropped focus on `<body>` when it closed.
 *
 * Callers own the whole className (including `fixed`/`z-50`), supply their own
 * `DialogOverlay` inside a `DialogPortal`, and must render a `DialogTitle` — it
 * is what names the dialog, and Radix warns in dev without one.
 */
const DialogPanel = DialogPrimitive.Content;

function DialogHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-between px-5 py-4 border-b border-(--color-border-secondary)",
        className,
      )}
      {...props}
    />
  );
}
DialogHeader.displayName = "DialogHeader";

function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex justify-end border-t border-(--color-border-secondary) px-4 py-3",
        className,
      )}
      {...props}
    />
  );
}
DialogFooter.displayName = "DialogFooter";

const DialogTitle = forwardRef<
  ComponentRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold text-(--color-text-primary)", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = forwardRef<
  ComponentRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-(--color-text-secondary)", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogPanel,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
