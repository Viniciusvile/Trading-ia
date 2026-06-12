"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { navItems } from "@/config/navigation";
import { cn } from "@/lib/cn";

/**
 * Dock flutuante estilo Fey v2: pílula central com magnificação no hover,
 * indicador de rota ativa e botão de busca destacado (abre o Command Palette).
 */
export function Dock() {
  const pathname = usePathname();

  return (
    <nav aria-label="Navegação principal" className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-1rem)]">
      <motion.div
        initial={{ y: 24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 320, damping: 28, delay: 0.1 }}
        className="flex items-center gap-0.5 sm:gap-1 px-2 py-2 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/85 backdrop-blur-xl shadow-[var(--shadow-pop)] overflow-x-auto"
      >
        {navItems.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <motion.div
              key={item.href}
              whileHover={{ scale: 1.18, y: -3 }}
              whileTap={{ scale: 0.95 }}
              transition={{ type: "spring", stiffness: 500, damping: 22 }}
            >
              <Link
                href={item.href}
                title={item.label}
                aria-label={item.label}
                className={cn(
                  "relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors duration-150",
                  active
                    ? "bg-[var(--color-surface-3)] text-[var(--color-text)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
                )}
              >
                <Icon size={18} strokeWidth={active ? 2.4 : 2} />
                {active && (
                  <motion.span
                    layoutId="dock-active-dot"
                    aria-hidden
                    className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-[var(--color-text)]"
                  />
                )}
              </Link>
            </motion.div>
          );
        })}

        {/* Busca — separada, como no Fey */}
        <div aria-hidden className="h-6 w-px bg-[var(--color-border)] mx-1 shrink-0" />
        <motion.button
          type="button"
          aria-label="Buscar (Ctrl+K)"
          title="Buscar (Ctrl+K)"
          whileHover={{ scale: 1.18, y: -3 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: "spring", stiffness: 500, damping: 22 }}
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)]"
        >
          <Search size={17} />
        </motion.button>
      </motion.div>
    </nav>
  );
}
