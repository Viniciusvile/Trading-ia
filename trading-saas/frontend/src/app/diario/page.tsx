"use client";

import { useEffect, useState } from "react";
import {
  BookOpen,
  MessageSquare,
  TrendingUp,
  TrendingDown,
  Activity,
  Filter,
  RefreshCw,
  Search,
  DollarSign,
  Percent,
  CheckCircle2,
  Calendar,
  Lock,
} from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge, Modal, EmptyState } from "@/components/ui";
import { fmtDateTime, fmtUSD, fmtPct } from "@/lib/format";
import { api } from "@/lib/api";

interface Position {
  id: string;
  symbol: string;
  timeframe: string;
  side: string;
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  stopPrice: number;
  takeProfitPrice: number;
  pnl: number | null;
  openedAt: string;
  closedAt: string | null;
  status: "open" | "closed";
  strategy?: string;
  plan?: string;
  journalNote?: string;
}

interface Strategy {
  id?: string;
  name: string;
  symbol: string;
  timeframe: string;
  active: boolean;
  activated_at?: string | null;
}

export default function DiarioPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [microScalperRunning, setMicroScalperRunning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [selectedStrategy, setSelectedStrategy] = useState("all");
  const [selectedSymbol, setSelectedSymbol] = useState("all");
  const [selectedStatus, setSelectedStatus] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");

  // Micro-Scalper coin selector
  const [selectedMicroSymbol, setSelectedMicroSymbol] = useState("Geral");

  // Modal State
  const [activePosition, setActivePosition] = useState<Position | null>(null);
  const [noteText, setNoteText] = useState("");
  const [savingNote, setSavingNote] = useState(false);

  async function loadData() {
    setRefreshing(true);
    try {
      const [posRes, stratRes, msStatusRes] = await Promise.all([
        api.botPositions(),
        api.botStrategies(),
        api.microScalperStatus().catch(() => ({ success: false, running: false })),
      ]);

      if (posRes && posRes.positions) {
        setPositions(posRes.positions);
      }
      if (stratRes && stratRes.strategies) {
        const mappedStrats = stratRes.strategies.map((s: any) => ({
          id: s.id,
          name: s.name,
          symbol: s.symbols?.[0] || s.symbol || "",
          timeframe: s.timeframes?.[0] || s.timeframe || "",
          active: s.active || s.is_active || false,
          activated_at: s.activated_at || null,
        }));
        setStrategies(mappedStrats);
      }
      if (msStatusRes && msStatusRes.success) {
        setMicroScalperRunning(msStatusRes.running);
      }
    } catch (err) {
      console.error("Erro ao carregar dados do diário", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function saveNote() {
    if (!activePosition) return;
    setSavingNote(true);
    try {
      const res = await api.botSavePositionNote(activePosition.id, noteText);
      if (res && res.success) {
        setPositions((prev) =>
          prev.map((p) =>
            p.id === activePosition.id ? { ...p, journalNote: noteText } : p
          )
        );
        setActivePosition(null);
      }
    } catch (err) {
      console.error("Erro ao salvar anotação", err);
    } finally {
      setSavingNote(false);
    }
  }

  // 1. Calcular estatísticas globais
  const closedPositions = positions.filter((p) => p.status === "closed");
  const totalTrades = closedPositions.length;
  const wins = closedPositions.filter((p) => (p.pnl || 0) > 0).length;
  const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
  const totalPnL = closedPositions.reduce((acc, p) => acc + (p.pnl || 0), 0);

  // PNL do Mês
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const monthlyPnL = closedPositions
    .filter((p) => {
      if (!p.closedAt) return false;
      const closedDate = new Date(p.closedAt);
      return closedDate.getFullYear() === currentYear && closedDate.getMonth() === currentMonth;
    })
    .reduce((acc, p) => acc + (p.pnl || 0), 0);

  // Fator de Lucro
  const grossProfit = closedPositions
    .filter((p) => (p.pnl || 0) > 0)
    .reduce((acc, p) => acc + (p.pnl || 0), 0);
  const grossLoss = Math.abs(
    closedPositions
      .filter((p) => (p.pnl || 0) < 0)
      .reduce((acc, p) => acc + (p.pnl || 0), 0)
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

  // 2. Estatísticas específicas do Micro-Scalper
  const microPositions = closedPositions.filter(
    (p) =>
      p.plan === "Micro-Scalper" ||
      (p.strategy && p.strategy.toLowerCase().includes("micro"))
  );
  const microSymbols = Array.from(new Set(microPositions.map((p) => p.symbol)));

  const activeMicroPositions = selectedMicroSymbol === "Geral"
    ? microPositions
    : microPositions.filter((p) => p.symbol === selectedMicroSymbol);

  const microTotal = activeMicroPositions.length;
  const microWins = activeMicroPositions.filter((p) => (p.pnl || 0) > 0).length;
  const microWinRate = microTotal > 0 ? (microWins / microTotal) * 100 : 0;
  const microPnL = activeMicroPositions.reduce((acc, p) => acc + (p.pnl || 0), 0);

  // 3. Agrupar trades para calcular estatísticas por estratégia customizada
  const strategyStats = strategies.map((strat) => {
    const stratNameLower = strat.name.toLowerCase();
    const stratPositions = closedPositions.filter((p) => {
      const pStrat = p.strategy?.toLowerCase() || "";
      const pPlan = p.plan?.toLowerCase() || "";
      return (
        pStrat === stratNameLower ||
        pPlan === stratNameLower ||
        (stratNameLower === "micro-scalper" && p.plan === "Micro-Scalper")
      );
    });

    const sTotal = stratPositions.length;
    const sWins = stratPositions.filter((p) => (p.pnl || 0) > 0).length;
    const sWinRate = sTotal > 0 ? (sWins / sTotal) * 100 : 0;
    const sPnL = stratPositions.reduce((acc, p) => acc + (p.pnl || 0), 0);

    return {
      ...strat,
      totalTrades: sTotal,
      winRate: sWinRate,
      pnl: sPnL,
    };
  });

  // 4. Obter lista única de símbolos para filtro
  const uniqueSymbols = Array.from(new Set(positions.map((p) => p.symbol)));

  // 5. Filtrar posições para exibição no log
  const filteredPositions = positions.filter((p) => {
    if (selectedStrategy !== "all") {
      const stratNameLower = selectedStrategy.toLowerCase();
      const pStrat = p.strategy?.toLowerCase() || "";
      const pPlan = p.plan?.toLowerCase() || "";
      const isMatch =
        pStrat === stratNameLower ||
        pPlan === stratNameLower ||
        (stratNameLower === "micro-scalper" && p.plan === "Micro-Scalper");
      if (!isMatch) return false;
    }
    if (selectedSymbol !== "all" && p.symbol !== selectedSymbol) return false;
    if (selectedStatus !== "all" && p.status !== selectedStatus) return false;
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchSymbol = p.symbol.toLowerCase().includes(query);
      const matchStrategy = (p.strategy || "").toLowerCase().includes(query);
      const matchNote = (p.journalNote || "").toLowerCase().includes(query);
      if (!matchSymbol && !matchStrategy && !matchNote) return false;
    }
    return true;
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <PageHeader
          title="Diário de operações"
          description="Monitore os trades executados e analise a taxa de acerto real das estratégias pós-ativação."
        />
        <Button
          variant="outline"
          size="sm"
          leftIcon={<RefreshCw className={refreshing ? "animate-spin" : ""} size={14} />}
          onClick={loadData}
          disabled={loading || refreshing}
        >
          Atualizar dados
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="animate-pulse h-24 bg-[var(--color-surface)]" />
          ))}
        </div>
      ) : (
        <>
          {/* Métricas Globais Pós-Ativação */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card padding="md" className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted font-medium uppercase tracking-wider">Taxa de Acerto Real</div>
                <div className="text-2xl font-bold mt-1 tabular-nums">{fmtPct(winRate)}</div>
              </div>
              <div className="h-10 w-10 rounded-[var(--radius-sm)] bg-[var(--color-brand-500)]/10 flex items-center justify-center text-[var(--color-brand-500)]">
                <Percent size={20} />
              </div>
            </Card>

            <Card padding="md" className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted font-medium uppercase tracking-wider">PnL do Mês Real</div>
                <div className={`text-2xl font-bold mt-1 tabular-nums ${monthlyPnL >= 0 ? "text-[var(--color-up-500)]" : "text-[var(--color-down-500)]"}`}>
                  {monthlyPnL >= 0 ? "+" : ""}{fmtUSD(monthlyPnL)}
                </div>
              </div>
              <div className={`h-10 w-10 rounded-[var(--radius-sm)] flex items-center justify-center ${monthlyPnL >= 0 ? "bg-[var(--color-up-500)]/10 text-[var(--color-up-500)]" : "bg-[var(--color-down-500)]/10 text-[var(--color-down-500)]"}`}>
                <DollarSign size={20} />
              </div>
            </Card>

            <Card padding="md" className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted font-medium uppercase tracking-wider">Total de Trades</div>
                <div className="text-2xl font-bold mt-1 tabular-nums">{totalTrades}</div>
              </div>
              <div className="h-10 w-10 rounded-[var(--radius-sm)] bg-blue-500/10 flex items-center justify-center text-blue-500">
                <Activity size={20} />
              </div>
            </Card>

            <Card padding="md" className="flex items-center justify-between">
              <div>
                <div className="text-xs text-muted font-medium uppercase tracking-wider">Fator de Lucro</div>
                <div className="text-2xl font-bold mt-1 tabular-nums">{profitFactor.toFixed(2)}</div>
              </div>
              <div className="h-10 w-10 rounded-[var(--radius-sm)] bg-purple-500/10 flex items-center justify-center text-purple-500">
                <CheckCircle2 size={20} />
              </div>
            </Card>
          </div>

          {/* Performance Real por Estratégia */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-[var(--color-text-2)] uppercase tracking-wider">Performance por Estratégia (Ativas)</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              
              {/* Card Especial para o Micro-Scalper Core */}
              <Card padding="md" className="relative overflow-hidden border border-[var(--color-brand-500)]/30 bg-gradient-to-br from-[var(--color-surface)] to-[var(--color-brand-500)]/5 hover:border-[var(--color-brand-500)]/60 transition-all flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-bold text-[var(--color-text)] flex items-center gap-2">
                        <span>⚡ Micro-Scalper Bot</span>
                        <Badge tone={microScalperRunning ? "up" : "neutral"} size="sm">
                          {microScalperRunning ? "Ativo" : "Inativo"}
                        </Badge>
                      </div>
                      <div className="text-[10px] text-muted mt-0.5 font-medium">
                        Bot Core · Múltiplos ativos em 5m
                      </div>
                    </div>
                  </div>

                  {/* Coin Selector Pills */}
                  <div className="flex flex-wrap gap-1 mt-3">
                    <button
                      onClick={() => setSelectedMicroSymbol("Geral")}
                      className={`px-2 py-0.5 text-[10px] rounded-[var(--radius-sm)] border transition ${
                        selectedMicroSymbol === "Geral"
                          ? "bg-[var(--color-brand-500)] text-black border-[var(--color-brand-500)] font-semibold"
                          : "bg-[var(--color-surface-2)] text-muted hover:text-[var(--color-text)] border-[var(--color-border)]"
                      }`}
                    >
                      Geral
                    </button>
                    {microSymbols.map((sym) => (
                      <button
                        key={sym}
                        onClick={() => setSelectedMicroSymbol(sym)}
                        className={`px-2 py-0.5 text-[10px] rounded-[var(--radius-sm)] border transition ${
                          selectedMicroSymbol === sym
                            ? "bg-[var(--color-brand-500)] text-black border-[var(--color-brand-500)] font-semibold"
                            : "bg-[var(--color-surface-2)] text-muted hover:text-[var(--color-text)] border-[var(--color-border)]"
                        }`}
                      >
                        {sym.replace("USDT", "")}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-[var(--color-border)] text-center">
                  <div>
                    <div className="text-[10px] text-muted uppercase">Taxa Acerto</div>
                    <div className="text-sm font-bold tabular-nums text-[var(--color-text)] mt-0.5">
                      {microTotal > 0 ? fmtPct(microWinRate) : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted uppercase">PnL Real</div>
                    <div className={`text-sm font-bold tabular-nums mt-0.5 ${microPnL >= 0 ? "text-[var(--color-up-500)]" : "text-[var(--color-down-500)]"}`}>
                      {microTotal > 0 ? `${microPnL >= 0 ? "+" : ""}${fmtUSD(microPnL)}` : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted uppercase">Trades</div>
                    <div className="text-sm font-bold tabular-nums text-[var(--color-text)] mt-0.5">
                      {microTotal}
                    </div>
                  </div>
                </div>
              </Card>

              {/* Demais Estratégias Customizadas */}
              {strategyStats.map((strat, i) => (
                <Card key={strat.id || i} padding="md" className="relative overflow-hidden border border-[var(--color-border)] hover:border-[var(--color-border-strong)] transition-all flex flex-col justify-between">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-semibold text-[var(--color-text)] flex items-center gap-2">
                        {strat.name}
                        <Badge tone={strat.active ? "up" : "neutral"} size="sm">
                          {strat.active ? "Ativa" : "Inativa"}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted mt-0.5">
                        {strat.symbol} · {strat.timeframe}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-4 pt-3 border-t border-[var(--color-border)] text-center">
                    <div>
                      <div className="text-[10px] text-muted uppercase">Taxa Acerto</div>
                      <div className="text-sm font-bold tabular-nums text-[var(--color-text)] mt-0.5">
                        {strat.totalTrades > 0 ? fmtPct(strat.winRate) : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted uppercase">PnL Real</div>
                      <div className={`text-sm font-bold tabular-nums mt-0.5 ${strat.pnl >= 0 ? "text-[var(--color-up-500)]" : "text-[var(--color-down-500)]"}`}>
                        {strat.totalTrades > 0 ? `${strat.pnl >= 0 ? "+" : ""}${fmtUSD(strat.pnl)}` : "—"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted uppercase">Trades</div>
                      <div className="text-sm font-bold tabular-nums text-[var(--color-text)] mt-0.5">
                        {strat.totalTrades}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}

            </div>
          </div>

          {/* Diário de Trades / Histórico */}
          <Card padding="md" className="space-y-4">
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <CardHeader
                icon={<BookOpen size={18} className="text-[var(--color-brand-500)]" />}
                title="Histórico de Trades & Anotações"
                subtitle="Examine cada operação e salve anotações de aprendizado"
              />

              {/* Filtros */}
              <div className="flex flex-wrap items-center gap-3">
                {/* Busca */}
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    placeholder="Buscar ativo/nota..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8 pr-3 py-1.5 w-48 text-xs bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] text-[var(--color-text)] placeholder-muted outline-none focus:border-[var(--color-brand-500)] transition"
                  />
                </div>

                {/* Filtro Estratégia */}
                <select
                  value={selectedStrategy}
                  onChange={(e) => setSelectedStrategy(e.target.value)}
                  className="bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[var(--color-text)] outline-none focus:border-[var(--color-brand-500)] cursor-pointer"
                >
                  <option value="all">Todas Estratégias</option>
                  <option value="Micro-Scalper">Micro-Scalper</option>
                  {strategies.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>

                {/* Filtro Par */}
                <select
                  value={selectedSymbol}
                  onChange={(e) => setSelectedSymbol(e.target.value)}
                  className="bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[var(--color-text)] outline-none focus:border-[var(--color-brand-500)] cursor-pointer"
                >
                  <option value="all">Todos Ativos</option>
                  {uniqueSymbols.map((sym) => (
                    <option key={sym} value={sym}>
                      {sym}
                    </option>
                  ))}
                </select>

                {/* Filtro Status */}
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  className="bg-[var(--color-surface-2)] border border-[var(--color-border)] text-xs rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[var(--color-text)] outline-none focus:border-[var(--color-brand-500)] cursor-pointer"
                >
                  <option value="all">Todos Status</option>
                  <option value="open">Aberto</option>
                  <option value="closed">Fechado</option>
                </select>
              </div>
            </div>

            {filteredPositions.length === 0 ? (
              <div className="py-12 border-t border-[var(--color-border)]">
                <EmptyState
                  icon={<BookOpen size={24} />}
                  title="Nenhum trade encontrado"
                  description="Os bots ainda não realizaram operações correspondentes aos filtros selecionados."
                />
              </div>
            ) : (
              <div className="overflow-x-auto border-t border-[var(--color-border)] -mx-4 sm:mx-0">
                <table className="w-full text-left border-collapse min-w-[700px] text-xs">
                  <thead>
                    <tr className="border-b border-[var(--color-border)] text-muted uppercase font-semibold text-[10px] tracking-wider">
                      <th className="py-3 px-4">Abertura</th>
                      <th className="py-3 px-4">Ativo / Lado</th>
                      <th className="py-3 px-4">Estratégia</th>
                      <th className="py-3 px-4 text-right">Preços</th>
                      <th className="py-3 px-4 text-right">Resultado (PnL)</th>
                      <th className="py-3 px-4">Anotação Técnica / Diário</th>
                      <th className="py-3 px-4 text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)] font-medium">
                    {filteredPositions.map((pos) => {
                      const hasNote = !!pos.journalNote;
                      const profit = (pos.pnl || 0) >= 0;
                      return (
                        <tr key={pos.id} className="hover:bg-[var(--color-surface-2)]/50 transition">
                          <td className="py-3.5 px-4 text-muted tabular-nums">
                            {pos.openedAt ? fmtDateTime(new Date(pos.openedAt)) : "—"}
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="font-bold text-[var(--color-text)]">{pos.symbol}</div>
                            <div className="mt-0.5">
                              <Badge tone={pos.side === "LONG" ? "up" : "down"} size="sm">
                                {pos.side}
                              </Badge>
                            </div>
                          </td>
                          <td className="py-3.5 px-4 text-[var(--color-text-2)]">
                            <span className="font-semibold text-[var(--color-text)]">{pos.plan || "Manual"}</span>
                            <span className="block text-[10px] text-muted">
                              {pos.strategy || "default"} · {pos.timeframe || "5m"}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right tabular-nums">
                            <div className="text-[var(--color-text)]">Entrada: {fmtUSD(pos.entryPrice)}</div>
                            {pos.exitPrice && (
                              <div className="text-muted text-[10px] mt-0.5">Saída: {fmtUSD(pos.exitPrice)}</div>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right tabular-nums">
                            {pos.status === "open" ? (
                              <Badge tone="warn" dot>Aberto</Badge>
                            ) : (
                              <div className="flex flex-col items-end">
                                <span className={profit ? "text-[var(--color-up-500)] font-bold" : "text-[var(--color-down-500)] font-bold"}>
                                  {profit ? "+" : ""}{pos.pnl !== null ? fmtUSD(pos.pnl) : "—"}
                                </span>
                                {pos.pnl !== null && pos.entryPrice ? (
                                  <span className={`text-[10px] mt-0.5 font-semibold ${profit ? "text-[var(--color-up-500)]" : "text-[var(--color-down-500)]"}`}>
                                    {(() => {
                                      const entry = pos.entryPrice;
                                      const exit = pos.exitPrice || entry;
                                      const side = pos.side === "LONG" ? 1 : -1;
                                      const pct = ((exit - entry) / entry) * 100 * side;
                                      return fmtPct(pct);
                                    })()}
                                  </span>
                                ) : null}
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4 max-w-[200px]">
                            {hasNote ? (
                              <div className="flex items-center gap-1.5 text-muted hover:text-[var(--color-text)] transition cursor-pointer" onClick={() => {
                                setActivePosition(pos);
                                setNoteText(pos.journalNote || "");
                              }}>
                                <MessageSquare size={13} className="shrink-0 text-[var(--color-brand-500)]" />
                                <span className="truncate">{pos.journalNote}</span>
                              </div>
                            ) : (
                              <span className="text-muted italic text-[11px]">Sem anotações</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setActivePosition(pos);
                                setNoteText(pos.journalNote || "");
                              }}
                            >
                              {hasNote ? "Editar" : "Anotar"}
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
        </>
      )}

      {/* Modal de Anotação do Trade */}
      <Modal
        open={!!activePosition}
        onClose={() => setActivePosition(null)}
        title="Anotação de Operação"
        description="Analise as condições técnicas do trade e registre o seu diário comportamental/técnico."
        footer={
          <>
            <Button variant="ghost" onClick={() => setActivePosition(null)} disabled={savingNote}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={saveNote} disabled={savingNote}>
              {savingNote ? "Salvando..." : "Salvar Diário"}
            </Button>
          </>
        }
      >
        {activePosition && (
          <div className="space-y-4">
            {/* Resumo do Trade */}
            <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] p-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <span className="text-muted block">Par & Direção:</span>
                <span className="font-bold text-[var(--color-text)]">
                  {activePosition.symbol} ({activePosition.side})
                </span>
              </div>
              <div>
                <span className="text-muted block">Estratégia:</span>
                <span className="font-bold text-[var(--color-text)]">
                  {activePosition.plan || "Manual"} ({activePosition.strategy || "default"})
                </span>
              </div>
              <div>
                <span className="text-muted block">Preço de Entrada:</span>
                <span className="font-bold text-[var(--color-text)] tabular-nums">
                  {fmtUSD(activePosition.entryPrice)}
                </span>
              </div>
              <div>
                <span className="text-muted block">Preço de Saída / PnL:</span>
                <span className="font-bold text-[var(--color-text)] tabular-nums">
                  {activePosition.exitPrice ? fmtUSD(activePosition.exitPrice) : "—"} ·{" "}
                  <span className={activePosition.pnl !== null && activePosition.pnl >= 0 ? "text-[var(--color-up-500)]" : "text-[var(--color-down-500)]"}>
                    {activePosition.pnl !== null ? fmtUSD(activePosition.pnl) : "Aberto"}
                  </span>
                </span>
              </div>
            </div>

            {/* Campo da Nota */}
            <div>
              <label className="block text-xs font-semibold text-[var(--color-text-2)] mb-1.5">
                O que você observou neste trade? (Gatilhos, contexto, erros ou acertos)
              </label>
              <textarea
                value={noteText}
                onChange={(e) => setNoteText(e.target.value)}
                rows={5}
                placeholder="Descreva o contexto do mercado, seu sentimento na entrada/saída, se respeitou o gerenciamento de risco, etc."
                className="w-full px-3 py-2 text-sm rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] text-[var(--color-text)] outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/15 resize-none"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
