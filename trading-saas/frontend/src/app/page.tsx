"use client";

import { useEffect, useState, Suspense } from "react";
import Link from "next/link";
import {
  TrendingUp,
  ShoppingCart,
  HandCoins,
  ScanLine,
  Pause,
  Bot,
  ArrowRight,
  CircleHelp,
  Activity,
  Sparkles,
} from "lucide-react";
import { Card, CardHeader, Stat, Badge, Button, Tooltip, Skeleton } from "@/components/ui";
import { fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";

const QUICK_ACTIONS = [
  { icon: ShoppingCart, label: "Comprar", color: "var(--color-up-500)", href: "/mercado" },
  { icon: HandCoins, label: "Vender", color: "var(--color-down-500)", href: "/posicoes" },
  { icon: ScanLine, label: "Analisar", color: "var(--color-brand-500)", href: "/mercado" },
  { icon: Pause, label: "Pausar bot", color: "var(--color-warn-500)", href: "/bots" },
];

// Tempo relativo em PT-BR para a lista de atividade (ex: "há 5 min")
function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "";
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "agora mesmo";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const d = Math.floor(h / 24);
  return `há ${d} d`;
}

interface ActivityItem {
  time: string;
  kind: "open" | "win" | "loss";
  symbol: string;
  title: string;
}

