/**
 * GitPullRequestClosedIcon — GitHub's "git-pull-request-closed" Octicon.
 *
 * Phosphor (our default icon pack) ships no closed-pull-request glyph, so this
 * one-off mirrors GitHub's own icon pixel-for-pixel for the closed-PR badge —
 * the single sanctioned exception to the "icons come from @phosphor-icons"
 * rule, justified by matching the user's GitHub muscle memory. Props mirror the
 * subset of Phosphor's icon API we actually use (`size` + SVG passthrough), so
 * it drops into the same `<Icon size={…} />` call sites.
 */
import type { SVGProps } from "react";

export function GitPullRequestClosedIcon({
  size = 16,
  ...props
}: { size?: number | string } & Omit<SVGProps<SVGSVGElement>, "width" | "height">) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
    </svg>
  );
}
