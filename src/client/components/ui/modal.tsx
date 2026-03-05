import { forwardRef, type HTMLAttributes } from "react";

export type ModalProps = HTMLAttributes<HTMLDivElement> & {
  onClose?: () => void;
};

export const Modal = forwardRef<HTMLDivElement, ModalProps>(
  ({ className, onClose, children, ...props }, ref) => (
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
        className={`relative z-10 bg-(--color-bg-elevated) border border-(--color-border-primary) rounded-xl shadow-xl max-h-[90vh] overflow-auto ${className ?? ""}`}
        {...props}
      >
        {children}
      </div>
    </div>
  ),
);
Modal.displayName = "Modal";
