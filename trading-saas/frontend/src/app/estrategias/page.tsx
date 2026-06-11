"use client";

import { useEffect, useState } from "react";
import {
  Brain,
  Plus,
  Trash2,
  Play,
  Square,
  BarChart3,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Badge, Stat, Button } from "@/components/ui";
import { fmtPct, fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";
import type { BacktestResult } from "@/lib/api";
import { StrategyWizard } from "@/components/strategy/StrategyWizard";
import { BacktestReport } from "@/components/strategy/BacktestReport";
import { ScalperSection } from "@/components/strategy/ScalperSection";

interface Strategy {
  name: string;
  description: string;
  symbols: string[];
  timeframes: string[];
  strategy: string;
  mode: string;
  leverage: number;
  active: boolean;
  winRate: number;
  profitFactor: number;
  netProfit: number;
  totalTrades: number;
  filters: any;
  sl: any;
  tp: any;
  statsSource?: "real" | "backtest" | "sem-dados";
  winRateTarget?: number | null;
  lastBacktest?: import("@/lib/api").BacktestResult | null;
}

export default function EstrategiasPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);

  const fetchStrategies = async () => {
    setLoading(true);
    try {
      const res = await api.botStrategies();
      if (res.success && res.strategies) {
        setStrategies(res.strategies);
      }
    } catch (e) {
      console.error("Erro ao buscar estratégias", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStrategies();
  }, []);

  const handleActivateToggle = async (strat: Strategy) => {
    try {
      if (strat.active) {
        await api.botStrategyDeactivate(strat.name);
      } else {
        await api.botStrategyActivate(strat.name);
      }
      fetchStrategies();
    } catch (e) {
      console.error("Erro ao alternar status da estratégia", e);
    }
  };

  const handleDelete = async (stratName: string) => {
    if (!confirm(`Deseja realmente excluir a estratégia "${stratName}"?`)) return;
    try {
      await api.botStrategyDelete(stratName);
      fetchStrategies();
    } catch (e) {
      console.error("Erro ao excluir estratégia", e);
    }
  };

  const openStats = (strat: Strategy) => {
    setSelectedStrategy(strat);
    setReanalyzeError(null);
    setShowStatsModal(true);
  };

  const handleReanalyze = async (strat: Strategy) => {
    setReanalyzing(true);
    setReanalyzeError(null);
    try {
      // Envia o name: o servidor persiste o lastBacktest no plano salvo
      const res = await api.botBacktest({
        name: strat.name,
        strategy: strat.strategy,
        symbols: strat.symbols,
        timeframes: strat.timeframes,
        mode: strat.mode,
        sl: strat.sl,
        tp: strat.tp,
        filters: strat.filters,
        winRateTarget: strat.winRateTarget,
      });
      if (res.success && res.equityCurve) {
        // Atualiza o modal aberto e a lista
        setSelectedStrategy({ ...strat, lastBacktest: res as BacktestResult, statsSource: "backtest" });
        fetchStrategies();
      } else {
        setReanalyzeError(res.error || "Falha ao executar a análise. Tente novamente.");
      }
    } finally {
      setReanalyzing(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-4 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <PageHeader
          title="Estratégias"
          description="Monitore, ative e crie conjuntos de regras automatizadas para seus bots."
        />
        <Button 
          variant="primary" 
          size="md" 
          onClick={() => setShowCreateModal(true)}
          className="flex items-center gap-2 self-start sm:self-auto shadow-md"
        >
          <Plus size={16} /> Nova Estratégia
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20 space-y-4">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-brand-500)]"></div>
          <span className="text-sm text-muted">Carregando estratégias...</span>
        </div>
      ) : strategies.length === 0 ? (
        <div className="text-center py-16 bg-[var(--color-surface-2)] rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)]">
          <Brain size={48} className="mx-auto text-muted opacity-50 mb-3" />
          <h3 className="text-base font-semibold text-[var(--color-text)]">Nenhuma estratégia configurada</h3>
          <p className="text-xs text-muted mt-1 max-w-sm mx-auto">
            Crie sua primeira estratégia personalizada para começar a automatizar operações na sua conta Binance.
          </p>
          <Button variant="outline" size="sm" onClick={() => setShowCreateModal(true)} className="mt-4">
            Criar Estratégia
          </Button>
        </div>
      ) : (
        <div className="grid gap-4">
          {strategies.map((s) => (
            <Card 
              key={s.name} 
              padding="lg" 
              className={`transition-all duration-300 border ${
                s.active 
                  ? "border-[var(--color-brand-500)] shadow-sm shadow-[var(--color-brand-500)]/10" 
                  : "border-[var(--color-border)]"
              } hover:border-[var(--color-brand-500)] space-y-4`}
            >
              {/* TOP HEADER: Info and Actions */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-[var(--color-border)]">
                <div className="flex items-start gap-4 min-w-0">
                  <div className={`h-11 w-11 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0 ${
                    s.active ? "bg-brand-soft" : "bg-[var(--color-surface-3)]"
                  }`}>
                    <Brain size={22} className={s.active ? "text-[var(--color-brand-500)]" : "text-muted"} />
                  </div>
                  
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 
                        className="text-sm font-semibold text-[var(--color-text)] hover:text-[var(--color-brand-500)] cursor-pointer"
                        onClick={() => openStats(s)}
                      >
                        {s.name}
                      </h3>
                      <Badge tone={s.active ? "up" : "neutral"} dot={s.active} size="sm">
                        {s.active ? "Ativa no Bot" : "Inativa"}
                      </Badge>
                      <span className="text-[10px] uppercase font-bold text-muted bg-[var(--color-surface-3)] px-1.5 py-0.5 rounded border border-[var(--color-border)]">
                        {s.mode} {s.mode === "futures" && `(${s.leverage}x)`}
                      </span>
                    </div>
                    
                    <p className="text-xs text-muted line-clamp-1">{s.description}</p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                  <Button 
                    variant={s.active ? "danger" : "success"} 
                    size="sm"
                    onClick={() => handleActivateToggle(s)}
                    className="flex items-center gap-1"
                  >
                    {s.active ? (
                      <>
                        <Square size={12} fill="currentColor" /> Desativar
                      </>
                    ) : (
                      <>
                        <Play size={12} fill="currentColor" /> Ativar
                      </>
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openStats(s)}>
                    <BarChart3 size={14} /> Estatísticas
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(s.name)} className="text-[var(--color-text-down)] hover:bg-[var(--color-text-down)]/10">
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>

              {/* BOTTOM DETAIL AND STATS */}
              <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
                {/* Meta details (Ativos, Timeframe, Lógica) */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <strong>Ativos:</strong> 
                    <span className="text-[var(--color-text-2)] break-all">{s.symbols.join(", ")}</span>
                  </div>
                  <span className="hidden sm:inline text-muted/30">•</span>
                  <div className="flex items-center gap-1">
                    <strong>Timeframe:</strong> 
                    <span className="text-[var(--color-text-2)]">{s.timeframes.join(", ")}</span>
                  </div>
                  <span className="hidden sm:inline text-muted/30">•</span>
                  <div className="flex items-center gap-1">
                    <strong>Lógica:</strong> 
                    <span className="text-[var(--color-text-2)]">{s.strategy}</span>
                  </div>
                </div>

                {/* Stats Block */}
                <div className="w-full lg:w-auto shrink-0 space-y-2">
                <div className="flex items-center gap-2">
                  {s.statsSource === "real" && <Badge tone="up" size="sm">Trades reais</Badge>}
                  {s.statsSource === "backtest" && <Badge tone="neutral" size="sm">Backtest real</Badge>}
                  {(!s.statsSource || s.statsSource === "sem-dados") && <Badge tone="neutral" size="sm">Sem análise</Badge>}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 sm:gap-10 border-t lg:border-t-0 pt-3 lg:pt-0 border-[var(--color-border)] justify-between lg:justify-end">
                  <Stat label="Win Rate" value={fmtPct(s.winRate * 100, { sign: false })} size="sm" />
                  <Stat label="P. Factor" value={s.profitFactor.toFixed(2)} size="sm" />
                  <Stat label="Lucro" value={fmtUSD(s.netProfit)} size="sm" className={s.netProfit >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"} />
                  <Stat label="Trades" value={s.totalTrades.toString()} size="sm" />
                </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* MICRO SCALPER — estratégias por ativo do robô de trades rápidos */}
      <ScalperSection />

      {showCreateModal && (
        <StrategyWizard
          onClose={() => setShowCreateModal(false)}
          onSaved={fetchStrategies}
        />
      )}

      {/* STATS & BACKTEST REPORT MODAL */}
      {showStatsModal && selectedStrategy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full max-w-3xl bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-md)] shadow-2xl p-6 my-8 max-h-[90vh] overflow-y-auto animate-in fade-in-50 zoom-in-95 duration-200">
            <button 
              onClick={() => setShowStatsModal(false)}
              className="absolute top-4 right-4 p-1 rounded-full text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]"
            >
              <X size={18} />
            </button>

            <div className="flex items-center gap-3 mb-1">
              <div className="h-10 w-10 rounded-[var(--radius-sm)] bg-brand-soft flex items-center justify-center shrink-0">
                <BarChart3 className="text-[var(--color-brand-500)]" size={20} />
              </div>
              <div>
                <h3 className="text-base font-semibold text-[var(--color-text)] flex items-center gap-2">
                  Análise de Mercado: {selectedStrategy.name}
                </h3>
                <p className="text-xs text-muted">Desempenho real da configuração nos dados históricos da Binance.</p>
              </div>
            </div>

            <div className="mt-6">
              {reanalyzeError && !reanalyzing && (
                <p className="text-xs text-[var(--color-text-down)] text-center mb-4">{reanalyzeError}</p>
              )}
              {reanalyzing ? (
                <div className="flex flex-col items-center justify-center py-16 space-y-3">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--color-brand-500)]"></div>
                  <span className="text-xs text-muted">Reanalisando com dados atuais da Binance...</span>
                </div>
              ) : selectedStrategy.lastBacktest ? (
                <BacktestReport data={selectedStrategy.lastBacktest} />
              ) : (
                <div className="text-center py-12 space-y-3">
                  <BarChart3 size={36} className="mx-auto text-muted opacity-50" />
                  <p className="text-sm font-semibold text-[var(--color-text)]">Esta estratégia ainda não foi analisada</p>
                  <p className="text-xs text-muted max-w-sm mx-auto">
                    Rode uma análise de mercado para ver como esta configuração teria performado nos dados históricos reais.
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 border-t border-[var(--color-border)] pt-4 mt-6">
              <Button variant="outline" disabled={reanalyzing} onClick={() => handleReanalyze(selectedStrategy)}>
                {reanalyzing ? "Analisando..." : "Reanalisar agora"}
              </Button>
              <Button variant="ghost" onClick={() => setShowStatsModal(false)}>Fechar Relatório</Button>
              <Button 
                variant={selectedStrategy.active ? "danger" : "success"} 
                onClick={() => {
                  handleActivateToggle(selectedStrategy);
                  setShowStatsModal(false);
                }}
              >
                {selectedStrategy.active ? "Desativar Estratégia" : "Ativar no Bot"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