export default function InicioPage() {
  const [balance, setBalance] = useState<{ spot: number; futures: number }>({ spot: 0, futures: 0 });
  const [loading, setLoading] = useState(true);
  const [activeBotsCount, setActiveBotsCount] = useState(0);
  const [pnl24h, setPnl24h] = useState(0);
  const [opsToday, setOpsToday] = useState(0);
  const [winRate30d, setWinRate30d] = useState<number | null>(null);
  const [trades30d, setTrades30d] = useState(0);
  const [openPositions, setOpenPositions] = useState(0);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  useEffect(() => {
    let active = true;

    async function loadData() {
      try {
        const balRes = await api.botBalance();
        if (active && balRes && balRes.success) {
          setBalance({
            spot: balRes.spot ?? 0,
            futures: balRes.futures ?? 0,
          });
        }

        // Fetch bot statuses to count active bots
        let activeCount = 0;
        const [master, scalper, futures] = await Promise.all([
          api.botMasterStatus(),
          api.microScalperStatus(),
          api.botFuturesStatus(),
        ]);
        if (master?.isAlive) activeCount++;
        if (scalper?.running) activeCount++;
        if (futures?.isAlive) activeCount++;

        if (active) {
          setActiveBotsCount(activeCount);
        }

        // Métricas reais agregadas das posições (P&L do dia, operações,
        // taxa de acerto 30d e atividade recente) — fim dos números mockados
        const summary = await api.dashboardSummary();
        if (active && summary.success) {
          setPnl24h(summary.pnlToday || 0);
          setOpsToday(summary.operationsToday || 0);
          setWinRate30d(summary.winRate30d);
          setTrades30d(summary.totalTrades30d || 0);
          setOpenPositions(summary.openPositions || 0);
          setActivity(summary.recentActivity || []);
        }
      } catch (e) {
        console.error("Erro ao carregar dados do inicio:", e);
      } finally {
        if (active) setLoading(false);
      }
    }

    loadData();
    const timer = setInterval(loadData, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const totalBalance = balance.spot + balance.futures;

  return (
    <div className="space-y-5">
      {/* Card de saldo destacado (estilo Nubank "seu saldo") */}
      <Card padding="lg" className="relative overflow-hidden">
        <div
          aria-hidden
          className="absolute -top-16 -right-16 h-56 w-56 rounded-full bg-[var(--color-brand-500)]/8 blur-2xl"
        />
        <div className="relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>Saldo total da conta</span>
              <Tooltip content="Soma do que você tem disponível + posições abertas na corretora">
                <CircleHelp size={13} className="text-[var(--color-muted)]" />
              </Tooltip>
            </div>
            <div className="text-3xl sm:text-4xl font-bold tabular-nums text-[var(--color-text)] mt-1">
              {loading ? (
                <div className="h-10 w-48 bg-[var(--color-surface-3)] animate-pulse rounded" />
              ) : (
                fmtUSD(totalBalance)
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={pnl24h >= 0 ? "up" : "down"} dot>
                {pnl24h >= 0 ? "+" : ""}{fmtUSD(pnl24h)} hoje
              </Badge>
              <span className="text-muted">atualizado há instantes</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              href="/status"
              className="inline-flex items-center gap-2 h-10 px-4 rounded-[var(--radius-sm)] text-sm font-medium border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition"
            >
              <Activity size={16} /> Status
            </Link>
            <Link
              href="/mercado"
              className="inline-flex items-center gap-2 h-10 px-4 rounded-[var(--radius-sm)] text-sm font-medium bg-[var(--color-brand-500)] text-white hover:bg-[var(--color-brand-600)] shadow-[var(--shadow-brand)] transition"
            >
              Operar <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </Card>

      {/* Atalhos circulares (estilo Nubank) */}
      <section>
        <h2 className="text-xs uppercase tracking-wider text-muted font-semibold mb-3 px-1">
          Atalhos
        </h2>
        <div className="grid grid-cols-4 gap-2 sm:gap-4">
          {QUICK_ACTIONS.map(({ icon: Icon, label, color, href }) => (
            <Link
              key={label}
              href={href}
              className="group flex flex-col items-center gap-2 p-2 sm:p-3 rounded-[var(--radius-md)] hover:bg-[var(--color-surface-3)] transition"
            >
              <span
                className="h-12 w-12 sm:h-14 sm:w-14 flex items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] group-hover:scale-105 transition-transform"
                style={{ color }}
              >
                <Icon size={22} strokeWidth={2.2} />
              </span>
              <span className="text-[11px] sm:text-xs font-medium text-[var(--color-text-2)] text-center">
                {label}
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* Cards de métricas resumidas */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <Card>
          <Stat label="P&L hoje" value={loading ? "..." : fmtUSD(pnl24h)} hint="realizado hoje (UTC)" size="sm" />
        </Card>
        <Card>
          <Stat label="Operações" value={loading ? "..." : String(opsToday)} hint="hoje" size="sm" />
        </Card>
        <Card>
          <Stat
            label="Taxa de acerto"
            value={loading ? "..." : winRate30d != null ? `${Math.round(winRate30d * 100)}%` : "—"}
            hint={winRate30d != null ? `${trades30d} trades em 30 dias` : "sem trades em 30 dias"}
            size="sm"
          />
        </Card>
        <Card>
          <Stat label="Bots ativos" value={`${activeBotsCount} / 3`} hint="rodando agora" size="sm" />
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Bot ativo agora */}
        <Card className="lg:col-span-2" padding="lg">
          <CardHeader
            icon={<Bot size={18} className="text-[var(--color-brand-500)]" />}
            title="Sincronização com Corretora"
            subtitle="Conexão API Binance via WebSockets ativa"
            action={
              <Badge tone="up" dot>
                Online
              </Badge>
            }
          />
          <Suspense fallback={<Skeleton height={140} className="rounded-[var(--radius-md)]" />}>
            <BotMiniChart />
          </Suspense>
          <div className="mt-4 grid grid-cols-3 gap-3 pt-4 border-t border-[var(--color-border)]">
            <Stat label="Spot USDT" value={fmtUSD(balance.spot)} size="sm" />
            <Stat label="Futuros USDT" value={fmtUSD(balance.futures)} size="sm" />
            <Stat label="Posições abertas" value={String(openPositions)} size="sm" />
          </div>
        </Card>

        {/* Atividade recente (eventos reais das posições) */}
        <Card padding="lg">
          <CardHeader title="Atividade recente" subtitle="Últimos eventos do sistema" />
          {activity.length === 0 ? (
            <p className="text-xs text-muted py-4">
              {loading ? "Carregando..." : "Nenhuma operação registrada ainda."}
            </p>
          ) : (
            <ul className="space-y-3">
              {activity.map((a) => {
                const Icon = a.kind === "open" ? TrendingUp : a.kind === "win" ? Sparkles : Activity;
                const toneClass = a.kind === "win" ? "bg-up" : a.kind === "loss" ? "bg-warn" : "bg-brand-soft";
                return (
                  <li key={`${a.kind}-${a.symbol}-${a.time}`} className="flex items-start gap-3">
                    <span
                      className={
                        "h-8 w-8 shrink-0 flex items-center justify-center rounded-full " + toneClass
                      }
                    >
                      <Icon size={14} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm text-[var(--color-text)] leading-snug">
                        {a.title}
                      </div>
                      <div className="text-[11px] text-muted mt-0.5">
                        {timeAgo(a.time)}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <Link
            href="/posicoes"
            className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand-500)] hover:underline"
          >
            Ver tudo <ArrowRight size={13} />
          </Link>
        </Card>
      </div>

      {/* Faixa "Como funciona" — onboarding */}
      <Card padding="lg" className="bg-brand-soft border-[var(--color-brand-500)]/30">
        <div className="flex items-start gap-4">
          <div className="hidden sm:flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-brand-500)] text-white">
            <Sparkles size={18} />
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-[var(--color-brand-600)]">
              Novo por aqui?
            </h3>
            <p className="text-xs text-[var(--color-text-2)] mt-1 max-w-xl">
              O Trading SaaS é o seu painel para acompanhar mercado, controlar
              robôs de operação e registrar tudo num diário. Comece pela aba{" "}
              <Link href="/mercado" className="font-semibold underline">
                Mercado
              </Link>{" "}
              ou veja seus{" "}
              <Link href="/bots" className="font-semibold underline">
                bots
              </Link>
              .
            </p>
          </div>
          <Button variant="primary" size="sm">
            Fazer tour
          </Button>
        </div>
      </Card>
    </div>
  );
}

function BotMiniChart() {
  return (
    <div className="relative h-32 w-full rounded-[var(--radius-md)] bg-gradient-to-br from-[var(--color-brand-500)]/10 to-transparent overflow-hidden border border-[var(--color-border)]">
      <svg
        viewBox="0 0 400 120"
        className="w-full h-full"
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.32" />
            <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d="M0,90 C40,80 80,40 120,55 C160,70 200,30 240,42 C280,54 320,20 360,28 L400,28 L400,120 L0,120 Z"
          fill="url(#grad)"
        />
        <path
          d="M0,90 C40,80 80,40 120,55 C160,70 200,30 240,42 C280,54 320,20 360,28 L400,28"
          fill="none"
          stroke="var(--color-brand-500)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="absolute top-2 right-3 text-[10px] text-muted uppercase tracking-wide">
        evolução 7d
      </div>
    </div>
  );
}
