// eslint-disable-next-line no-restricted-imports -- useEffect: setTimeout auto-dismiss with cleanup (timer-based side effect)
import { useEffect, useState } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { Button } from "./ui/button.js";
import { useUiStore } from "../stores/ui-store.js";

export interface ToastData {
  message: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

interface ToastProps {
  toast: ToastData;
}

// Dismiss reads the latest store function inside the callback so the effect
// can depend on `toast` alone — an unstable `onDismiss` prop (a fresh arrow
// on every parent render) used to reset the auto-dismiss timer on every
// re-render, making toasts effectively permanent.
function clearToast(): void {
  useUiStore.getState().setToast(null);
}

export function Toast({ toast }: ToastProps) {
  const [visible, setVisible] = useState(true);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const duration = toast.duration ?? 8000;
    const timer = setTimeout(() => {
      setVisible(false);
      // Wait for exit animation before removing
      setTimeout(clearToast, 200);
    }, duration);
    return () => clearTimeout(timer);
  }, [toast]);

  const handleDismiss = () => {
    setVisible(false);
    setTimeout(clearToast, 200);
  };

  return (
    <div
      data-testid="toast"
      className={`toast-enter fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border border-(--color-border-primary) bg-(--color-bg-elevated) text-sm text-(--color-text-primary) transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      <CheckCircleIcon size={16} className="text-(--color-success) shrink-0" />
      <span>{toast.message}</span>
      {toast.action && (
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            toast.action!.onClick();
            handleDismiss();
          }}
          className="ml-2 shrink-0"
        >
          {toast.action.label}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="ml-1 shrink-0"
      >
        &times;
      </Button>
    </div>
  );
}
