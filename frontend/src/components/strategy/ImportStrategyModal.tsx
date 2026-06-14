"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, KeyRound, FileCode2, ArrowLeft, Check, AlertTriangle, Lightbulb, Clock, Coins } from "lucide-react";
import { Modal, Button, Input } from "@/components/ui";
import { api, type ImportedStrategy } from "@/lib/api";

/** Lógicas que o motor do bot realmente executa. Qualquer outra (ex: "custom")
 * cai no fallback "warrior" ao vivo — ou seja, NÃO opera o indicador importado. */
const SUPPORTED_STRATEGIES = new Set([
  "warrior",
  "range-v2",
  "volatility-envelope",
  "state-ma-cross",
  "micro-dip",
  "turbo-reversion",
]);

interface ImportStrategyModalProps {
  onClose: () => void;
  onSaved: () => void;
  /** Código pré-preenchido vindo de um link de compartilhamento (?importar=SH-...). */
  initialCode?: string;
}

type Tab = "p2p" | "tradingview";

/** Renderiza os parâmetros mapeados (filters) em pequenos cards legíveis. */
function FilterChips({ filters }: { filters: Record<string, any> }) {
  const entries = Object.entries(filters || {});
  if (entries.length === 0) {
    return <p className="text-xs text-muted">Nenhum parâmetro de indicador detectado.</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([key, val]) => (
        <div
          key={key}
          className="px-2.5 py-1.5 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]"
        >
          <span className="text-[10px] uppercase font-bold text-[var(--color-brand-500)]">{key}</span>
          <span className="block text-[11px] text-[var(--color-text-2)] font-mono">
            {typeof val === "object" && val !== null
              ? Object.entries(val)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")
              : String(val)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function ImportStrategyModal({ onClose, onSaved, initialCode }: ImportStrategyModalProps) {
  const [tab, setTab] = useState<Tab>(initialCode ? "p2p" : "p2p");

  // Aba P2P
  const [code, setCode] = useState(initialCode || "");

  // Aba TradingView
  const [url, setUrl] = useState("");
  const [pineScript, setPineScript] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Quando o scrape da URL falha, destacamos o campo de colar código.
  const [highlightPaste, setHighlightPaste] = useState(false);

  // Resultado mapeado → tela de revisão
  const [preview, setPreview] = useState<ImportedStrategy | null>(null);
  const [saving, setSaving] = useState(false);
  const pasteRef = useRef<HTMLTextAreaElement>(null);

  // Se veio com código no link, busca automaticamente ao abrir.
  useEffect(() => {
    if (initialCode) void fetchByCode(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchByCode(c: string) {
    const clean = c.trim().toUpperCase();
    if (!clean) {
      setError("Informe o código de compartilhamento.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.botStrategySharedGet(clean);
      if (res.success && res.strategy) {
        setPreview({
          name: res.strategy.name,
          description: res.strategy.description || "",
          strategy: res.strategy.strategy || "custom",
          symbols: res.strategy.symbols || ["BTCUSDT"],
          timeframes: res.strategy.timeframes || ["1H"],
          mode: res.strategy.mode || "spot",
          leverage: res.strategy.leverage,
          filters: res.strategy.filters || {},
          sl: res.strategy.sl,
          tp: res.strategy.tp,
          winRateTarget: res.strategy.winRateTarget ?? null,
        });
      } else {
        setError(res.error || "Código inválido ou estratégia não encontrada.");
      }
    } catch {
      setError("Falha ao buscar a estratégia.");
    } finally {
      setLoading(false);
    }
  }

  async function analyzeWithAI() {
    if (!url.trim() && !pineScript.trim()) {
      setError("Cole a URL do TradingView ou o código Pine Script.");
      return;
    }
    setLoading(true);
    setError(null);
    setHighlightPaste(false);
    try {
      const res = await api.botStrategyImportTradingView({
        url: url.trim() || undefined,
        rawPineScript: pineScript.trim() || undefined,
      });
      if (res.success && res.strategy) {
        setPreview(res.strategy);
      } else {
        setError(res.error || "Não foi possível analisar o script.");
        // Falha ao ler pela URL (bloqueio/script protegido): direciona o
        // usuário ao campo de colar o código, que sempre funciona.
        if (!pineScript.trim() && url.trim()) {
          setHighlightPaste(true);
          requestAnimationFrame(() => pasteRef.current?.focus());
        }
      }
    } catch {
      setError("Falha ao analisar o script.");
    } finally {
      setLoading(false);
    }
  }

  async function saveImported() {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.botStrategyCreate({
        name: preview.name,
        description: preview.description,
        symbols: preview.symbols,
        timeframes: preview.timeframes,
        strategy: preview.strategy,
        mode: preview.mode,
        leverage: preview.leverage,
        sl: preview.sl,
        tp: preview.tp,
        filters: preview.filters,
        winRateTarget: preview.winRateTarget,
      });
      if (res.success) {
        onSaved();
        onClose();
      } else {
        setError("Não foi possível salvar a estratégia.");
      }
    } catch {
      setError("Falha ao salvar a estratégia.");
    } finally {
      setSaving(false);
    }
  }

  // ─── Tela de revisão dos parâmetros extraídos ───
  if (preview) {
    return (
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={
          <span className="flex items-center gap-2">
            <Sparkles size={18} className="text-[var(--color-brand-500)]" />
            Revisar Estratégia Importada
          </span>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreview(null)} leftIcon={<ArrowLeft size={14} />}>
              Voltar
            </Button>
            <Button variant="success" loading={saving} onClick={saveImported} leftIcon={<Check size={14} />}>
              Salvar e Criar
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <p className="text-xs text-muted">
            Confira os parâmetros detectados. Você pode ajustar o nome e a descrição antes de salvar.
          </p>

          <Input
            label="Nome da estratégia"
            value={preview.name}
            onChange={(e) => setPreview({ ...preview, name: e.target.value })}
          />

          <div>
            <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1.5">Descrição</label>
            <textarea
              className="w-full min-h-[64px] rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/15"
              value={preview.description}
              onChange={(e) => setPreview({ ...preview, description: e.target.value })}
            />
          </div>

          {!SUPPORTED_STRATEGIES.has(preview.strategy) && (
            <div className="flex gap-2.5 p-3 rounded-[var(--radius-sm)] border border-[var(--color-warn-600,#b45309)]/40 bg-[var(--color-warn-600,#b45309)]/10">
              <AlertTriangle size={16} className="text-[var(--color-text-down)] shrink-0 mt-0.5" />
              <p className="text-[11px] leading-relaxed text-[var(--color-text-2)]">
                <span className="font-semibold text-[var(--color-text)]">Lógica não suportada pelo robô.</span>{" "}
                Este script usa uma estratégia que o motor ainda não sabe executar. Você pode salvá-la
                como referência, mas se ativá-la o bot operará com a <span className="font-semibold">regra
                padrão (Warrior — seguidor de tendência)</span>, e não com o indicador importado. O
                backtest também refletirá a regra padrão, não o script.
              </p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
              <span className="text-muted">Lógica base</span>
              <span className="block font-semibold text-[var(--color-text)]">{preview.strategy}</span>
            </div>
            <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
              <span className="text-muted">Modo</span>
              <span className="block font-semibold text-[var(--color-text)]">{preview.mode}</span>
            </div>
          </div>

          {/* Recomendação da IA: timeframe + ativos sugeridos para esta estratégia */}
          {(preview.recommendedTimeframes?.length || preview.recommendedSymbols?.length || preview.recommendationReason) && (
            <div className="p-3.5 rounded-[var(--radius-sm)] border border-[var(--color-brand-500)]/30 bg-[var(--color-brand-500)]/8 space-y-2.5">
              <span className="flex items-center gap-2 text-xs font-semibold text-[var(--color-text)]">
                <Lightbulb size={15} className="text-[var(--color-brand-500)]" />
                Recomendação da IA
              </span>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <span className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted">
                    <Clock size={11} /> Timeframe
                  </span>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {preview.recommendedTimeframes?.length ? (
                      preview.recommendedTimeframes.map((tf) => (
                        <span key={tf} className="px-2 py-0.5 rounded-[var(--radius-xs)] bg-[var(--color-brand-500)]/15 text-[11px] font-semibold text-[var(--color-brand-500)]">
                          {tf}
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-muted">—</span>
                    )}
                  </div>
                </div>
                <div>
                  <span className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-muted">
                    <Coins size={11} /> Ativos
                  </span>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {preview.recommendedSymbols?.length ? (
                      preview.recommendedSymbols.map((s) => (
                        <span key={s} className="px-2 py-0.5 rounded-[var(--radius-xs)] bg-[var(--color-brand-500)]/15 text-[11px] font-semibold text-[var(--color-brand-500)]">
                          {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-[11px] text-muted">—</span>
                    )}
                  </div>
                </div>
              </div>
              {preview.recommendationReason && (
                <p className="text-[11px] leading-relaxed text-[var(--color-text-2)]">
                  {preview.recommendationReason}
                </p>
              )}
              <p className="text-[10px] text-muted">
                Já preenchemos os campos de ativo e timeframe com a sugestão — você pode ajustar antes de salvar.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs font-semibold text-[var(--color-text)]">Parâmetros mapeados</span>
            <FilterChips filters={preview.filters} />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-[var(--radius-sm)] border border-[var(--color-down-600)]/30 bg-[var(--color-down-600)]/5">
              <span className="text-[10px] uppercase font-bold text-[var(--color-text-down)]">Stop Loss</span>
              <span className="block text-sm font-mono text-[var(--color-text)]">
                {preview.sl?.value != null
                  ? `${preview.sl.value}${preview.sl.type === "percentage" ? "%" : ""}`
                  : preview.sl?.multiplier != null
                  ? `${preview.sl.multiplier}× ATR`
                  : "—"}
              </span>
            </div>
            <div className="p-3 rounded-[var(--radius-sm)] border border-[var(--color-up-600)]/30 bg-[var(--color-up-600)]/5">
              <span className="text-[10px] uppercase font-bold text-[var(--color-text-up)]">Take Profit</span>
              <span className="block text-sm font-mono text-[var(--color-text)]">
                {preview.tp?.value != null
                  ? `${preview.tp.value}${preview.tp.type === "percentage" ? "%" : ""}`
                  : preview.tp?.multiplier != null
                  ? `${preview.tp.multiplier}× ATR`
                  : "—"}
              </span>
            </div>
          </div>

          {error && <p className="text-xs text-[var(--color-text-down)]">{error}</p>}
        </div>
      </Modal>
    );
  }

  // ─── Telas de entrada (abas) ───
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={18} className="text-[var(--color-brand-500)]" />
          Importar Estratégia
        </span>
      }
      footer={<Button variant="ghost" onClick={onClose}>Cancelar</Button>}
    >
      <div className="space-y-4">
        {/* Abas */}
        <div className="flex gap-1 p-1 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
          <button
            type="button"
            onClick={() => { setTab("p2p"); setError(null); }}
            className={`flex-1 flex items-center justify-center gap-1.5 h-8 text-xs font-medium rounded-[var(--radius-xs)] transition ${
              tab === "p2p"
                ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
                : "text-muted hover:text-[var(--color-text)]"
            }`}
          >
            <KeyRound size={13} /> Código P2P
          </button>
          <button
            type="button"
            onClick={() => { setTab("tradingview"); setError(null); }}
            className={`flex-1 flex items-center justify-center gap-1.5 h-8 text-xs font-medium rounded-[var(--radius-xs)] transition ${
              tab === "tradingview"
                ? "bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm"
                : "text-muted hover:text-[var(--color-text)]"
            }`}
          >
            <FileCode2 size={13} /> TradingView / Pine
          </button>
        </div>

        {tab === "p2p" ? (
          <div className="space-y-3">
            <Input
              label="Código de compartilhamento"
              placeholder="Cole o código (ex: SH-9A2F8B)"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <Button fullWidth loading={loading} onClick={() => fetchByCode(code)}>
              Buscar e Importar
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <Input
              label="URL do TradingView ou script público"
              placeholder="https://www.tradingview.com/script/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1.5">
                Ou cole o código Pine Script diretamente
                <span className="text-muted font-normal"> (mais confiável)</span>
              </label>
              <textarea
                ref={pasteRef}
                className={`w-full min-h-[120px] rounded-[var(--radius-sm)] border bg-[var(--color-surface)] px-3 py-2 text-xs font-mono text-[var(--color-text)] outline-none transition-colors focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/15 ${
                  highlightPaste
                    ? "border-[var(--color-brand-500)] ring-2 ring-[var(--color-brand-500)]/20"
                    : "border-[var(--color-border-strong)]"
                }`}
                placeholder="//@version=5&#10;indicator(...)"
                value={pineScript}
                onChange={(e) => { setPineScript(e.target.value); if (highlightPaste) setHighlightPaste(false); }}
              />
              <p className="text-[10px] text-muted mt-1">
                Muitos scripts são protegidos e o TradingView bloqueia leitura automática. Abra o
                script no TradingView, copie o código-fonte (Pine Editor) e cole aqui — a IA analisa
                do mesmo jeito.
              </p>
            </div>
            <Button fullWidth loading={loading} onClick={analyzeWithAI} leftIcon={<Sparkles size={14} />}>
              {pineScript.trim() ? "Analisar código com IA" : "Analisar com IA"}
            </Button>
          </div>
        )}

        {error && (
          <div className={`text-xs rounded-[var(--radius-sm)] p-2.5 ${
            highlightPaste
              ? "bg-[var(--color-brand-500)]/10 text-[var(--color-text-2)] border border-[var(--color-brand-500)]/30"
              : "text-[var(--color-text-down)]"
          }`}>
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
