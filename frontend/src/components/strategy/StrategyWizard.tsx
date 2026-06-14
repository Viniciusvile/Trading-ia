"use client";

import { useState, useRef } from "react";
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

/**
 * Metadados dos filtros que o motor (applyPlanFilters) reconhece. Usado para
 * renderizar dinamicamente os indicadores de uma estratégia CUSTOM importada —
 * cada filtro presente vira um controle editável, com nome legível em PT-BR.
 */
type FilterKind = "bool" | "number" | "matype";
interface FilterMeta {
  label: string;
  hint?: string;
  kind: FilterKind;
  min?: number;
  max?: number;
  step?: number;
}
const MA_TYPE_OPTIONS = ["ema", "sma", "rma", "hma", "wma"];
const FILTER_META: Record<string, FilterMeta> = {
  ema_triple: { label: "EMA Tripla (tendência)", hint: "EMA9 > EMA21 > EMA55 > EMA200", kind: "bool" },
  macd_positive: { label: "MACD positivo", hint: "Histograma do MACD > 0", kind: "bool" },
  macd_growing: { label: "MACD acelerando", hint: "Histograma do MACD crescente", kind: "bool" },
  di_direction: { label: "DI+ > DI- (direção comprada)", kind: "bool" },
  bb_range: { label: "Bollinger comprimido (range)", kind: "bool" },
  rsi_range_mid: { label: "RSI neutro (range)", kind: "bool" },
  adx_min: { label: "ADX mínimo (força de tendência)", kind: "number", min: 10, max: 40, step: 1 },
  adx_max: { label: "ADX máximo (sem tendência forte)", kind: "number", min: 10, max: 40, step: 1 },
  rsi_min: { label: "RSI mínimo", kind: "number", min: 0, max: 100, step: 1 },
  rsi_max: { label: "RSI máximo (zona de compra)", kind: "number", min: 0, max: 100, step: 1 },
  rsi_period: { label: "RSI período", kind: "number", min: 2, max: 50, step: 1 },
  volume_mult: { label: "Volume relativo mín.", hint: "× média de 20 candles", kind: "number", min: 1, max: 3, step: 0.1 },
  volume_max_mult: { label: "Volume relativo máx.", kind: "number", min: 1, max: 5, step: 0.1 },
  bb_period: { label: "Bollinger período", kind: "number", min: 5, max: 50, step: 1 },
  bb_mult: { label: "Bollinger desvio padrão", kind: "number", min: 1, max: 4, step: 0.1 },
  bb_pct_b_min: { label: "%B mínimo (posição nas bandas)", kind: "number", min: 0, max: 1, step: 0.05 },
  bb_pct_b_max: { label: "%B máximo (perto da banda inferior)", kind: "number", min: 0, max: 1, step: 0.05 },
  supertrend_period: { label: "Supertrend período", kind: "number", min: 5, max: 30, step: 1 },
  supertrend_mult: { label: "Supertrend multiplicador", kind: "number", min: 1, max: 6, step: 0.1 },
  choppiness_min: { label: "Choppiness mínimo (lateral)", kind: "number", min: 30, max: 60, step: 1 },
  // Adaptive Volatility Envelope
  adapt_length: { label: "Adaptação (lookback)", hint: "Bars p/ detectar tendência vs lateral", kind: "number", min: 2, max: 50, step: 1 },
  choppy_speed: { label: "Velocidade em lateral", hint: "Reação da centerline em mercado choppy", kind: "number", min: 0.01, max: 0.5, step: 0.01 },
  trend_speed: { label: "Velocidade em tendência", hint: "Quão colada a centerline segue o preço", kind: "number", min: 0.5, max: 0.99, step: 0.01 },
  vol_length: { label: "Período de volatilidade (ATR)", kind: "number", min: 1, max: 50, step: 1 },
  color_sens: { label: "Sensibilidade do momentum", kind: "number", min: 1, max: 20, step: 0.5 },
  // State-aware MA Cross
  base_period: { label: "Período da média base (estado)", kind: "number", min: 2, max: 200, step: 1 },
};
// Rótulos legíveis dos estados do State-aware MA Cross.
const STATE_LABELS: Record<string, string> = {
  "00": "Baixa + abaixo da base",
  "01": "Baixa + acima da base",
  "10": "Alta + abaixo da base",
  "11": "Alta + acima da base",
};
function stateMaMeta(key: string): FilterMeta | null {
  // ex.: s10_short_type / s01_long_len
  const m = key.match(/^s(00|01|10|11)_(short|long)_(type|len)$/);
  if (!m) return null;
  const [, st, side, attr] = m;
  const sideLabel = side === "short" ? "curta" : "longa";
  const stLabel = STATE_LABELS[st] ?? st;
  if (attr === "type") {
    return { label: `Estado ${st} (${stLabel}) — tipo MA ${sideLabel}`, kind: "matype" };
  }
  return { label: `Estado ${st} (${stLabel}) — período MA ${sideLabel}`, kind: "number", min: 2, max: 200, step: 1 };
}
function metaFor(key: string): FilterMeta {
  return FILTER_META[key] || stateMaMeta(key) || { label: key.replace(/_/g, " "), kind: "number" };
}

