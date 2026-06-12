"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Camera, RefreshCw, HelpCircle, CheckCircle, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { Card, Button, Input, Modal } from "@/components/ui";
import { AnimatedNumber, PillTabs, MetricStrip, SymbolIcon } from "@/components/fx";
import { fmtUSD, fmtPct, fmtCompact } from "@/lib/format";
import { TradingViewWidget } from "@/components/TradingViewWidget";
import { api } from "@/lib/api";

// Lista de ativos acompanhados. Preço/variação/volume são preenchidos em
// tempo real pela Binance no fetchQuotesAndBalance — sem valores fixos para
// não exibir cotações desatualizadas antes do primeiro fetch.
const FAVORITES_INIT = [
  { symbol: "BTCUSDT", name: "Bitcoin", price: 0, changePct: 0, volume: 0, high: 0, low: 0 },
  { symbol: "ETHUSDT", name: "Ethereum", price: 0, changePct: 0, volume: 0, high: 0, low: 0 },
  { symbol: "SOLUSDT", name: "Solana", price: 0, changePct: 0, volume: 0, high: 0, low: 0 },
  { symbol: "XRPUSDT", name: "XRP", price: 0, changePct: 0, volume: 0, high: 0, low: 0 },
];

function MercadoInner() {
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState(FAVORITES_INIT[0].symbol);
  const [favorites, setFavorites] = useState(FAVORITES_INIT);
  const [loadingQuotes, setLoadingQuotes] = useState(false);

  // Command palette / links externos: /mercado?symbol=SOLUSDT
  useEffect(() => {
    const s = searchParams.get("symbol");
    if (s && FAVORITES_INIT.some((f) => f.symbol === s)) setSelected(s);
  }, [searchParams]);

  // Trade Modal State
  const [tradeModalOpen, setTradeModalOpen] = useState(false);
  const [tradeSide, setTradeSide] = useState<"LONG" | "SHORT">("LONG");
  const [tradeMode, setTradeMode] = useState<"spot" | "futures">("spot");
  const [tradeAmount, setTradeAmount] = useState<string>("10");
  const [balance, setBalance] = useState<{ spot: number; futures: number }>({ spot: 0, futures: 0 });
  
  // Execution State
  const [executing, setExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<{
    success: boolean;
    error?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  } | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  // Fetch real-time quotes and balance
  async function fetchQuotesAndBalance() {
    setLoadingQuotes(true);
    try {
      // Fetch balance
      const balRes = await api.botBalance();
      if (balRes && balRes.success) {
        setBalance({
          spot: balRes.spot ?? 0,
          futures: balRes.futures ?? 0,
        });
      }

      // Fetch quotes in parallel
      const updated = await Promise.all(
        favorites.map(async (f) => {
          try {
            const q = await api.quote(f.symbol);
            if (q && q.last) {
              return {
                ...f,
                price: q.last,
                changePct: q.changePct ?? f.changePct,
                volume: q.volume ?? f.volume,
                high: q.high ?? f.high,
                low: q.low ?? f.low,
              };
            }
          } catch (e) {
            console.error(`Erro ao carregar quote para ${f.symbol}:`, e);
          }
          return f;
        })
      );
      setFavorites(updated);
    } catch (err) {
      console.error("Erro geral na busca de quotes:", err);
    } finally {
      setLoadingQuotes(false);
    }
  }

  useEffect(() => {
    fetchQuotesAndBalance();
    const interval = setInterval(fetchQuotesAndBalance, 10000);
    return () => clearInterval(interval);
  }, []);

  const current = favorites.find((f) => f.symbol === selected) ?? favorites[0];

  const handleOpenTrade = (side: "LONG" | "SHORT") => {
    setTradeSide(side);
    setExecutionResult(null);
    setShowLogs(false);
    // Auto default trade mode depending on spot/futures typical sides (SHORT is always futures)
    if (side === "SHORT") {
      setTradeMode("futures");
    } else {
      setTradeMode("spot");
    }
    setTradeModalOpen(true);
  };

  const handleExecuteTrade = async () => {
    const amountNum = parseFloat(tradeAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      alert("Por favor, insira um valor válido de trade.");
      return;
    }

    setExecuting(true);
    setExecutionResult(null);
    try {
      const res = await api.botForceTrade({
        symbol: current.symbol,
        timeframe: "1h",
        side: tradeSide,
        amount: amountNum,
        mode: tradeMode,
      });

      setExecutionResult({
        success: res.success,
        error: res.error,
        stdout: res.stdout,
        stderr: res.stderr,
        exitCode: res.exitCode,
      });

      // Refetch balance to see impact
      setTimeout(fetchQuotesAndBalance, 2000);
    } catch (err: any) {
      setExecutionResult({
        success: false,
        error: err.message || "Erro na execução do bot.",
      });
    } finally {
      setExecuting(false);
    }
  };

  const availableBalance = tradeMode === "spot" ? balance.spot : balance.futures;

  return (
    <div className="space-y-5">
      {/* Header de detalhe do ativo — estilo Fey (TSLA) */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <SymbolIcon symbol={current.symbol} size={40} />
            <div>
              <div className="text-sm font-semibold text-[var(--color-text)]">{current.symbol.replace("USDT", "")}</div>
              <div className="text-[11px] text-muted">{current.name} · USDT · Binance</div>
            </div>
          </div>
          <div className="mt-3 flex items-end gap-3 flex-wrap">
            <AnimatedNumber
              value={current.price}
              format={fmtUSD}
              className="text-4xl sm:text-5xl font-bold tabular-nums tracking-tight text-[var(--color-text)]"
            />
            <span className={`text-sm font-semibold mb-1.5 ${current.changePct >= 0 ? "text-up" : "text-down"}`}>
              {current.changePct >= 0 ? "+" : ""}{fmtPct(current.changePct)} · 24h
            </span>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="ghost"
            size="md"
            leftIcon={<Camera size={15} />}
            onClick={() => alert("Captura de gráfico salva na pasta de screenshots.")}
          >
            Capturar
          </Button>
          <Button
            variant="outline"
            size="md"
            leftIcon={<RefreshCw size={15} className={loadingQuotes ? "animate-spin" : ""} />}
            onClick={fetchQuotesAndBalance}
          >
            {loadingQuotes ? "Carregando..." : "Atualizar"}
          </Button>
          <Button variant="success" size="md" onClick={() => handleOpenTrade("LONG")}>
            Comprar
          </Button>
          <Button variant="danger" size="md" onClick={() => handleOpenTrade("SHORT")}>
            Vender
          </Button>
        </div>
      </div>

      {/* Troca de ativo por pills (substitui a lista lateral) */}
      <PillTabs
        options={favorites.map((f) => ({ value: f.symbol, label: f.symbol.replace("USDT", "") }))}
        value={selected}
        onChange={setSelected}
        size="md"
      />

      {/* Gráfico */}
      <Card padding="sm">
        <TradingViewWidget symbol={current.symbol} />
      </Card>

      {/* Faixa de métricas estilo Fey */}
      <MetricStrip
        items={[
          { label: "Volume 24h", value: fmtCompact(current.volume) },
          { label: "Máxima 24h", value: fmtUSD(current.high || current.price) },
          { label: "Mínima 24h", value: fmtUSD(current.low || current.price) },
          { label: "Variação 24h", value: `${current.changePct >= 0 ? "+" : ""}${fmtPct(current.changePct)}`, tone: current.changePct >= 0 ? "up" : "down" },
          { label: "Saldo Spot", value: fmtUSD(balance.spot) },
          { label: "Saldo Futuros", value: fmtUSD(balance.futures) },
        ]}
      />

      {/* Indicadores-chave (estilo Key Indicators do Fey) */}
      <Card padding="lg">
        <div className="text-xs font-semibold text-[var(--color-text)] mb-3">Indicadores-chave</div>
        <ul className="space-y-2.5 text-sm text-[var(--color-text-2)]">
          <li className="flex items-center gap-2.5">
            <span className={`h-1.5 w-1.5 rounded-full ${current.changePct >= 0 ? "bg-[var(--color-up-500)]" : "bg-[var(--color-down-500)]"}`} />
            <span>
              {current.changePct >= 0 ? "Em alta" : "Em queda"} de <strong className="text-[var(--color-text)]">{fmtPct(Math.abs(current.changePct))}</strong> nas últimas 24h
            </span>
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-brand-400)]" />
            <span>
              Amplitude do dia de <strong className="text-[var(--color-text)]">{current.low > 0 ? fmtPct(((current.high - current.low) / current.low) * 100) : "—"}</strong> (mínima → máxima)
            </span>
          </li>
          <li className="flex items-center gap-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-warn-500)]" />
            <span>
              Preço a <strong className="text-[var(--color-text)]">{current.high > 0 ? fmtPct(((current.high - current.price) / current.high) * 100) : "—"}</strong> da máxima de 24h
            </span>
          </li>
        </ul>
      </Card>

      {/* Trade execution modal */}
      <Modal
        open={tradeModalOpen}
        onClose={() => !executing && setTradeModalOpen(false)}
        title={
          <div className="flex items-center gap-2 text-lg font-bold">
            <span className={tradeSide === "LONG" ? "text-up" : "text-down"}>
              {tradeSide === "LONG" ? "Comprar (LONG)" : "Vender (SHORT)"}
            </span>
            <span>· {current.symbol}</span>
          </div>
        }
        description={`Envie uma ordem forçada diretamente para a API do bot na Binance.`}
        size="md"
      >
        <div className="space-y-4">
          {/* Form parameters */}
          {!executionResult && (
            <>
              {/* Trade Mode Selector */}
              <div>
                <label className="text-xs font-semibold text-muted block mb-1.5">
                  Modo de Execução
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={tradeSide === "SHORT"} // Short requires margin/futures usually
                    onClick={() => setTradeMode("spot")}
                    className={
                      "py-2 px-3 rounded-[var(--radius-sm)] text-xs font-medium border text-center transition " +
                      (tradeSide === "SHORT"
                        ? "opacity-50 cursor-not-allowed border-[var(--color-border)] text-muted"
                        : tradeMode === "spot"
                          ? "border-[var(--color-brand-500)] bg-brand-soft text-[var(--color-brand-600)]"
                          : "border-[var(--color-border)] hover:bg-[var(--color-surface-3)] text-[var(--color-text-2)]")
                    }
                  >
                    Binance SPOT
                  </button>
                  <button
                    type="button"
                    onClick={() => setTradeMode("futures")}
                    className={
                      "py-2 px-3 rounded-[var(--radius-sm)] text-xs font-medium border text-center transition " +
                      (tradeMode === "futures"
                        ? "border-[var(--color-brand-500)] bg-brand-soft text-[var(--color-brand-600)]"
                        : "border-[var(--color-border)] hover:bg-[var(--color-surface-3)] text-[var(--color-text-2)]")
                    }
                  >
                    Binance FUTURES
                  </button>
                </div>
              </div>

              {/* Balance display info */}
              <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] flex items-center justify-between text-xs">
                <span className="text-muted">Saldo disponível ({tradeMode.toUpperCase()}):</span>
                <span className="font-semibold text-[var(--color-text)]">
                  {fmtUSD(availableBalance)}
                </span>
              </div>

              {/* Amount Input */}
              <div>
                <label htmlFor="trade-amount-input" className="text-xs font-semibold text-muted block mb-1.5">
                  Valor da Operação (USDT)
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Input
                      id="trade-amount-input"
                      type="number"
                      placeholder="Valor em USDT"
                      value={tradeAmount}
                      onChange={(e) => setTradeAmount(e.target.value)}
                      min={5}
                      disabled={executing}
                    />
                    <span className="absolute right-3 top-2.5 text-xs text-muted font-medium">USDT</span>
                  </div>
                </div>
                {/* Quick amount buttons */}
                <div className="grid grid-cols-5 gap-1.5 mt-2">
                  {["10", "25", "50", "100", "250"].map((v) => (
                    <button
                      key={v}
                      type="button"
                      disabled={executing}
                      onClick={() => setTradeAmount(v)}
                      className={
                        "py-1 px-1.5 rounded-[var(--radius-xs)] text-[10px] font-medium border text-center transition " +
                        (tradeAmount === v
                          ? "border-[var(--color-brand-500)] bg-[var(--color-brand-500)] text-white"
                          : "border-[var(--color-border)] hover:bg-[var(--color-surface-3)] text-muted hover:text-[var(--color-text)]")
                      }
                    >
                      ${v}
                    </button>
                  ))}
                </div>
              </div>

              {/* Safety notice */}
              <div className="p-3 bg-[var(--color-warn-500)]/8 text-[var(--color-warn-600)] rounded-[var(--radius-sm)] border border-[var(--color-warn-500)]/25 flex gap-2.5 items-start">
                <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                <p className="text-[11px] leading-relaxed">
                  <strong>Atenção:</strong> Esta é uma ordem forçada que ignora os filtros de tendência e regras de tempo ativo. Ela será enviada diretamente à corretora.
                </p>
              </div>
            </>
          )}

          {/* Executing loader state */}
          {executing && (
            <div className="py-8 flex flex-col items-center justify-center gap-3">
              <div className="h-10 w-10 border-4 border-[var(--color-brand-500)] border-t-transparent rounded-full animate-spin" />
              <div className="text-center">
                <h4 className="text-sm font-semibold text-[var(--color-text)]">Enviando Ordem ao Bot...</h4>
                <p className="text-xs text-muted mt-1">Isso pode levar de 5 a 15 segundos para sincronizar com a Binance.</p>
              </div>
            </div>
          )}

          {/* Results display */}
          {executionResult && (
            <div className="space-y-4">
              {executionResult.success ? (
                <div className="p-4 bg-up/8 text-up rounded-[var(--radius-sm)] border border-up/20 flex gap-3 items-start">
                  <CheckCircle size={20} className="shrink-0 mt-0.5 text-up-600" />
                  <div>
                    <h4 className="text-sm font-bold text-up-700">Ordem Executada com Sucesso!</h4>
                    <p className="text-xs mt-1 text-up-600">A ordem foi registrada e executada na Binance.</p>
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-down/8 text-down rounded-[var(--radius-sm)] border border-down/20 flex gap-3 items-start">
                  <AlertTriangle size={20} className="shrink-0 mt-0.5 text-down-600" />
                  <div>
                    <h4 className="text-sm font-bold text-down-700">Falha ao Executar Ordem</h4>
                    <p className="text-xs mt-1 text-down-600">{executionResult.error || "O bot retornou um erro ao processar a ordem."}</p>
                  </div>
                </div>
              )}

              {/* Bot process execution stdout logs */}
              {(executionResult.stdout || executionResult.stderr) && (
                <div className="border border-[var(--color-border)] rounded-[var(--radius-sm)] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowLogs(!showLogs)}
                    className="w-full flex items-center justify-between px-3 py-2 bg-[var(--color-surface-3)] text-xs font-semibold text-[var(--color-text-2)] hover:bg-[var(--color-surface-3)]/80 transition"
                  >
                    <span>Logs de Execução do Bot</span>
                    {showLogs ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {showLogs && (
                    <pre className="p-3 bg-[var(--color-surface)] text-[10px] text-muted overflow-auto max-h-48 font-mono leading-relaxed border-t border-[var(--color-border)] whitespace-pre-wrap">
                      {executionResult.stdout}
                      {executionResult.stderr && (
                        <span className="text-[var(--color-down-500)] font-semibold">
                          {"\n[ERRO STDOUT]\n" + executionResult.stderr}
                        </span>
                      )}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="mt-5 pt-3 border-t border-[var(--color-border)] flex justify-end gap-2">
          {!executionResult ? (
            <>
              <Button
                variant="outline"
                size="md"
                disabled={executing}
                onClick={() => setTradeModalOpen(false)}
              >
                Cancelar
              </Button>
              <Button
                variant={tradeSide === "LONG" ? "success" : "danger"}
                size="md"
                disabled={executing}
                onClick={handleExecuteTrade}
              >
                Confirmar Ordem
              </Button>
            </>
          ) : (
            <Button
              variant="primary"
              size="md"
              onClick={() => setTradeModalOpen(false)}
            >
              Fechar
            </Button>
          )}
        </div>
      </Modal>
    </div>
  );
}

// useSearchParams exige Suspense no App Router
export default function MercadoPage() {
  return (
    <Suspense fallback={null}>
      <MercadoInner />
    </Suspense>
  );
}
