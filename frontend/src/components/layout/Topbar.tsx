"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { Moon, Sun, Search, Bell, ChevronDown, Check, LogOut, TrendingUp, CheckCheck, Inbox, AlertTriangle } from "lucide-react";
import { navItems } from "@/config/navigation";
import { Badge } from "@/components/ui";
import { fmtUSD } from "@/lib/format";
import { api, type SystemNotification } from "@/lib/api";
import { useBalance, useDashboardSummary, useSystemStatus, useMarketRegime } from "@/lib/hooks";
import { BalanceChartModal, AnimatedNumber } from "@/components/fx";
import { toast } from "sonner";

export function Topbar() {
  const pathname = usePathname();
  const current = [...navItems]
    .sort((a, b) => b.href.length - a.href.length)
    .find((i) =>
      i.href === "/" ? pathname === "/" : pathname.startsWith(i.href),
    );

  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [firstName, setFirstName] = useState<string>("");
  const [avatar, setAvatar] = useState<string>("");

  useEffect(() => {
    async function loadUserProfile() {
      try {
        const res = await api.me();
        if (res.success && res.user) {
          localStorage.setItem("user", JSON.stringify(res.user));
          if (res.user.name) {
            setFirstName(String(res.user.name).split(" ")[0]);
          } else if (res.user.email) {
            setFirstName(res.user.email.split("@")[0]);
          }
          if (res.user.picture) {
            setAvatar(res.user.picture);
          }
        }
      } catch (e) {
        try {
          const u = JSON.parse(localStorage.getItem("user") || "null");
          if (u?.name) setFirstName(String(u.name).split(" ")[0]);
          else if (u?.email) setFirstName(u.email.split("@")[0]);
          if (u?.picture) setAvatar(u.picture);
        } catch {}
      }
    }
    loadUserProfile();
  }, []);
  // Regime macro BTC 4H — cache 15 min, igual ao detector dos bots
  const { data: regimeData } = useMarketRegime("BTCUSDT");
  const btcRegime = regimeData?.regimes?.BTCUSDT;

  // Status do sistema (worker / beat / redis) — poll 60s
  const { data: sysStatus } = useSystemStatus();
  const systemDegraded =
    sysStatus &&
    (sysStatus.worker === "down" || sysStatus.beat === "down" || sysStatus.redis === "down");

  // Saldo e PnL via SWR — mesmo cache do Dashboard (uma requisição só p/ os dois)
  const { data: balRes, isLoading: balLoading } = useBalance();
  const { data: summaryRes } = useDashboardSummary();
  const balance = {
    spot: balRes?.success ? balRes.spot ?? 0 : 0,
    futures: balRes?.success ? balRes.futures ?? 0 : 0,
  };
  const pnl24h = summaryRes?.success ? summaryRes.pnlToday ?? 0 : 0;
  const loading = balLoading && !balRes;

  // Multi-account states
  const [accounts, setAccounts] = useState<{ id: string; name: string; isActive: boolean; isTestnet: boolean }[]>([]);
  const [activeAccount, setActiveAccount] = useState<{ id: string; name: string; isTestnet: boolean } | null>(null);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isChartOpen, setIsChartOpen] = useState(false);

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


  // Notifications states
  const [notifications, setNotifications] = useState<SystemNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const seenNotificationIds = useRef<Set<string>>(new Set());

  async function handleMarkAllAsRead() {
    try {
      const res = await api.notificationsRead();
      if (res.success) {
        setNotifications(prev => prev.map(n => ({ ...n, isRead: true })));
        setUnreadCount(0);
      }
    } catch (e) {
      console.error("Erro ao marcar todas como lidas:", e);
    }
  }

  async function handleMarkAsRead(id: string) {
    try {
      const res = await api.notificationsRead([id]);
      if (res.success) {
        setNotifications(prev =>
          prev.map(n => n.id === id ? { ...n, isRead: true } : n)
        );
        setUnreadCount(prev => Math.max(0, prev - 1));
      }
    } catch (e) {
      console.error("Erro ao marcar notificação como lida:", e);
    }
  }

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
    async function fetchData() {
      try {
        const notifRes = await api.notifications(20);
        if (active && notifRes && notifRes.success) {
          const isFirstLoad = seenNotificationIds.current.size === 0;
          if (isFirstLoad) {
            notifRes.notifications.forEach(n => seenNotificationIds.current.add(n.id));
          } else {
            notifRes.notifications.forEach(n => {
              if (!seenNotificationIds.current.has(n.id)) {
                seenNotificationIds.current.add(n.id);
                // Exibe o popup toast
                const isSuccess = n.type === 'success';
                const isError = n.type === 'error';
                const toastFn = isSuccess ? toast.success : isError ? toast.error : toast;
                toastFn(n.title, {
                  description: n.message,
                  duration: 6000,
                });
              }
            });
          }
          setNotifications(notifRes.notifications);
          setUnreadCount(notifRes.notifications.filter(n => !n.isRead).length);
        }
      } catch (e) {
        console.error("Erro ao carregar dados do topbar:", e);
      }
    }

    fetchData();
    const timer = setInterval(fetchData, 15000);
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

  const totalBalance = balance.spot + balance.futures;
  const prevBalance = totalBalance - pnl24h;
  const pnlPercent = prevBalance > 0 ? (pnl24h / prevBalance) * 100 : 0;
  const isProfit = pnl24h >= 0;
  const tone = isProfit ? "up" : "down";
  const formattedPercent = `${isProfit ? "+" : ""}${pnlPercent.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;

  return (
    <header className="sticky top-0 z-20 bg-[var(--color-bg)]/70 backdrop-blur-xl">
      {systemDegraded && (
        <div className="bg-down-500/10 border-b border-down-500/20 px-4 py-1.5 flex items-center justify-center gap-2">
          <AlertTriangle size={13} className="text-down-300 shrink-0" />
          <span className="text-xs text-down-300 font-medium">
            Sistema degradado —{" "}
            {sysStatus?.worker === "down" && "worker offline · "}
            {sysStatus?.beat === "down" && "agendador offline · "}
            {sysStatus?.redis === "down" && "redis offline · "}
            bots podem não estar operando
          </span>
        </div>
      )}
      <div className="max-w-6xl mx-auto h-16 flex items-center gap-3 px-4 sm:px-6">
        <div className="min-w-0 flex-1 flex items-center gap-4">
          {/* Vexa Cripto Brand Logo */}
          <Link href="/" className="flex items-center gap-2 shrink-0 mr-1 hover:opacity-85 transition-opacity">
            <svg className="h-8 w-8 shrink-0" viewBox="0 0 48 48" fill="none" aria-label="Vexa Cripto">
              <rect x="1" y="1" width="46" height="46" rx="13" fill="#0d0f14" stroke="#1f232c"/>
              <defs>
                <linearGradient id="g-topbar" x1="14" y1="34" x2="34" y2="12" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#0fae7e"/><stop offset="1" stopColor="#2ee6a6"/>
                </linearGradient>
              </defs>
              <path d="M13 14 L23 32 L31 18 L40 8" stroke="url(#g-topbar)" strokeWidth="3.4"
                    strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M34 8 L40 8 L40 14" stroke="#2ee6a6" stroke-width="3.4"
                    stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span className="hidden sm:inline font-bold tracking-wider text-sm text-[var(--color-text)]">VEXA</span>
            <div className="h-4 w-px bg-[var(--color-border)] hidden sm:block mx-1" />
          </Link>

          {/* Logo + saudação (estilo "Hello, Sam" do Fey) */}
          <div className="flex items-center gap-3 min-w-0">
            {avatar ? (
              <img
                src={avatar}
                alt={firstName || "Perfil"}
                referrerPolicy="no-referrer"
                className="h-8 w-8 shrink-0 rounded-full object-cover border border-[var(--color-border)]"
              />
            ) : (
              <div 
                style={{ backgroundColor: "var(--color-text)", color: "var(--color-bg)" }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
              >
                <TrendingUp size={15} strokeWidth={2.5} />
              </div>
            )}
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[var(--color-text)] truncate">
                {firstName ? `Olá, ${firstName}` : current?.label ?? "Vexa Cripto"}
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

        <button
          type="button"
          onClick={() => setIsChartOpen(true)}
          className="hidden md:flex items-center gap-2 px-4 py-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-3)] text-xs text-muted min-w-[160px] text-left transition cursor-pointer"
          title={`Spot: ${fmtUSD(balance.spot)} | Futuros: ${fmtUSD(balance.futures)} · Clique para ver a evolução`}
        >
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider">Saldo</span>
            <span className="text-[var(--color-text)] font-semibold">
              {loading ? "Carregando..." : <AnimatedNumber value={balance.spot + balance.futures} format={fmtUSD} />}
            </span>
          </div>
          <Badge tone={tone} dot size="sm" className="ml-auto">
            {formattedPercent}
          </Badge>
        </button>

        {/* Regime macro BTC 4H */}
        {btcRegime && (
          <div
            title={`BTC 4H · EMA200: ${btcRegime.ema200?.toFixed(0) ?? "—"} · Inclinação EMA50: ${btcRegime.slope_pct?.toFixed(2) ?? "—"}%`}
            className={`hidden md:flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-semibold border select-none ${
              btcRegime.regime === "bull"
                ? "bg-up/10 border-up/20 text-up"
                : btcRegime.regime === "bear"
                ? "bg-down/10 border-down/20 text-down"
                : "bg-[var(--color-surface-3)] border-[var(--color-border)] text-muted"
            }`}
          >
            {btcRegime.regime === "bull" ? "🐂" : btcRegime.regime === "bear" ? "🐻" : "↔"}
            <span className="hidden lg:inline">
              {btcRegime.regime === "bull" ? "Alta" : btcRegime.regime === "bear" ? "Baixa" : "Neutro"}
            </span>
          </div>
        )}

        <button
          type="button"
          aria-label="Buscar (Ctrl+K)"
          title="Buscar (Ctrl+K)"
          onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
          className="hidden sm:flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition"
        >
          <Search size={18} />
        </button>
      <div className="relative">
        <button
          type="button"
          aria-label="Notificações"
          onClick={() => setIsNotificationsOpen(!isNotificationsOpen)}
          className="relative h-9 w-9 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)] transition cursor-pointer"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span
              className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-[var(--color-down-500)] animate-pulse"
            />
          )}
        </button>

        {isNotificationsOpen && (
          <>
            <div 
              className="fixed inset-0 z-30" 
              onClick={() => setIsNotificationsOpen(false)}
            />
            <div className="absolute right-0 mt-2 w-80 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-2)]/90 backdrop-blur-xl shadow-2xl p-4 space-y-3 z-40 animate-in fade-in slide-in-from-top-2 duration-200">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-sm text-[var(--color-text)]">Notificações</span>
                {unreadCount > 0 && (
                  <button
                    type="button"
                    onClick={handleMarkAllAsRead}
                    className="text-[10px] font-medium text-[var(--color-brand-500)] hover:underline flex items-center gap-1 cursor-pointer"
                  >
                    <CheckCheck size={12} />
                    Marcar todas como lidas
                  </button>
                )}
              </div>

              <div className="max-h-72 overflow-y-auto space-y-2 pr-1 custom-scrollbar">
                {notifications.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted flex flex-col items-center justify-center gap-2">
                    <Inbox size={20} className="text-muted/50" />
                    <span>Nenhuma notificação por enquanto</span>
                  </div>
                ) : (
                  notifications.map((n) => {
                    const isSuccess = n.type === 'success';
                    const isError = n.type === 'error';
                    const toneColor = isSuccess 
                      ? "text-[var(--color-text-up)]" 
                      : isError 
                        ? "text-[var(--color-text-down)]" 
                        : "text-[var(--color-brand-500)]";
                    
                    return (
                      <div 
                        key={n.id} 
                        onClick={() => handleMarkAsRead(n.id)}
                        className={`p-2.5 rounded-lg border border-transparent transition text-left cursor-pointer ${
                          n.isRead 
                            ? "bg-[var(--color-surface-1)]/40 hover:bg-[var(--color-surface-1)]/60" 
                            : "bg-[var(--color-surface-3)] border-[var(--color-border)] hover:bg-[var(--color-surface-3)]/80"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="font-semibold text-[11px] flex items-center gap-1.5 truncate">
                            {!n.isRead && (
                              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-down-500)] shrink-0" />
                            )}
                            <span className={toneColor}>{n.title}</span>
                          </div>
                          <span className="text-[9px] text-muted shrink-0">
                            {new Date(n.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <p className="text-[10px] text-[var(--color-text-2)] mt-1 leading-relaxed">
                          {n.message}
                        </p>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </>
        )}
      </div>
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

      <BalanceChartModal open={isChartOpen} onClose={() => setIsChartOpen(false)} />
    </header>
  );
}
