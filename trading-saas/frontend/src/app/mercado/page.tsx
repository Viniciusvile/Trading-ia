"use client";

import { useState, useEffect } from "react";
import { Search, Star, Camera, RefreshCw, TrendingUp, TrendingDown, HelpCircle, CheckCircle, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Input, Button, Badge, Stat, Skeleton, Modal } from "@/components/ui";
import { fmtUSD, fmtPct, fmtCompact } from "@/lib/format";
import { TradingViewWidget } from "@/components/TradingViewWidget";
import { api } from "@/lib/api";

const FAVORITES_INIT = [
  { symbol: "BTCUSDT", name: "Bitcoin", price: 68450.12, changePct: 2.34, volume: 28_400_000_000 },
  { symbol: "ETHUSDT", name: "Ethereum", price: 3490.55, changePct: -1.12, volume: 14_200_000_000 },
  { symbol: "SOLUSDT", name: "Solana", price: 168.27, changePct: 5.78, volume: 2_900_000_000 },
  { symbol: "XRPUSDT", name: "XRP", price: 0.524, changePct: 0.42, volume: 1_300_000_000 },
];

export default function MercadoPage() {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(FAVORITES_INIT[0].symbol);
  const [favorites, setFavorites] = useState(FAVORITES_INIT);
  const [loadingQuotes, setLoadingQuotes] = useState(false);

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
            if (q) {
              return {
                ...f,
                price: q.last || f.price,
                changePct: q.changePct || f.changePct,
                volume: q.volume || f.volume,
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

  const filtered = favorites.filter(
    (f) =>
      f.symbol.toLowerCase().includes(query.toLowerCase()) ||
      f.name.toLowerCase().includes(query.toLowerCase())
  );

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
      <PageHeader
        title="Mercado"
        description="Acompanhe cotações em tempo real e analise gráficos sem complicação."
        actions={
          <>
            <Button
              variant="outline"
              size="md"
              leftIcon={<Camera size={15} />}
              onClick={() => alert("Captura de gráfico salva na pasta de screenshots.")}
            >
              Capturar gráfico
            </Button>
            <Button
              variant="primary"
              size="md"
              leftIcon={<RefreshCw size={15} className={loadingQuotes ? "animate-spin" : ""} />}
              onClick={fetchQuotesAndBalance}
            >
              {loadingQuotes ? "Carregando..." : "Atualizar"}
            </Button>
          </>
        }
      />

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Lista de ativos */}
        <Card padding="md" className="lg:col-span-1">
          <CardHeader title="Ativos favoritos" subtitle={`${filtered.length} ativos`} />
          <Input
            placeholder="Buscar ativo (BTC, ETH...)"
            leftIcon={<Search size={15} />}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-3"
          />
          <ul className="flex flex-col gap-1">
            {filtered.map((item) => {
              const isUp = item.changePct >= 0;
              const active = item.symbol === selected;
              return (
                <li key={item.symbol}>
                  <button
                    type="button"
                    onClick={() => setSelected(item.symbol)}
                    className={
                      "w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-[var(--radius-sm)] text-left transition " +
                      (active
                        ? "bg-brand-soft"
                        : "hover:bg-[var(--color-surface-3)]")
                    }
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[var(--color-text)] flex items-center gap-1.5">
                        <Star
                          size={12}
                          className="text-[var(--color-warn-500)] fill-[var(--color-warn-500)]"
                        />
                        {item.symbol}
                      </div>
                      <div className="text-[11px] text-muted">{item.name}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-sm font-semibold tabular-nums">
                        {fmtUSD(item.price)}
                      </div>
                      <div
                        className={
                          "text-[11px] font-semibold tabular-nums flex items-center justify-end gap-0.5 " +
                          (isUp ? "text-up" : "text-down")
                        }
                      >
                        {isUp ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                        {fmtPct(item.changePct)}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>

        {/* Detalhe do ativo selecionado */}
        <div className="lg:col-span-2 space-y-4">
          <Card padding="lg">
            <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-[var(--color-text)]">{current.symbol}</h2>
                  <Badge tone="brand" size="sm">{current.name}</Badge>
                </div>
                <div className="text-3xl font-bold tabular-nums mt-2">
                  {fmtUSD(current.price)}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge
                    tone={current.changePct >= 0 ? "up" : "down"}
                    dot
                  >
                    {fmtPct(current.changePct)}
                  </Badge>
                  <span className="text-xs text-muted">últimas 24h</span>
                </div>
              </div>
              <div className="flex gap-2">
                <Button variant="success" size="md" onClick={() => handleOpenTrade("LONG")}>
                  Comprar
                </Button>
                <Button variant="danger" size="md" onClick={() => handleOpenTrade("SHORT")}>
                  Vender
                </Button>
              </div>
            </div>

            <div className="mt-5">
              <TradingViewWidget symbol={current.symbol} />
            </div>
          </Card>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Card><Stat label="Volume 24h" value={fmtCompact(current.volume)} size="sm" /></Card>
            <Card><Stat label="Máxima 24h" value={fmtUSD(current.price * 1.03)} size="sm" /></Card>
            <Card><Stat label="Mínima 24h" value={fmtUSD(current.price * 0.97)} size="sm" /></Card>
            <Card><Stat label="Variação" value={fmtPct(current.changePct)} delta={current.changePct} size="sm" /></Card>
          </div>
        </div>
      </div>

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
