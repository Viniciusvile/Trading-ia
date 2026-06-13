"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Card, Stat, Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtUSD } from "@/lib/format";
import { TrendingUp, TrendingDown, Calendar, Award, BarChart2, DollarSign } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from "recharts";

interface BalanceChartModalProps {
  open: boolean;
  onClose: () => void;
}

interface ChartPoint {
  timestamp: number;
  balance: number;
  date: string;
  fullDate: string;
}

export function BalanceChartModal({ open, onClose }: BalanceChartModalProps) {
  const [isMounted, setIsMounted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [closedPositions, setClosedPositions] = useState<any[]>([]);
  const [timeframe, setTimeframe] = useState<"7d" | "30d" | "all">("30d");

  // Estatísticas calculadas
  const [stats, setStats] = useState({
    current: 0,
    changeUsd: 0,
    changePct: 0,
    max: 0,
    min: 0,
    totalTrades: 0,
    winRate: 0,
    bestTrade: 0,
    worstTrade: 0,
  });

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return;

    async function loadHistory() {
      setLoading(true);
      try {
        const [balRes, posRes] = await Promise.all([
          api.botBalance(),
          api.botPositions(),
        ]);

        if (balRes.success && posRes.success) {
          const spot = balRes.spot ?? 0;
          const futures = balRes.futures ?? 0;
          const currentBal = spot + futures;

          // Filtra posições fechadas do usuário
          const closed = posRes.positions
            .filter((p) => p.status === "closed" && p.openedAt)
            .sort(
              (a, b) =>
                new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime()
            );

          setClosedPositions(closed);

          let balanceTracker = currentBal;
          const rawPoints: ChartPoint[] = [];

          // Ponto atual
          rawPoints.push({
            timestamp: Date.now(),
            balance: balanceTracker,
            date: new Date().toLocaleDateString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
            }),
            fullDate: new Date().toLocaleDateString("pt-BR", {
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            }),
          });

          for (const pos of closed) {
            const actualPnl = parseFloat((pos as any).pnl) || 0;
            balanceTracker -= actualPnl;
            const dateObj = new Date(pos.openedAt);
            rawPoints.push({
              timestamp: dateObj.getTime(),
              balance: balanceTracker,
              date: dateObj.toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "2-digit",
              }),
              fullDate: dateObj.toLocaleDateString("pt-BR", {
                day: "2-digit",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              }),
            });
          }

          // Se tivermos apenas 1 ponto, geramos histórico plano fictício
          if (rawPoints.length === 1) {
            const now = Date.now();
            const singleVal = rawPoints[0].balance;
            const fallbackPoints: ChartPoint[] = [];
            for (let i = 6; i >= 0; i--) {
              const d = new Date(now - i * 24 * 3600 * 1000);
              fallbackPoints.push({
                timestamp: d.getTime(),
                balance: singleVal,
                date: d.toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "2-digit",
                }),
                fullDate: d.toLocaleDateString("pt-BR", {
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                }),
              });
            }
            setChartData(fallbackPoints);
          } else {
            // Ordena cronologicamente (do mais antigo ao mais recente)
            rawPoints.reverse();
            setChartData(rawPoints);
          }
        }
      } catch (err) {
        console.error("Erro ao montar histórico de saldo:", err);
      } finally {
        setLoading(false);
      }
    }

    loadHistory();
  }, [open]);

  // Recalcular métricas sempre que os dados ou o timeframe mudarem
  useEffect(() => {
    if (chartData.length === 0) return;

    let filtered = [...chartData];
    const now = Date.now();

    if (timeframe === "7d") {
      filtered = chartData.filter((p) => p.timestamp >= now - 7 * 86400 * 1000);
    } else if (timeframe === "30d") {
      filtered = chartData.filter(
        (p) => p.timestamp >= now - 30 * 86400 * 1000
      );
    }

    // Se o filtro retornar menos de 2 pontos, tenta pegar o máximo possível
    if (filtered.length < 2) {
      filtered = chartData.slice(-7);
    }

    const balances = filtered.map((p) => p.balance);
    const minVal = Math.min(...balances);
    const maxVal = Math.max(...balances);
    const currentVal = chartData[chartData.length - 1].balance; // O saldo atual real da conta é sempre o último ponto real
    const initialVal = balances[0];
    const changeUsd = currentVal - initialVal;
    const changePct = initialVal > 0 ? (changeUsd / initialVal) * 100 : 0;

    // Métricas dos trades fechados no período
    const periodClosed = closedPositions.filter((p) => {
      const t = new Date(p.openedAt).getTime();
      if (timeframe === "7d") return t >= now - 7 * 86400 * 1000;
      if (timeframe === "30d") return t >= now - 30 * 86400 * 1000;
      return true;
    });

    const totalTrades = periodClosed.length;
    const wins = periodClosed.filter((p) => (parseFloat(p.pnl) || 0) > 0).length;
    const winRate = totalTrades ? (wins / totalTrades) * 100 : 0;
    const pnls = periodClosed.map((p) => parseFloat(p.pnl) || 0);
    const bestTrade = pnls.length ? Math.max(...pnls) : 0;
    const worstTrade = pnls.length ? Math.min(...pnls) : 0;

    setStats({
      current: currentVal,
      changeUsd,
      changePct,
      max: maxVal,
      min: minVal,
      totalTrades,
      winRate,
      bestTrade,
      worstTrade,
    });
  }, [chartData, timeframe, closedPositions]);

  if (!isMounted) return null;

  // Filtra dados a serem passados para o Recharts
  const now = Date.now();
  const filteredData = chartData.filter((p) => {
    if (timeframe === "7d") return p.timestamp >= now - 7 * 86400 * 1000;
    if (timeframe === "30d") return p.timestamp >= now - 30 * 86400 * 1000;
    return true;
  });

  const displayData = filteredData.length >= 2 ? filteredData : chartData;

  const isProfit = stats.changeUsd >= 0;
  const strokeColor = isProfit ? "var(--color-up-500)" : "var(--color-down-500)";
  const fillColor = isProfit ? "var(--color-up-500)" : "var(--color-down-500)";

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-full bg-[var(--color-surface-3)]">
            {isProfit ? (
              <TrendingUp className="text-up" size={18} />
            ) : (
              <TrendingDown className="text-down" size={18} />
            )}
          </div>
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text)]">
              Desempenho da Carteira
            </h2>
            <p className="text-[10px] text-muted font-medium">
              Evolução e estatísticas consolidadas
            </p>
          </div>
        </div>
      }
    >
      <div className="space-y-4 sm:space-y-5">
        {/* Seção Principal de Saldo (Estilo Fey v2) */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 bg-[var(--color-surface-3)]/30 border border-[var(--color-border)] p-5 rounded-2xl">
          <div className="space-y-1">
            <span className="text-[10px] text-muted font-bold uppercase tracking-wider">
              Saldo Atual Consolidado
            </span>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl sm:text-4xl font-extrabold text-[var(--color-text)] tracking-tight tabular-nums">
                {loading ? "..." : fmtUSD(stats.current)}
              </span>
              <Badge tone={isProfit ? "up" : "down"} size="sm" className="font-semibold">
                {isProfit ? "+" : ""}
                {stats.changePct.toLocaleString("pt-BR", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
                %
              </Badge>
            </div>
            <div className="text-[11px] text-muted flex items-center gap-1 font-medium">
              <span>Retorno de</span>
              <span className={isProfit ? "text-up font-semibold" : "text-down font-semibold"}>
                {isProfit ? "+" : ""}
                {fmtUSD(stats.changeUsd)}
              </span>
              <span>no período selecionado</span>
            </div>
          </div>

          {/* Filtros de período */}
          <div className="flex items-center gap-1 bg-[var(--color-surface-3)] p-0.5 rounded-lg border border-[var(--color-border)] text-[11px] font-medium h-fit shrink-0">
            <button
              type="button"
              onClick={() => setTimeframe("7d")}
              className={`px-3 py-1 rounded-md transition cursor-pointer ${
                timeframe === "7d"
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-sm font-semibold"
                  : "text-muted hover:text-[var(--color-text)]"
              }`}
            >
              7D
            </button>
            <button
              type="button"
              onClick={() => setTimeframe("30d")}
              className={`px-3 py-1 rounded-md transition cursor-pointer ${
                timeframe === "30d"
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-sm font-semibold"
                  : "text-muted hover:text-[var(--color-text)]"
              }`}
            >
              30D
            </button>
            <button
              type="button"
              onClick={() => setTimeframe("all")}
              className={`px-3 py-1 rounded-md transition cursor-pointer ${
                timeframe === "all"
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-sm font-semibold"
                  : "text-muted hover:text-[var(--color-text)]"
              }`}
            >
              Tudo
            </button>
          </div>
        </div>

        {/* Grade de Estatísticas Detalhadas */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card padding="sm" className="bg-[var(--color-surface-3)]/20 border-[var(--color-border)]/50">
            <div className="text-[9px] uppercase tracking-wider text-muted font-bold mb-1 flex items-center gap-1">
              <Award size={10} className="text-brand-300" /> Taxa de Acerto
            </div>
            <div className="text-sm font-bold text-[var(--color-text)]">
              {loading ? "..." : `${Math.round(stats.winRate)}%`}
            </div>
            <div className="text-[9px] text-muted mt-0.5 font-medium">
              {stats.totalTrades} operações no total
            </div>
          </Card>

          <Card padding="sm" className="bg-[var(--color-surface-3)]/20 border-[var(--color-border)]/50">
            <div className="text-[9px] uppercase tracking-wider text-muted font-bold mb-1 flex items-center gap-1">
              <TrendingUp size={10} className="text-up" /> Melhor Operação
            </div>
            <div className="text-sm font-bold text-up">
              {loading ? "..." : `+${fmtUSD(stats.bestTrade)}`}
            </div>
            <div className="text-[9px] text-muted mt-0.5 font-medium">
              Maior lucro registrado
            </div>
          </Card>

          <Card padding="sm" className="bg-[var(--color-surface-3)]/20 border-[var(--color-border)]/50">
            <div className="text-[9px] uppercase tracking-wider text-muted font-bold mb-1 flex items-center gap-1">
              <TrendingDown size={10} className="text-down" /> Pior Operação
            </div>
            <div className="text-sm font-bold text-down">
              {loading ? "..." : fmtUSD(stats.worstTrade)}
            </div>
            <div className="text-[9px] text-muted mt-0.5 font-medium">
              Maior perda registrada
            </div>
          </Card>

          <Card padding="sm" className="bg-[var(--color-surface-3)]/20 border-[var(--color-border)]/50">
            <div className="text-[9px] uppercase tracking-wider text-muted font-bold mb-1 flex items-center gap-1">
              <BarChart2 size={10} className="text-amber-500" /> Pico da Conta
            </div>
            <div className="text-sm font-bold text-emerald-400">
              {loading ? "..." : fmtUSD(stats.max)}
            </div>
            <div className="text-[9px] text-muted mt-0.5 font-medium">
              Máximo do período
            </div>
          </Card>
        </div>

        {/* Área do gráfico */}
        <div className="h-44 sm:h-56 md:h-64 w-full bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-3 relative flex items-center justify-center">
          {loading ? (
            <div className="flex flex-col items-center gap-2 text-xs text-muted">
              <div className="w-6 h-6 border-2 border-muted border-t-[var(--color-brand-500)] rounded-full animate-spin" />
              <span>Processando histórico...</span>
            </div>
          ) : displayData.length === 0 ? (
            <div className="text-xs text-muted">Sem dados disponíveis</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={displayData}
                margin={{ top: 10, right: 5, left: -20, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="balanceColorModal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={fillColor} stopOpacity={0.25} />
                    <stop offset="95%" stopColor={fillColor} stopOpacity={0.0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--color-border)"
                  vertical={false}
                  opacity={0.3}
                />
                <XAxis
                  dataKey="date"
                  stroke="var(--color-muted)"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  dy={10}
                />
                <YAxis
                  stroke="var(--color-muted)"
                  fontSize={10}
                  tickLine={false}
                  axisLine={false}
                  domain={["auto", "auto"]}
                  tickFormatter={(val) => `$${val.toFixed(0)}`}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload as ChartPoint;
                      return (
                        <div className="bg-[var(--color-surface-2)]/90 backdrop-blur-md border border-[var(--color-border)] p-3 rounded-lg shadow-lg text-xs space-y-1">
                          <div className="text-muted flex items-center gap-1">
                            <Calendar size={12} />
                            {data.fullDate}
                          </div>
                          <div className="font-bold text-[var(--color-text)]">
                            Saldo: {fmtUSD(data.balance)}
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="balance"
                  stroke={strokeColor}
                  strokeWidth={2.2}
                  fillOpacity={1}
                  fill="url(#balanceColorModal)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </Modal>
  );
}
