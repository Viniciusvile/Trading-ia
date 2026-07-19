"use client";

/**
 * Painel de ordem manual (página Mercado) — envia ordens REAIS via /api/trade.
 *
 * Substitui o modal antigo (que chamava o force-trade simulado). Fica fixo ao
 * lado do gráfico, estilo terminal de exchange, seguindo o design system VEXA:
 * tabs Comprar/Vender com bolha animada, valor com botões de % do saldo,
 * TP/SL opcionais com preview de preço e aviso de regime do mercado.
 */

import { useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { AlertTriangle, ChevronDown, Sliders, ShieldCheck, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Card, Button, Input, Badge } from "@/components/ui";
import { springSnappy } from "@/components/fx/motion";
import { fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";
import { useTradeContext } from "@/lib/hooks";
import { cn } from "@/lib/cn";

interface OrderPanelProps {
  symbol: string;
}

const PCT_OPTIONS = [25, 50, 75, 100] as const;

export function OrderPanel({ symbol }: OrderPanelProps) {
  const reduce = useReducedMotion();
  const { data: ctx, mutate: mutateCtx, isLoading } = useTradeContext(symbol);

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amountUsdt, setAmountUsdt] = useState("10");
  const [sellPct, setSellPct] = useState(100);
  const [useTpSl, setUseTpSl] = useState(true);
  const [tpPct, setTpPct] = useState("2");
  const [slPct, setSlPct] = useState("1");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [tp1Pct, setTp1Pct] = useState("1.5");
  const [tp1SizePct, setTp1SizePct] = useState(50);
  const [trailingPct, setTrailingPct] = useState("1");
  const [advSlPct, setAdvSlPct] = useState("2");
  const [executing, setExecuting] = useState(false);

  const price = ctx?.price || 0;
  const base = ctx?.baseAsset || symbol.replace("USDT", "");
  const usdtFree = ctx?.usdtFree || 0;
  const baseFree = ctx?.baseFree || 0;
  const regime = ctx?.regime;
  const quote = ctx?.quoteAsset || "USDT";
  const exchangeName = ctx?.exchange === "coinbase" ? "Coinbase" : "Binance";
  const supportsTpSl = ctx?.supportsTpSl !== false;

  const amountNum = parseFloat(amountUsdt) || 0;
  const tpNum = parseFloat(tpPct) || 0;
  const slNum = parseFloat(slPct) || 0;

  const buyQtyPreview = price > 0 ? amountNum / price : 0;
  const sellQty = baseFree * (sellPct / 100);
  const sellUsdtPreview = sellQty * price;

  const tpPrice = useMemo(() => (price > 0 && tpNum > 0 ? price * (1 + tpNum / 100) : null), [price, tpNum]);
  const slPrice = useMemo(() => (price > 0 && slNum > 0 ? price * (1 - slNum / 100) : null), [price, slNum]);

  const tp1Num = parseFloat(tp1Pct) || 0;
  const trailingNum = parseFloat(trailingPct) || 0;
  const advSlNum = parseFloat(advSlPct) || 0;
  const tp1Price = useMemo(() => (price > 0 && tp1Num > 0 ? price * (1 + tp1Num / 100) : null), [price, tp1Num]);
  const advSlPrice = useMemo(() => (price > 0 && advSlNum > 0 ? price * (1 - advSlNum / 100) : null), [price, advSlNum]);
  const trailStopPreview = useMemo(
    () => (tp1Price && trailingNum > 0 ? tp1Price * (1 - trailingNum / 100) : null),
    [tp1Price, trailingNum],
  );

  const advValid = showAdvanced && (tp1Num > 0 || trailingNum > 0);
  const canSubmit = side === "buy"
    ? amountNum >= 5 && amountNum <= usdtFree &&
      (showAdvanced ? advValid : (!supportsTpSl || !useTpSl || (tpNum > 0 && slNum > 0)))
    : sellUsdtPreview >= 5;

  async function handleSubmit() {
    if (!canSubmit || executing) return;
    setExecuting(true);
    try {
      if (side === "buy") {
        const advancedExtras = showAdvanced
          ? {
              ...(tp1Num > 0 ? { tp1_pct: tp1Num / 100 } : {}),
              tp1_size_pct: tp1SizePct / 100,
              ...(trailingNum > 0 ? { trailing_pct: trailingNum / 100 } : {}),
              ...(advSlNum > 0 ? { sl_pct: advSlNum / 100 } : {}),
            }
          : supportsTpSl && useTpSl && tpNum > 0 && slNum > 0
            ? { tp_pct: tpNum / 100, sl_pct: slNum / 100 }
            : {};
        const res = await api.tradeOrder({
          symbol,
          side: "buy",
          amount_usdt: amountNum,
          ...advancedExtras,
        });
        const entryDesc = `Entrada ${fmtUSD(res.entryPrice || 0)} · ${((res.quantity || 0)).toFixed(6)} ${base}`;
        const protDesc = res.advanced
          ? ` · watchdog ativado`
          : res.tpPrice ? ` · TP ${fmtUSD(res.tpPrice)} / SL ${fmtUSD(res.slPrice || 0)}` : "";
        toast.success(`Compra executada: ${symbol}`, { description: entryDesc + protDesc });
        if (!res.advanced && useTpSl && res.ocoOk === false) {
          toast.warning("Compra ok, mas o TP/SL (OCO) não foi aceito", {
            description: res.ocoError || "Verifique a posição e defina a proteção manualmente.",
          });
        }
      } else {
        const res = await api.tradeOrder({ symbol, side: "sell", quantity: sellQty });
        toast.success(`Venda executada: ${symbol}`, {
          description: `${(res.quantity || 0).toFixed(6)} ${base} a ${fmtUSD(res.exitPrice || 0)} · total ${fmtUSD(res.totalUsdt || 0)}`,
        });
      }
      mutateCtx();
    } catch (err: any) {
      toast.error("Ordem rejeitada", { description: err?.message || "Erro ao enviar a ordem." });
    } finally {
      setExecuting(false);
    }
  }

  const showBearWarning = side === "buy" && regime && !regime.allowed;

  return (
    <Card padding="lg" className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-[var(--color-text)]">Ordem manual</div>
        <Badge tone="neutral" size="sm">Spot · {exchangeName}</Badge>
      </div>

      {/* Tabs Comprar/Vender com bolha animada */}
      <div className="relative grid grid-cols-2 p-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)]">
        {(["buy", "sell"] as const).map((s) => {
          const active = side === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={cn(
                "relative py-2 text-xs font-semibold rounded-[10px] transition-colors",
                active
                  ? s === "buy" ? "text-[var(--color-up-300)]" : "text-[var(--color-down-300)]"
                  : "text-[var(--color-muted)] hover:text-[var(--color-text-2)]",
              )}
            >
              {active && (
                <motion.span
                  layoutId="order-side-bubble"
                  transition={reduce ? { duration: 0 } : springSnappy}
                  className={cn(
                    "absolute inset-0 rounded-[10px] border",
                    s === "buy"
                      ? "bg-[var(--color-up-50)] border-[var(--color-up-500)]/30"
                      : "bg-[var(--color-down-50)] border-[var(--color-down-500)]/30",
                  )}
                />
              )}
              <span className="relative z-10">{s === "buy" ? "Comprar" : "Vender"}</span>
            </button>
          );
        })}
      </div>

      {/* Saldo disponível */}
      <div className="flex items-center justify-between p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)] text-xs">
        <span className="flex items-center gap-1.5 text-muted"><Wallet size={13} /> Disponível</span>
        <span className="font-semibold tabular-nums text-[var(--color-text)]">
          {isLoading && !ctx
            ? "…"
            : side === "buy"
              ? `${fmtUSD(usdtFree)} ${quote}`
              : `${baseFree.toFixed(6)} ${base} (≈ ${fmtUSD(baseFree * price)})`}
        </span>
      </div>

      {side === "buy" ? (
        <>
          <div>
            <label htmlFor="op-amount" className="text-xs font-semibold text-muted block mb-1.5">
              Valor da compra ({quote})
            </label>
            <div className="relative">
              <Input
                id="op-amount"
                type="number"
                min={5}
                value={amountUsdt}
                onChange={(e) => setAmountUsdt(e.target.value)}
                disabled={executing}
              />
              <span className="absolute right-3 top-2.5 text-xs text-muted font-medium">{quote}</span>
            </div>
            <div className="grid grid-cols-4 gap-1.5 mt-2">
              {PCT_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={executing || usdtFree <= 0}
                  onClick={() => setAmountUsdt((usdtFree * (p / 100)).toFixed(2))}
                  className="py-1 rounded-[var(--radius-xs)] text-[10px] font-medium border border-[var(--color-border)] text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition"
                >
                  {p}%
                </button>
              ))}
            </div>
            <div className="mt-1.5 text-[11px] text-muted tabular-nums">
              ≈ {buyQtyPreview > 0 ? buyQtyPreview.toFixed(6) : "0"} {base} ao preço atual
            </div>
          </div>

          {/* TP/SL padrão (OCO — só Binance, escondido no modo avançado) */}
          {supportsTpSl && !showAdvanced && (
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3 space-y-3">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-text-2)]">
                <ShieldCheck size={14} className="text-[var(--color-brand-300)]" />
                Proteção TP/SL automática
              </span>
              <input
                type="checkbox"
                checked={useTpSl}
                onChange={(e) => setUseTpSl(e.target.checked)}
                disabled={executing}
                className="accent-[var(--color-brand-500)] h-4 w-4"
              />
            </label>
            {useTpSl && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="op-tp" className="text-[10px] uppercase tracking-wider text-muted block mb-1">Take Profit %</label>
                  <Input id="op-tp" type="number" min={0.1} step={0.1} value={tpPct}
                    onChange={(e) => setTpPct(e.target.value)} disabled={executing} />
                  <div className="mt-1 text-[10px] text-up tabular-nums">
                    {tpPrice ? `alvo ${fmtUSD(tpPrice)}` : "—"}
                  </div>
                </div>
                <div>
                  <label htmlFor="op-sl" className="text-[10px] uppercase tracking-wider text-muted block mb-1">Stop Loss %</label>
                  <Input id="op-sl" type="number" min={0.1} step={0.1} value={slPct}
                    onChange={(e) => setSlPct(e.target.value)} disabled={executing} />
                  <div className="mt-1 text-[10px] text-down tabular-nums">
                    {slPrice ? `stop ${fmtUSD(slPrice)}` : "—"}
                  </div>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Modo Avançado: TP1 parcial + trailing (software, qualquer exchange) */}
          <div className="rounded-[var(--radius-sm)] border border-[var(--color-border)] overflow-hidden">
            <button
              type="button"
              disabled={executing}
              onClick={() => setShowAdvanced((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2.5 text-xs font-semibold text-[var(--color-text-2)] hover:bg-[var(--color-surface-3)] transition"
            >
              <span className="flex items-center gap-1.5">
                <Sliders size={13} className="text-[var(--color-brand-300)]" />
                Avançado · TP1 parcial + trailing
              </span>
              <ChevronDown
                size={13}
                className={cn("transition-transform", showAdvanced && "rotate-180")}
              />
            </button>

            <AnimatePresence initial={false}>
              {showAdvanced && (
                <motion.div
                  key="adv"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={reduce ? { duration: 0 } : { duration: 0.18 }}
                  className="overflow-hidden"
                >
                  <div className="p-3 pt-2 space-y-3 border-t border-[var(--color-border)]">

                    {/* TP1 % */}
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">
                        TP1 — alvo parcial (%)
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number" min={0.1} step={0.1}
                          value={tp1Pct}
                          onChange={(e) => setTp1Pct(e.target.value)}
                          disabled={executing}
                        />
                        <span className="text-[10px] text-up tabular-nums whitespace-nowrap">
                          {tp1Price ? fmtUSD(tp1Price) : "—"}
                        </span>
                      </div>
                    </div>

                    {/* TP1 tamanho (% da posição) */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[10px] uppercase tracking-wider text-muted">
                          Vender no TP1
                        </label>
                        <span className="text-[10px] font-semibold text-[var(--color-text)]">{tp1SizePct}%</span>
                      </div>
                      <input
                        type="range" min={10} max={90} step={5}
                        value={tp1SizePct}
                        onChange={(e) => setTp1SizePct(Number(e.target.value))}
                        disabled={executing}
                        className="w-full accent-[var(--color-brand-500)]"
                      />
                      <div className="flex justify-between text-[9px] text-muted mt-0.5">
                        <span>10%</span><span>50%</span><span>90%</span>
                      </div>
                    </div>

                    {/* Trailing stop */}
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">
                        Trailing stop (%) · ativo após TP1
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number" min={0.1} step={0.1}
                          value={trailingPct}
                          onChange={(e) => setTrailingPct(e.target.value)}
                          disabled={executing}
                        />
                        <span className="text-[10px] text-down tabular-nums whitespace-nowrap">
                          {trailStopPreview ? `≥ ${fmtUSD(trailStopPreview)}` : "—"}
                        </span>
                      </div>
                    </div>

                    {/* SL fixo (opcional) */}
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-muted block mb-1">
                        Stop loss fixo (%) · opcional
                      </label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="number" min={0.1} step={0.1}
                          value={advSlPct}
                          onChange={(e) => setAdvSlPct(e.target.value)}
                          disabled={executing}
                        />
                        <span className="text-[10px] text-down tabular-nums whitespace-nowrap">
                          {advSlPrice ? fmtUSD(advSlPrice) : "—"}
                        </span>
                      </div>
                    </div>

                    <p className="text-[10px] text-muted leading-relaxed">
                      O watchdog verifica a posição a cada 60s e executa as saídas automaticamente — funciona em qualquer exchange.
                    </p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </>
      ) : (
        <div>
          <label className="text-xs font-semibold text-muted block mb-1.5">
            Quantidade a vender ({base})
          </label>
          <div className="grid grid-cols-4 gap-1.5">
            {PCT_OPTIONS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={executing || baseFree <= 0}
                onClick={() => setSellPct(p)}
                className={cn(
                  "py-1.5 rounded-[var(--radius-xs)] text-[11px] font-medium border transition",
                  sellPct === p
                    ? "border-[var(--color-down-500)]/50 bg-[var(--color-down-50)] text-[var(--color-down-300)]"
                    : "border-[var(--color-border)] text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)]",
                )}
              >
                {p}%
              </button>
            ))}
          </div>
          <div className="mt-2 text-[11px] text-muted tabular-nums">
            {sellQty > 0 ? sellQty.toFixed(6) : "0"} {base} ≈ {fmtUSD(sellUsdtPreview)}
          </div>
        </div>
      )}

      {/* Aviso do regime de mercado (inteligência integrada — não bloqueia) */}
      {showBearWarning && (
        <div className="p-3 bg-[var(--color-warn-50)] rounded-[var(--radius-sm)] border border-[var(--color-warn-500)]/25 flex gap-2.5 items-start">
          <AlertTriangle size={15} className="shrink-0 mt-0.5 text-[var(--color-warn-500)]" />
          <p className="text-[11px] leading-relaxed text-[var(--color-warn-500)]">
            <strong>Mercado em baixa:</strong> {regime?.reason}. Os bots não comprariam agora — a decisão manual é sua.
          </p>
        </div>
      )}

      <Button
        fullWidth
        size="lg"
        variant={side === "buy" ? "success" : "danger"}
        loading={executing}
        disabled={!canSubmit || executing || !ctx}
        onClick={handleSubmit}
      >
        {executing
          ? "Enviando ordem..."
          : side === "buy"
            ? `Comprar ${base}${amountNum >= 5 ? ` · ${fmtUSD(amountNum)}` : ""}`
            : `Vender ${base}${sellUsdtPreview >= 5 ? ` · ≈ ${fmtUSD(sellUsdtPreview)}` : ""}`}
      </Button>

      <p className="text-[10px] text-muted leading-relaxed">
        Ordem a mercado enviada à {exchangeName} na sua conta ativa.
        {showAdvanced
          ? " Modo avançado: TP1 parcial e trailing gerenciados pelo watchdog (60s). Posição aparece no Diário como estratégia "
          : supportsTpSl
            ? " Compras com TP/SL criam uma OCO automática e aparecem no Diário como estratégia "
            : " A Coinbase não suporta TP/SL automático por aqui. Compras aparecem no Diário como estratégia "}
        <strong>Manual</strong>.
      </p>
    </Card>
  );
}
