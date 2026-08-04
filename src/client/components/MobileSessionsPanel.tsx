import type { ReactNode } from "react";

interface MobileSessionsPanelProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** Keeps the mobile sessions drawer mounted so its navigation state survives closing. */
export function MobileSessionsPanel({ open, onClose, children }: MobileSessionsPanelProps) {
  return (
    <div
      className={`absolute inset-0 z-40 ${open ? "flex" : "hidden"}`}
      role="dialog"
      aria-label="Sessions"
      aria-hidden={!open}
    >
      <button
        type="button"
        aria-label="Close sessions"
        onClick={onClose}
        className="absolute inset-0 bg-(--color-bg-overlay)"
      />
      <div className="relative flex h-full w-full bg-(--color-bg-primary)">
        {children}
      </div>
    </div>
  );
}
