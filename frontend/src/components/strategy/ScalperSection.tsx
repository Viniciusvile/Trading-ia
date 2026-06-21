"use client";

import { useEffect, useRef, useState } from "react";
import { Zap, X, ChevronLeft, FlaskConical, Target, Settings2, Sparkles } from "lucide-react";
import { Card, Badge, Button } from "@/components/ui";
import { api, type BacktestResult, type ScalperPlan } from "@/lib/api";
import { BacktestReport } from "./BacktestReport";
import { toast } from "sonner";

const MODE_INFO: Record<string, { title: string; desc: string }> = {
  "micro-dip": {
    title: "Micro Dip",
    desc: "Compra micro-quedas dentro de tendência de alta (preço acima da EMA, RSI em zona válida).",
  },
  "turbo-reversion": {
    title: "Turbo Reversão",
    desc: "Compra exaustão: preço abaixo da banda inferior de Bollinger com RSI baixo e pico de volume.",
  },
};

const SYMBOL_OPTIONS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"];

type ScalperConfig = {
  active_symbols: string[];
  max_trade_usdt?: number;
  daily_profit_target_usdt?: number;
  plans: Record<string, ScalperPlan>;
};

function Slider({ label, value, display, min, max, step, onChange }: {
  label: string; value: number; display: string;
  min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
      <div className="flex justify-between text-xs">
        <span className="font-semibold text-[var(--color-text)]">{label}</span>
        <span className="font-bold text-[var(--color-brand-500)]">{display}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-[var(--color-brand-500)]"
      />
    </div>
  );
}

