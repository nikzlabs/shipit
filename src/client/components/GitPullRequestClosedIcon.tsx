/**
 * GitPullRequestClosedIcon — closed-pull-request glyph drawn in Phosphor's style.
 *
 * Phosphor (our default icon pack) ships no closed-pull-request glyph, so this
 * one-off fills the gap — the single sanctioned exception to the "icons come
 * from @phosphor-icons" rule. It is NOT GitHub's Octicon: that glyph is a 16px
 * native drawing with thin strokes that fill the badge edge-to-edge, so next to
 * its Phosphor siblings (`GitPullRequest`/`GitMerge`) it read as too thin and
 * too large within the badge border. Instead this reuses Phosphor's own
 * `GitPullRequest` (regular) left rail verbatim and adds a right-side stem,
 * bottom dot, and an X mark drawn with Phosphor's 16-unit stroke weight on the
 * same 256 viewBox — so it matches its neighbors' stroke weight, dot size, and
 * internal padding pixel-for-pixel. Props mirror the subset of Phosphor's icon
 * API we use (`size` + SVG passthrough), so it drops into the same
 * `<Icon size={…} />` call sites.
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
      viewBox="0 0 256 256"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...props}
    >
      {/* Left rail (top dot + bar + bottom dot) — Phosphor GitPullRequest, regular weight */}
      <path d="M104,64A32,32,0,1,0,64,95v66a32,32,0,1,0,16,0V95A32.06,32.06,0,0,0,104,64ZM56,64A16,16,0,1,1,72,80,16,16,0,0,1,56,64ZM88,192a16,16,0,1,1-16-16A16,16,0,0,1,88,192Z" />
      {/* Right-side stem + bottom dot */}
      <path d="M192,161V120a8,8,0,0,0-16,0v41a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,184,208Z" />
      {/* X mark (top right) — closed-without-merge */}
      <path d="M211.31,69.66,200,81l11.31,11.31a8,8,0,0,1-11.32,11.32L188.69,92.34,177.37,103.66a8,8,0,0,1-11.32-11.32L177.37,81,166.05,69.66a8,8,0,0,1,11.32-11.32L188.69,69.66,200,58.34a8,8,0,1,1,11.32,11.32Z" />
    </svg>
  );
}
