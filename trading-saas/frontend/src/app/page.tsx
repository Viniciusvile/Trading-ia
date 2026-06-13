"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CircleHelp,
  Activity,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, Stat, Badge, Button, Tooltip, Modal } from "@/components/ui";
import { Sparkline, AnimatedNumber, PillTabs, SymbolIcon, BalanceChartModal } from "@/components/fx";
import { fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";
import type { SummaryTrade } from "@/lib/api";

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
  const [isChartOpen, setIsChartOpen] = useState(false);
  const [activeBotsCount, setActiveBotsCount] = useState(0);
  const [pnl24h, setPnl24h] = useState(0);
  const [opsToday, setOpsToday] = useState(0);
  const [winRate30d, setWinRate30d] = useState<number | null>(null);
  const [trades30d, setTrades30d] = useState(0);
  const [openPositions, setOpenPositions] = useState(0);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [todayTrades, setTodayTrades] = useState<SummaryTrade[]>([]);
  const [todayOpened, setTodayOpened] = useState<SummaryTrade[]>([]);
  const [stats30d, setStats30d] = useState<{
    wins: number;
    losses: number;
    totalPnl: number;
    bestPnl: number;
    worstPnl: number;
    avgDurationMin?: number;
    timeoutCount?: number;
    tpCount?: number;
    slCount?: number;
    totalClosed?: number;
  } | null>(null);
  const [metricModal, setMetricModal] = useState<"pnl" | "ops" | "winrate" | null>(null);
  const router = useRouter();

  // Gráfico real do mercado (klines públicos da Binance, 7 dias em 1h)
  const [chartSymbol, setChartSymbol] = useState("BTCUSDT");
  const [chartData, setChartData] = useState<number[]>([]);
  const [chartChangePct, setChartChangePct] = useState(0);

  useEffect(() => {
    let chartActive = true;
    (async () => {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${chartSymbol}&interval=1h&limit=168`);
        const rows = await res.json();
        if (!chartActive || !Array.isArray(rows) || rows.length === 0) return;
        const closes = rows.map((r: (string | number)[]) => parseFloat(String(r[4])));
        setChartData(closes);
        setChartChangePct(((closes[closes.length - 1] - closes[0]) / closes[0]) * 100);
      } catch {}
    })();
    return () => { chartActive = false; };
  }, [chartSymbol]);

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
          setTodayTrades(summary.todayTrades || []);
          setTodayOpened(summary.todayOpened || []);
          setStats30d(summary.stats30d || null);
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
      {/* Hero de saldo (estilo "Hello, the markets are..." do Fey) */}
      <Card padding="lg" className="relative overflow-hidden">
        <div
          aria-hidden
          className="absolute -top-24 left-1/2 -translate-x-1/2 h-64 w-[480px] rounded-full bg-[var(--color-brand-500)]/10 blur-3xl"
        />
        <div className="relative flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <div className="text-[11px] text-muted capitalize">
              {new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" })}
            </div>
            <div className="text-sm text-[var(--color-text-2)] mt-1 flex items-center gap-2">
              <span>
                Os mercados estão{" "}
                <span className={pnl24h > 0 ? "text-up font-semibold" : pnl24h < 0 ? "text-down font-semibold" : "text-[var(--color-text)] font-semibold"}>
                  {pnl24h > 0 ? "a seu favor" : pnl24h < 0 ? "contra você hoje" : "neutros"}
                </span>
              </span>
              <Tooltip content="Saldo total = disponível + posições abertas na corretora">
                <CircleHelp size={13} className="text-[var(--color-muted)]" />
              </Tooltip>
            </div>
            <button
              type="button"
              onClick={() => setIsChartOpen(true)}
              className="block text-4xl sm:text-5xl font-bold tabular-nums tracking-tight text-[var(--color-text)] mt-3 hover:opacity-80 transition cursor-pointer text-left focus:outline-none"
              title="Clique para ver o gráfico de evolução"
            >
              {loading ? (
                <div className="h-12 w-56 bg-[var(--color-surface-3)] animate-pulse rounded" />
              ) : (
                <AnimatedNumber value={totalBalance} format={fmtUSD} />
              )}
            </button>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={pnl24h >= 0 ? "up" : "down"} dot>
                {pnl24h >= 0 ? "+" : ""}{fmtUSD(pnl24h)} hoje
              </Badge>
              <span className="text-muted">atualizado há instantes</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Link
              href="/status"
              className="inline-flex items-center gap-2 h-10 px-4 rounded-full text-sm font-medium border border-[var(--color-border-strong)] text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition"
            >
              <Activity size={16} /> Status
            </Link>
            <Link
              href="/mercado"
              style={{ backgroundColor: "var(--color-text)", color: "var(--color-bg)" }}
              className="inline-flex items-center gap-2 h-10 px-5 rounded-full text-sm font-semibold hover:opacity-90 transition"
            >
              Operar <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </Card>

      {/* Cards de métricas resumidas — clicáveis: abrem o detalhamento */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <button type="button" onClick={() => setMetricModal("pnl")} className="text-left cursor-pointer">
          <Card className="h-full transition-colors hover:border-[var(--color-brand-500)]">
            <Stat label="P&L hoje" value={loading ? "..." : fmtUSD(pnl24h)} hint="realizado hoje (UTC) · clique p/ detalhes" size="sm" />
          </Card>
        </button>
        <button type="button" onClick={() => setMetricModal("ops")} className="text-left cursor-pointer">
          <Card className="h-full transition-colors hover:border-[var(--color-brand-500)]">
            <Stat label="Operações" value={loading ? "..." : String(opsToday)} hint="hoje · clique p/ detalhes" size="sm" />
          </Card>
        </button>
        <button type="button" onClick={() => setMetricModal("winrate")} className="text-left cursor-pointer">
          <Card className="h-full transition-colors hover:border-[var(--color-brand-500)]">
            <Stat
              label="Taxa de acerto"
              value={loading ? "..." : winRate30d != null ? `${Math.round(winRate30d * 100)}%` : "—"}
              hint={winRate30d != null ? `${trades30d} trades em 30 dias · clique p/ detalhes` : "sem trades em 30 dias"}
              size="sm"
            />
          </Card>
        </button>
        <button type="button" onClick={() => router.push("/bots")} className="text-left cursor-pointer">
          <Card className="h-full transition-colors hover:border-[var(--color-brand-500)]">
            <Stat label="Bots ativos" value={`${activeBotsCount} / 3`} hint="rodando agora · clique p/ gerenciar" size="sm" />
          </Card>
        </button>
      </div>

      {/* Grid principal estilo "Hello" do Fey: mercado em destaque + feed */}
      <div className="grid lg:grid-cols-5 gap-4">
        {/* ESQUERDA — gráfico real do mercado */}
        <Card padding="lg" className="lg:col-span-3">
          <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
            <div className="flex items-center gap-2">
              <SymbolIcon symbol={chartSymbol} size={26} />
              <span className="text-sm font-semibold text-[var(--color-text)]">{chartSymbol.replace("USDT", "")}</span>
              <span className={`text-xs font-semibold ${chartChangePct >= 0 ? "text-up" : "text-down"}`}>
                {chartChangePct >= 0 ? "+" : ""}{chartChangePct.toFixed(2)}% · 7d
              </span>
            </div>
            <PillTabs
              options={[{ value: "BTCUSDT", label: "BTC" }, { value: "ETHUSDT", label: "ETH" }, { value: "SOLUSDT", label: "SOL" }]}
              value={chartSymbol}
              onChange={setChartSymbol}
            />
          </div>
          <Sparkline data={chartData} width={640} height={180} className="w-full h-[180px]" />
          <div className="mt-4 pt-4 border-t border-[var(--color-border)] grid grid-cols-3 gap-3">
            <Stat label="Spot USDT" value={fmtUSD(balance.spot)} size="sm" />
            <Stat label="Futuros USDT" value={fmtUSD(balance.futures)} size="sm" />
            <Stat label="Posições abertas" value={String(openPositions)} size="sm" />
          </div>
        </Card>

        {/* DIREITA — resumo do dia + feed de atividade */}
        <div className="lg:col-span-2 space-y-4">
          {activity.length > 0 && (
            <Card padding="lg" className="bg-gradient-to-br from-[var(--color-surface-3)] to-[var(--color-surface)]">
              <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted font-semibold mb-2">
                <Sparkles size={12} className="text-[var(--color-brand-300)]" /> Resumo do dia
              </div>
              <p className="text-sm text-[var(--color-text-2)] leading-relaxed">
                {opsToday > 0
                  ? `Seus robôs abriram ${opsToday} operaç${opsToday > 1 ? "ões" : "ão"} hoje, com resultado realizado de ${fmtUSD(pnl24h)}. Última atividade: ${activity[0].title.toLowerCase()}.`
                  : `Nenhuma operação aberta hoje ainda — os robôs seguem varrendo o mercado. Última atividade: ${activity[0].title.toLowerCase()}.`}
              </p>
            </Card>
          )}

          <Card padding="lg">
            <CardHeader title="Atividade recente" subtitle="Últimos eventos do sistema" />
            {activity.length === 0 ? (
              <p className="text-xs text-muted py-4">
                {loading ? "Carregando..." : "Nenhuma operação registrada ainda."}
              </p>
            ) : (
              <ul className="space-y-3.5">
                {activity.map((a) => (
                  <li key={`${a.kind}-${a.symbol}-${a.time}`} className="flex items-center gap-3">
                    <SymbolIcon symbol={a.symbol} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-[var(--color-text)] leading-snug truncate">{a.title}</div>
                      <div className="text-[11px] text-muted mt-0.5">{timeAgo(a.time)}</div>
                    </div>
                    <Badge tone={a.kind === "win" ? "up" : a.kind === "loss" ? "down" : "neutral"} size="sm" className="shrink-0">
                      {a.kind === "win" ? "lucro" : a.kind === "loss" ? "perda" : "abertura"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/posicoes"
              className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-brand-300)] hover:underline"
            >
              Ver tudo <ArrowRight size={13} />
            </Link>
          </Card>
        </div>
      </div>

      {/* Modais de detalhamento das métricas */}
      <Modal
        open={metricModal === "pnl"}
        onClose={() => setMetricModal(null)}
        title="Resultado de hoje (UTC)"
        description={`${todayTrades.length} operação${todayTrades.length === 1 ? "" : "ões"} fechada${todayTrades.length === 1 ? "" : "s"} hoje · total ${fmtUSD(pnl24h)}`}
        footer={
          <Button variant="outline" size="sm" onClick={() => { setMetricModal(null); router.push("/posicoes"); }}>
            Ver todas as posições <ArrowRight size={13} />
          </Button>
        }
      >
        {todayTrades.length === 0 ? (
          <p className="text-xs text-muted py-6 text-center">Nenhuma operação fechada hoje ainda. O P&L do dia soma apenas resultados realizados (posições fechadas).</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {todayTrades.map((t, i) => (
              <li key={i} className="flex items-center justify-between py-2.5 gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-[var(--color-text)]">{t.symbol}</span>
                  <span className="text-[11px] text-muted ml-2">{t.strategy || t.side}</span>
                  <div className="text-[11px] text-muted">{t.closedAt ? new Date(t.closedAt).toLocaleTimeString("pt-BR") : ""}</div>
                </div>
                <span className={`text-sm font-semibold tabular-nums ${t.pnl >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>
                  {t.pnl >= 0 ? "+" : ""}{fmtUSD(t.pnl)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        open={metricModal === "ops"}
        onClose={() => setMetricModal(null)}
        title="Operações de hoje"
        description={`${todayOpened.length} entrada${todayOpened.length === 1 ? "" : "s"} aberta${todayOpened.length === 1 ? "" : "s"} hoje pelos robôs`}
        footer={
          <Button variant="outline" size="sm" onClick={() => { setMetricModal(null); router.push("/posicoes"); }}>
            Ver todas as posições <ArrowRight size={13} />
          </Button>
        }
      >
        {todayOpened.length === 0 ? (
          <p className="text-xs text-muted py-6 text-center">Nenhuma entrada aberta hoje. Os robôs abrem posições quando o mercado dá sinal dentro das regras das estratégias ativas.</p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {todayOpened.map((t, i) => (
              <li key={i} className="flex items-center justify-between py-2.5 gap-3">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-[var(--color-text)]">{t.symbol}</span>
                  <span className="text-[11px] text-muted ml-2">{t.strategy || t.side}</span>
                  <div className="text-[11px] text-muted">aberta às {new Date(t.openedAt).toLocaleTimeString("pt-BR")}</div>
                </div>
                {t.status === "open" ? (
                  <Badge tone="neutral" dot size="sm">Aberta</Badge>
                ) : (
                  <span className={`text-sm font-semibold tabular-nums ${t.pnl >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>
                    {t.pnl >= 0 ? "+" : ""}{fmtUSD(t.pnl)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        open={metricModal === "winrate"}
        onClose={() => setMetricModal(null)}
        title="Taxa de acerto — últimos 30 dias"
        description={winRate30d != null ? `${trades30d} operações fechadas no período` : "Sem operações fechadas no período"}
        footer={
          <Button variant="outline" size="sm" onClick={() => { setMetricModal(null); router.push("/posicoes"); }}>
            Ver histórico completo <ArrowRight size={13} />
          </Button>
        }
      >
        {!stats30d ? (
          <p className="text-xs text-muted py-6 text-center">Quando houver operações fechadas nos últimos 30 dias, o detalhamento de vitórias, derrotas e resultado aparece aqui.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] text-center">
                <div className="text-lg font-bold text-[var(--color-text-up)]">{stats30d.wins}</div>
                <div className="text-[10px] text-muted uppercase">Vitórias</div>
              </div>
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] text-center">
                <div className="text-lg font-bold text-[var(--color-text-down)]">{stats30d.losses}</div>
                <div className="text-[10px] text-muted uppercase">Derrotas</div>
              </div>
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-2)] border border-[var(--color-border)] text-center">
                <div className={`text-lg font-bold ${stats30d.totalPnl >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>{fmtUSD(stats30d.totalPnl)}</div>
                <div className="text-[10px] text-muted uppercase">Resultado</div>
              </div>
            </div>
            <div className="text-xs text-[var(--color-text-2)] space-y-1">
              <div className="flex justify-between"><span className="text-muted">Melhor operação</span><span className="font-medium text-[var(--color-text-up)]">+{fmtUSD(stats30d.bestPnl)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Pior operação</span><span className="font-medium text-[var(--color-text-down)]">{fmtUSD(stats30d.worstPnl)}</span></div>
              <div className="flex justify-between"><span className="text-muted">Taxa de acerto</span><span className="font-medium">{winRate30d != null ? `${Math.round(winRate30d * 100)}%` : "—"}</span></div>
            </div>

            {/* Nova Seção: Diagnóstico de Duração e Tipo de Fechamento */}
            <div className="pt-3.5 border-t border-[var(--color-border)]">
              <div className="text-[10px] text-muted uppercase tracking-wider font-semibold mb-2 flex items-center gap-1">
                ⏱️ Duração & Motivos de Fechamento
              </div>
              <div className="text-xs text-[var(--color-text-2)] space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted">Duração média por trade</span>
                  <span className="font-medium text-[var(--color-text)]">
                    {stats30d.avgDurationMin != null ? `${Math.round(stats30d.avgDurationMin)} minutos` : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Fechados por Timeout (trava)</span>
                  <span className="font-medium text-[var(--color-text)]">
                    {stats30d.timeoutCount != null && stats30d.totalClosed ? `${stats30d.timeoutCount} (${Math.round((stats30d.timeoutCount / stats30d.totalClosed) * 100)}%)` : "0 (0%)"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Fechados por Take Profit (TP)</span>
                  <span className="font-medium text-[var(--color-text-up)]">
                    {stats30d.tpCount != null && stats30d.totalClosed ? `${stats30d.tpCount} (${Math.round((stats30d.tpCount / stats30d.totalClosed) * 100)}%)` : "0 (0%)"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted">Fechados por Stop Loss (SL)</span>
                  <span className="font-medium text-[var(--color-text-down)]">
                    {stats30d.slCount != null && stats30d.totalClosed ? `${stats30d.slCount} (${Math.round((stats30d.slCount / stats30d.totalClosed) * 100)}%)` : "0 (0%)"}
                  </span>
                </div>
              </div>
            </div>

            <p className="text-[10px] text-muted">
              A taxa e as durações consideram todas as posições fechadas com resultado nos últimos 30 dias, somando todos os robôs ativos.
            </p>
          </div>
        )}
      </Modal>

      <BalanceChartModal open={isChartOpen} onClose={() => setIsChartOpen(false)} />
    </div>
  );
}
