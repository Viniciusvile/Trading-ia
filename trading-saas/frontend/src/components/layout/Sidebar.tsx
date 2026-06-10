"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TrendingUp } from "lucide-react";
import { navItems } from "@/config/navigation";
import { cn } from "@/lib/cn";

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex flex-col w-[240px] shrink-0 h-screen sticky top-0 border-r border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="h-16 flex items-center gap-3 px-5 border-b border-[var(--color-border)]">
        <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-brand-500)] text-white shadow-[var(--shadow-brand)]">
          <TrendingUp size={18} strokeWidth={2.5} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold text-[var(--color-text)] truncate">
            Trading SaaS
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted">
            painel de operações
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-3 px-2.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-muted px-2.5 py-2">
          Menu
        </div>
        <ul className="flex flex-col gap-0.5">
          {navItems.map((item) => {
            const active =
              item.href === "/"
                ? pathname === "/"
                : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "group flex items-center gap-3 px-2.5 py-2 rounded-[var(--radius-sm)] text-sm",
                    "transition-colors duration-150",
                    active
                      ? "bg-brand-soft text-[var(--color-brand-600)] font-semibold"
                      : "text-[var(--color-text-2)] hover:bg-[var(--color-surface-3)]",
                  )}
                >
                  <Icon
                    size={18}
                    strokeWidth={active ? 2.4 : 2}
                    className="shrink-0"
                  />
                  <span className="truncate">{item.label}</span>
                  {active && (
                    <span
                      aria-hidden
                      className="ml-auto h-1.5 w-1.5 rounded-full bg-[var(--color-brand-500)]"
                    />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="p-4 border-t border-[var(--color-border)] text-[10px] text-muted">
        v1.0.0 — feito para você operar com clareza
      </div>
    </aside>
  );
}
