"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Brain,
  Plus,
  Trash2,
  Play,
  Square,
  BarChart3,
  SlidersHorizontal,
  Share2,
  ArrowDownToLine,
  X,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Badge, Stat, Button } from "@/components/ui";
import { fmtPct, fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";
import { toast } from "sonner";
import type { BacktestResult } from "@/lib/api";
import { StrategyWizard } from "@/components/strategy/StrategyWizard";
import { ShareStrategyModal } from "@/components/strategy/ShareStrategyModal";
import { ImportStrategyModal } from "@/components/strategy/ImportStrategyModal";
import { BacktestReport } from "@/components/strategy/BacktestReport";
import { ScalperSection } from "@/components/strategy/ScalperSection";
import { AdaptiveSection } from "@/components/strategy/AdaptiveSection";
import { Sparkline, SymbolIcon } from "@/components/fx";

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
  entry_conditions?: { indicator: string; indicator_period: number; operator: string; value?: number | null; compare_to_indicator?: string | null }[];
  entry_side?: string;
  exit_conditions?: { indicator: string; indicator_period: number; operator: string; value?: number | null; compare_to_indicator?: string | null }[];
  statsSource?: "real" | "backtest" | "sem-dados";
  lastBacktestAt?: number | null;
  realStats?: { totalTrades: number; winRate: number; profitFactor: number; netProfit: number } | null;
  winRateTarget?: number | null;
  lastBacktest?: import("@/lib/api").BacktestResult | null;
}

