import { forwardRef, useCallback, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button, type ButtonProps } from "./button.js";
import { ICON_SIZE } from "../../design-tokens.js";

export type CopyButtonProps = Omit<ButtonProps, "onClick" | "children" | "type"> & {

  text: string | (() => string);

  label?: string;

  copiedLabel?: string;

  timeout?: number;

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

        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), timeout);
      } catch {
        // Clipboard access can fail without permission.
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
