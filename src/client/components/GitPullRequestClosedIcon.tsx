// Phosphor has no closed-pull-request glyph; match its 256 viewBox and stroke weight.
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
      <path d="M104,64A32,32,0,1,0,64,95v66a32,32,0,1,0,16,0V95A32.06,32.06,0,0,0,104,64ZM56,64A16,16,0,1,1,72,80,16,16,0,0,1,56,64ZM88,192a16,16,0,1,1-16-16A16,16,0,0,1,88,192Z" />
      <path d="M192,161V120a8,8,0,0,0-16,0v41a32,32,0,1,0,16,0Zm-8,47a16,16,0,1,1,16-16A16,16,0,0,1,184,208Z" />
      <path d="M211.31,69.66,200,81l11.31,11.31a8,8,0,0,1-11.32,11.32L188.69,92.34,177.37,103.66a8,8,0,0,1-11.32-11.32L177.37,81,166.05,69.66a8,8,0,0,1,11.32-11.32L188.69,69.66,200,58.34a8,8,0,1,1,11.32,11.32Z" />
    </svg>
  );
}
