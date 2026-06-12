"use client";

import { useEffect, useState } from "react";
import { Wallet, History, Trash2, Loader2, ArrowUpRight, ArrowDownRight, RefreshCw, Calendar, ChevronLeft, ChevronRight, CheckCircle2, XCircle, Info } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, EmptyState, Badge, Stat, Button, Modal } from "@/components/ui";
import { SymbolIcon, RangeBar, AnimatedNumber } from "@/components/fx";
import { fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";

interface Position {
  id: string;
  symbol: string;
  timeframe: string;
  side: string;
  entryPrice: number;
  quantity: number;
  stopPrice: number;
  takeProfitPrice: number;
  orderId: string;
  ocoOrderListId: string | null;
  openedAt: string;
  status: string;
  strategy?: string;
  plan?: string;
  closedAt?: string;
  
  // Detalhamento extra
  exitPrice?: number | null;
  exitReason?: string;
  exitOrderId?: string;
  pnl?: number | null;
  conditions?: Array<{
    pass: boolean;
    label: string;
    actual: string;
    required: string;
  }>;
  indicators?: any;
}

export default function PosicoesPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileMsg, setReconcileMsg] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  async function handleReconcile() {
    setReconciling(true);
    setReconcileMsg(null);
    try {
      const r = await api.botReconcile();
      if (r.success) {
        const lines = [`✓ ${r.checked ?? 0} posição(ões) aberta(s) conferida(s) com a Binance.`];
        if (r.ghostsClosed?.length) lines.push(`Registros fantasma encerrados: ${r.ghostsClosed.join(", ")}.`);
        if (r.missingOco?.length) lines.push(`⚠ Sem ordem TP/SL na exchange (o robô repõe no próximo ciclo): ${r.missingOco.join(", ")}.`);
        if (r.untracked?.length) lines.push(`⚠ Saldos sem posição registrada: ${r.untracked.map(u => `${u.asset} (~$${u.valueUsd})`).join(", ")}.`);
        if (!r.ghostsClosed?.length && !r.missingOco?.length && !r.untracked?.length) lines.push("Tudo consistente — nenhuma divergência encontrada.");
        setReconcileMsg(lines.join("\n"));
        loadPositions();
      } else {
        setReconcileMsg(r.error || "Falha ao reconciliar com a Binance.");
      }
    } finally {
      setReconciling(false);
    }
  }

  // Calendar states
  const [currentDate, setCurrentDate] = useState(new Date());
  const [hoveredDayKey, setHoveredDayKey] = useState<string | null>(null);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);
  const [isMounted, setIsMounted] = useState(false);

  async function loadPositions() {
    try {
      const res = await api.botPositions();
      if (res && res.success) {
        setPositions(res.positions || []);
      } else {
        setError("Não foi possível carregar as posições.");
      }
    } catch (e: any) {
      console.error(e);
      setError("Erro de rede ao carregar posições.");
    } finally {
      setLoading(false);
    }
  }

  // Poll positions from DB
  useEffect(() => {
    setIsMounted(true);
    loadPositions();
    const interval = setInterval(loadPositions, 10000);
    return () => clearInterval(interval);
  }, []);

  // Poll live ticker prices from Binance
  useEffect(() => {
    let active = true;
    async function fetchPrices() {
      try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/price");
        const data = await res.json();
        if (Array.isArray(data) && active) {
          const priceMap: Record<string, number> = {};
          data.forEach((item: { symbol: string; price: string }) => {
            priceMap[item.symbol] = parseFloat(item.price);
          });
          setPrices(priceMap);
        }
      } catch (e) {
        console.error("Erro ao carregar cotações em tempo real:", e);
      }
    }
    fetchPrices();
    const timer = setInterval(fetchPrices, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  const handleClosePosition = async (id: string, markOnly = false) => {
    const confirmMsg = markOnly 
      ? "Deseja forçar o fechamento local desta posição? Isso não enviará ordens para a Binance."
      : "Tem certeza que deseja fechar esta posição no mercado da Binance?";
    if (!confirm(confirmMsg)) return;
    setClosingId(id);
    try {
      const res = await api.botClosePosition(id, markOnly);
      if (res && res.success) {
        await loadPositions();
      } else {
        const errorMsg = res.error || "Erro ao fechar posição.";
        if (!markOnly) {
          const forceLocal = confirm(`${errorMsg}\n\nDeseja forçar o fechamento local no banco de dados (marcar como fechada)?`);
          if (forceLocal) {
            await handleClosePosition(id, true);
          }
        } else {
          alert(errorMsg);
        }
      }
    } catch (e) {
      console.error(e);
      alert("Erro ao enviar comando de fechamento.");
    } finally {
      setClosingId(null);
    }
  };

  const openPositions = positions.filter((p) => p.status === "open");
  const closedPositions = positions
    .filter((p) => p.status === "closed")
    .sort((a, b) => {
      const dateA = new Date(a.closedAt || (a as any).data?.closedAt || a.openedAt).getTime();
      const dateB = new Date(b.closedAt || (b as any).data?.closedAt || b.openedAt).getTime();
      return dateB - dateA;
    });

  const itemsPerPage = 10;
  const totalPages = Math.max(1, Math.ceil(closedPositions.length / itemsPerPage));
  const activePage = Math.min(currentPage, totalPages);
  const paginatedClosedPositions = closedPositions.slice(
    (activePage - 1) * itemsPerPage,
    activePage * itemsPerPage
  );

  const getPageNumbers = () => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }
    const pages: (number | string)[] = [];
    pages.push(1);
    if (activePage > 3) {
      pages.push("...");
    }
    const start = Math.max(2, activePage - 1);
    const end = Math.min(totalPages - 1, activePage + 1);
    for (let i = start; i <= end; i++) {
      pages.push(i);
    }
    if (activePage < totalPages - 2) {
      pages.push("...");
    }
    pages.push(totalPages);
    return pages;
  };

  // Calculate real-time stats
  let totalUnrealizedPnL = 0;
  const enrichedOpenPositions = openPositions.map((pos) => {
    const currentPrice = prices[pos.symbol] || pos.entryPrice;
    const isLong = pos.side === "LONG";
    const pnl = isLong 
      ? (currentPrice - pos.entryPrice) * pos.quantity 
      : (pos.entryPrice - currentPrice) * pos.quantity;
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * (isLong ? 1 : -1);
    totalUnrealizedPnL += pnl;

    return {
      ...pos,
      currentPrice,
      pnl,
      pnlPct,
    };
  }).sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime());

  const totalOpen = openPositions.length;
  const marginUsed = openPositions.reduce((acc, p) => acc + (p.entryPrice * p.quantity), 0);

  // Group daily P&L and total realized P&L
  const dailyPnL: Record<string, number> = {};
  let totalRealizedPnL = 0;
  closedPositions.forEach((pos) => {
    const pnlVal = typeof (pos as any).pnl === "number" ? (pos as any).pnl : parseFloat((pos as any).pnl || "0");
    totalRealizedPnL += pnlVal;

    const closedDateStr = pos.closedAt || (pos as any).data?.closedAt || pos.openedAt;
    if (closedDateStr) {
      const closedDate = new Date(closedDateStr);
      const year = closedDate.getFullYear();
      const month = String(closedDate.getMonth() + 1).padStart(2, '0');
      const day = String(closedDate.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;
      dailyPnL[dateKey] = (dailyPnL[dateKey] || 0) + pnlVal;
    }
  });

  // Calendar calculations
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth();
  const firstDayOfMonth = new Date(year, month, 1);
  const startDayOfWeek = firstDayOfMonth.getDay();
  const totalDaysInMonth = new Date(year, month + 1, 0).getDate();

  const daysArray: (number | null)[] = [];
  for (let i = 0; i < startDayOfWeek; i++) {
    daysArray.push(null);
  }
  for (let d = 1; d <= totalDaysInMonth; d++) {
    daysArray.push(d);
  }

  const monthsPt = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <PageHeader
          title="Posições"
          description="Suas operações abertas e o histórico de tudo que já foi fechado."
        />
        <div className="flex items-center gap-2 self-start sm:self-center">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReconcile}
            disabled={reconciling}
            className="gap-2"
          >
            <CheckCircle2 size={14} className={reconciling ? "animate-pulse" : ""} />
            {reconciling ? "Reconciliando..." : "Reconciliar com a Binance"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setLoading(true);
              loadPositions();
            }}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            Atualizar
          </Button>
        </div>
      </div>

      {reconcileMsg && (
        <p className="text-[11px] text-muted bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] p-2.5 whitespace-pre-line">
          {reconcileMsg}
        </p>
      )}

      {/* Responsive layout: Grid on large screens to include calendar on the right */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
        
        {/* Main Area (3/4 on desktop) */}
        <div className="lg:col-span-3 space-y-5 min-w-0">
          
          {/* Stats Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <Card padding="md">
              <Stat label="Posições abertas" value={String(totalOpen)} size="sm" />
            </Card>
            <Card padding="md">
              <Stat
                label="P&L não realizado"
                value={
                  <AnimatedNumber
                    value={totalUnrealizedPnL}
                    format={(v) => `${v > 0 ? "+" : ""}${fmtUSD(v)}`}
                    className={totalUnrealizedPnL > 0 ? "text-up" : totalUnrealizedPnL < 0 ? "text-down" : ""}
                  />
                }
                size="sm"
              />
            </Card>
            <Card padding="md">
              <Stat
                label="P&L realizado"
                value={
                  <AnimatedNumber
                    value={totalRealizedPnL}
                    format={(v) => `${v > 0 ? "+" : ""}${fmtUSD(v)}`}
                    className={totalRealizedPnL > 0 ? "text-up" : totalRealizedPnL < 0 ? "text-down" : ""}
                  />
                }
                size="sm"
              />
            </Card>
            <Card padding="md">
              <Stat label="Margem total alocada" value={fmtUSD(marginUsed)} size="sm" />
            </Card>
          </div>

          {/* OPEN POSITIONS */}
          <Card padding="lg">
            <CardHeader
              icon={<Wallet size={18} className="text-[var(--color-brand-500)]" />}
              title="Abertas"
              subtitle="Posições ativas em todas as corretoras"
              action={<Badge tone={totalOpen > 0 ? "success" : "neutral"} dot>{totalOpen} ativas</Badge>}
            />

            {loading && openPositions.length === 0 ? (
              <div className="flex justify-center py-8">
                <Loader2 className="animate-spin text-muted" size={24} />
              </div>
            ) : openPositions.length === 0 ? (
              <EmptyState
                icon={<Wallet size={22} />}
                title="Nenhuma posição aberta"
                description="Quando um bot abrir uma operação, ela aparecerá aqui em tempo real."
              />
            ) : (
              <div className="overflow-x-auto mt-4">
                <table className="w-full min-w-[1000px] text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[10px] font-semibold text-muted uppercase tracking-[0.08em]">
                      <th className="pb-3 font-medium pr-4">Ativo / Tipo</th>
                      <th className="pb-3 font-medium px-4">Lado</th>
                      <th className="pb-3 font-medium px-4">Preço Entrada</th>
                      <th className="pb-3 font-medium px-4">Preço Atual</th>
                      <th className="pb-3 font-medium px-4">Quantidade</th>
                      <th className="pb-3 font-medium px-4">P&L live</th>
                      <th className="pb-3 font-medium px-4">Stop → Alvo</th>
                      <th className="pb-3 font-medium text-right pl-4">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10 text-sm">
                    {enrichedOpenPositions.map((pos) => {
                      const isLong = pos.side === "LONG";
                      const isProfit = pos.pnl >= 0;
                      return (
                        <tr key={pos.id} className="hover:bg-white/5 cursor-pointer transition-colors" onClick={() => setSelectedPosition(pos)}>
                          <td className="py-4 pr-4">
                            <div className="flex items-center gap-2.5">
                              <SymbolIcon symbol={pos.symbol} size={28} />
                              <div className="min-w-0">
                                <div className="font-semibold">{pos.symbol.replace("USDT", "")}</div>
                                <div className="text-xs text-muted truncate">
                                  {pos.plan || "Sem Plano"} ({pos.timeframe})
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="py-4 px-4">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                              isLong ? "bg-up-light text-up" : "bg-down-light text-down"
                            }`}>
                              {isLong ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                              {pos.side}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-mono">{fmtUSD(pos.entryPrice)}</td>
                          <td className="py-4 px-4 font-mono font-semibold text-[var(--color-brand-600)]">
                            {fmtUSD(pos.currentPrice)}
                          </td>
                          <td className="py-4 px-4 font-mono text-xs">{pos.quantity}</td>
                          <td className="py-4 px-4 font-mono">
                            <div className={`font-bold ${isProfit ? "text-up" : "text-down"}`}>
                              {isProfit ? "+" : ""}{fmtUSD(pos.pnl)}
                            </div>
                            <div className={`text-xs ${isProfit ? "text-up" : "text-down"}`}>
                              {isProfit ? "+" : ""}{pos.pnlPct.toFixed(2)}%
                            </div>
                          </td>
                          <td className="py-4 px-4">
                            {pos.stopPrice && pos.takeProfitPrice ? (
                              <RangeBar
                                stop={pos.stopPrice}
                                tp={pos.takeProfitPrice}
                                entry={pos.entryPrice}
                                current={pos.currentPrice}
                                format={fmtUSD}
                                className="min-w-[150px]"
                              />
                            ) : (
                              <span className="text-xs text-muted">—</span>
                            )}
                          </td>
                          <td className="py-4 pl-4 text-right">
                            <Button
                              variant="danger"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleClosePosition(pos.id);
                              }}
                              disabled={closingId === pos.id}
                            >
                              {closingId === pos.id ? (
                                <Loader2 className="animate-spin mr-1" size={12} />
                              ) : (
                                <Trash2 size={12} className="mr-1" />
                              )}
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

          {/* CLOSED POSITIONS */}
          <Card padding="lg">
            <CardHeader
              icon={<History size={18} className="text-[var(--color-muted)]" />}
              title="Histórico de fechadas"
              subtitle="Últimas operações encerradas"
            />

            {loading && closedPositions.length === 0 ? (
              <div className="flex justify-center py-8">
                <Loader2 className="animate-spin text-muted" size={24} />
              </div>
            ) : closedPositions.length === 0 ? (
              <EmptyState
                icon={<History size={22} />}
                title="Ainda sem histórico"
                description="O histórico das suas operações encerradas vai construir essa lista."
              />
            ) : (
              <div className="overflow-x-auto mt-4">
                <table className="w-full min-w-[700px] text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-[10px] font-semibold text-muted uppercase tracking-[0.08em]">
                      <th className="pb-3 font-medium pr-4">Ativo / Tipo</th>
                      <th className="pb-3 font-medium px-4">Lado</th>
                      <th className="pb-3 font-medium px-4">Preço Entrada</th>
                      <th className="pb-3 font-medium px-4 hidden sm:table-cell">Quantidade</th>
                      <th className="pb-3 font-medium px-4">P&L Realizado</th>
                      <th className="pb-3 font-medium px-4 hidden md:table-cell">Status</th>
                      <th className="pb-3 font-medium pl-4">Encerramento</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/10 text-sm">
                    {paginatedClosedPositions.map((pos) => {
                      const isLong = pos.side === "LONG";
                      const pnlVal = typeof (pos as any).pnl === "number" ? (pos as any).pnl : parseFloat((pos as any).pnl || "0");
                      const isProfit = pnlVal >= 0;
                      return (
                        <tr key={pos.id} className="hover:bg-white/5 cursor-pointer transition-colors" onClick={() => setSelectedPosition(pos)}>
                          <td className="py-4 pr-4">
                            <div className="flex items-center gap-2.5">
                              <SymbolIcon symbol={pos.symbol} size={28} />
                              <div className="min-w-0">
                                <div className="font-semibold">{pos.symbol.replace("USDT", "")}</div>
                                <div className="text-xs text-muted truncate">
                                  {pos.plan || "Sem Plano"} ({pos.timeframe})
                                </div>
                              </div>
                            </div>
                          </td>
                          <td className="py-4 px-4">
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${
                              isLong ? "bg-up-light text-up" : "bg-down-light text-down"
                            }`}>
                              {isLong ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                              {pos.side}
                            </span>
                          </td>
                          <td className="py-4 px-4 font-mono">{fmtUSD(pos.entryPrice)}</td>
                          <td className="py-4 px-4 font-mono text-xs hidden sm:table-cell">{pos.quantity}</td>
                          <td className="py-4 px-4 font-mono">
                            <span className={`font-bold ${isProfit ? "text-up" : "text-down"}`}>
                              {isProfit ? "+" : ""}{fmtUSD(pnlVal)}
                            </span>
                          </td>
                          <td className="py-4 px-4 hidden md:table-cell">
                            <Badge tone="neutral">Fechada</Badge>
                          </td>
                          <td className="py-4 pl-4 text-xs text-muted font-mono">
                            {new Date(pos.closedAt || (pos as any).data?.closedAt || pos.openedAt).toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* Pagination Controls */}
                <div className="flex flex-col sm:flex-row items-center justify-between gap-4 mt-6 pt-4 border-t border-[var(--color-border)] text-xs text-muted">
                  <div>
                    Mostrando <span className="font-semibold text-[var(--color-text)]">{(activePage - 1) * itemsPerPage + 1}</span> a{" "}
                    <span className="font-semibold text-[var(--color-text)]">
                      {Math.min(activePage * itemsPerPage, closedPositions.length)}
                    </span>{" "}
                    de <span className="font-semibold text-[var(--color-text)]">{closedPositions.length}</span> operações
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={activePage === 1}
                      onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                      className="h-8 w-8 p-0"
                    >
                      <ChevronLeft size={14} />
                    </Button>
                    
                    <div className="flex items-center gap-1">
                      {getPageNumbers().map((pageNum, idx) => {
                        if (pageNum === "...") {
                          return <span key={`ellipsis-${idx}`} className="px-1.5 text-muted select-none">...</span>;
                        }
                        return (
                          <button
                            key={pageNum}
                            onClick={() => setCurrentPage(Number(pageNum))}
                            className={`h-8 min-w-8 px-2 rounded-lg text-xs font-semibold transition cursor-pointer ${
                              pageNum === activePage
                                ? "bg-[var(--color-text)] text-[var(--color-bg)]"
                                : "text-muted hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]"
                            }`}
                          >
                            {pageNum}
                          </button>
                        );
                      })}
                    </div>

                    <Button
                      variant="outline"
                      size="sm"
                      disabled={activePage === totalPages}
                      onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                      className="h-8 w-8 p-0"
                    >
                      <ChevronRight size={14} />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Sidebar: Mini Calendar (1/4 on desktop) */}
        <div className="space-y-5">
          <Card padding="lg" className="h-fit">
            {/* Header: Title and Nav Header stacked for responsiveness */}
            <div className="flex flex-col gap-3 mb-4">
              <div className="flex items-center gap-2">
                <Calendar size={18} className="text-[var(--color-brand-500)]" />
                <h3 className="font-semibold text-sm text-[var(--color-text)]">Calendário de P&L</h3>
              </div>
              
              <div className="flex items-center justify-between bg-[var(--color-surface-3)] px-3 py-1.5 rounded-lg border border-[var(--color-border)]">
                <button
                  onClick={() => {
                    const prev = new Date(currentDate);
                    prev.setMonth(prev.getMonth() - 1);
                    setCurrentDate(prev);
                  }}
                  className="p-1 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-2)] hover:text-[var(--color-text)] transition"
                  title="Mês Anterior"
                >
                  <ChevronLeft size={16} />
                </button>
                <span className="text-xs font-semibold text-[var(--color-text)] select-none">
                  {monthsPt[month]} {year}
                </span>
                <button
                  onClick={() => {
                    const next = new Date(currentDate);
                    next.setMonth(next.getMonth() + 1);
                    setCurrentDate(next);
                  }}
                  className="p-1 rounded hover:bg-[var(--color-surface-2)] text-[var(--color-text-2)] hover:text-[var(--color-text)] transition"
                  title="Próximo Mês"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            {/* Week Days Headers */}
            <div className="grid grid-cols-7 gap-1 text-center mb-2 font-medium text-xs text-[var(--color-text-2)] uppercase">
              {["D", "S", "T", "Q", "Q", "S", "S"].map((d, idx) => (
                <div key={idx} className="py-1">
                  {d}
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-1 text-center">
              {!isMounted ? (
                // Skeleton loading cells to ensure zero SSR hydration mismatch
                Array.from({ length: 35 }).map((_, idx) => (
                  <div key={`skeleton-${idx}`} className="aspect-square animate-pulse bg-[var(--color-surface-3)] rounded-lg" />
                ))
              ) : (
                daysArray.map((day, idx) => {
                  if (day === null) {
                    return <div key={`empty-${idx}`} className="aspect-square" />;
                  }

                  const dateKey = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const pnlForDay = dailyPnL[dateKey];
                  const hasTrade = pnlForDay !== undefined;
                  const isProfit = hasTrade && pnlForDay > 0;
                  const isLoss = hasTrade && pnlForDay < 0;

                  const isToday = 
                    new Date().getDate() === day && 
                    new Date().getMonth() === month && 
                    new Date().getFullYear() === year;

                  const isSelected = selectedDayKey === dateKey;
                  const isHovered = hoveredDayKey === dateKey;

                  let cellClass = "aspect-square flex flex-col items-center justify-center text-xs font-semibold rounded-lg transition-all duration-150 relative select-none cursor-pointer ";
                  
                  if (hasTrade) {
                    if (isProfit) {
                      cellClass += "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 border border-emerald-500/20 dark:border-emerald-500/30 hover:bg-emerald-500/25 dark:hover:bg-emerald-500/35";
                    } else if (isLoss) {
                      cellClass += "bg-rose-500/10 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400 border border-rose-500/20 dark:border-rose-500/30 hover:bg-rose-500/25 dark:hover:bg-rose-500/35";
                    } else {
                      cellClass += "bg-[var(--color-surface-3)] text-[var(--color-text)] hover:bg-[var(--color-surface-2)]";
                    }
                  } else {
                    cellClass += "text-[var(--color-text-2)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-text)]";
                  }

                  if (isToday) {
                    cellClass += " ring-2 ring-[var(--color-brand-500)] ring-offset-2 ring-offset-[var(--color-surface-2)]";
                  }

                  if (isSelected) {
                    cellClass += " !bg-[var(--color-brand-500)] !text-white !border-transparent shadow-md scale-95";
                  } else if (isHovered) {
                    cellClass += " scale-105 shadow-sm";
                  }

                  return (
                    <div
                      key={`day-${day}`}
                      className={cellClass}
                      onMouseEnter={() => setHoveredDayKey(dateKey)}
                      onMouseLeave={() => setHoveredDayKey(null)}
                      onClick={() => setSelectedDayKey(selectedDayKey === dateKey ? null : dateKey)}
                    >
                      <span>{day}</span>
                      {hasTrade && !isSelected && (
                        <span className={`w-1.5 h-1.5 rounded-full mt-0.5 ${
                          isProfit ? "bg-emerald-500" : isLoss ? "bg-rose-500" : "bg-muted"
                        }`} />
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Selected or Hovered Details */}
            <div className="mt-4 pt-3 border-t border-[var(--color-border)] text-xs min-h-[55px] flex flex-col justify-center">
              {(() => {
                const activeKey = hoveredDayKey || selectedDayKey;
                if (activeKey) {
                  const [y, m, d] = activeKey.split("-");
                  const pnlVal = dailyPnL[activeKey];
                  const formattedDate = `${d}/${m}/${y}`;
                  
                  if (pnlVal !== undefined) {
                    const isProfit = pnlVal >= 0;
                    return (
                      <div className="space-y-1">
                        <div className="text-[var(--color-text-2)] font-medium">{formattedDate}</div>
                        <div className="flex items-center justify-between">
                          <span className="text-[var(--color-text-2)]">Resultado do dia:</span>
                          <span className={`font-bold ${isProfit ? "text-[var(--color-text-up)]" : "text-[var(--color-text-down)]"}`}>
                            {isProfit ? "+" : ""}{fmtUSD(pnlVal)}
                          </span>
                        </div>
                      </div>
                    );
                  } else {
                    return (
                      <div className="space-y-1">
                        <div className="text-[var(--color-text-2)] font-medium">{formattedDate}</div>
                        <div className="text-[var(--color-text-2)]">Sem operações encerradas.</div>
                      </div>
                    );
                  }
                }

                return (
                  <div className="text-[var(--color-text-2)] text-center italic">
                    Passe o mouse ou clique em um dia para ver os detalhes
                  </div>
                );
              })()}
            </div>
          </Card>
        </div>

      </div>

      {/* DETALHES DA POSIÇÃO MODAL */}
      {selectedPosition && (
        <Modal
          open={!!selectedPosition}
          onClose={() => setSelectedPosition(null)}
          title={
            <div className="flex items-center gap-2">
              <Info size={18} className="text-[var(--color-brand-500)]" />
              <span>Detalhes da Posição</span>
            </div>
          }
          size="lg"
        >
          <div className="space-y-6">
            {/* Top Banner: Status, Side, Symbol */}
            <div className="flex flex-wrap items-center justify-between gap-4 p-4 rounded-[var(--radius-md)] bg-[var(--color-surface-2)] border border-[var(--color-border)]">
              <div>
                <div className="text-xs text-[var(--color-text-2)] font-medium uppercase tracking-wider">Ativo / ID</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xl font-bold text-[var(--color-text)]">{selectedPosition.symbol}</span>
                  <span className="text-xs text-[var(--color-text-2)] font-mono bg-[var(--color-surface-3)] border border-[var(--color-border)] px-2 py-0.5 rounded">
                    {selectedPosition.id}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold ${
                  selectedPosition.side === "LONG" ? "bg-up-light text-up" : "bg-down-light text-down"
                }`}>
                  {selectedPosition.side === "LONG" ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                  {selectedPosition.side}
                </span>

                <Badge tone={selectedPosition.status === "open" ? "success" : "neutral"}>
                  {selectedPosition.status === "open" ? "Aberta" : "Fechada"}
                </Badge>
              </div>
            </div>

            {/* Main Grid: Parameters */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                <span className="block text-xs text-[var(--color-text-2)]">Estratégia</span>
                <span className="block text-sm font-semibold text-[var(--color-text)] mt-0.5">
                  {selectedPosition.strategy || selectedPosition.plan || "N/A"}
                </span>
              </div>
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                <span className="block text-xs text-[var(--color-text-2)]">Timeframe</span>
                <span className="block text-sm font-semibold text-[var(--color-text)] mt-0.5">
                  {selectedPosition.timeframe || "N/A"}
                </span>
              </div>
              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                <span className="block text-xs text-[var(--color-text-2)]">Quantidade</span>
                <span className="block text-sm font-mono font-semibold text-[var(--color-text)] mt-0.5">
                  {selectedPosition.quantity}
                </span>
              </div>

              <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                <span className="block text-xs text-[var(--color-text-2)]">Preço Entrada</span>
                <span className="block text-sm font-mono font-semibold text-[var(--color-text)] mt-0.5">
                  {fmtUSD(selectedPosition.entryPrice)}
                </span>
              </div>

              {selectedPosition.status === "open" ? (
                <>
                  <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                    <span className="block text-xs text-[var(--color-text-2)]">Preço Atual</span>
                    <span className="block text-sm font-mono font-semibold text-[var(--color-brand-500)] mt-0.5">
                      {fmtUSD(prices[selectedPosition.symbol] || selectedPosition.entryPrice)}
                    </span>
                  </div>
                  <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                    <span className="block text-xs text-[var(--color-text-2)]">P&L Live</span>
                    {(() => {
                      const curPrice = prices[selectedPosition.symbol] || selectedPosition.entryPrice;
                      const pnl = selectedPosition.side === "LONG" 
                        ? (curPrice - selectedPosition.entryPrice) * selectedPosition.quantity 
                        : (selectedPosition.entryPrice - curPrice) * selectedPosition.quantity;
                      const isProfit = pnl >= 0;
                      return (
                        <span className={`block text-sm font-mono font-bold mt-0.5 ${isProfit ? "text-up" : "text-down"}`}>
                          {isProfit ? "+" : ""}{fmtUSD(pnl)}
                        </span>
                      );
                    })()}
                  </div>
                </>
              ) : (
                <>
                  <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                    <span className="block text-xs text-[var(--color-text-2)]">Preço Saída</span>
                    <span className="block text-sm font-mono font-semibold text-[var(--color-text)] mt-0.5">
                      {selectedPosition.exitPrice ? fmtUSD(selectedPosition.exitPrice) : "-"}
                    </span>
                  </div>
                  <div className="p-3 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                    <span className="block text-xs text-[var(--color-text-2)]">P&L Realizado</span>
                    {(() => {
                      const pnlVal = typeof selectedPosition.pnl === "number" ? selectedPosition.pnl : parseFloat((selectedPosition as any).pnl || "0");
                      const isProfit = pnlVal >= 0;
                      return (
                        <span className={`block text-sm font-mono font-bold mt-0.5 ${isProfit ? "text-up" : "text-down"}`}>
                          {isProfit ? "+" : ""}{fmtUSD(pnlVal)}
                        </span>
                      );
                    })()}
                  </div>
                </>
              )}
            </div>

            {/* Execution Details / Timestamps */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Timestamps */}
              <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)] space-y-2">
                <h4 className="text-xs font-semibold text-[var(--color-text-2)] uppercase tracking-wider mb-3">Linha do Tempo</h4>
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--color-text-2)]">Abertura:</span>
                  <span className="font-mono text-[var(--color-text)]">
                    {new Date(selectedPosition.openedAt).toLocaleString()}
                  </span>
                </div>
                {selectedPosition.closedAt && (
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--color-text-2)]">Fechamento:</span>
                    <span className="font-mono text-[var(--color-text)]">
                      {new Date(selectedPosition.closedAt).toLocaleString()}
                    </span>
                  </div>
                )}
              </div>

              {/* Binance Info */}
              <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)] space-y-2">
                <h4 className="text-xs font-semibold text-[var(--color-text-2)] uppercase tracking-wider mb-3">Dados de Execução (Binance)</h4>
                <div className="flex justify-between text-xs">
                  <span className="text-[var(--color-text-2)]">ID Ordem Entrada:</span>
                  <span className="font-mono text-[var(--color-text)] select-all">{selectedPosition.orderId || "-"}</span>
                </div>
                {selectedPosition.ocoOrderListId && (
                  <div className="flex justify-between text-xs">
                    <span className="text-[var(--color-text-2)]">ID OCO List:</span>
                    <span className="font-mono text-[var(--color-text)] select-all">{selectedPosition.ocoOrderListId}</span>
                  </div>
                )}
                {selectedPosition.status === "closed" && (
                  <>
                    {selectedPosition.exitOrderId && (
                      <div className="flex justify-between text-xs">
                        <span className="text-[var(--color-text-2)]">ID Ordem Saída:</span>
                        <span className="font-mono text-[var(--color-text)] select-all">{selectedPosition.exitOrderId || "-"}</span>
                      </div>
                    )}
                    {selectedPosition.exitReason && (
                      <div className="flex justify-between text-xs">
                        <span className="text-[var(--color-text-2)]">Motivo Saída:</span>
                        <span className="text-[var(--color-text)]">{selectedPosition.exitReason || "-"}</span>
                      </div>
                    )}
                  </>
                )}
                {selectedPosition.status === "open" && (
                  <>
                    <div className="flex justify-between text-xs">
                      <span className="text-[var(--color-text-2)]">Stop Loss:</span>
                      <span className="font-mono text-down">{selectedPosition.stopPrice ? fmtUSD(selectedPosition.stopPrice) : "-"}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-[var(--color-text-2)]">Take Profit:</span>
                      <span className="font-mono text-up">{selectedPosition.takeProfitPrice ? fmtUSD(selectedPosition.takeProfitPrice) : "-"}</span>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Conditions Checklist Section */}
            {selectedPosition.conditions && selectedPosition.conditions.length > 0 && (
              <div className="p-4 rounded-[var(--radius-md)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
                <h4 className="text-xs font-semibold text-[var(--color-text-2)] uppercase tracking-wider mb-3">Condições de Entrada Atendidas</h4>
                <div className="space-y-2">
                  {selectedPosition.conditions.map((cond, idx) => (
                    <div key={idx} className="flex items-center justify-between p-2 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs">
                      <div className="flex items-center gap-2">
                        {cond.pass ? (
                          <CheckCircle2 size={14} className="text-up" />
                        ) : (
                          <XCircle size={14} className="text-down" />
                        )}
                        <span className={cond.pass ? "text-[var(--color-text)] font-medium" : "text-[var(--color-text-2)]"}>
                          {cond.label}
                        </span>
                      </div>
                      <div className="font-mono text-[var(--color-text-2)]">
                        Valor: <span className="text-[var(--color-text)]">{cond.actual}</span> (Req: {cond.required})
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Raw JSON View (Collapsible) */}
            <details className="group p-3 rounded-[var(--radius-md)] bg-[var(--color-surface-3)] border border-[var(--color-border)]">
              <summary className="text-xs font-semibold text-[var(--color-text-2)] uppercase tracking-wider cursor-pointer select-none list-none flex items-center justify-between">
                <span>Dados Brutos (JSON)</span>
                <ChevronRight size={14} className="transform group-open:rotate-90 transition-transform" />
              </summary>
              <pre className="mt-3 p-3 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)] text-[10px] font-mono text-[var(--color-text-2)] overflow-x-auto select-all max-h-48">
                {JSON.stringify(selectedPosition, null, 2)}
              </pre>
            </details>
          </div>
        </Modal>
      )}

    </div>
  );
}
