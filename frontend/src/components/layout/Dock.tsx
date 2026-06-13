"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Search } from "lucide-react";
import { navItems } from "@/config/navigation";
import { cn } from "@/lib/cn";

/**
 * Dock flutuante estilo Fey v2: pílula central ampliada com magnificação no hover,
 * indicador de rota ativa e botão de busca destacado (abre o Command Palette).
 */
export function Dock() {
  const pathname = usePathname();

  // Variantes para animação fluida e sem latência na interação de hover
  const dockVariants = {
    hidden: { y: 32, opacity: 0, scale: 0.98 },
    visible: {
      y: 0,
      opacity: 1,
      scale: 1,
      transition: { type: "spring", stiffness: 320, damping: 28, delay: 0.1 }
    },
    hover: {
      scale: 1.05,
      y: -5,
      boxShadow: "0 24px 48px rgba(0, 0, 0, 0.7), 0 0 20px rgba(110, 123, 242, 0.15)",
      borderColor: "var(--color-border-strong)",
      transition: { type: "spring", stiffness: 400, damping: 22 }
    }
  };

  return (
    <nav 
      aria-label="Navegação principal" 
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 max-w-[calc(100vw-1rem)]"
    >
      <motion.div
        variants={dockVariants}
        initial="hidden"
        animate="visible"
        whileHover="hover"
        className="flex items-center gap-1.5 sm:gap-2 px-3.5 py-2.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]/85 backdrop-blur-xl shadow-[var(--shadow-pop)] max-md:overflow-x-auto md:overflow-visible transition-colors duration-300"
      >
        {navItems.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <motion.div
              key={item.href}
              whileHover={{ scale: 1.15, y: -4 }}
              whileTap={{ scale: 0.94 }}
              transition={{ type: "spring", stiffness: 450, damping: 20 }}
            >
              <Link
                href={item.href}
                title={item.label}
                aria-label={item.label}
                className={cn(
                  "relative flex h-12 w-12 shrink-0 items-center justify-center rounded-full transition-colors duration-200",
                  active
                    ? "bg-[var(--color-surface-3)] text-[var(--color-text)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-2)]",
                )}
              >
                <Icon size={21} strokeWidth={active ? 2.4 : 2} />
                {active && (
                  <motion.span
                    layoutId="dock-active-dot"
                    aria-hidden
                    className="absolute bottom-1.5 h-1.5 w-1.5 rounded-full bg-[var(--color-text)]"
                  />
                )}
              </Link>
            </motion.div>
          );
        })}

        {/* Busca — separada, como no Fey */}
        <div aria-hidden className="h-8 w-px bg-[var(--color-border)] mx-1.5 shrink-0" />
        
        <motion.button
          type="button"
          aria-label="Buscar (Ctrl+K)"
          title="Buscar (Ctrl+K)"
          whileHover={{ scale: 1.15, y: -4 }}
          whileTap={{ scale: 0.94 }}
          transition={{ type: "spring", stiffness: 450, damping: 20 }}
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition-colors duration-200"
        >
          <Search size={20} />
        </motion.button>
      </motion.div>
    </nav>
  );
}
