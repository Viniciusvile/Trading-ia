"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/cn";

interface PillTabsProps {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  size?: "sm" | "md";
  className?: string;
}

export function PillTabs({ options, value, onChange, size = "sm", className }: PillTabsProps) {
  // layoutId único por grupo para a "bolha" não migrar entre grupos distintos
  const groupId = `pill-${options.map((o) => o.value).join("-")}`;
  return (
    <div className={cn("inline-flex items-center gap-0.5 p-1 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)]", className)}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "relative rounded-full font-medium transition-colors",
              size === "sm" ? "px-3 py-1 text-[11px]" : "px-4 py-1.5 text-xs",
              active ? "text-[var(--color-text)]" : "text-[var(--color-muted)] hover:text-[var(--color-text-2)]",
            )}
          >
            {active && (
              <motion.span
                layoutId={groupId}
                className="absolute inset-0 rounded-full bg-[var(--color-surface-3)] border border-[var(--color-border-strong)]"
                transition={{ type: "spring", stiffness: 500, damping: 35 }}
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}
