import { useEffect, useState } from "react";

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

  useEffect(() => {
    // Trigger slide-in on mount
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

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
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 transition-all duration-200 ${
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      }`}
    >
      <span className="text-green-500 shrink-0">&#10003;</span>
      <span>{toast.message}</span>
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick();
            handleDismiss();
          }}
          className="ml-2 px-3 py-1 rounded-md text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white shrink-0"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="ml-1 text-gray-400 hover:text-gray-200 shrink-0"
      >
        &times;
      </button>
    </div>
  );
}
