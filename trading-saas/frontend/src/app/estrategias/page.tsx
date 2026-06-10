"use client";

import { useEffect, useState } from "react";
import { 
  Brain, 
  ChevronRight, 
  CircleCheck, 
  Plus, 
  Trash2, 
  Play, 
  Square, 
  Settings, 
  Activity, 
  TrendingUp, 
  BarChart3, 
  X, 
  Percent, 
  DollarSign, 
  AlertCircle, 
  CheckCircle2, 
  SlidersHorizontal,
  Info
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Badge, Stat, Button } from "@/components/ui";
import { fmtPct, fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";

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
}

export default function EstrategiasPage() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showStatsModal, setShowStatsModal] = useState(false);
  const [selectedStrategy, setSelectedStrategy] = useState<Strategy | null>(null);

  // Form states
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState("spot");
  const [strategyType, setStrategyType] = useState("warrior");
  const [symbols, setSymbols] = useState<string[]>(["BTCUSDT"]);
  const [timeframes, setTimeframes] = useState<string[]>(["1H"]);
  const [leverage, setLeverage] = useState(1);
  const [slMultiplier, setSlMultiplier] = useState(1.5);
  const [tpMultiplier, setTpMultiplier] = useState(2.0);
  
  // Filters checklist
  const [emaTriple, setEmaTriple] = useState(true);
  const [adxMin, setAdxMin] = useState(20);
  const [volumeMult, setVolumeMult] = useState(1.3);
  const [choppinessMin, setChoppinessMin] = useState(45);

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

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    const filters: any = {};
    if (emaTriple) filters.ema_triple = true;
    if (strategyType === "warrior") {
      filters.adx_min = adxMin;
      filters.volume_mult = volumeMult;
    } else if (strategyType === "range-v2") {
      filters.adx_max = 28;
      filters.choppiness_min = choppinessMin;
    }

    const newStrat = {
      name: name.replace(/\s+/g, "_"), // snake_case for plans
      description,
      symbols,
      timeframes,
      strategy: strategyType,
      mode,
      leverage: mode === "futures" ? leverage : 1,
      sl: { type: "atr", multiplier: slMultiplier },
      tp: { type: "atr", multiplier: tpMultiplier },
      filters
    };

    try {
      const res = await api.botStrategyCreate(newStrat);
      if (res.success) {
        setShowCreateModal(false);
        // Reset form
        setName("");
        setDescription("");
        setSymbols(["BTCUSDT"]);
        setTimeframes(["1H"]);
        setLeverage(1);
        setSlMultiplier(1.5);
        setTpMultiplier(2.0);
        fetchStrategies();
      }
    } catch (e) {
      console.error("Erro ao criar estratégia", e);
    }
  };

  const openStats = (strat: Strategy) => {
    setSelectedStrategy(strat);
    setShowStatsModal(true);
  };

  const handleSymbolToggle = (sym: string) => {
    if (symbols.includes(sym)) {
      if (symbols.length > 1) setSymbols(symbols.filter(s => s !== sym));
    } else {
      setSymbols([...symbols, sym]);
    }
  };

  const handleTimeframeToggle = (tf: string) => {
    if (timeframes.includes(tf)) {
      if (timeframes.length > 1) setTimeframes(timeframes.filter(t => t !== tf));
    } else {
      setTimeframes([...timeframes, tf]);
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
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 sm:gap-10 border-t lg:border-t-0 pt-3 lg:pt-0 border-[var(--color-border)] w-full lg:w-auto shrink-0 justify-between lg:justify-end">
                  <Stat label="Win Rate" value={fmtPct(s.winRate * 100, { sign: false })} size="sm" />
                  <Stat label="P. Factor" value={s.profitFactor.toFixed(2)} size="sm" />
                  <Stat label="Lucro" value={fmtUSD(s.netProfit)} size="sm" className={s.netProfit >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"} />
                  <Stat label="Trades" value={s.totalTrades.toString()} size="sm" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* CREATE MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full max-w-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-md)] shadow-2xl p-6 my-8 max-h-[90vh] overflow-y-auto animate-in fade-in-50 zoom-in-95 duration-200">
            <button 
              onClick={() => setShowCreateModal(false)}
              className="absolute top-4 right-4 p-1 rounded-full text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]"
            >
              <X size={18} />
            </button>

            <h3 className="text-base font-semibold text-[var(--color-text)] flex items-center gap-2 mb-1">
              <Brain className="text-[var(--color-brand-500)]" size={20} /> Criar Nova Estratégia
            </h3>
            <p className="text-xs text-muted mb-6">Defina as regras, ativos e limites de risco para execução do bot.</p>

            <form onSubmit={handleCreate} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--color-text)]">Nome da Estratégia</label>
                  <input 
                    type="text" 
                    placeholder="Ex: Alpha_TrendFlow" 
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    className="w-full text-sm bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-brand-500)]"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--color-text)]">Descrição Rápida</label>
                  <input 
                    type="text" 
                    placeholder="Ex: Cruzamento triplo de médias e RSI" 
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    className="w-full text-sm bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-brand-500)]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--color-text)]">Modo de Operação</label>
                  <select 
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                    className="w-full text-sm bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-brand-500)]"
                  >
                    <option value="spot">Binance Spot</option>
                    <option value="futures">Binance Futuros</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--color-text)]">Lógica Central</label>
                  <select 
                    value={strategyType}
                    onChange={(e) => setStrategyType(e.target.value)}
                    className="w-full text-sm bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-brand-500)]"
                  >
                    <option value="warrior">Warrior Trading (Seguidor de Tendência)</option>
                    <option value="range-v2">Range-V2 (Reversão à Média)</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-[var(--color-text)]">Alavancagem {mode === "spot" && "(Apenas Futuros)"}</label>
                  <input 
                    type="number" 
                    min={1}
                    max={20}
                    disabled={mode === "spot"}
                    value={leverage}
                    onChange={(e) => setLeverage(parseInt(e.target.value))}
                    className="w-full text-sm bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-brand-500)] disabled:opacity-50"
                  />
                </div>
              </div>

              {/* Ativos Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--color-text)] block">Ativos Cobertos</label>
                <div className="flex flex-wrap gap-2">
                  {["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "LTCUSDT", "AVAXUSDT"].map((sym) => {
                    const active = symbols.includes(sym);
                    return (
                      <button
                        key={sym}
                        type="button"
                        onClick={() => handleSymbolToggle(sym)}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                          active 
                            ? "bg-[var(--color-brand-500)] text-white border-[var(--color-brand-500)]" 
                            : "bg-[var(--color-surface-3)] text-muted border-[var(--color-border)] hover:border-muted"
                        }`}
                      >
                        {sym}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Timeframes Selector */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-[var(--color-text)] block">Timeframes de Análise</label>
                <div className="flex flex-wrap gap-2">
                  {["1m", "5m", "15m", "1H", "4H", "1D"].map((tf) => {
                    const active = timeframes.includes(tf);
                    return (
                      <button
                        key={tf}
                        type="button"
                        onClick={() => handleTimeframeToggle(tf)}
                        className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
                          active 
                            ? "bg-[var(--color-brand-500)] text-white border-[var(--color-brand-500)]" 
                            : "bg-[var(--color-surface-3)] text-muted border-[var(--color-border)] hover:border-muted"
                        }`}
                      >
                        {tf}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* SL / TP Multipliers */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-[var(--color-border)] pt-4">
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-medium">
                    <span className="text-[var(--color-text)]">Distância do Stop Loss (ATR)</span>
                    <span className="text-[var(--color-brand-500)]">{slMultiplier}x ATR</span>
                  </div>
                  <input 
                    type="range" 
                    min={0.5}
                    max={4.0}
                    step={0.1}
                    value={slMultiplier}
                    onChange={(e) => setSlMultiplier(parseFloat(e.target.value))}
                    className="w-full accent-[var(--color-brand-500)] bg-[var(--color-surface-3)]"
                  />
                  <span className="text-[10px] text-muted">Abaixo ou acima do suporte/resistência recente</span>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-medium">
                    <span className="text-[var(--color-text)]">Distância do Take Profit (ATR)</span>
                    <span className="text-[var(--color-brand-500)]">{tpMultiplier}x ATR</span>
                  </div>
                  <input 
                    type="range" 
                    min={0.5}
                    max={6.0}
                    step={0.1}
                    value={tpMultiplier}
                    onChange={(e) => setTpMultiplier(parseFloat(e.target.value))}
                    className="w-full accent-[var(--color-brand-500)] bg-[var(--color-surface-3)]"
                  />
                  <span className="text-[10px] text-muted">Alvo da operação baseada na volatilidade recente</span>
                </div>
              </div>

              {/* Technical Filters */}
              <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
                <label className="text-xs font-medium text-[var(--color-text)] block">Gatilhos e Filtros Técnicos</label>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="flex items-start gap-3 p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] cursor-pointer hover:border-muted">
                    <input 
                      type="checkbox" 
                      checked={emaTriple}
                      onChange={(e) => setEmaTriple(e.target.checked)}
                      className="mt-0.5 accent-[var(--color-brand-500)]"
                    />
                    <div>
                      <span className="text-xs font-semibold text-[var(--color-text)] block">Filtro de Tendência EMA Tripla</span>
                      <span className="text-[10px] text-muted">Só compra com EMA9 &gt; EMA21 &gt; EMA55 &gt; EMA200</span>
                    </div>
                  </label>

                  {strategyType === "warrior" ? (
                    <>
                      <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                        <span className="text-xs font-semibold text-[var(--color-text)] block">Força de Tendência (ADX mínimo)</span>
                        <div className="flex items-center gap-2">
                          <input 
                            type="range" 
                            min={10}
                            max={35}
                            value={adxMin}
                            onChange={(e) => setAdxMin(parseInt(e.target.value))}
                            className="flex-1 accent-[var(--color-brand-500)]"
                          />
                          <span className="text-xs font-bold text-[var(--color-brand-500)] w-8 text-right">{adxMin}</span>
                        </div>
                      </div>
                      <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                        <span className="text-xs font-semibold text-[var(--color-text)] block">Volume Relativo Mínimo</span>
                        <div className="flex items-center gap-2">
                          <input 
                            type="range" 
                            min={1.0}
                            max={2.5}
                            step={0.1}
                            value={volumeMult}
                            onChange={(e) => setVolumeMult(parseFloat(e.target.value))}
                            className="flex-1 accent-[var(--color-brand-500)]"
                          />
                          <span className="text-xs font-bold text-[var(--color-brand-500)] w-8 text-right">{volumeMult}x</span>
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                      <span className="text-xs font-semibold text-[var(--color-text)] block">Choppiness Index Mínimo (Lateralização)</span>
                      <div className="flex items-center gap-2">
                        <input 
                          type="range" 
                          min={30}
                          max={60}
                          value={choppinessMin}
                          onChange={(e) => setChoppinessMin(parseInt(e.target.value))}
                          className="flex-1 accent-[var(--color-brand-500)]"
                        />
                        <span className="text-xs font-bold text-[var(--color-brand-500)] w-8 text-right">{choppinessMin}</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end gap-3 border-t border-[var(--color-border)] pt-4">
                <Button type="button" variant="ghost" onClick={() => setShowCreateModal(false)}>Cancelar</Button>
                <Button type="submit" variant="primary">Criar Estratégia</Button>
              </div>
            </form>
          </div>
        </div>
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
                  Estatísticas de Backtests Passados: {selectedStrategy.name}
                </h3>
                <p className="text-xs text-muted">Desempenho da estratégia nos dados históricos de mercado.</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-6">
              <Card><Stat label="Total Retorno" value={fmtUSD(selectedStrategy.netProfit)} className={selectedStrategy.netProfit >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"} /></Card>
              <Card><Stat label="Win Rate" value={fmtPct(selectedStrategy.winRate * 100, { sign: false })} /></Card>
              <Card><Stat label="Profit Factor" value={selectedStrategy.profitFactor.toFixed(2)} /></Card>
              <Card><Stat label="Trades Totais" value={selectedStrategy.totalTrades.toString()} /></Card>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mt-6">
              {/* Simulated Equity Curve */}
              <div className="md:col-span-2 space-y-2">
                <span className="text-xs font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                  <TrendingUp size={14} className="text-[var(--color-brand-500)]" /> Curva de Patrimônio Simulada (30 dias)
                </span>
                <div className="h-44 w-full bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] flex items-end p-4 relative overflow-hidden">
                  <svg className="w-full h-full" viewBox="0 0 300 100" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity="0.25"/>
                        <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity="0.0"/>
                      </linearGradient>
                    </defs>
                    {/* Grid Lines */}
                    <line x1="0" y1="25" x2="300" y2="25" stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="3,3" />
                    <line x1="0" y1="50" x2="300" y2="50" stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="3,3" />
                    <line x1="0" y1="75" x2="300" y2="75" stroke="var(--color-border)" strokeWidth="0.5" strokeDasharray="3,3" />
                    
                    {/* Filled Area */}
                    <path 
                      d={`M 0 100 L 0 80 L 30 83 L 60 70 L 90 75 L 120 62 L 150 68 L 180 50 L 210 55 L 240 38 L 270 42 L 300 20 L 300 100 Z`} 
                      fill="url(#chartGrad)" 
                    />
                    {/* Line path */}
                    <path 
                      d={`M 0 80 L 30 83 L 60 70 L 90 75 L 120 62 L 150 68 L 180 50 L 210 55 L 240 38 L 270 42 L 300 20`} 
                      fill="none" 
                      stroke="var(--color-brand-500)" 
                      strokeWidth="2" 
                    />
                  </svg>
                  <span className="absolute top-2 left-3 text-[10px] text-muted">$10,000 inicial</span>
                  <span className="absolute bottom-2 right-3 text-[10px] text-[var(--color-text-up)] font-semibold">
                    +{((selectedStrategy.netProfit / 1000) * 10).toFixed(1)}% retorno
                  </span>
                </div>
              </div>

              {/* Analysis/Parameters Report */}
              <div className="space-y-3">
                <span className="text-xs font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                  <SlidersHorizontal size={14} /> Parâmetros Ativos
                </span>
                <div className="bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] p-3.5 space-y-2.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-muted">SL Técnico:</span>
                    <span className="font-semibold text-[var(--color-text)]">{selectedStrategy.sl?.multiplier || 1.5}x ATR</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">TP Técnico:</span>
                    <span className="font-semibold text-[var(--color-text)]">{selectedStrategy.tp?.multiplier || 2.0}x ATR</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">EMA Filtro:</span>
                    <span className="font-semibold text-[var(--color-text)]">{selectedStrategy.filters?.ema_triple ? "Ativo (Bullish)" : "Nenhum"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">ADX Filtro:</span>
                    <span className="font-semibold text-[var(--color-text)]">
                      {selectedStrategy.filters?.adx_min ? `≥ ${selectedStrategy.filters.adx_min}` : selectedStrategy.filters?.adx_max ? `≤ ${selectedStrategy.filters.adx_max}` : "Desabilitado"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted">Timeframe Principal:</span>
                    <span className="font-semibold text-[var(--color-text)]">{selectedStrategy.timeframes[0]}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Simulated Past Trade Logs */}
            <div className="mt-6 space-y-3">
              <span className="text-xs font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                <Info size={14} /> Histórico Recente de Execuções Simulado
              </span>
              <div className="border border-[var(--color-border)] rounded-[var(--radius-sm)] overflow-hidden">
                <table className="w-full text-xs text-left">
                  <thead className="bg-[var(--color-surface-3)] text-muted font-medium border-b border-[var(--color-border)]">
                    <tr>
                      <th className="p-3">Data</th>
                      <th className="p-3">Ativo</th>
                      <th className="p-3">Lado</th>
                      <th className="p-3">Preço Entrada</th>
                      <th className="p-3 text-right">Resultado (PnL)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)] text-[var(--color-text)]">
                    {[
                      { date: "Ontem, 18:42", symbol: selectedStrategy.symbols[0] || "BTCUSDT", side: "LONG", price: 68450.00, pnl: selectedStrategy.netProfit * 0.15 },
                      { date: "08 Jun, 12:15", symbol: selectedStrategy.symbols[0] || "BTCUSDT", side: "SHORT", price: 69200.00, pnl: selectedStrategy.netProfit * 0.08 },
                      { date: "07 Jun, 09:30", symbol: selectedStrategy.symbols[0] || "BTCUSDT", side: "LONG", price: 67100.00, pnl: -selectedStrategy.netProfit * 0.12 },
                      { date: "05 Jun, 15:20", symbol: selectedStrategy.symbols[0] || "BTCUSDT", side: "LONG", price: 66800.00, pnl: selectedStrategy.netProfit * 0.22 },
                      { date: "03 Jun, 21:05", symbol: selectedStrategy.symbols[0] || "BTCUSDT", side: "SHORT", price: 68150.00, pnl: selectedStrategy.netProfit * 0.05 },
                    ].map((t, idx) => (
                      <tr key={idx} className="hover:bg-[var(--color-surface-3)]/40 transition-colors">
                        <td className="p-3 text-muted">{t.date}</td>
                        <td className="p-3 font-semibold">{t.symbol}</td>
                        <td className="p-3">
                          <Badge tone={t.side === "LONG" ? "up" : "down"} size="sm">{t.side}</Badge>
                        </td>
                        <td className="p-3">{fmtUSD(t.price)}</td>
                        <td className={`p-3 text-right font-bold ${t.pnl >= 0 ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>
                          {t.pnl >= 0 ? "+" : ""}{fmtUSD(t.pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex justify-end gap-3 border-t border-[var(--color-border)] pt-4 mt-6">
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
