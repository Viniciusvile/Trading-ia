"use client";

import { useEffect, useState } from "react";
import { Sparkles, Brain, RefreshCw, CheckCircle2, MinusCircle } from "lucide-react";
import { Card, Badge, Stat } from "@/components/ui";
import { api } from "@/lib/api";
import type { AdaptiveStatus } from "@/lib/api";

/**
 * Seção do AdaptiveBot — bot auto-adaptativo com IA (Gemini).
 * Somente leitura: o robô roda como processo próprio no servidor e
 * aprende sozinho; aqui mostramos o estado, as lições e as revisões.
 */
export function AdaptiveSection() {
  const [status, setStatus] = useState<AdaptiveStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await api.adaptiveStatus();
      setStatus(res);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const id = setInterval(fetchStatus, 60_000);
    return () => clearInterval(id);
  }, []);

  const p = status?.params;

  return (
    <div className="space-y-4 pt-6 border-t border-[var(--color-border)]">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-2">
            <Sparkles size={16} className="text-[var(--color-brand-500)]" /> AdaptiveBot (IA)
          </h2>
          <p className="text-xs text-muted mt-1">
            Robô auto-adaptativo: opera BTCUSDT em candles de 5 minutos e usa IA (Gemini) para analisar os próprios erros,
            aprender lições e ajustar a estratégia — toda mudança é validada em backtest antes de entrar em vigor.
          </p>
        </div>
        <button
          onClick={fetchStatus}
          className="p-2 rounded-[var(--radius-sm)] text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] shrink-0"
          title="Atualizar"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      {!status || (loading && !status.params) ? (
        <Card padding="lg">
          <p className="text-xs text-muted text-center py-6">Carregando status do AdaptiveBot…</p>
        </Card>
      ) : !status.success && !status.params ? (
        <Card padding="lg">
          <p className="text-xs text-muted text-center py-6">
            Não foi possível carregar o AdaptiveBot{status.error ? ` (${status.error})` : ""}.
          </p>
        </Card>
      ) : (
        <Card padding="lg" className={`space-y-4 border ${status.running ? "border-[var(--color-brand-500)]/60" : "border-[var(--color-border)]"}`}>
          {/* Header: status + params atuais */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-[var(--color-border)]">
            <div className="flex items-center gap-3 min-w-0">
              <div className={`h-11 w-11 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 ${status.running ? "bg-brand-soft" : "bg-[var(--color-surface-3)]"}`}>
                <Brain size={22} className={status.running ? "text-[var(--color-brand-500)]" : "text-muted"} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="text-sm font-semibold text-[var(--color-text)]">BTCUSDT</h3>
                  <Badge tone={status.running ? "up" : "neutral"} dot={status.running} size="sm">
                    {status.running ? "Operando" : "Parado"}
                  </Badge>
                  <Badge tone="neutral" size="sm">{status.paper ? "Simulação (paper)" : "Real"}</Badge>
                  {p && <Badge tone="neutral" size="sm">Estratégia v{p.version}</Badge>}
                </div>
                {p && (
                  <p className="text-[11px] text-muted mt-1">
                    {p.strategy === "micro-dip" ? "Compra em quedas curtas a favor da tendência" : "Compra em exaustão (reversão)"} ·
                    {" "}TP +{(p.tp_pct * 100).toFixed(2)}% · SL -{(p.sl_pct * 100).toFixed(2)}% · RSI {p.min_rsi}–{p.max_rsi} · espera {p.cooldown_min}min entre trades
                  </p>
                )}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 sm:gap-6 w-full sm:w-auto shrink-0">
              <Stat label="Trades (30d)" value={String(status.stats30d.trades)} size="sm" />
              <Stat label="Win Rate" value={`${(status.stats30d.winRate * 100).toFixed(0)}%`} size="sm" />
              <Stat
                label="Resultado"
                value={`${status.stats30d.pnlPct >= 0 ? "+" : ""}${status.stats30d.pnlPct.toFixed(2)}%`}
                size="sm"
                className={status.stats30d.pnlPct >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}
              />
            </div>
          </div>

          {/* Posição aberta */}
          {status.openTrades.length > 0 && (
            <div className="text-[11px] text-[var(--color-text-2)] bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] px-3 py-2">
              <strong className="text-[var(--color-text)]">Posição aberta:</strong>{" "}
              {status.openTrades.map((t) => `${t.symbol} @ ${t.entry} (alvo ${t.tp.toFixed(2)} / stop ${t.stop.toFixed(2)})`).join(" · ")}
            </div>
          )}

          <div className="grid md:grid-cols-2 gap-4">
            {/* Lições aprendidas */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-[var(--color-text)]">Lições aprendidas pela IA</p>
              {status.lessons.length === 0 ? (
                <p className="text-[11px] text-muted">
                  Nenhuma lição ainda — a IA revisa os trades a cada 10 operações fechadas (ou 24h) e registra aqui o que aprendeu.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {status.lessons.slice(0, 5).map((l, i) => (
                    <li key={i} className="text-[11px] text-[var(--color-text-2)] flex gap-2">
                      <Sparkles size={12} className="text-[var(--color-brand-500)] shrink-0 mt-0.5" />
                      <span>{l}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Revisões recentes */}
            <div className="space-y-2">
              <p className="text-xs font-semibold text-[var(--color-text)]">Revisões da estratégia</p>
              {status.reviews.length === 0 ? (
                <p className="text-[11px] text-muted">Nenhuma revisão registrada ainda.</p>
              ) : (
                <ul className="space-y-1.5">
                  {status.reviews.slice(0, 5).map((r, i) => (
                    <li key={i} className="text-[11px] text-[var(--color-text-2)] flex gap-2">
                      {r.applied ? (
                        <CheckCircle2 size={12} className="text-[var(--color-text-up)] shrink-0 mt-0.5" />
                      ) : (
                        <MinusCircle size={12} className="text-muted shrink-0 mt-0.5" />
                      )}
                      <span>
                        <span className="text-muted">{new Date(r.at).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}{" "}</span>
                        {r.applied ? `Nova versão v${r.newVersion} aplicada` : "Sem mudança"} — {r.analysis || r.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
