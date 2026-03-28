// eslint-disable-next-line no-restricted-imports -- useEffect: requestAnimationFrame for animation + setTimeout auto-dismiss with cleanup (timer-based side effects)
import { useEffect, useState } from "react";
import { CheckCircleIcon } from "@phosphor-icons/react";
import { Button } from "./ui/button.js";

export interface ToastData {
  message: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

interface ToastProps {
  toast: ToastData;
  onDismiss: () => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  const [visible, setVisible] = useState(false);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    // Trigger slide-in on mount
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // eslint-disable-next-line no-restricted-syntax -- existing usage
  useEffect(() => {
    const duration = toast.duration ?? 8000;
    const timer = setTimeout(() => {
      setVisible(false);
      // Wait for exit animation before removing
      setTimeout(onDismiss, 200);
    }, duration);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  const handleDismiss = () => {
    setVisible(false);
    setTimeout(onDismiss, 200);
  };

  return (
    <div
      data-testid="toast"
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border border-(--color-border-primary) bg-(--color-bg-elevated) text-sm text-(--color-text-primary) transition-all duration-200 ${
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
