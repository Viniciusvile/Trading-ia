"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Moon, Sun, Search, Bell } from "lucide-react";
import { navItems } from "@/config/navigation";
import { Badge } from "@/components/ui";
import { fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";

export function Topbar() {
  const pathname = usePathname();
  const current = [...navItems]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) =>
      i.href === "/" ? pathname === "/" : pathname.startsWith(i.href),
    );

  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [balance, setBalance] = useState<{ spot: number; futures: number }>({ spot: 0, futures: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const saved = (localStorage.getItem("theme") as "light" | "dark" | null) ?? "light";
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);

  useEffect(() => {
    let active = true;
    async function fetchBalance() {
      try {
        const res = await api.botBalance();
        if (active && res && res.success) {
          setBalance({
            spot: res.spot ?? 0,
            futures: res.futures ?? 0,
          });
        }
      } catch (e) {
        console.error("Erro ao carregar saldo:", e);
      } finally {
        if (active) setLoading(false);
      }
    }

    fetchBalance();
    const timer = setInterval(fetchBalance, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  function toggleTheme() {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  }

  return (
    <header className="sticky top-0 z-20 bg-[var(--color-surface)]/85 backdrop-blur border-b border-[var(--color-border)]">
      <div className="h-16 flex items-center gap-3 px-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wider text-muted">
            {current?.description ?? "Painel de operações"}
          </div>
          <div className="text-base font-semibold text-[var(--color-text)] truncate">
            {current?.label ?? "Dashboard"}
          </div>
        </div>

        <div
          className="hidden md:flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] text-xs text-muted min-w-[160px]"
          title={`Spot: ${fmtUSD(balance.spot)} | Futuros: ${fmtUSD(balance.futures)}`}
        >
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider">Saldo</span>
            <span className="text-[var(--color-text)] font-semibold">
              {loading ? "Carregando..." : fmtUSD(balance.spot + balance.futures)}
            </span>
          </div>
          <Badge tone="up" dot size="sm" className="ml-auto">
            +0,00%
          </Badge>
        </div>

        <button
          type="button"
          aria-label="Buscar"
          className="hidden sm:flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition"
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          aria-label="Notificações"
          className="relative h-9 w-9 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition"
        >
          <Bell size={18} />
          <span
            aria-hidden
            className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-[var(--color-down-500)]"
          />
        </button>
        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Alternar tema"
          className="h-9 w-9 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition"
        >
          {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
        </button>
      </div>
    </header>
  );
}
