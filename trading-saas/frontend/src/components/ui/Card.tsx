import { type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  padding?: "none" | "sm" | "md" | "lg";
}

const paddings = {
  none: "",
  sm: "p-3",
  md: "p-4 sm:p-5",
  lg: "p-5 sm:p-6",
};

export function Card({
  className,
  children,
  interactive = false,
  padding = "md",
  ...rest
}: CardProps) {
  return (
    <div
      className={cn(
        "bg-gradient-to-b from-[var(--color-surface-2)] to-[var(--color-surface)] border border-[var(--color-border)]",
        "rounded-[var(--radius-md)] shadow-[var(--shadow-card)]",
        "transition-colors duration-200 hover:border-[var(--color-border-strong)]",
        interactive &&
          "transition-all hover:shadow-[var(--shadow-card-hover)] hover:-translate-y-0.5 cursor-pointer",
        paddings[padding],
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function CardHeader({ title, subtitle, icon, action, className }: CardHeaderProps) {
  return (
    <div className={cn("flex items-start justify-between gap-3 mb-3", className)}>
      <div className="flex items-start gap-3 min-w-0">
        {icon && (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-brand-soft">
            {icon}
          </div>
        )}
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-[var(--color-text)] truncate">{title}</h3>
          {subtitle && (
            <p className="text-xs text-muted mt-0.5 truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
