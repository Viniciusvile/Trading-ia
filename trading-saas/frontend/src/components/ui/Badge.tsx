import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "brand" | "up" | "down" | "warn";
type Size = "sm" | "md";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  size?: Size;
  icon?: ReactNode;
  dot?: boolean;
}

const tones: Record<Tone, string> = {
  neutral:
    "bg-[var(--color-surface-3)] text-[var(--color-text-2)] border border-[var(--color-border)]",
  brand: "bg-brand-soft",
  up: "bg-up",
  down: "bg-down",
  warn: "bg-warn",
};

const dots: Record<Tone, string> = {
  neutral: "bg-[var(--color-muted)]",
  brand: "bg-[var(--color-brand-500)]",
  up: "bg-[var(--color-up-500)]",
  down: "bg-[var(--color-down-500)]",
  warn: "bg-[var(--color-warn-500)]",
};

const sizes: Record<Size, string> = {
  sm: "text-[10px] px-2 py-0.5 gap-1",
  md: "text-xs px-2.5 py-1 gap-1.5",
};

export function Badge({
  tone = "neutral",
  size = "md",
  icon,
  dot = false,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center font-medium rounded-full whitespace-nowrap",
        tones[tone],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {dot && (
        <span
          aria-hidden
          className={cn("h-1.5 w-1.5 rounded-full", dots[tone])}
        />
      )}
      {icon}
      {children}
    </span>
  );
}
