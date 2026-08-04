import { forwardRef, useCallback, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button, type ButtonProps } from "./button.js";
import { ICON_SIZE } from "../../design-tokens.js";

export type CopyButtonProps = Omit<ButtonProps, "onClick" | "children" | "type"> & {
  /**
   * Text to copy. Pass a function to compute it lazily at click time — useful
   * when the value depends on state captured at the moment of the click (e.g. a
   * payload stamped with the current timestamp).
   */
  text: string | (() => string);
  /** Idle label. Default "Copy". Pass an empty string to render icon-only. */
  label?: string;
  /** Label shown briefly after a successful copy. Default "Copied". */
  copiedLabel?: string;
  /** Milliseconds before reverting to the idle state. Default 2000. */
  timeout?: number;
  /** Phosphor icon size. Default `ICON_SIZE.SM`. */
  iconSize?: number;
};

/**
 * Clipboard copy button: encapsulates the `copied` state, the
 * `navigator.clipboard.writeText` call, the timed reset, and the
 * CopyIcon → CheckIcon + label swap that was previously re-implemented inline at
 * every copy site. Built on `Button` so it inherits styling and accepts the full
 * variant/size/className surface (defaults to `ghost`/`sm`).
 *
 * Clipboard writes can reject (insecure context, permission policy); we swallow
 * the error so the surrounding UI never crashes — the user can still
 * select-and-copy manually.
 */
export const CopyButton = forwardRef<HTMLButtonElement, CopyButtonProps>(
  (
    {
      text,
      label = "Copy",
      copiedLabel = "Copied",
      timeout = 2000,
      iconSize = ICON_SIZE.SM,
      variant = "ghost",
      size = "sm",
      className,
      "aria-label": ariaLabel,
      ...props
    },
    ref,
  ) => {
    const [copied, setCopied] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const handleCopy = useCallback(async () => {
      const value = typeof text === "function" ? text() : text;
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        // Clear any in-flight reset so rapid re-clicks don't revert early; a
        // reset firing after unmount is a harmless no-op under React 18+.
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), timeout);
      } catch {
        // Clipboard unavailable (insecure context / permission policy) — swallow
        // so the surrounding UI doesn't crash.
      }
    }, [text, timeout]);

    return (
      <Button
        ref={ref}
        variant={variant}
        size={size}
        className={className}
        aria-label={ariaLabel ?? (copied ? copiedLabel : label || "Copy")}
        {...props}
        type="button"
        onClick={() => void handleCopy()}
      >
        {copied ? <CheckIcon size={iconSize} /> : <CopyIcon size={iconSize} />}
        {label ? <span>{copied ? copiedLabel : label}</span> : null}
      </Button>
    );
  },
);
CopyButton.displayName = "CopyButton";
