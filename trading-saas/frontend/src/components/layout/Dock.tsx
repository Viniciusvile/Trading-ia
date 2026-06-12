"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/config/navigation";
import { cn } from "@/lib/cn";

/**
 * Dock flutuante estilo Fey: pílula central fixa no rodapé com TODAS as
 * rotas do app. Substitui a Sidebar e a MobileNav — mesma navegação,
 * apresentação nova. Tooltips nativos via title.
 */
export function Dock() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Navegação principal"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-1rem)]"
    >
      <div className="flex items-center gap-0.5 sm:gap-1 px-2 py-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/85 backdrop-blur-xl shadow-[var(--shadow-pop)] overflow-x-auto">
        {navItems.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              aria-label={item.label}
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-all duration-150",
                active
                  ? "bg-[var(--color-surface-3)] text-[var(--color-text)] scale-105"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
              )}
            >
              <Icon size={18} strokeWidth={active ? 2.4 : 2} />
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
