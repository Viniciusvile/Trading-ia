"use client";

import { useId } from "react";
import { TrendingUp, CheckCircle2, AlertCircle, AlertTriangle, Clock } from "lucide-react";
import { Card, Badge, Stat } from "@/components/ui";
import { fmtPct, fmtUSD } from "@/lib/format";
import type { BacktestResult } from "@/lib/api";

function EquityCurve({ points }: { points: { time: number; equity: number }[] }) {
  const gid = useId();
  if (points.length < 2) {
    return (
      <div className="h-44 flex items-center justify-center text-xs text-muted bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)]">
        Poucos trades para desenhar a curva.
      </div>
    );
  }
  const W = 300, H = 100, PAD = 4;
  const eqs = points.map((p) => p.equity);
  const min = Math.min(...eqs), max = Math.max(...eqs);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (e: number) => PAD + (1 - (e - min) / span) * (H - PAD * 2);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(p.equity).toFixed(1)}`).join(" ");
  const area = `${line} L ${W} ${H} L 0 ${H} Z`;
  const base = eqs[0] || 1;
  const finalPct = ((eqs[eqs.length - 1] - base) / base) * 100;

  return (
    <div className="h-44 w-full bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] p-4 relative overflow-hidden">
      <svg className="w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Curva de patrimônio, ${finalPct >= 0 ? "+" : ""}${finalPct.toFixed(1)}% no período`}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke="var(--color-brand-500)" strokeWidth="2" />
      </svg>
      <span className="absolute top-2 left-3 text-[10px] text-muted">{fmtUSD(eqs[0])} inicial</span>
      <span className={`absolute bottom-2 right-3 text-[10px] font-semibold ${finalPct >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>
        {finalPct >= 0 ? "+" : ""}{finalPct.toFixed(1)}% no período
      </span>
    </div>
  );
}

export function BacktestReport({ data }: { data: BacktestResult }) {
  const c = data.combined;

  if (!c) {
    return (
      <div className="text-center py-10 space-y-2">
        <AlertCircle size={32} className="mx-auto text-muted" />
        <p className="text-sm font-semibold text-[var(--color-text)]">Nenhum trade gerado no período analisado</p>
        <p className="text-xs text-muted max-w-md mx-auto">
          Os filtros estão restritivos demais para o regime de mercado recente.
          Tente relaxar ADX/volume, ampliar timeframes ou incluir mais ativos.
        </p>
        {data.results.some((r) => r.error) && (
          <div className="text-[10px] text-[var(--color-text-down)] space-y-0.5 pt-2">
            {data.results.filter((r) => r.error).map((r) => (
              <p key={`${r.symbol}-${r.timeframe}`}>{r.symbol} {r.timeframe}: {r.error}</p>
            ))}
          </div>
        )}
      </div>
    );
  }

  const wrPct = c.winRate * 100;

  return (
    <div className="space-y-5">
      {/* Veredito vs meta */}
      {data.winRateTarget != null && (
        <div className={`flex items-center gap-3 p-3 rounded-[var(--radius-sm)] border ${
          data.approved
            ? "border-[var(--color-text-up)]/40 bg-[var(--color-text-up)]/5"
            : "border-[var(--color-text-down)]/40 bg-[var(--color-text-down)]/5"
        }`}>
          {data.approved
            ? <CheckCircle2 size={20} className="text-[var(--color-text-up)] shrink-0" />
            : <AlertCircle size={20} className="text-[var(--color-text-down)] shrink-0" />}
          <div className="text-xs">
            <p className="font-semibold text-[var(--color-text)]">
              {data.approved ? "Configuração aprovada na análise histórica" : "Configuração abaixo da meta"}
            </p>
            <p className="text-muted">
              Win rate real de <strong>{wrPct.toFixed(1)}%</strong> contra meta de <strong>{data.winRateTarget}%</strong>
              {" "}em {c.totalTrades} trades simulados com dados reais da Binance.
            </p>
          </div>
        </div>
      )}

      {/* Avisos de limitação do backtest */}
      {data.warnings?.length > 0 && (
        <div className="space-y-1">
          {data.warnings.map((w, i) => (
            <p key={i} className="flex items-start gap-1.5 text-[10px] text-muted">
              <AlertTriangle size={12} className="shrink-0 mt-0.5 text-[var(--color-text-down)]/70" /> {w}
            </p>
          ))}
        </div>
      )}

      {/* Stats principais */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><Stat label="Lucro em $10k" value={fmtUSD(c.netProfitUsd)} className={c.netProfitUsd >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"} /></Card>
        <Card><Stat label="Win Rate" value={fmtPct(wrPct, { sign: false })} /></Card>
        <Card><Stat label="Profit Factor" value={c.profitFactor.toFixed(2)} /></Card>
        <Card><Stat label="Max Drawdown" value={fmtPct(c.maxDrawdownPct, { sign: false })} /></Card>
      </div>

      {/* Curva real */}
      <div className="space-y-2">
        <span className="text-xs font-semibold text-[var(--color-text)] flex items-center gap-1.5">
          <TrendingUp size={14} className="text-[var(--color-brand-500)]" />
          Curva de patrimônio real ({c.totalTrades} trades, {c.wins}W/{c.losses}L)
        </span>
        <EquityCurve points={data.equityCurve} />
      </div>

      {/* Por ativo × timeframe */}
      {data.results.length > 1 && (
        <div className="border border-[var(--color-border)] rounded-[var(--radius-sm)] overflow-hidden">
          <table className="w-full text-xs text-left">
            <thead className="bg-[var(--color-surface-3)] text-muted font-medium border-b border-[var(--color-border)]">
              <tr>
                <th className="p-2.5">Ativo</th>
                <th className="p-2.5">TF</th>
                <th className="p-2.5 text-right">Trades</th>
                <th className="p-2.5 text-right">Win Rate</th>
                <th className="p-2.5 text-right">PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)] text-[var(--color-text)]">
              {data.results.map((r) => (
                <tr key={`${r.symbol}-${r.timeframe}`}>
                  <td className="p-2.5 font-semibold">{r.symbol}</td>
                  <td className="p-2.5">{r.timeframe}</td>
                  <td className="p-2.5 text-right">{r.stats?.totalTrades ?? 0}</td>
                  <td className="p-2.5 text-right">{r.stats ? fmtPct(r.stats.winRate * 100, { sign: false }) : "—"}</td>
                  <td className={`p-2.5 text-right font-semibold ${(r.stats?.netProfitPct ?? 0) >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>
                    {r.stats ? `${r.stats.netProfitPct >= 0 ? "+" : ""}${r.stats.netProfitPct.toFixed(2)}%` : (r.error || "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Trades recentes reais */}
      {data.recentTrades.length > 0 && (
        <div className="space-y-2">
          <span className="text-xs font-semibold text-[var(--color-text)] flex items-center gap-1.5">
            <Clock size={14} /> Últimos trades simulados (dados reais de mercado)
          </span>
          <div className="border border-[var(--color-border)] rounded-[var(--radius-sm)] overflow-hidden max-h-56 overflow-y-auto">
            <table className="w-full text-xs text-left">
              <thead className="bg-[var(--color-surface-3)] text-muted font-medium border-b border-[var(--color-border)] sticky top-0">
                <tr>
                  <th className="p-2.5">Entrada</th>
                  <th className="p-2.5">Ativo</th>
                  <th className="p-2.5">Lado</th>
                  <th className="p-2.5 text-right">Preço</th>
                  <th className="p-2.5 text-right">Resultado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)] text-[var(--color-text)]">
                {[...data.recentTrades].reverse().map((t, idx) => (
                  <tr key={idx}>
                    <td className="p-2.5 text-muted">
                      {new Date(t.entryTime).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                    </td>
                    <td className="p-2.5 font-semibold">{t.symbol || "—"}</td>
                    <td className="p-2.5"><Badge tone={t.side === "LONG" ? "up" : "down"} size="sm">{t.side}</Badge></td>
                    <td className="p-2.5 text-right">{fmtUSD(t.entryPrice)}</td>
                    <td className={`p-2.5 text-right font-bold ${t.returnPct >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>
                      {t.returnPct >= 0 ? "+" : ""}{t.returnPct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted">
        Análise executada em {new Date(data.ranAt).toLocaleString("pt-BR")} sobre candles públicos da Binance.
        Desempenho passado não garante resultados futuros.
      </p>
    </div>
  );
}
