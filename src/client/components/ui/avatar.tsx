import type { CSSProperties } from "react";
import { cn } from "../../utils/cn.js";

/** Default avatar diameter in pixels (Tailwind `size-5`). */
const DEFAULT_SIZE = 20;

/** Fallback initials: the first character of the name, or "?" when empty. */
function firstCharInitial(name: string): string {
  return name.charAt(0) || "?";
}

export interface AvatarProps {
  /** Display name, used for the initials fallback and (by default) image alt text. */
  name: string;
  /** Avatar image URL. When present, renders an `<img>`; otherwise an initials circle. */
  avatarUrl?: string;
  /** Diameter in pixels. Default 20 (Tailwind `size-5`). */
  size?: number;
  /**
   * Derive the fallback initials from the name. Defaults to the first character.
   * The logic varies per site (first char vs first-of-each-word), so it's a prop.
   */
  getInitials?: (name: string) => string;
  /** Alt text for the image branch. Defaults to the name. */
  alt?: string;
  /** Extra classes merged onto the rendered element (image or initials circle). */
  className?: string;
}

/**
 * Round avatar that renders the user's image when available, falling back to a
 * styled initials circle. Shared primitive for refactor B (docs/225).
 */
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