// Tempo relativo curto em pt-BR (ex.: "há 2h")
function agoShort(ts?: number | null): string {
  if (!ts) return "";
  const min = Math.floor((Date.now() - ts) / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min}min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

export default function EstrategiasPage() {
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingStrategy, setEditingStrategy] = useState<Strategy | null>(null);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [reanalyzeError, setReanalyzeError] = useState<string | null>(null);
  const [sharingStrategy, setSharingStrategy] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importInitialCode, setImportInitialCode] = useState<string | undefined>(undefined);

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

  const loadUser = async () => {
    try {
      const res = await api.me();
      if (res.success) {
        setCurrentUser(res.user);
      }
    } catch (e) {
      console.error("Erro ao carregar usuário:", e);
    }
  };

  useEffect(() => {
    loadUser();
    fetchStrategies();
    // O servidor reanalisa os backtests a cada 4h — este refetch leve mantém
    // os cards atualizados sem o usuário precisar recarregar a página.
    const timer = setInterval(async () => {
      try {
        const res = await api.botStrategies();
        if (res.success && res.strategies) setStrategies(res.strategies);
      } catch {}
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  // Abertura automática do importador via link de compartilhamento
  // (ex.: /estrategias?importar=SH-9A2F8B).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const code = new URLSearchParams(window.location.search).get("importar");
    if (code) {
      setImportInitialCode(code);
      setShowImportModal(true);
    }
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
          title={`Estratégias (${strategies.length}/${currentUser?.max_strategies || 3})`}
          description="Monitore, ative e crie conjuntos de regras automatizadas para seus bots."
        />
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <Button
            variant="outline"
            size="md"
            onClick={() => { setImportInitialCode(undefined); setShowImportModal(true); }}
            className="flex items-center gap-2"
          >
            <ArrowDownToLine size={16} /> Importar
          </Button>
          <Button
            variant="primary"
            size="md"
            onClick={() => {
              if (strategies.length >= (currentUser?.max_strategies || 3)) {
                toast.error(`Limite de estratégias atingido (${currentUser?.max_strategies || 3}). Faça upgrade do seu plano para criar mais.`);
                window.location.href = "/planos";
              } else {
                setShowCreateModal(true);
              }
            }}
            className="flex items-center gap-2 shadow-md"
          >
            <Plus size={16} /> Nova Estratégia
          </Button>
        </div>
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
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => {
              if (strategies.length >= (currentUser?.max_strategies || 3)) {
                toast.error(`Limite de estratégias atingido (${currentUser?.max_strategies || 3}). Faça upgrade do seu plano para criar mais.`);
                window.location.href = "/planos";
              } else {
                setShowCreateModal(true);
              }
            }} 
            className="mt-4"
          >
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
                <div className="flex items-center gap-1.5 w-full sm:w-auto justify-end sm:justify-start mt-2 sm:mt-0 shrink-0">
                  <Button 
                    variant={s.active ? "danger" : "success"} 
                    size="sm"
                    onClick={() => handleActivateToggle(s)}
                    className="flex items-center gap-1 justify-center flex-1 sm:flex-none min-h-[32px] px-3 text-xs"
                  >
                    {s.active ? (
                      <>
                        <Square size={10} fill="currentColor" /> Desativar
                      </>
                    ) : (
                      <>
                        <Play size={10} fill="currentColor" /> Ativar
                      </>
                    )}
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => setEditingStrategy(s)}
                    className="flex items-center gap-1 justify-center min-h-[32px]"
                    title="Personalizar"
                  >
                    <SlidersHorizontal size={14} />
                    <span className="hidden sm:inline">Personalizar</span>
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm" 
                    onClick={() => openStats(s)}
                    className="flex items-center gap-1 justify-center min-h-[32px]"
                    title="Estatísticas"
                  >
                    <BarChart3 size={14} />
                    <span className="hidden sm:inline">Estatísticas</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSharingStrategy(s.name)}
                    title="Compartilhar estratégia"
                    className="h-8 w-8 p-0 flex items-center justify-center shrink-0"
                  >
                    <Share2 size={14} />
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    onClick={() => handleDelete(s.name)} 
                    className="text-[var(--color-text-down)] hover:bg-[var(--color-text-down)]/10 h-8 w-8 p-0 flex items-center justify-center shrink-0"
                    title="Excluir"
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </div>

              {/* BOTTOM DETAIL AND STATS */}
              <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
                {/* Meta details (Ativos, Timeframe, Lógica) */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-muted flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="flex -space-x-1.5">
                      {s.symbols.slice(0, 4).map((sym) => <SymbolIcon key={sym} symbol={sym} size={18} />)}
                    </span>
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
                  {s.statsSource === "backtest" && (
                    <Badge tone="neutral" size="sm">
                      Backtest real{s.lastBacktestAt ? ` · ${agoShort(s.lastBacktestAt)}` : ""}
                    </Badge>
                  )}
                  {(!s.statsSource || s.statsSource === "sem-dados") && <Badge tone="neutral" size="sm">Sem análise</Badge>}
                  {s.statsSource === "backtest" && s.lastBacktestAt != null && Date.now() - s.lastBacktestAt < 5 * 60 * 60 * 1000 && (
                    <Badge tone="up" size="sm" dot>Auto 4h</Badge>
                  )}
                  {s.lastBacktest?.equityCurve && s.lastBacktest.equityCurve.length > 1 && (
                    <Sparkline
                      data={s.lastBacktest.equityCurve.map((p) => p.equity)}
                      width={140}
                      height={32}
                      className="ml-auto"
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 sm:gap-10 border-t lg:border-t-0 pt-3 lg:pt-0 border-[var(--color-border)] justify-between lg:justify-end">
                  <Stat label="Win Rate" value={fmtPct(s.winRate * 100, { sign: false })} size="sm" />
                  <Stat label="P. Factor" value={s.profitFactor.toFixed(2)} size="sm" />
                  <Stat label="Lucro" value={fmtUSD(Number(s.netProfit || 0))} size="sm" className={(Number(s.netProfit) || 0) >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"} />
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

      {/* ADAPTIVEBOT — robô auto-adaptativo com IA */}
      <AdaptiveSection />

      {showCreateModal && (
        <StrategyWizard
          onClose={() => setShowCreateModal(false)}
          onSaved={fetchStrategies}
        />
      )}

      {/* PERSONALIZAR — mesmo wizard, pré-preenchido com a estratégia existente */}
      {editingStrategy && (
        <StrategyWizard
          initial={editingStrategy}
          onClose={() => setEditingStrategy(null)}
          onSaved={fetchStrategies}
        />
      )}

      {/* COMPARTILHAR — gera código/link P2P para a estratégia */}
      {sharingStrategy && (
        <ShareStrategyModal
          strategyName={sharingStrategy}
          onClose={() => setSharingStrategy(null)}
        />
      )}

      {/* IMPORTAR — código P2P ou análise por IA de Pine Script / TradingView */}
      {showImportModal && (
        <ImportStrategyModal
          initialCode={importInitialCode}
          onClose={() => { setShowImportModal(false); setImportInitialCode(undefined); }}
          onSaved={fetchStrategies}
        />
      )}

      {/* STATS & BACKTEST REPORT MODAL */}
      {showStatsModal && selectedStrategy && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
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
                <div className="space-y-5">
                  {/* Esperado (backtest) × Realizado (conta) */}
                  {selectedStrategy.realStats && selectedStrategy.lastBacktest.combined && (() => {
                    const bt = selectedStrategy.lastBacktest!.combined!;
                    const real = selectedStrategy.realStats!;
                    const wrGap = bt.winRate * 100 - real.winRate * 100;
                    const degraded = real.totalTrades >= 5 && wrGap > 15;
                    return (
                      <div className={`p-3 rounded-[var(--radius-sm)] border space-y-2 ${
                        degraded
                          ? "border-[var(--color-text-down)]/40 bg-[var(--color-text-down)]/5"
                          : "border-[var(--color-border)] bg-[var(--color-surface-3)]"
                      }`}>
                        <p className="text-xs font-semibold text-[var(--color-text)]">Esperado (backtest) × Realizado (sua conta)</p>
                        <table className="w-full text-[11px]">
                          <thead className="text-muted">
                            <tr>
                              <th className="text-left font-medium pb-1"></th>
                              <th className="text-right font-medium pb-1">Win Rate</th>
                              <th className="text-right font-medium pb-1">P. Factor</th>
                              <th className="text-right font-medium pb-1">Resultado</th>
                              <th className="text-right font-medium pb-1">Trades</th>
                            </tr>
                          </thead>
                          <tbody className="text-[var(--color-text)]">
                            <tr>
                              <td className="py-0.5 text-muted">Backtest</td>
                              <td className="text-right">{(bt.winRate * 100).toFixed(1)}%</td>
                              <td className="text-right">{bt.profitFactor.toFixed(2)}</td>
                              <td className="text-right">{fmtUSD(Number(bt.netProfitUsd || 0))}</td>
                              <td className="text-right">{bt.totalTrades}</td>
                            </tr>
                            <tr>
                              <td className="py-0.5 text-muted">Real</td>
                              <td className="text-right font-semibold">{(real.winRate * 100).toFixed(1)}%</td>
                              <td className="text-right font-semibold">{real.profitFactor.toFixed(2)}</td>
                              <td className={`text-right font-semibold ${(Number(real.netProfit) || 0) >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>{fmtUSD(Number(real.netProfit || 0))}</td>
                              <td className="text-right font-semibold">{real.totalTrades}</td>
                            </tr>
                          </tbody>
                        </table>
                        {degraded ? (
                          <p className="text-[10px] text-[var(--color-text-down)]">
                            O desempenho real está bem abaixo do backtest ({wrGap.toFixed(0)} p.p. de win rate). Considere pausar a estratégia e reanalisar com o mercado atual.
                          </p>
                        ) : real.totalTrades < 5 ? (
                          <p className="text-[10px] text-muted">Amostra real ainda pequena ({real.totalTrades} trade{real.totalTrades > 1 ? "s" : ""}) — compare novamente com mais operações.</p>
                        ) : null}
                      </div>
                    );
                  })()}
                  <BacktestReport data={selectedStrategy.lastBacktest} />
                </div>
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

            <div className="flex flex-col sm:flex-row sm:justify-end gap-2 sm:gap-3 border-t border-[var(--color-border)] pt-4 mt-6">
              <Button variant="ghost" className="w-full sm:w-auto order-last sm:order-first" onClick={() => setShowStatsModal(false)}>Fechar Relatório</Button>
              <Button variant="outline" className="w-full sm:w-auto" disabled={reanalyzing} onClick={() => handleReanalyze(selectedStrategy)}>
                {reanalyzing ? "Analisando..." : "Reanalisar agora"}
              </Button>
              <Button
                variant={selectedStrategy.active ? "danger" : "success"}
                className="w-full sm:w-auto"
                onClick={() => {
                  handleActivateToggle(selectedStrategy);
                  setShowStatsModal(false);
                }}
              >
                {selectedStrategy.active ? "Desativar Estratégia" : "Ativar no Bot"}
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