export function ScalperSection() {
  const [config, setConfig] = useState<ScalperConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingSymbol, setEditingSymbol] = useState<string | null>(null);
  const [savingSymbol, setSavingSymbol] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await api.microScalperConfig();
      if (res.success && res.config) {
        setConfig({ active_symbols: res.config.active_symbols || [], plans: res.config.plans || {}, ...res.config });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfig(); }, []);

  const handleToggleActive = async (symbol: string) => {
    if (!config) return;
    const isActive = config.active_symbols.includes(symbol);
    setSavingSymbol(symbol);
    try {
      const res = await api.microScalperStrategySave({ symbol, active: !isActive });
      if (res.success) {
        setNotice(res.restarted ? "Scalper reiniciado com a nova configuração." : null);
        fetchConfig();
      }
    } finally {
      setSavingSymbol(null);
    }
  };

  const symbols = config
    ? Array.from(new Set([...Object.keys(config.plans), ...config.active_symbols]))
    : [];

  return (
    <div className="space-y-4 pt-8">
      <div className="border-t border-[var(--color-border)] pt-6">
        <div className="flex items-center gap-2">
          <Zap size={18} className="text-[var(--color-brand-500)]" />
          <h2 className="text-base font-semibold text-[var(--color-text)]">Micro Scalper</h2>
        </div>
        <p className="text-xs text-muted mt-1">
          Robô de trades rápidos: analisa o mercado continuamente em candles de 5 minutos com alvos curtos.
          Cada ativo tem sua própria estratégia — personalize as variáveis e analise no mercado antes de aplicar.
        </p>
      </div>

      {notice && (
        <p className="text-[11px] text-[var(--color-text-up)] bg-[var(--color-text-up)]/5 border border-[var(--color-text-up)]/30 rounded-[var(--radius-sm)] p-2.5">
          {notice}
        </p>
      )}

      {loading ? (
        <div className="flex items-center gap-3 py-6 text-xs text-muted">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--color-brand-500)]"></div>
          Carregando configuração do scalper...
        </div>
      ) : !config ? (
        <p className="text-xs text-muted py-4">Não foi possível carregar a configuração do scalper.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {symbols.map((symbol) => {
            const plan = config.plans[symbol] || { strategy_mode: "micro-dip" as const };
            const isActive = config.active_symbols.includes(symbol);
            const mode = MODE_INFO[plan.strategy_mode] || MODE_INFO["micro-dip"];
            return (
              <Card key={symbol} padding="lg" className={`space-y-3 border ${isActive ? "border-[var(--color-brand-500)]" : "border-[var(--color-border)]"}`}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-semibold text-[var(--color-text)]">{symbol}</span>
                    <Badge tone={isActive ? "up" : "neutral"} dot={isActive} size="sm">
                      {isActive ? "Operando" : "Pausado"}
                    </Badge>
                  </div>
                  <Badge tone="neutral" size="sm">{mode.title}</Badge>
                </div>

                <p className="text-[11px] text-muted">{mode.desc}</p>

                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
                  <span><strong className="text-[var(--color-text-2)]">TP:</strong> +{((plan.tp_pct ?? 0.01) * 100).toFixed(2)}%</span>
                  <span><strong className="text-[var(--color-text-2)]">SL:</strong> -{((plan.sl_pct ?? 0.005) * 100).toFixed(2)}%</span>
                  {plan.strategy_mode === "turbo-reversion" ? (
                    <span><strong className="text-[var(--color-text-2)]">RSI &lt;</strong> {plan.rsi_limit ?? 35}</span>
                  ) : (
                    <span><strong className="text-[var(--color-text-2)]">EMA:</strong> {plan.ema_period ?? 20}</span>
                  )}
                  {plan.breakeven_pct ? <span><strong className="text-[var(--color-text-2)]">BE:</strong> +{(plan.breakeven_pct * 100).toFixed(2)}%</span> : null}
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant={isActive ? "danger" : "success"}
                    size="sm"
                    disabled={savingSymbol === symbol}
                    onClick={() => handleToggleActive(symbol)}
                  >
                    {savingSymbol === symbol ? "..." : isActive ? "Pausar ativo" : "Ativar ativo"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setEditingSymbol(symbol)}>
                    <Settings2 size={13} /> Personalizar
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editingSymbol && config && (
        <ScalperEditor
          symbol={editingSymbol}
          initialPlan={config.plans[editingSymbol] || { strategy_mode: "micro-dip" }}
          onClose={() => setEditingSymbol(null)}
          onSaved={(restarted) => {
            setNotice(restarted ? "Estratégia salva — scalper reiniciado e já operando com as novas regras." : "Estratégia salva.");
            setEditingSymbol(null);
            fetchConfig();
          }}
        />
      )}
    </div>
  );
}

function ScalperEditor({ symbol, initialPlan, onClose, onSaved }: {
  symbol: string;
  initialPlan: ScalperPlan;
  onClose: () => void;
  onSaved: (restarted: boolean) => void;
}) {
  const [mode, setMode] = useState<"micro-dip" | "turbo-reversion">(initialPlan.strategy_mode || "micro-dip");
  // percentuais em % na UI (0.01 → 1.0)
  const [tpPct, setTpPct] = useState(((initialPlan.tp_pct ?? 0.01) * 100));
  const [slPct, setSlPct] = useState(((initialPlan.sl_pct ?? 0.005) * 100));
  const [breakevenPct, setBreakevenPct] = useState(((initialPlan.breakeven_pct ?? 0) * 100));
  // micro-dip
  const [emaPeriod, setEmaPeriod] = useState(initialPlan.ema_period ?? 20);
  const [rsiPeriod, setRsiPeriod] = useState(initialPlan.rsi_period ?? 3);
  const [minDipPct, setMinDipPct] = useState(((initialPlan.min_dip_pct ?? 0.001) * 100));
  const [minRsi, setMinRsi] = useState(initialPlan.min_rsi ?? 20);
  const [maxRsi, setMaxRsi] = useState(initialPlan.max_rsi ?? 65);
  // turbo-reversion
  const [bbLength, setBbLength] = useState(initialPlan.bb_length ?? 20);
  const [bbMult, setBbMult] = useState(initialPlan.bb_mult ?? 2.0);
  const [rsiLimit, setRsiLimit] = useState(initialPlan.rsi_limit ?? 30);
  const [volMult, setVolMult] = useState(initialPlan.vol_mult ?? 1.5);
  // análise
  const [winRateTarget, setWinRateTarget] = useState(55);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const reqIdRef = useRef(0);

  const buildPlanFields = (): Partial<ScalperPlan> => {
    const base: Partial<ScalperPlan> = {
      strategy_mode: mode,
      tp_pct: parseFloat((tpPct / 100).toFixed(5)),
      sl_pct: parseFloat((slPct / 100).toFixed(5)),
    };
    if (breakevenPct > 0) base.breakeven_pct = parseFloat((breakevenPct / 100).toFixed(5));
    else base.breakeven_pct = 0;
    if (mode === "micro-dip") {
      base.ema_period = emaPeriod;
      base.rsi_period = rsiPeriod;
      base.min_dip_pct = parseFloat((minDipPct / 100).toFixed(5));
      base.min_rsi = minRsi;
      base.max_rsi = maxRsi;
    } else {
      base.bb_length = bbLength;
      base.bb_mult = bbMult;
      base.rsi_period = rsiPeriod;
      base.rsi_limit = rsiLimit;
      base.vol_mult = volMult;
    }
    return base;
  };

  const runAnalysis = async () => {
    const myId = ++reqIdRef.current;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.botBacktest({
        strategy: mode,
        scalper: buildPlanFields(),
        symbols: [symbol],
        timeframes: ["5m"],
        winRateTarget,
      });
      if (myId !== reqIdRef.current) return;
      if (res.success && res.equityCurve) {
        setResult(res as BacktestResult);
      } else {
        setError(res.error || "Falha ao executar a análise");
      }
    } catch {
      if (myId !== reqIdRef.current) return;
      setError("Falha de conexão com o servidor de análise");
    } finally {
      if (myId === reqIdRef.current) setAnalyzing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.microScalperStrategySave({ symbol, plan: buildPlanFields() });
      if (res.success) {
        onSaved(!!res.restarted);
      } else {
        setError(res.error || "Falha ao salvar a estratégia");
      }
    } finally {
      setSaving(false);
    }
  };

  const [optimizing, setOptimizing] = useState(false);

  const applyPlanToStates = (p: any) => {
    if (!p) return;
    if (p.strategy_mode) setMode(p.strategy_mode);
    if (p.tp_pct !== undefined) setTpPct(p.tp_pct * 100);
    if (p.sl_pct !== undefined) setSlPct(p.sl_pct * 100);
    if (p.breakeven_pct !== undefined) setBreakevenPct(p.breakeven_pct * 100);
    if (p.ema_period !== undefined) setEmaPeriod(p.ema_period);
    if (p.rsi_period !== undefined) setRsiPeriod(p.rsi_period);
    if (p.min_dip_pct !== undefined) setMinDipPct(p.min_dip_pct * 100);
    if (p.min_rsi !== undefined) setMinRsi(p.min_rsi);
    if (p.max_rsi !== undefined) setMaxRsi(p.max_rsi);
    if (p.bb_length !== undefined) setBbLength(p.bb_length);
    if (p.bb_mult !== undefined) setBbMult(p.bb_mult);
    if (p.rsi_limit !== undefined) setRsiLimit(p.rsi_limit);
    if (p.vol_mult !== undefined) setVolMult(p.vol_mult);
  };

  const handleOptimizeAI = async () => {
    setOptimizing(true);
    setError(null);
    try {
      const res = await api.microScalperOptimize({ symbol });
      if (res.success && res.plan) {
        applyPlanToStates(res.plan);
        toast.success("Estratégia otimizada com sucesso pelo Gemini!");
        // Roda a análise após preencher os dados
        setTimeout(() => {
          runAnalysis();
        }, 100);
      } else {
        setError(res.error || "Falha ao otimizar com IA. Verifique os limites do plano.");
      }
    } catch (err: any) {
      setError("Erro ao solicitar otimização por IA.");
    } finally {
      setOptimizing(false);
    }
  };

  const selectCls = "w-full text-sm bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-brand-500)]";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-2xl bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-md)] shadow-2xl p-6 my-8 max-h-[92vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 p-1 rounded-full text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]">
          <X size={18} />
        </button>

        <h3 className="text-base font-semibold text-[var(--color-text)] flex items-center gap-2 mb-1">
          <Zap className="text-[var(--color-brand-500)]" size={20} /> Scalper — {symbol}
        </h3>
        <p className="text-xs text-muted mb-5">
          Personalize a estratégia deste ativo. Salvar reinicia o scalper automaticamente com as novas regras.
        </p>

        {!result && !analyzing && (
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--color-text)]">Modo da Estratégia</label>
              <select value={mode} onChange={(e) => setMode(e.target.value as "micro-dip" | "turbo-reversion")} className={selectCls}>
                <option value="micro-dip">Micro Dip — compra quedas curtas em tendência de alta</option>
                <option value="turbo-reversion">Turbo Reversão — compra exaustão na banda de Bollinger</option>
              </select>
              <p className="text-[10px] text-muted">{MODE_INFO[mode].desc}</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Slider label="Take Profit" value={tpPct} display={`+${tpPct.toFixed(2)}%`} min={0.2} max={3} step={0.05} onChange={setTpPct} />
              <Slider label="Stop Loss" value={slPct} display={`-${slPct.toFixed(2)}%`} min={0.2} max={2} step={0.05} onChange={setSlPct} />
              <Slider label="Breakeven (0 = desligado)" value={breakevenPct} display={breakevenPct > 0 ? `+${breakevenPct.toFixed(2)}%` : "desligado"} min={0} max={1.5} step={0.05} onChange={setBreakevenPct} />
              <Slider label="RSI período" value={rsiPeriod} display={`${rsiPeriod}`} min={2} max={14} step={1} onChange={(v) => setRsiPeriod(Math.round(v))} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-[var(--color-border)] pt-4">
              {mode === "micro-dip" ? (
                <>
                  <Slider label="EMA período" value={emaPeriod} display={`${emaPeriod}`} min={5} max={50} step={1} onChange={(v) => setEmaPeriod(Math.round(v))} />
                  <Slider label="Queda mínima (dip)" value={minDipPct} display={`${minDipPct.toFixed(2)}%`} min={0.02} max={1} step={0.02} onChange={setMinDipPct} />
                  <Slider label="RSI mínimo" value={minRsi} display={`${minRsi}`} min={5} max={45} step={1} onChange={(v) => setMinRsi(Math.round(v))} />
                  <Slider label="RSI máximo" value={maxRsi} display={`${maxRsi}`} min={50} max={90} step={1} onChange={(v) => setMaxRsi(Math.round(v))} />
                </>
              ) : (
                <>
                  <Slider label="Bollinger período" value={bbLength} display={`${bbLength}`} min={10} max={40} step={1} onChange={(v) => setBbLength(Math.round(v))} />
                  <Slider label="Bollinger desvios" value={bbMult} display={`${bbMult.toFixed(1)}x`} min={1} max={3} step={0.1} onChange={setBbMult} />
                  <Slider label="RSI limite (sobrevenda)" value={rsiLimit} display={`< ${rsiLimit}`} min={10} max={50} step={1} onChange={(v) => setRsiLimit(Math.round(v))} />
                  <Slider label="Pico de volume mínimo" value={volMult} display={`${volMult.toFixed(1)}x`} min={1} max={3} step={0.1} onChange={setVolMult} />
                </>
              )}
            </div>

            <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
              <div className="flex justify-between text-xs font-medium">
                <span className="text-[var(--color-text)] flex items-center gap-1.5"><Target size={13} /> Meta de Win Rate (para a análise)</span>
                <span className="text-[var(--color-brand-500)] font-bold">{winRateTarget}%</span>
              </div>
              <input type="range" min={40} max={85} step={1} value={winRateTarget}
                onChange={(e) => setWinRateTarget(parseInt(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
            </div>

            <div className="flex flex-col sm:flex-row justify-between gap-3 border-t border-[var(--color-border)] pt-4">
              <Button variant="ghost" onClick={onClose}>Cancelar</Button>
              <div className="flex gap-2 justify-end">
                <Button 
                  variant="outline"
                  className="border-violet-500/50 hover:bg-violet-500/10 text-violet-400 font-medium"
                  disabled={optimizing} 
                  onClick={handleOptimizeAI}
                >
                  <Sparkles size={14} className="mr-1 text-violet-400" /> 
                  {optimizing ? "Otimizando..." : "Otimizar com IA"}
                </Button>
                <Button variant="outline" onClick={runAnalysis}>
                  <FlaskConical size={14} /> Analisar no Mercado (5m)
                </Button>
                <Button variant="primary" disabled={saving} onClick={handleSave}>
                  {saving ? "Salvando..." : "Salvar Estratégia"}
                </Button>
              </div>
            </div>
            {error && <p className="text-xs text-[var(--color-text-down)] text-center">{error}</p>}
          </div>
        )}

        {analyzing && (
          <div className="flex flex-col items-center justify-center py-16 space-y-4">
            <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[var(--color-brand-500)]"></div>
            <p className="text-sm font-semibold text-[var(--color-text)]">Analisando {symbol} no 5m...</p>
            <p className="text-xs text-muted text-center max-w-sm">
              Simulando a estratégia {MODE_INFO[mode].title} com candles reais da Binance (últimos ~5 dias de 5m).
            </p>
          </div>
        )}

        {result && !analyzing && (
          <div className="space-y-5">
            <BacktestReport data={result} />
            {error && <p className="text-xs text-[var(--color-text-down)] text-center">{error}</p>}
            <div className="flex flex-col sm:flex-row justify-between gap-3 border-t border-[var(--color-border)] pt-4">
              <Button variant="ghost" onClick={() => setResult(null)}><ChevronLeft size={14} /> Ajustar variáveis</Button>
              <div className="flex gap-2 justify-end">
                <Button 
                  variant="outline"
                  className="border-violet-500/50 hover:bg-violet-500/10 text-violet-400 font-medium"
                  disabled={optimizing} 
                  onClick={handleOptimizeAI}
                >
                  <Sparkles size={14} className="mr-1 text-violet-400" /> 
                  {optimizing ? "Melhorando..." : "Melhorar com IA"}
                </Button>
                <Button variant="success" disabled={saving} onClick={handleSave}>
                  {saving ? "Salvando..." : "Salvar e Aplicar no Scalper"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
