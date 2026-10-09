import { forwardRef, useCallback, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button, type ButtonProps } from "./button.js";
import { ICON_SIZE } from "../../design-tokens.js";
import { copyText } from "../../utils/copy-text.js";

export type CopyButtonProps = Omit<ButtonProps, "onClick" | "children" | "type"> & {

  text: string | (() => string);

  label?: string;

  copiedLabel?: string;

  timeout?: number;

  iconSize?: number;
};

/**
 * Built on `Button`, so it accepts the full variant/size/className surface
 * (defaults to `ghost`/`sm`). A copy that fails leaves the idle label: the button
 * never reports a copy that did not happen.
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
      if (!(await copyText(value))) return;
      setCopied(true);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), timeout);
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
