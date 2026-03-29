// eslint-disable-next-line no-restricted-imports -- useEffect: keydown listener for Escape with cleanup (browser API subscription)
import { forwardRef, useEffect, type HTMLAttributes } from "react";

export type ModalProps = HTMLAttributes<HTMLDivElement> & {
  onClose?: () => void;
};

export const Modal = forwardRef<HTMLDivElement, ModalProps>(
  ({ className, onClose, children, ...props }, ref) => {
    // eslint-disable-next-line no-restricted-syntax -- existing usage
    useEffect(() => {
      if (!onClose) return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          onClose();
        }
      };
      document.addEventListener("keydown", handler);
      return () => document.removeEventListener("keydown", handler);
    }, [onClose]);

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-(--color-bg-overlay)"
          onClick={onClose}
          aria-hidden="true"
        />
        {/* Content */}
        <div
          ref={ref}
          className={`relative z-10 bg-(--color-bg-elevated) border border-(--color-border-primary) shadow-xl overflow-auto max-md:fixed max-md:inset-0 max-md:w-full max-md:h-full max-md:max-w-full! max-md:max-h-full! max-md:m-0! max-md:rounded-none max-md:border-0 md:rounded-xl md:max-h-[90vh] ${className ?? ""}`}
          {...props}
        >
          {children}
        </div>
      </div>
    );
  },
);
Modal.displayName = "Modal";
