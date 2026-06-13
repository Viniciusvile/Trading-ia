"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ArrowRight } from "lucide-react";
import { navItems } from "@/config/navigation";
import { SymbolIcon } from "@/components/fx";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "LTCUSDT", "AVAXUSDT"];

/** Paleta de comandos global: rotas + ativos. Abre com ⌘K/Ctrl+K (e via evento "open-command-palette"). */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQ("");
        setIdx(0);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const onOpen = () => { setOpen(true); setQ(""); setIdx(0); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  const items = useMemo(() => {
    const routes = navItems.map((n) => ({
      kind: "route" as const, key: n.href, label: n.label,
      hint: n.description ?? "", icon: n.icon, action: () => router.push(n.href),
    }));
    const symbols = SYMBOLS.map((s) => ({
      kind: "symbol" as const, key: s, label: s.replace("USDT", ""),
      hint: `Abrir ${s} no Mercado`, icon: null, action: () => router.push(`/mercado?symbol=${s}`),
    }));
    const all = [...routes, ...symbols];
    if (!q.trim()) return all;
    const t = q.toLowerCase();
    return all.filter((i) => i.label.toLowerCase().includes(t) || i.hint.toLowerCase().includes(t) || i.key.toLowerCase().includes(t));
  }, [q, router]);

  const run = useCallback((i: number) => {
    const item = items[i];
    if (!item) return;
    setOpen(false);
    item.action();
  }, [items]);

  useEffect(() => { setIdx(0); }, [q]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[18vh] p-4">
          <motion.div
            className="absolute inset-0 bg-black/70 backdrop-blur-md"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="relative w-full max-w-lg rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-2)]/95 backdrop-blur-xl shadow-[var(--shadow-pop)] overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 border-b border-[var(--color-border)] py-3.5">
              <Search size={16} className="text-muted shrink-0" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setIdx((v) => Math.min(v + 1, items.length - 1)); }
                  if (e.key === "ArrowUp") { e.preventDefault(); setIdx((v) => Math.max(v - 1, 0)); }
                  if (e.key === "Enter") run(idx);
                }}
                placeholder="Buscar páginas e ativos…"
                className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder-[var(--color-muted-2)] outline-none"
              />
              <kbd className="text-[10px] text-muted border border-[var(--color-border)] rounded px-1.5 py-0.5">esc</kbd>
            </div>
            <ul className="max-h-72 overflow-y-auto py-1.5">
              {items.length === 0 && (
                <li className="px-4 py-6 text-center text-xs text-muted">Nada encontrado.</li>
              )}
              {items.map((item, i) => {
                const Icon = item.icon;
                return (
                  <li key={`${item.kind}-${item.key}`}>
                    <button
                      type="button"
                      onMouseEnter={() => setIdx(i)}
                      onClick={() => run(i)}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                        i === idx ? "bg-[var(--color-surface-3)]" : ""
                      }`}
                    >
                      {item.kind === "symbol" ? (
                        <SymbolIcon symbol={item.key} size={22} />
                      ) : Icon ? (
                        <Icon size={16} className="text-muted shrink-0" />
                      ) : null}
                      <span className="text-sm text-[var(--color-text)] font-medium">{item.label}</span>
                      <span className="text-[11px] text-muted truncate flex-1">{item.hint}</span>
                      {i === idx && <ArrowRight size={13} className="text-muted shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
