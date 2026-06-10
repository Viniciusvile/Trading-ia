"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { mobileNavItems } from "@/config/navigation";
import { cn } from "@/lib/cn";

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      role="navigation"
      aria-label="Menu principal"
      className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-[var(--color-surface)] border-t border-[var(--color-border)] pb-[env(safe-area-inset-bottom)]"
    >
      <ul className="flex items-stretch justify-around">
        {mobileNavItems.map((item) => {
          const active =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 h-16 text-[10px] font-medium transition-colors",
                  active
                    ? "text-[var(--color-brand-500)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-text-2)]",
                )}
              >
                <Icon size={22} strokeWidth={active ? 2.4 : 2} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
