"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Card, Stat, Badge } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtUSD } from "@/lib/format";
import { TrendingUp, TrendingDown, Calendar, Percent } from "lucide-react";
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
  const [timeframe, setTimeframe] = useState<"7d" | "30d" | "all">("30d");

  // Estatísticas do período
  const [stats, setStats] = useState({
    current: 0,
    changeUsd: 0,
    changePct: 0,
    max: 0,
    min: 0,
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
            // Se a posição foi fechada, removemos o PnL dela para saber o saldo antes
            const pnl = parseFloat(pos.takeProfitPrice ? String(pos.takeProfitPrice) : "0") - parseFloat(String(pos.entryPrice));
            // Mas o pnl correto já vem no objeto do banco se estiver gravado.
            // Para maior robustez, usamos o pnl gravado na posição:
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
    const currentVal = balances[balances.length - 1];
    const initialVal = balances[0];
    const changeUsd = currentVal - initialVal;
    const changePct = initialVal > 0 ? (changeUsd / initialVal) * 100 : 0;

    setStats({
      current: currentVal,
      changeUsd,
      changePct,
      max: maxVal,
      min: minVal,
    });
  }, [chartData, timeframe]);

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
              Evolução do Saldo
            </h2>
            <p className="text-[10px] text-muted">
              Histórico consolidado da conta
            </p>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Filtros de período */}
        <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] pb-3">
          <div className="flex items-center gap-1.5 bg-[var(--color-surface-3)] p-0.5 rounded-lg text-[11px] font-medium">
            <button
              type="button"
              onClick={() => setTimeframe("7d")}
              className={`px-3 py-1 rounded-md transition cursor-pointer ${
                timeframe === "7d"
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-sm"
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
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-sm"
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
                  ? "bg-[var(--color-surface-2)] text-[var(--color-text)] shadow-sm"
                  : "text-muted hover:text-[var(--color-text)]"
              }`}
            >
              Tudo
            </button>
          </div>

          <Badge tone={isProfit ? "up" : "down"} dot size="sm">
            {isProfit ? "+" : ""}
            {stats.changePct.toLocaleString("pt-BR", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
            % no período
          </Badge>
        </div>

        {/* Resumo de estatísticas */}
        <div className="grid grid-cols-3 gap-3">
          <Card padding="md" className="bg-[var(--color-surface-3)]/40 border-none">
            <div className="text-[9px] uppercase tracking-wider text-muted font-semibold mb-1">
              Saldo Atual
            </div>
            <div className="text-sm font-bold text-[var(--color-text)]">
              {loading ? "..." : fmtUSD(stats.current)}
            </div>
          </Card>
          <Card padding="md" className="bg-[var(--color-surface-3)]/40 border-none">
            <div className="text-[9px] uppercase tracking-wider text-muted font-semibold mb-1">
              Retorno
            </div>
            <div className={`text-sm font-bold ${isProfit ? "text-up" : "text-down"}`}>
              {loading ? "..." : `${isProfit ? "+" : ""}${fmtUSD(stats.changeUsd)}`}
            </div>
          </Card>
          <Card padding="md" className="bg-[var(--color-surface-3)]/40 border-none">
            <div className="text-[9px] uppercase tracking-wider text-muted font-semibold mb-1">
              Pico do Período
            </div>
            <div className="text-sm font-bold text-emerald-400">
              {loading ? "..." : fmtUSD(stats.max)}
            </div>
          </Card>
        </div>

        {/* Área do gráfico */}
        <div className="h-64 w-full bg-[var(--color-surface)] rounded-xl border border-[var(--color-border)] p-3 relative flex items-center justify-center">
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
                  <linearGradient id="balanceColor" x1="0" y1="0" x2="0" y2="1">
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
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#balanceColor)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </Modal>
  );
}
