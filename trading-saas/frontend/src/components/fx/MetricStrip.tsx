"use client";

import { cn } from "@/lib/cn";

interface MetricStripProps {
  items: { label: string; value: string; tone?: "up" | "down" | "neutral" }[];
  className?: string;
}

export function MetricStrip({ items, className }: MetricStripProps) {
  return (
    <div className={cn(
      "flex items-stretch overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)]/60 divide-x divide-[var(--color-border)]",
      className,
    )}>
      {items.map((m) => (
        <div key={m.label} className="flex-1 min-w-[110px] px-4 py-3 text-center">
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted font-semibold whitespace-nowrap">{m.label}</div>
          <div className={cn(
            "text-sm font-bold tabular-nums mt-1 whitespace-nowrap",
            m.tone === "up" && "text-up", m.tone === "down" && "text-down",
            (!m.tone || m.tone === "neutral") && "text-[var(--color-text)]",
          )}>
            {m.value}
          </div>
        </div>
      ))}
    </div>
  );
}
