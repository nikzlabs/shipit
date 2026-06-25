import {
  forwardRef,
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

// ── Back-button dismissal ───────────────────────────────────────────────────
//
// ShipIt runs on react-router (`/session/:id`). Without this, pressing the
// browser / PWA / Android hardware **Back** button while a dialog is open pops a
// ROUTE — so on a phone "back" navigates to *another session* instead of closing
// the dialog the user is actually looking at (and on a fullscreen mobile dialog,
// with no tappable backdrop and no Esc key, the in-dialog close button may be the
// only other way out).
//
// So every dialog becomes a history "trap": opening pushes a dummy **same-URL**
// history entry (react-router sees no location change, so it never navigates);
// Back pops that entry and we translate it into a *close* instead; closing by any
// OTHER means (the X, Esc, the backdrop, an action button) consumes the dummy
// entry so the history stack stays balanced.
//
// This lives INSIDE the shared `Dialog` wrapper on purpose. Every dialog already
// routes through it, so the behavior is automatic and impossible to forget —
// there is no per-dialog hook to wire up (that "someone forgot to wire it"
// failure mode is exactly what we're avoiding). A module-level LIFO stack makes a
// single Back close only the *topmost* dialog when several are open at once.

type DismissEntry = { close: () => void };
const dismissStack: DismissEntry[] = [];
let popListenerInstalled = false;
// Number of pending programmatic `history.back()` calls whose resulting popstate
// must NOT be treated as a user pressing Back (they're our own cleanup).
let suppressPops = 0;

function handleGlobalPop() {
  if (suppressPops > 0) {
    suppressPops--;
    return;
  }
  // Back was pressed: close the topmost open dialog. The browser has already
  // popped our dummy entry, so the stack and history stay in sync.
  const top = dismissStack.pop();
  if (top) top.close();
  // Empty stack → a real navigation; let react-router handle it untouched.
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
  // Keep the latest onOpenChange without re-running the effect every render.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    // Only controlled dialogs (the norm here) can be closed via onOpenChange.
    if (!open || !onOpenChangeRef.current || typeof window === "undefined") return;

    ensurePopListener();
    const entry: DismissEntry = { close: () => onOpenChangeRef.current?.(false) };
    dismissStack.push(entry);
    window.history.pushState({ ...window.history.state, __shipitDialog: true }, "");

    return () => {
      const idx = dismissStack.indexOf(entry);
      if (idx === -1) {
        // Already removed by handleGlobalPop → Back closed us and the browser
        // already popped our dummy entry. Nothing to balance.
        return;
      }
      // Closed by some other means (X / Esc / backdrop / action button): our
      // dummy entry is still on the history stack. Pop it to stay balanced, and
      // suppress the resulting popstate so it doesn't also close the dialog
      // beneath us.
      dismissStack.splice(idx, 1);
      suppressPops++;
      window.history.back();
    };
  }, [open]);
}

// ── Components ──────────────────────────────────────────────────────────────

function Dialog({ open, onOpenChange, ...props }: ComponentPropsWithoutRef<typeof DialogPrimitive.Root>) {
  useBackDismiss(open, onOpenChange);
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />;
}

const DialogTrigger = DialogPrimitive.Trigger;

const DialogPortal = DialogPrimitive.Portal;

const DialogClose = DialogPrimitive.Close;

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
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /**
     * Suppress the built-in top-right close button. Pass this only when the
     * dialog renders its OWN close affordance (e.g. a header with an X) so the
     * two don't double up. Default: the close button is shown — every dialog
     * gets one for free, so none can ship without a way out (critical on mobile,
     * where the dialog is fullscreen with no tappable backdrop or Esc key).
     */
    hideClose?: boolean;
  }
>(({ className, children, hideClose = false, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
        "bg-(--color-bg-elevated) border border-(--color-border-primary) shadow-xl overflow-auto",
        "max-md:fixed max-md:inset-0 max-md:w-full max-md:h-full max-md:max-w-full! max-md:max-h-full! max-md:m-0! max-md:rounded-none max-md:border-0 max-md:translate-x-0 max-md:translate-y-0 max-md:left-0 max-md:top-0",
        // Fullscreen on mobile means the content (and any shrink-0 footer) reaches
        // the true viewport bottom, where the Android nav/gesture bar sits. The
        // native wrapper leaves the bottom inset to the web side (see
        // android/README.md "Edge-to-edge"), so reserve it here. env() is 0 when
        // there's no inset (desktop, no nav bar), so this is a no-op off-mobile.
        "max-md:[padding-bottom:env(safe-area-inset-bottom)]",
        "md:rounded-xl md:max-h-[90vh]",
        "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          className={cn(
            "absolute right-3 top-3 z-10 rounded-md p-1 transition-colors",
            "text-(--color-text-secondary) hover:bg-(--color-bg-hover) hover:text-(--color-text-primary)",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)",
            // Keep it clear of the status bar / notch when the dialog is fullscreen
            // on mobile. env() is 0 off-mobile, so this is the plain top-3 there.
            "max-md:top-[max(0.75rem,env(safe-area-inset-top))]",
          )}
          aria-label="Close"
          data-testid="dialog-close"
        >
          <XIcon size={ICON_SIZE.MD} />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = DialogPrimitive.Content.displayName;

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
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
  DialogClose,
};
