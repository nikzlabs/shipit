import { cn } from "../utils/cn.js";

export const BRAND_ACCENT = "#f0506e";

export type LogoSize = "md" | "lg";

const SIZES: Record<LogoSize, { icon: string; text: string; gap: string }> = {
  md: {
    icon: "w-5 h-5",
    text: "text-base sm:text-lg font-semibold tracking-tight",
    gap: "gap-1.5",
  },
  lg: {
    icon: "w-[30px] h-[30px] rounded-lg",
    text: "text-[27px] font-bold tracking-tight",
    gap: "gap-2.5",
  },
};

export function Logo({
  size = "md",
  className,
  textClassName,
}: {
  size?: LogoSize;
  className?: string;
  textClassName?: string;
}) {
  const s = SIZES[size];
  return (
    <span className={cn("inline-flex items-center", s.gap, className)}>
      <img src="/favicon.svg" alt="" className={s.icon} />
      <span className={cn(s.text, textClassName)}>
        Ship<span style={{ color: BRAND_ACCENT }}>It</span>
      </span>
    </span>
  );
}
