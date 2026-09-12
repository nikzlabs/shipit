import type { CSSProperties } from "react";
import { cn } from "../../utils/cn.js";

const DEFAULT_SIZE = 20;

function firstCharInitial(name: string): string {
  return name.charAt(0) || "?";
}

export interface AvatarProps {

  name: string;

  avatarUrl?: string;

  size?: number;

  getInitials?: (name: string) => string;

  alt?: string;

  className?: string;
}

export function Avatar({
  name,
  avatarUrl,
  size = DEFAULT_SIZE,
  getInitials = firstCharInitial,
  alt,
  className,
}: AvatarProps) {
  const style: CSSProperties = { width: size, height: size };

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={alt ?? name}
        style={style}
        className={cn("shrink-0 rounded-full object-cover", className)}
        loading="lazy"
      />
    );
  }

  return (
    <div
      style={style}
      className={cn(
        "shrink-0 rounded-full bg-(--color-bg-tertiary) text-(--color-text-tertiary) flex items-center justify-center text-[10px] font-semibold uppercase",
        className,
      )}
    >
      {getInitials(name)}
    </div>
  );
}
