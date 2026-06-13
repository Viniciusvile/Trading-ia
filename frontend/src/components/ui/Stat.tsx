import { type ReactNode } from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { cn } from "@/lib/cn";
import { fmtPct } from "@/lib/format";

interface StatProps {
  label: ReactNode;
  value: ReactNode;
  delta?: number;
  hint?: ReactNode;
  icon?: ReactNode;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizes = {
  sm: { value: "text-xl tracking-tight", label: "text-[10px]" },
  md: { value: "text-2xl tracking-tight", label: "text-[11px]" },
  lg: { value: "text-3xl sm:text-4xl tracking-tight", label: "text-xs" },
};

export function Stat({ label, value, delta, hint, icon, size = "md", className }: StatProps) {
  const s = sizes[size];
  const dir = delta == null ? "flat" : delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-2">
        {icon && <span className="text-[var(--color-muted)]">{icon}</span>}
        <span className={cn("uppercase tracking-[0.08em] font-semibold text-muted", s.label)}>
          {label}
        </span>
      </div>
      <div className={cn("font-bold tabular-nums leading-tight text-[var(--color-text)]", s.value)}>
        {value}
      </div>
      {delta != null && (
        <div
          className={cn(
            "inline-flex items-center gap-1 text-xs font-semibold",
            dir === "up" && "text-up",
            dir === "down" && "text-down",
            dir === "flat" && "text-muted",
          )}
        >
          {dir === "up" && <TrendingUp size={12} />}
          {dir === "down" && <TrendingDown size={12} />}
          {dir === "flat" && <Minus size={12} />}
          <span>{fmtPct(delta)}</span>
          {hint && <span className="text-muted font-normal ml-1">{hint}</span>}
        </div>
      )}
      {delta == null && hint && (
        <div className="text-xs text-muted">{hint}</div>
      )}
    </div>
  );
}
