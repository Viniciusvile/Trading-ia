"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { Card, Button, Badge, EmptyState } from "@/components/ui";
import { AnimatedNumber, PillTabs, MetricStrip, SymbolIcon, FadeSlide } from "@/components/fx";
import { OrderPanel } from "@/components/trade/OrderPanel";
import { fmtUSD, fmtPct, fmtCompact } from "@/lib/format";
import { TradingViewWidget } from "@/components/TradingViewWidget";
import { api } from "@/lib/api";
import { useQuotes, useTradeContext } from "@/lib/hooks";

const SYMBOLS = [
  { symbol: "BTCUSDT", name: "Bitcoin" },
  { symbol: "ETHUSDT", name: "Ethereum" },
  { symbol: "SOLUSDT", name: "Solana" },
  { symbol: "XRPUSDT", name: "XRP" },
];

function MercadoInner() {
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState(SYMBOLS[0].symbol);

  // Command palette / links externos: /mercado?symbol=SOLUSDT
  useEffect(() => {
    const s = searchParams.get("symbol");
    if (s && SYMBOLS.some((f) => f.symbol === s)) setSelected(s);
  }, [searchParams]);

  // Cotações via SWR (refresh 5s, sem flash) + contexto de trade (saldos/posições/regime)
  const { data: quotes, isValidating: loadingQuotes, mutate: mutateQuotes } =
    useQuotes(SYMBOLS.map((s) => s.symbol));
  const { data: ctx, mutate: mutateCtx } = useTradeContext(selected);

  const [closingId, setClosingId] = useState<string | null>(null);

  const q = quotes?.[selected];
  const current = {
    symbol: selected,
    name: SYMBOLS.find((s) => s.symbol === selected)?.name || selected,
    price: q?.last ?? ctx?.price ?? 0,
    changePct: q?.changePct ?? 0,
    volume: q?.volume ?? 0,
    high: q?.high ?? 0,
    low: q?.low ?? 0,
  };

  const openPositions = ctx?.openPositions || [];

  async function handleClosePosition(positionId: string) {
    if (closingId) return;
    setClosingId(positionId);
    try {
      const res = await api.tradeClose(positionId);
      toast.success("Posição fechada a mercado", {
        description: `Saída ${fmtUSD(res.exitPrice || 0)} · PnL ${res.pnl != null ? `${res.pnl >= 0 ? "+" : ""}${fmtUSD(res.pnl)}` : "—"}`,
      });
      mutateCtx();
    } catch (err: any) {
      toast.error("Falha ao fechar posição", { description: err?.message });
    } finally {
      setClosingId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header de detalhe do ativo */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <SymbolIcon symbol={current.symbol} size={40} />
            <div>
              <div className="text-sm font-semibold text-[var(--color-text)]">{current.symbol.replace("USDT", "")}</div>
              <div className="text-[11px] text-muted">
                {current.name} · {ctx?.quoteAsset || "USDT"} · {ctx?.exchange === "coinbase" ? "Coinbase" : "Binance"}
              </div>
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
            variant="outline"
            size="md"
            leftIcon={<RefreshCw size={15} className={loadingQuotes ? "animate-spin" : ""} />}
            onClick={() => { mutateQuotes(); mutateCtx(); }}
          >
            Atualizar
          </Button>
        </div>
      </div>

      {/* Troca de ativo por pills */}
      <PillTabs
        options={SYMBOLS.map((f) => ({ value: f.symbol, label: f.symbol.replace("USDT", "") }))}
        value={selected}
        onChange={setSelected}
        size="md"
      />

      {/* Gráfico + painel de ordem lado a lado */}
      <div className="grid lg:grid-cols-3 gap-4 items-start">
        <div className="lg:col-span-2 space-y-4">
          <Card padding="sm">
            <TradingViewWidget symbol={current.symbol} />
          </Card>

          <MetricStrip
            items={[
              { label: "Volume 24h", value: fmtCompact(current.volume) },
              { label: "Máxima 24h", value: fmtUSD(current.high || current.price) },
              { label: "Mínima 24h", value: fmtUSD(current.low || current.price) },
              { label: "Variação 24h", value: `${current.changePct >= 0 ? "+" : ""}${fmtPct(current.changePct)}`, tone: current.changePct >= 0 ? "up" : "down" },
              { label: `${ctx?.quoteAsset || "USDT"} livre`, value: fmtUSD(ctx?.usdtFree ?? 0) },
              { label: `${ctx?.baseAsset || current.symbol.replace("USDT", "")} em carteira`, value: fmtUSD(ctx?.baseFreeUsdt ?? 0) },
            ]}
          />

          {/* Posições abertas neste ativo */}
          <Card padding="md">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold text-[var(--color-text)]">
                Posições abertas · {current.symbol.replace("USDT", "")}
              </div>
              <Badge tone={openPositions.length > 0 ? "up" : "neutral"} size="sm">
                {openPositions.length} aberta{openPositions.length === 1 ? "" : "s"}
              </Badge>
            </div>
            {openPositions.length === 0 ? (
              <EmptyState
                icon={<X size={20} />}
                title="Nenhuma posição aberta"
                description="Compre pelo painel ao lado — a posição aparece aqui com PnL ao vivo e botão de fechamento."
              />
            ) : (
              <div className="overflow-x-auto -mx-4 sm:mx-0">
                <table className="w-full text-left border-collapse min-w-[560px] text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-muted uppercase font-semibold text-[10px] tracking-wider">
                      <th className="py-2.5 px-4">Origem</th>
                      <th className="py-2.5 px-4 text-right">Qtd</th>
                      <th className="py-2.5 px-4 text-right">Entrada</th>
                      <th className="py-2.5 px-4 text-right">TP / SL</th>
                      <th className="py-2.5 px-4 text-right">PnL aberto</th>
                      <th className="py-2.5 px-4 text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)] font-medium">
                    {openPositions.map((p) => {
                      const pnl = p.unrealizedPnl ?? 0;
                      return (
                        <tr key={p.id} className="hover:bg-[var(--color-surface-2)]/50 transition">
                          <td className="py-3 px-4">
                            <span className="font-semibold text-[var(--color-text)]">{p.plan || "—"}</span>
                            <span className="block text-[10px] text-muted">
                              {p.openedAt ? new Date(p.openedAt).toLocaleString("pt-BR") : ""}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right tabular-nums">{(p.quantity || 0).toFixed(6)}</td>
                          <td className="py-3 px-4 text-right tabular-nums">{fmtUSD(p.entryPrice || 0)}</td>
                          <td className="py-3 px-4 text-right tabular-nums text-[11px]">
                            <span className="text-up">{p.takeProfitPrice ? fmtUSD(p.takeProfitPrice) : "—"}</span>
                            {" / "}
                            <span className="text-down">{p.stopPrice ? fmtUSD(p.stopPrice) : "—"}</span>
                          </td>
                          <td className={`py-3 px-4 text-right tabular-nums font-bold ${pnl >= 0 ? "text-up" : "text-down"}`}>
                            <AnimatedNumber value={pnl} format={(v) => `${v >= 0 ? "+" : ""}${fmtUSD(v)}`} />
                          </td>
                          <td className="py-3 px-4 text-center">
                            <Button
                              variant="outline"
                              size="sm"
                              loading={closingId === p.id}
                              disabled={!!closingId}
                              onClick={() => handleClosePosition(p.id)}
                            >
                              Fechar
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* Indicadores-chave */}
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
                <span className={`h-1.5 w-1.5 rounded-full ${ctx?.regime?.allowed ? "bg-[var(--color-up-500)]" : "bg-[var(--color-warn-500)]"}`} />
                <span>
                  Regime do mercado: <strong className="text-[var(--color-text)]">
                    {ctx?.regime
                      ? ctx.regime.allowed
                        ? `favorável (${ctx.regime.symbolRegime || "—"})`
                        : `desfavorável para compras (${ctx.regime.symbolRegime || "—"})`
                      : "carregando..."}
                  </strong>
                </span>
              </li>
            </ul>
          </Card>
        </div>

        {/* Painel de ordem manual — sticky no desktop */}
        <FadeSlide from="right" className="lg:sticky lg:top-20">
          <OrderPanel symbol={selected} />
        </FadeSlide>
      </div>
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
