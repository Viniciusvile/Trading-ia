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

/** Período coberto pela análise: menor periodStart e maior periodEnd entre as
 * combinações symbol×timeframe. Retorna null se o backend não enviou as datas. */
function analysisPeriod(data: BacktestResult): { start: number; end: number } | null {
  const starts = data.results.map((r) => r.periodStart).filter((t): t is number => !!t);
  const ends = data.results.map((r) => r.periodEnd).filter((t): t is number => !!t);
  if (!starts.length || !ends.length) return null;
  return { start: Math.min(...starts), end: Math.max(...ends) };
}

const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });

export function BacktestReport({ data }: { data: BacktestResult }) {
  const c = data.combined;
  const period = analysisPeriod(data);

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
      {/* Período coberto pela análise — visível logo no topo */}
      {period && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
          <Clock size={14} className="text-[var(--color-brand-500)] shrink-0" />
          <span className="text-xs text-[var(--color-text-2)]">
            Período analisado:{" "}
            <span className="font-semibold text-[var(--color-text)]">{fmtDate(period.start)}</span>
            {" "}até{" "}
            <span className="font-semibold text-[var(--color-text)]">{fmtDate(period.end)}</span>
          </span>
        </div>
      )}

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
        <Card><Stat label="Lucro em $10k" value={fmtUSD(c.netProfitUsd)} size="sm" className={c.netProfitUsd >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"} /></Card>
        <Card><Stat label="Win Rate" value={fmtPct(wrPct, { sign: false })} size="sm" /></Card>
        <Card><Stat label="PF pós-custos" value={(c.pfAfterCosts ?? c.profitFactor).toFixed(2)} size="sm" className={(c.pfAfterCosts ?? c.profitFactor) >= 1.3 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"} /></Card>
        <Card><Stat label="Max Drawdown" value={fmtPct(c.maxDrawdownPct, { sign: false })} size="sm" /></Card>
      </div>

      {/* Banner de custos reais */}
      {(() => {
        const pfNet = c.pfAfterCosts ?? c.profitFactor;
        const pfBruto = c.pfGross;
        const minPf = data.minPfAfterCosts ?? 1.3;
        const slipPct = data.slippagePct ?? 0.18;
        const feePct = data.feePctPerSide ?? 0.1;
        const totalCostPct = (feePct + slipPct) * 2;
        const blocked = pfNet < minPf;
        return (
          <div className={`flex items-start gap-3 p-3 rounded-[var(--radius-sm)] border text-xs ${
            blocked
              ? "border-[var(--color-text-down)]/40 bg-[var(--color-text-down)]/5"
              : "border-[var(--color-border)] bg-[var(--color-surface-3)]"
          }`}>
            {blocked
              ? <AlertTriangle size={16} className="text-[var(--color-text-down)] shrink-0 mt-0.5" />
              : <CheckCircle2 size={16} className="text-[var(--color-text-up)] shrink-0 mt-0.5" />}
            <div className="space-y-0.5">
              {blocked ? (
                <>
                  <p className="font-semibold text-[var(--color-text-down)]">
                    Estratégia provavelmente perde dinheiro após custos reais
                  </p>
                  <p className="text-muted">
                    PF pós-custos <strong>{pfNet.toFixed(2)}</strong> está abaixo do mínimo {minPf} —
                    taxas+slippage ({totalCostPct.toFixed(2)}%/trade) transformam o empate estatístico em prejuízo certo.
                    {pfBruto != null && ` PF bruto: ${pfBruto.toFixed(2)}.`}
                  </p>
                </>
              ) : (
                <p className="text-muted">
                  Inclui <strong>{feePct}% taxa</strong> + <strong>{slipPct}% slippage</strong> por perna ({totalCostPct.toFixed(2)}%/trade).
                  {pfBruto != null && c.costDragPct != null && ` Custos consomem ${Math.abs(c.costDragPct).toFixed(3)}%/trade (PF bruto ${pfBruto.toFixed(2)} → ${pfNet.toFixed(2)} líquido).`}
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {/* Curva real */}
      <div className="space-y-2">
        <span className="text-xs font-semibold text-[var(--color-text)] flex items-center gap-1.5">
          <TrendingUp size={14} className="text-[var(--color-brand-500)]" />
          Curva de patrimônio real ({c.totalTrades} trades, {c.wins}W/{c.losses}L)
        </span>
        <EquityCurve points={data.equityCurve} />
      </div>

      {/* Consistência temporal (walk-forward 70/30) */}
      {data.walkForward?.inSample && data.walkForward?.outOfSample && (() => {
        const ws = data.walkForward!;
        const wrIn = ws.inSample!.winRate * 100;
        const wrOut = ws.outOfSample!.winRate * 100;
        const divergent = wrIn - wrOut > 15;
        return (
          <div className={`p-3 rounded-[var(--radius-sm)] border space-y-1.5 ${
            divergent
              ? "border-[var(--color-text-down)]/40 bg-[var(--color-text-down)]/5"
              : "border-[var(--color-border)] bg-[var(--color-surface-3)]"
          }`}>
            <p className="text-xs font-semibold text-[var(--color-text)]">Consistência temporal (70% iniciais × 30% finais)</p>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-muted">
              <span>Início: <strong className="text-[var(--color-text)]">{wrIn.toFixed(1)}% WR</strong> ({ws.inSample!.totalTrades} trades, {ws.inSample!.netProfitPct >= 0 ? "+" : ""}{ws.inSample!.netProfitPct.toFixed(2)}%)</span>
              <span>Final: <strong className="text-[var(--color-text)]">{wrOut.toFixed(1)}% WR</strong> ({ws.outOfSample!.totalTrades} trades, {ws.outOfSample!.netProfitPct >= 0 ? "+" : ""}{ws.outOfSample!.netProfitPct.toFixed(2)}%)</span>
            </div>
            {divergent && (
              <p className="text-[10px] text-[var(--color-text-down)]">
                O desempenho caiu bastante no trecho final do período — pode ser ajuste excessivo ao passado ou mudança de regime do mercado. Considere relaxar os filtros e reanalisar.
              </p>
            )}
          </div>
        );
      })()}

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
                      {new Date(t.entryTime).toLocaleString("pt-BR", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
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
        {period && (
          <>Período analisado: <span className="font-semibold text-[var(--color-text-2)]">{fmtDate(period.start)} — {fmtDate(period.end)}</span>. </>
        )}
        Análise executada em {new Date(data.ranAt).toLocaleString("pt-BR")} sobre candles públicos da Binance
        {data.feePctPerSide != null ? `, com taxas de ${data.feePctPerSide}% por lado incluídas` : ""}.
        Desempenho passado não garante resultados futuros.
      </p>
    </div>
  );
}
