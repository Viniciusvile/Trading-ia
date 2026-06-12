"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Moon, Sun, Search, Bell, ChevronDown, Check, LogOut, TrendingUp } from "lucide-react";
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

  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [firstName, setFirstName] = useState<string>("");

  useEffect(() => {
    try {
      const u = JSON.parse(localStorage.getItem("user") || "null");
      if (u?.name) setFirstName(String(u.name).split(" ")[0]);
    } catch {}
  }, []);
  const [balance, setBalance] = useState<{ spot: number; futures: number }>({ spot: 0, futures: 0 });
  const [loading, setLoading] = useState(true);

  // Multi-account states
  const [accounts, setAccounts] = useState<{ id: string; name: string; isActive: boolean; isTestnet: boolean }[]>([]);
  const [activeAccount, setActiveAccount] = useState<{ id: string; name: string; isTestnet: boolean } | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  useEffect(() => {
    const saved = (localStorage.getItem("theme") as "light" | "dark" | null) ?? "dark";
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);

  useEffect(() => {
    async function loadAccounts() {
      try {
        const res = await api.accountsList();
        if (res.success && res.accounts) {
          setAccounts(res.accounts);
          const active = res.accounts.find(a => a.isActive);
          if (active) {
            setActiveAccount({ id: active.id, name: active.name, isTestnet: active.isTestnet });
          } else if (res.accounts.length > 0) {
            setActiveAccount({ id: res.accounts[0].id, name: res.accounts[0].name, isTestnet: res.accounts[0].isTestnet });
          }
        }
      } catch (e) {
        console.error("Erro ao carregar contas:", e);
      }
    }
    loadAccounts();
    window.addEventListener("accounts-updated", loadAccounts);
    return () => {
      window.removeEventListener("accounts-updated", loadAccounts);
    };
  }, []);

  async function handleSwitchAccount(id: string) {
    try {
      const res = await api.accountActivate(id);
      if (res.success) {
        setIsDropdownOpen(false);
        window.location.reload();
      }
    } catch (e) {
      console.error("Erro ao alternar conta:", e);
    }
  }

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
    <header className="sticky top-0 z-20 bg-[var(--color-bg)]/70 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto h-16 flex items-center gap-3 px-4 sm:px-6">
        <div className="min-w-0 flex-1 flex items-center gap-4">
          {/* Logo + saudação (estilo "Hello, Sam" do Fey) */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-text)] text-[var(--color-bg)]">
              <TrendingUp size={15} strokeWidth={2.5} />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--color-text)] truncate">
                {firstName ? `Olá, ${firstName}` : current?.label ?? "Trading SaaS"}
              </div>
              <div className="text-[10px] text-muted truncate capitalize">
                {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}
              </div>
            </div>
          </div>

          {/* Account Switcher */}
          {activeAccount && (
            <div className="relative ml-2">
              <button
                type="button"
                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                className="flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] text-xs text-[var(--color-text)] font-medium transition cursor-pointer"
              >
                <span className="max-w-[100px] sm:max-w-[150px] truncate">{activeAccount.name}</span>
                {activeAccount.isTestnet && (
                  <span className="px-1 py-0.5 text-[8px] font-bold uppercase rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">
                    Testnet
                  </span>
                )}
                <ChevronDown size={14} className="opacity-60" />
              </button>

              {isDropdownOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-30" 
                    onClick={() => setIsDropdownOpen(false)}
                  />
                  <div className="absolute left-0 mt-1.5 w-56 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg py-1 z-40 max-h-60 overflow-y-auto">
                    <div className="px-3 py-1.5 text-[10px] uppercase font-bold tracking-wider text-muted border-b border-[var(--color-border)]">
                      Alternar Conta
                    </div>
                    {accounts.map((acc) => (
                      <button
                        key={acc.id}
                        type="button"
                        onClick={() => handleSwitchAccount(acc.id)}
                        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-2)] transition cursor-pointer"
                      >
                        <span className="flex-1 truncate font-medium">{acc.name}</span>
                        {acc.isTestnet && (
                          <span className="px-1 py-0.5 text-[8px] font-bold uppercase rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">
                            Testnet
                          </span>
                        )}
                        {acc.id === activeAccount.id && (
                          <Check size={14} className="text-emerald-500 ml-auto" />
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div
          className="hidden md:flex items-center gap-2 px-4 py-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] text-xs text-muted min-w-[160px]"
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
          aria-label="Buscar (Ctrl+K)"
          title="Buscar (Ctrl+K)"
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          className="hidden sm:flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition"
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
        <button
          type="button"
          onClick={() => {
            localStorage.removeItem("token");
            localStorage.removeItem("user");
            window.location.href = "/login";
          }}
          aria-label="Sair"
          title="Sair"
          className="h-9 w-9 flex items-center justify-center rounded-full text-[var(--color-muted)] hover:text-[var(--color-down-300)] hover:bg-[var(--color-down-50)] transition"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