/** Estratégia existente para edição (personalização) — pré-preenche o wizard. */
export interface StrategyInitial {
  name: string;
  description?: string;
  symbols?: string[];
  timeframes?: string[];
  strategy?: string;
  mode?: string;
  leverage?: number;
  sl?: { type?: string; multiplier?: number } | null;
  tp?: { type?: string; multiplier?: number } | null;
  filters?: Record<string, number | boolean | string> | null;
  winRateTarget?: number | null;
}

interface Props {
  onClose: () => void;
  onSaved: () => void;
  initial?: StrategyInitial | null;
}

export function StrategyWizard({ onClose, onSaved, initial }: Props) {
  const isEditing = !!initial;
  // Edição pula direto para o passo de personalização
  const [step, setStep] = useState<1 | 2 | 3>(isEditing ? 2 : 1);

  // Estratégia importada do TradingView: lógica "custom" (qualquer coisa que não
  // seja uma das bases nativas). Nesse caso renderizamos os filtros REAIS dela.
  const isCustom = !!initial?.strategy && initial.strategy !== "warrior" && initial.strategy !== "range-v2";
  // Lógica que o motor NÃO executa de fato (cai no fallback warrior ao vivo).
  const SUPPORTED = ["warrior", "range-v2", "volatility-envelope", "state-ma-cross", "micro-dip", "turbo-reversion"];
  const isUnsupported = !!initial?.strategy && !SUPPORTED.includes(initial.strategy);

  // Passo 1
  const [strategyType, setStrategyType] = useState<"warrior" | "range-v2">(
    initial?.strategy === "range-v2" ? "range-v2" : "warrior"
  );

  // Passo 2 — pré-preenchido na edição
  const f = initial?.filters || {};
  const [name, setName] = useState(initial?.name || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [mode, setMode] = useState(initial?.mode || "spot");
  const [leverage, setLeverage] = useState(initial?.leverage || 1);
  const [symbols, setSymbols] = useState<string[]>(initial?.symbols?.length ? initial.symbols : ["BTCUSDT"]);
  const [timeframes, setTimeframes] = useState<string[]>(initial?.timeframes?.length ? initial.timeframes : ["1H"]);
  const [slMultiplier, setSlMultiplier] = useState(initial?.sl?.multiplier ?? 1.5);
  const [tpMultiplier, setTpMultiplier] = useState(initial?.tp?.multiplier ?? 2.0);
  const [winRateTarget, setWinRateTarget] = useState(initial?.winRateTarget ?? 55);
  // filtros warrior
  const [emaTriple, setEmaTriple] = useState(f.ema_triple != null ? !!f.ema_triple : true);
  const [adxMin, setAdxMin] = useState(Number(f.adx_min ?? 20));
  const [volumeMult, setVolumeMult] = useState(Number(f.volume_mult ?? 1.3));
  // filtros range
  const [adxMax, setAdxMax] = useState(Number(f.adx_max ?? 28));
  const [choppinessMin, setChoppinessMin] = useState(Number(f.choppiness_min ?? 45));
  const [rsiLongMax, setRsiLongMax] = useState(Number(f.rsi_long_max ?? 42));
  const [rsiShortMin, setRsiShortMin] = useState(Number(f.rsi_short_min ?? 58));
  // Filtros dinâmicos de uma estratégia CUSTOM importada (preserva os reais).
  const [customFilters, setCustomFilters] = useState<Record<string, number | boolean | string>>(
    isCustom && initial?.filters && typeof initial.filters === "object"
      ? { ...(initial.filters as Record<string, number | boolean | string>) }
      : {}
  );
  // SL/TP de estratégia importada costumam ser percentuais (type: pct/percentage).
  const slIsPct = isCustom && (initial?.sl?.type === "pct" || (initial?.sl as any)?.type === "percentage");
  const tpIsPct = isCustom && (initial?.tp?.type === "pct" || (initial?.tp as any)?.type === "percentage");
  const [slPct, setSlPct] = useState<number>(Number((initial?.sl as any)?.value ?? 1.5));
  const [tpPct, setTpPct] = useState<number>(Number((initial?.tp as any)?.value ?? 3.0));

  const setCustomFilter = (key: string, value: number | boolean | string) =>
    setCustomFilters((prev) => ({ ...prev, [key]: value }));
  const removeCustomFilter = (key: string) =>
    setCustomFilters((prev) => { const next = { ...prev }; delete next[key]; return next; });

  // Passo 3
  const reqIdRef = useRef(0);
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const comboCount = symbols.length * timeframes.length;

  const buildPlan = () => {
    // Estratégia importada: preserva a lógica "custom" e seus filtros reais,
    // em vez de reescrevê-los com os defaults de warrior/range.
    if (isCustom) {
      return {
        name: name.replace(/\s+/g, "_"),
        description,
        symbols,
        timeframes,
        strategy: initial!.strategy!, // mantém "custom" (ou o que veio)
        mode,
        leverage: mode === "futures" ? leverage : 1,
        sl: slIsPct ? { type: "pct", value: slPct } : { type: "atr", multiplier: slMultiplier },
        tp: tpIsPct ? { type: "pct", value: tpPct } : { type: "atr", multiplier: tpMultiplier },
        filters: customFilters,
        winRateTarget,
      };
    }

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
    const myId = ++reqIdRef.current;
    setAnalyzing(true);
    setError(null);
    setResult(null);
    try {
      // name: undefined → análise pré-salvamento não grava lastBacktest no servidor
      const res = await api.botBacktest({ ...buildPlan(), name: undefined });
      if (myId !== reqIdRef.current) return; // resposta de análise antiga: ignora
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

  const handleSave = async (activate: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const plan = { ...buildPlan(), lastBacktest: result };
      const res = await api.botStrategyCreate(plan);
      if (!res.success) {
        setError("Falha ao salvar a estratégia");
        return;
      }
      if (activate) {
        const act = await api.botStrategyActivate(plan.name);
        if (!act.success) {
          setError("Estratégia salva, mas falhou ao ativar no bot. Ative manualmente pela lista.");
          onSaved(); // a lista precisa refletir a estratégia salva
          return;
        }
      }
      onSaved();
      onClose();
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
          <Brain className="text-[var(--color-brand-500)]" size={20} />
          {isEditing ? `Personalizar: ${initial!.name}` : "Nova Estratégia Personalizada"}
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
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Minha_Tendencia_BTC" disabled={isEditing} className={`${inputCls} disabled:opacity-60`} />
                {isEditing && <p className="text-[10px] text-muted">O nome não muda na personalização — as alterações sobrescrevem esta estratégia.</p>}
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
              {isCustom && slIsPct ? (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-medium">
                    <span className="text-[var(--color-text)]">Stop Loss (%)</span>
                    <span className="text-[var(--color-brand-500)]">{slPct}%</span>
                  </div>
                  <input type="range" min={0.2} max={10} step={0.1} value={slPct}
                    onChange={(e) => setSlPct(parseFloat(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs font-medium">
                    <span className="text-[var(--color-text)]">Stop Loss (ATR)</span>
                    <span className="text-[var(--color-brand-500)]">{slMultiplier}x</span>
                  </div>
                  <input type="range" min={0.5} max={4} step={0.1} value={slMultiplier}
                    onChange={(e) => setSlMultiplier(parseFloat(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                </div>
              )}
              {isCustom ? (
                tpIsPct ? (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-medium">
                      <span className="text-[var(--color-text)]">Take Profit (%)</span>
                      <span className="text-[var(--color-brand-500)]">{tpPct}%</span>
                    </div>
                    <input type="range" min={0.4} max={20} step={0.1} value={tpPct}
                      onChange={(e) => setTpPct(parseFloat(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs font-medium">
                      <span className="text-[var(--color-text)]">Take Profit (ATR)</span>
                      <span className="text-[var(--color-brand-500)]">{tpMultiplier}x</span>
                    </div>
                    <input type="range" min={0.5} max={6} step={0.1} value={tpMultiplier}
                      onChange={(e) => setTpMultiplier(parseFloat(e.target.value))} className="w-full accent-[var(--color-brand-500)]" />
                  </div>
                )
              ) : strategyType === "warrior" ? (
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
              <label className="text-xs font-medium text-[var(--color-text)] block">
                {isCustom ? "Indicadores detectados" : "Filtros da estratégia"}
              </label>
              {isUnsupported && (
                <div className="flex gap-2.5 p-3 -mt-2 rounded-[var(--radius-sm)] border border-[var(--color-down-600)]/40 bg-[var(--color-down-600)]/10">
                  <span className="text-[11px] leading-relaxed text-[var(--color-text-2)]">
                    <span className="font-semibold text-[var(--color-text)]">⚠ Lógica não suportada pelo robô.</span>{" "}
                    Se você ativar esta estratégia, o bot operará com a regra padrão (Warrior — seguidor de
                    tendência), e não com o indicador importado. O backtest também usa a regra padrão.
                  </span>
                </div>
              )}
              {isCustom && !isUnsupported && (
                <p className="text-[10px] text-muted -mt-2">
                  Indicadores extraídos do Pine Script importado. Ajuste os valores como quiser — o bot usa exatamente estes filtros.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {isCustom ? (
                  Object.keys(customFilters).length === 0 ? (
                    <p className="text-xs text-muted col-span-full">
                      Nenhum indicador mapeável foi detectado neste script. Você pode adicionar filtros manualmente reimportando ou usando uma estratégia base.
                    </p>
                  ) : (
                    Object.entries(customFilters).map(([key, val]) => {
                      const meta = metaFor(key);
                      if (meta.kind === "bool") {
                        return (
                          <label key={key} className="flex items-start gap-3 p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] cursor-pointer">
                            <input
                              type="checkbox"
                              checked={!!val}
                              onChange={(e) => setCustomFilter(key, e.target.checked)}
                              className="mt-0.5 accent-[var(--color-brand-500)]"
                            />
                            <div>
                              <span className="text-xs font-semibold text-[var(--color-text)] block">{meta.label}</span>
                              {meta.hint && <span className="text-[10px] text-muted">{meta.hint}</span>}
                            </div>
                          </label>
                        );
                      }
                      if (meta.kind === "matype") {
                        return (
                          <div key={key} className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                            <span className="text-xs font-semibold text-[var(--color-text)] block">{meta.label}</span>
                            <select
                              value={String(val)}
                              onChange={(e) => setCustomFilter(key, e.target.value)}
                              className="w-full h-8 text-xs rounded-[var(--radius-xs)] bg-[var(--color-surface)] border border-[var(--color-border-strong)] px-2 text-[var(--color-text)] outline-none focus:border-[var(--color-brand-500)]"
                            >
                              {MA_TYPE_OPTIONS.map((opt) => (
                                <option key={opt} value={opt}>{opt.toUpperCase()}</option>
                              ))}
                            </select>
                          </div>
                        );
                      }
                      const num = Number(val);
                      const min = meta.min ?? 0;
                      const max = meta.max ?? Math.max(100, num * 2);
                      const step = meta.step ?? 1;
                      return (
                        <div key={key} className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] space-y-2">
                          <div className="flex justify-between text-xs">
                            <span className="font-semibold text-[var(--color-text)]">{meta.label}</span>
                            <span className="font-bold text-[var(--color-brand-500)]">{Number.isInteger(num) ? num : num.toFixed(2)}</span>
                          </div>
                          <input
                            type="range"
                            min={min}
                            max={max}
                            step={step}
                            value={num}
                            onChange={(e) => setCustomFilter(key, parseFloat(e.target.value))}
                            className="w-full accent-[var(--color-brand-500)]"
                          />
                          {meta.hint && <p className="text-[10px] text-muted">{meta.hint}</p>}
                        </div>
                      );
                    })
                  )
                ) : strategyType === "warrior" ? (
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
              <Button variant="ghost" onClick={() => setStep(1)}><ChevronLeft size={14} /> {isEditing ? "Trocar estratégia base" : "Voltar"}</Button>
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
