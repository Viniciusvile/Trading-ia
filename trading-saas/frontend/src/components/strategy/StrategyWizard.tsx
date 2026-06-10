"use client";

import { useState } from "react";
import { Brain, X, TrendingUp, Repeat, ChevronLeft, ChevronRight, FlaskConical, Target } from "lucide-react";
import { Button } from "@/components/ui";
import { api, type BacktestResult } from "@/lib/api";
import { BacktestReport } from "./BacktestReport";

const BASES = [
  {
    key: "warrior",
    title: "Warrior — Seguidor de Tendência",
    icon: TrendingUp,
    desc: "Compra força: entra quando preço está acima do VWAP com EMAs alinhadas e momentum (RSI > 45). Ideal para mercados em alta direcional.",
    perfil: "Mais trades em tendência, sofre em mercado lateral.",
  },
  {
    key: "range-v2",
    title: "Range v2 — Reversão à Média",
    icon: Repeat,
    desc: "Opera os extremos: compra no suporte e vende na resistência quando RSI e Estocástico confirmam exaustão. Ideal para mercados laterais.",
    perfil: "Long e short (short apenas em Futuros), alvos curtos na borda oposta do range.",
  },
] as const;

const SYMBOL_OPTIONS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "LTCUSDT", "AVAXUSDT"];
const TF_OPTIONS = ["15m", "1H", "4H", "1D"];

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export function StrategyWizard({ onClose, onSaved }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);

  // Passo 1
  const [strategyType, setStrategyType] = useState<"warrior" | "range-v2">("warrior");

  // Passo 2
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState("spot");
  const [leverage, setLeverage] = useState(1);
  const [symbols, setSymbols] = useState<string[]>(["BTCUSDT"]);
  const [timeframes, setTimeframes] = useState<string[]>(["1H"]);
  const [slMultiplier, setSlMultiplier] = useState(1.5);
  const [tpMultiplier, setTpMultiplier] = useState(2.0);
  const [winRateTarget, setWinRateTarget] = useState(55);
  // filtros warrior
  const [emaTriple, setEmaTriple] = useState(true);
  const [adxMin, setAdxMin] = useState(20);
  const [volumeMult, setVolumeMult] = useState(1.3);
  // filtros range
  const [adxMax, setAdxMax] = useState(28);
  const [choppinessMin, setChoppinessMin] = useState(45);
  const [rsiLongMax, setRsiLongMax] = useState(42);
  const [rsiShortMin, setRsiShortMin] = useState(58);

  // Passo 3
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const comboCount = symbols.length * timeframes.length;

  const buildPlan = () => {
    const filters: Record<string, number | boolean> = {};
    if (strategyType === "warrior") {
      if (emaTriple) filters.ema_triple = true;
      filters.adx_min = adxMin;
      filters.volume_mult = volumeMult;
    } else {
      filters.adx_max = adxMax;
      filters.choppiness_min = choppinessMin;
      filters.rsi_long_max = rsiLongMax;
      filters.rsi_short_min = rsiShortMin;
    }
    return {
      name: name.replace(/\s+/g, "_"),
      description,
      symbols,
      timeframes,
      strategy: strategyType,
      mode,
      leverage: mode === "futures" ? leverage : 1,
      sl: { type: "atr", multiplier: slMultiplier },
      tp: strategyType === "range-v2" ? { type: "boundary", multiplier: 1.0 } : { type: "atr", multiplier: tpMultiplier },
      filters,
      winRateTarget,
    };
  };

  const runAnalysis = async () => {
    setAnalyzing(true);
    setError(null);
    setResult(null);
    try {
      // name: undefined → análise pré-salvamento não grava lastBacktest no servidor
      const res = await api.botBacktest({ ...buildPlan(), name: undefined });
      if (res.success && res.equityCurve) {
        setResult(res as BacktestResult);
      } else {
        setError(res.error || "Falha ao executar a análise");
      }
    } catch {
      setError("Falha de conexão com o servidor de análise");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSave = async (activate: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const plan = { ...buildPlan(), lastBacktest: result };
      const res = await api.botStrategyCreate(plan);
      if (res.success) {
        if (activate) await api.botStrategyActivate(plan.name);
        onSaved();
        onClose();
      } else {
        setError("Falha ao salvar a estratégia");
      }
    } finally {
      setSaving(false);
    }
  };

  const toggle = (list: string[], setList: (v: string[]) => void, item: string) => {
    if (list.includes(item)) {
      if (list.length > 1) setList(list.filter((x) => x !== item));
    } else {
      setList([...list, item]);
    }
  };

  const inputCls = "w-full text-sm bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] px-3 py-2 text-[var(--color-text)] focus:outline-none focus:border-[var(--color-brand-500)]";
  const chipCls = (active: boolean) =>
    `text-xs px-3 py-1.5 rounded-full border transition-all ${active
      ? "bg-[var(--color-brand-500)] text-white border-[var(--color-brand-500)]"
      : "bg-[var(--color-surface-3)] text-muted border-[var(--color-border)] hover:border-muted"}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-3xl bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-md)] shadow-2xl p-6 my-8 max-h-[92vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 p-1 rounded-full text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]">
          <X size={18} />
        </button>

        {/* Header + progresso */}
        <h3 className="text-base font-semibold text-[var(--color-text)] flex items-center gap-2 mb-1">
          <Brain className="text-[var(--color-brand-500)]" size={20} /> Nova Estratégia Personalizada
        </h3>
        <div className="flex items-center gap-2 text-[11px] text-muted mb-6 flex-wrap">
          {["Estratégia base", "Personalizar", "Análise de mercado"].map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <span className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                step > i ? "bg-[var(--color-brand-500)] text-white" : "bg-[var(--color-surface-3)] text-muted border border-[var(--color-border)]"
              }`}>{i + 1}</span>
              <span className={step === i + 1 ? "text-[var(--color-text)] font-semibold" : ""}>{label}</span>
              {i < 2 && <ChevronRight size={12} className="text-muted/40" />}
            </div>
          ))}
        </div>

        {/* PASSO 1 — escolher base */}
        {step === 1 && (
          <div className="space-y-4">
            <p className="text-xs text-muted">Escolha o comportamento central. Você ajusta todas as variáveis no próximo passo.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {BASES.map((b) => {
                const Icon = b.icon;
                const active = strategyType === b.key;
                return (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setStrategyType(b.key)}
                    className={`text-left p-4 rounded-[var(--radius-md)] border-2 transition-all space-y-2 ${
                      active ? "border-[var(--color-brand-500)] bg-brand-soft" : "border-[var(--color-border)] hover:border-muted"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Icon size={18} className={active ? "text-[var(--color-brand-500)]" : "text-muted"} />
                      <span className="text-sm font-semibold text-[var(--color-text)]">{b.title}</span>
                    </div>
                    <p className="text-xs text-muted">{b.desc}</p>
                    <p className="text-[10px] text-muted/80 italic">{b.perfil}</p>
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end pt-2">
              <Button variant="primary" onClick={() => setStep(2)}>Personalizar <ChevronRight size={14} /></Button>
            </div>
          </div>
        )}

        {/* PASSO 2 — personalizar variáveis */}
        {step === 2 && (
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-[var(--color-text)]">Nome da Estratégia</label>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Minha_Tendencia_BTC" className={inputCls} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-[var(--color-text)]">Descrição</label>
                <input type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Opcional" className={inputCls} />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-xs font-medium text-[var(--color-text)]">Modo de Operação</label>
                <select value={mode} onChange={(e) => setMode(e.target.value)} className={inputCls}>
                  <option value="spot">Binance Spot</option>
                  <option value="futures">Binance Futuros</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-[var(--color-text)]">Alavancagem {mode === "spot" && "(apenas Futuros)"}</label>
                <input type="number" min={1} max={20} disabled={mode === "spot"} value={leverage}
                  onChange={(e) => setLeverage(parseInt(e.target.value) || 1)} className={`${inputCls} disabled:opacity-50`} />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--color-text)] block">Ativos</label>
              <div className="flex flex-wrap gap-2">
                {SYMBOL_OPTIONS.map((s) => (
                  <button key={s} type="button" onClick={() => toggle(symbols, setSymbols, s)} className={chipCls(symbols.includes(s))}>{s}</button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-[var(--color-text)] block">Timeframes</label>
              <div className="flex flex-wrap gap-2">
                {TF_OPTIONS.map((tf) => (
                  <button key={tf} type="button" onClick={() => toggle(timeframes, setTimeframes, tf)} className={chipCls(timeframes.includes(tf))}>{tf}</button>
                ))}
              </div>
              {comboCount > 6 && (
                <p className="text-[10px] text-[var(--color-text-down)]">
                  Máximo de 6 combinações ativo×timeframe por análise (atual: {comboCount}). Reduza ativos ou timeframes.
                </p>
              )}
            </div>

            {/* Meta de win rate */}
            <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
              <div className="flex justify-between text-xs font-medium">
                <span className="text-[var(--color-text)] flex items-center gap-1.5"><Target size={13} /> Meta de Win Rate</span>
                <span className="text-[var(--color-brand-500)] font-bold">{winRateTarget}%</span>
              </div>
              <input type="range" min={40} max={80} step={1} value={winRateTarget}
                onChange={(e) => setWinRateTarget(parseInt(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
              <p className="text-[10px] text-muted">
                A análise de mercado vai medir o win rate real desta configuração e comparar com a sua meta.
              </p>
            </div>

            {/* SL/TP */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-[var(--color-border)] pt-4">
              <div className="space-y-1">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-[var(--color-text)]">Stop Loss (ATR)</span>
                  <span className="text-[var(--color-brand-500)]">{slMultiplier}x</span>
                </div>
                <input type="range" min={0.5} max={4} step={0.1} value={slMultiplier}
                  onChange={(e) => setSlMultiplier(parseFloat(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
              </div>
              {strategyType === "warrior" ? (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-medium">
                    <span className="text-[var(--color-text)]">Take Profit (ATR)</span>
                    <span className="text-[var(--color-brand-500)]">{tpMultiplier}x</span>
                  </div>
                  <input type="range" min={0.5} max={6} step={0.1} value={tpMultiplier}
                    onChange={(e) => setTpMultiplier(parseFloat(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                </div>
              ) : (
                <div className="space-y-1 text-xs text-muted flex flex-col justify-center">
                  <span className="font-medium text-[var(--color-text)]">Take Profit: borda oposta do range</span>
                  <span className="text-[10px]">No Range v2 o alvo é a resistência/suporte oposto, calculado a cada sinal.</span>
                </div>
              )}
            </div>

            {/* Filtros específicos */}
            <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
              <label className="text-xs font-medium text-[var(--color-text)] block">Filtros da estratégia</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {strategyType === "warrior" ? (
                  <>
                    <label className="flex items-start gap-3 p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] cursor-pointer">
                      <input type="checkbox" checked={emaTriple} onChange={(e) => setEmaTriple(e.target.checked)} className="mt-0.5 accent-[var(--color-brand-500)]" />
                      <div>
                        <span className="text-xs font-semibold text-[var(--color-text)] block">EMA Tripla (tendência)</span>
                        <span className="text-[10px] text-muted">EMA9 &gt; EMA21 &gt; EMA55 &gt; EMA200</span>
                      </div>
                    </label>
                    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                      <div className="flex justify-between text-xs"><span className="font-semibold text-[var(--color-text)]">ADX mínimo</span><span className="font-bold text-[var(--color-brand-500)]">{adxMin}</span></div>
                      <input type="range" min={10} max={35} value={adxMin} onChange={(e) => setAdxMin(parseInt(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                    </div>
                    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                      <div className="flex justify-between text-xs"><span className="font-semibold text-[var(--color-text)]">Volume relativo mín.</span><span className="font-bold text-[var(--color-brand-500)]">{volumeMult}x</span></div>
                      <input type="range" min={1} max={2.5} step={0.1} value={volumeMult} onChange={(e) => setVolumeMult(parseFloat(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                    </div>
                  </>
                ) : (
                  <>
                    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                      <div className="flex justify-between text-xs"><span className="font-semibold text-[var(--color-text)]">ADX máximo (sem tendência)</span><span className="font-bold text-[var(--color-brand-500)]">{adxMax}</span></div>
                      <input type="range" min={15} max={40} value={adxMax} onChange={(e) => setAdxMax(parseInt(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                    </div>
                    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                      <div className="flex justify-between text-xs"><span className="font-semibold text-[var(--color-text)]">Choppiness mínimo</span><span className="font-bold text-[var(--color-brand-500)]">{choppinessMin}</span></div>
                      <input type="range" min={30} max={60} value={choppinessMin} onChange={(e) => setChoppinessMin(parseInt(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                    </div>
                    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                      <div className="flex justify-between text-xs"><span className="font-semibold text-[var(--color-text)]">RSI máx. p/ compra</span><span className="font-bold text-[var(--color-brand-500)]">{rsiLongMax}</span></div>
                      <input type="range" min={30} max={50} value={rsiLongMax} onChange={(e) => setRsiLongMax(parseInt(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                    </div>
                    <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                      <div className="flex justify-between text-xs"><span className="font-semibold text-[var(--color-text)]">RSI mín. p/ venda</span><span className="font-bold text-[var(--color-brand-500)]">{rsiShortMin}</span></div>
                      <input type="range" min={50} max={70} value={rsiShortMin} onChange={(e) => setRsiShortMin(parseInt(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                    </div>
                  </>
                )}
              </div>
            </div>

            <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
              <Button variant="ghost" onClick={() => setStep(1)}><ChevronLeft size={14} /> Voltar</Button>
              <Button variant="primary" disabled={!name || comboCount > 6} onClick={() => { setStep(3); runAnalysis(); }}>
                <FlaskConical size={14} /> Analisar no Mercado
              </Button>
            </div>
          </div>
        )}

        {/* PASSO 3 — análise real */}
        {step === 3 && (
          <div className="space-y-5">
            {analyzing && (
              <div className="flex flex-col items-center justify-center py-16 space-y-4">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-[var(--color-brand-500)]"></div>
                <p className="text-sm font-semibold text-[var(--color-text)]">Analisando sua configuração no mercado...</p>
                <p className="text-xs text-muted text-center max-w-sm">
                  Buscando candles históricos reais da Binance para {symbols.join(", ")} ({timeframes.join(", ")})
                  e simulando cada entrada com as suas regras.
                </p>
              </div>
            )}

            {error && !analyzing && (
              <div className="text-center py-10 space-y-3">
                <p className="text-sm text-[var(--color-text-down)]">{error}</p>
                <Button variant="outline" size="sm" onClick={runAnalysis}>Tentar novamente</Button>
              </div>
            )}

            {result && !analyzing && <BacktestReport data={result} />}

            {!analyzing && (
              <div className="flex flex-col sm:flex-row justify-between gap-3 border-t border-[var(--color-border)] pt-4">
                <Button variant="ghost" onClick={() => setStep(2)}><ChevronLeft size={14} /> Ajustar variáveis</Button>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" disabled={saving} onClick={() => handleSave(false)}>Salvar estratégia</Button>
                  <Button variant="success" disabled={saving || !result?.combined} onClick={() => handleSave(true)}>
                    {saving ? "Salvando..." : "Salvar e Ativar no Bot"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
