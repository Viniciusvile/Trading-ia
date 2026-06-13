"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Bot, Pause, Play, AlertTriangle, FileText, Settings, Zap, HelpCircle, CheckCircle2, XCircle, Info } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge, Stat, Tooltip, Modal, Input } from "@/components/ui";
import { AnimatedNumber, SymbolIcon, PillTabs } from "@/components/fx";
import { fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";
import { toast } from "sonner";

// Traduções legíveis para sinais/motivos técnicos do histórico de decisões
const REASON_LABELS: Record<string, string> = {
  stop_loss: "Stop Loss atingido",
  timeout: "Tempo esgotado",
  binance_oco_filled: "Alvo atingido (OCO)",
  take_profit: "Alvo atingido",
  manual: "Fechamento manual",
  trailing_stop: "Trailing stop",
  "turbo-reversion-bottom": "Reversão no fundo (Turbo)",
  "micro-dip": "Queda curta (Micro Dip)",
};
const labelFor = (key?: string) => (key ? REASON_LABELS[key] ?? key.replace(/[-_]/g, " ") : "");

interface BotData {
  id: string;
  name: string;
  description: string;
  status: "online" | "paused" | "offline";
  pnl24h: number;
  trades24h: number;
  strategy: string;
  symbol: string;
}

export default function BotsPage() {
  const [bots, setBots] = useState<BotData[]>([
    {
      id: "masterbot",
      name: "MasterBot",
      description: "Bot principal de trading automático",
      status: "offline",
      pnl24h: 0,
      trades24h: 0,
      strategy: "Alpha-RangeMaster",
      symbol: "BTCUSDT",
    },
    {
      id: "micro-scalper",
      name: "Micro Scalper",
      description: "Operações rápidas em timeframe baixo",
      status: "offline",
      pnl24h: 0,
      trades24h: 0,
      strategy: "Scalper-1m",
      symbol: "SOLUSDT",
    },
    {
      id: "futures",
      name: "Bot Futuros",
      description: "Operações de alavancagem em futuros",
      status: "offline",
      pnl24h: 0,
      trades24h: 0,
      strategy: "Warrior-Futures",
      symbol: "BTCUSDT",
    },
  ]);

  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [isEmergencyLoading, setIsEmergencyLoading] = useState(false);
  const [historyFilter, setHistoryFilter] = useState<"all" | "buys" | "sells" | "scans">("all");

  // States for interactive actions
  const [loadingMap, setLoadingMap] = useState<Record<string, boolean>>({});
  
  // Settings Modal State
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  // Masterbot & Futures configuration fields
  const [masterConfig, setMasterConfig] = useState({
    symbol: "BTCUSDT",
    timeframe: "4H",
    strategy: "warrior",
    portfolio: 200,
    maxTrade: 20,
    paperTrading: true,
    dailyMaxLoss: 0,
    loopInterval: "1h",
    activePlan: "" as string | null,
    activePlans: [] as string[],
    groupPlans: [] as { name: string; description: string; symbols: string[] }[],
  });

  // Micro scalper configuration fields
  const [microConfig, setMicroConfig] = useState({
    max_trade_usdt: 20,
    loop_interval_ms: 5000,
    active_symbols: [] as string[],
    timeout_enabled: true,
  });

  // Logs Modal State
  const [logsOpen, setLogsOpen] = useState(false);
  const [logBotId, setLogBotId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // About Modal State
  const [aboutOpen, setAboutOpen] = useState(false);
  const [aboutBotId, setAboutBotId] = useState<string | null>(null);

  // Decision history state
  const [decisionHistory, setDecisionHistory] = useState<any[]>([]);
  const [decisionDetailsOpen, setDecisionDetailsOpen] = useState(false);
  const [selectedDecision, setSelectedDecision] = useState<any | null>(null);

  // Headers com JWT para os fetch diretos (endpoints exigem login)
  const legacyAuthHeaders = (): Record<string, string> => {
    const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  // Function to load all bot statuses
  const refreshStatuses = async () => {
    try {
      const [masterRes, microRes, futuresRes, microLogRes] = await Promise.all([
        api.botMasterStatus(),
        api.microScalperStatus(),
        api.botFuturesStatus(),
        fetch("/api/legacy/micro-scalper/log?limit=5", { headers: legacyAuthHeaders() }).then(r => r.json()).catch(() => null),
      ]);

      setBots(prev => prev.map(bot => {
        if (bot.id === "masterbot") {
          const isOnline = masterRes.isAlive;
          return {
            ...bot,
            status: isOnline ? "online" : "offline",
            strategy: masterRes.status === "waiting" ? "Aguardando Sinal" : (masterRes.status || bot.strategy),
            symbol: masterRes.watchlist ? masterRes.watchlist.slice(0, 3).join(", ") + "..." : bot.symbol,
            trades24h: masterRes.openPositions || 0,
          };
        }
        if (bot.id === "micro-scalper") {
          const isOnline = microRes.running;
          const dailyStats = microLogRes?.daily || { trades: 0, profit: 0 };
          // O scalper opera MÚLTIPLOS ativos — mostra todos os ativos ativos,
          // não só o símbolo do último trade (que travava o card em "SOLUSDT").
          const actives = microRes.activeSymbols || [];
          const symbolLabel = actives.length
            ? (actives.length > 3 ? actives.slice(0, 3).join(", ") + "…" : actives.join(", "))
            : (microLogRes?.trades?.[0]?.symbol || bot.symbol);
          return {
            ...bot,
            status: isOnline ? "online" : "paused",
            trades24h: dailyStats.trades || 0,
            pnl24h: dailyStats.profit || 0,
            symbol: symbolLabel,
          };
        }
        if (bot.id === "futures") {
          const isOnline = futuresRes.isAlive;
          return {
            ...bot,
            status: isOnline ? "online" : "offline",
            strategy: futuresRes.status === "stopped" ? "Pausado" : (futuresRes.status || bot.strategy),
            trades24h: futuresRes.openPositions || 0,
          };
        }
        return bot;
      }));

      // Histórico de decisões: varreduras do MasterBot + trades do Scalper
      const masterDecisions = (masterRes.lastResults || []).slice(0, 12).map(r => ({
        kind: "master" as const,
        time: masterRes.lastRun,
        ...r,
      }));
      const scalperDecisions = (microLogRes?.trades || []).slice(0, 5).map((t: any) => ({
        kind: "scalper" as const,
        ...t,
      }));
      setDecisionHistory(prev => {
        // Entre o início e o fim de um ciclo o MasterBot zera lastResults —
        // preserva as decisões anteriores para a lista não piscar vazia
        const masters = masterDecisions.length
          ? masterDecisions
          : prev.filter((p: any) => p.kind === "master");
        return [...masters, ...scalperDecisions];
      });
    } catch (err) {
      console.error("Erro ao atualizar status dos robôs:", err);
    }
  };

  useEffect(() => {
    refreshStatuses();
    const interval = setInterval(refreshStatuses, 5000);
    return () => clearInterval(interval);
  }, []);

  // Handle Turn On / Turn Off (Ligar / Pausar)
  const handleToggleBot = async (botId: string, currentStatus: "online" | "paused" | "offline") => {
    setLoadingMap(prev => ({ ...prev, [botId]: true }));
    const toStart = currentStatus !== "online";

    try {
      let res;
      if (botId === "masterbot") {
        res = toStart ? await api.botMasterStart() : await api.botMasterStop();
      } else if (botId === "micro-scalper") {
        res = toStart ? await api.microScalperStart() : await api.microScalperStop();
      } else {
        res = toStart ? await api.botFuturesStart() : await api.botFuturesStop();
      }

      if (res.success) {
        toast.success(`${botId === "masterbot" ? "MasterBot" : botId === "micro-scalper" ? "Micro Scalper" : "Bot Futuros"} ${toStart ? "iniciado" : "pausado"} com sucesso!`);
        await refreshStatuses();
      } else {
        toast.error(res.error || "Ocorreu um erro ao alterar o estado do robô.");
      }
    } catch (err: any) {
      toast.error(err.message || "Erro de conexão com o servidor.");
    } finally {
      setLoadingMap(prev => ({ ...prev, [botId]: false }));
    }
  };

  // Open Config Modal
  const handleOpenConfig = async (botId: string) => {
    setSelectedBotId(botId);
    setSettingsOpen(true);
    setConfigLoading(true);

    try {
      if (botId === "masterbot" || botId === "futures") {
        // api.botConfig envia o token JWT — fetch direto recebia 401 e o modal ficava nos defaults
        const configData = await api.botConfig();
        if (configData?.success) {
          setMasterConfig({
            symbol: configData.symbol || "BTCUSDT",
            timeframe: configData.timeframe || "4H",
            strategy: configData.strategyKey || "warrior",
            portfolio: configData.portfolio || 200,
            maxTrade: configData.maxTrade || 20,
            paperTrading: configData.paperTrading,
            dailyMaxLoss: configData.dailyMaxLoss || 0,
            loopInterval: configData.loopInterval || "1h",
            activePlan: configData.activePlan,
            activePlans: configData.activePlans || [],
            groupPlans: configData.groupPlans || [],
          });
        }
      } else if (botId === "micro-scalper") {
        // api.* envia o token JWT — o endpoint agora é por usuário e exige login
        const configData = await api.microScalperConfig();
        if (configData.success && configData.config) {
          setMicroConfig({
            max_trade_usdt: configData.config.max_trade_usdt || 20,
            loop_interval_ms: configData.config.loop_interval_ms || 5000,
            active_symbols: configData.config.active_symbols || [],
            timeout_enabled: configData.config.timeout_enabled !== false,
          });
        }
      }
    } catch (err) {
      toast.error("Falha ao carregar configurações do servidor.");
    } finally {
      setConfigLoading(false);
    }
  };

  // Save Configuration
  const handleSaveConfig = async () => {
    if (!selectedBotId) return;
    setSavingConfig(true);

    try {
      // O endpoint /bot/config agora exige login (ativa plano por usuário) —
      // anexa o JWT igual ao cliente api.ts, senão dá "Token ausente".
      const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
      const authHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      let res;
      if (selectedBotId === "masterbot" || selectedBotId === "futures") {
        res = await fetch("/api/legacy/bot/config", {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify(masterConfig),
        }).then(r => r.json());
      } else if (selectedBotId === "micro-scalper") {
        // Endpoint EXCLUSIVO do Micro Scalper — não toca nas configs do MasterBot
        res = await fetch("/api/legacy/micro-scalper/config", {
          method: "PATCH",
          headers: authHeaders,
          body: JSON.stringify({
            max_trade_usdt: microConfig.max_trade_usdt,
            timeout_enabled: microConfig.timeout_enabled,
          }),
        }).then(r => r.json());
      }

      if (res && res.success) {
        toast.success("Configuração atualizada e salva com sucesso!");
        setSettingsOpen(false);
        refreshStatuses();
      } else {
        toast.error(res?.error || "Erro ao salvar a configuração.");
      }
    } catch (err) {
      toast.error("Erro ao enviar atualizações de configuração.");
    } finally {
      setSavingConfig(false);
    }
  };

  // Open Log Modal
  const handleOpenLogs = async (botId: string) => {
    setLogBotId(botId);
    setLogsOpen(true);
    setLogsLoading(true);
    setLogLines([]);

    try {
      if (botId === "micro-scalper") {
        const logData = await fetch("/api/legacy/micro-scalper/log?limit=25", { headers: legacyAuthHeaders() }).then(r => r.json());
        if (logData.success && logData.trades) {
          const lines = logData.trades.map((tr: any) => {
            const timeStr = new Date(tr.t).toLocaleTimeString();
            if (tr.event === "entry") {
              return `[${timeStr}] [${tr.symbol}] ORDEM COMPRA ENVIADA - Qtd: ${tr.qty} | Preço: ${fmtUSD(tr.entryPrice)} | Sinal: ${tr.signal}`;
            } else {
              const profitText = tr.pnlPct ? ` | Retorno: ${(tr.pnlPct * 100).toFixed(2)}% (${fmtUSD(tr.pnlUsdt || 0)})` : "";
              return `[${timeStr}] [${tr.symbol}] POSIÇÃO FECHADA - Motivo: ${tr.reason} | Preço Saída: ${fmtUSD(tr.exitPrice)}${profitText}`;
            }
          });
          setLogLines(lines.length ? lines : ["Nenhum evento de trading registrado recentemente."]);
        }
      } else {
        // Master & Futures
        const logData = await api.botMasterRawLog();
        if (logData && logData.lines) {
          setLogLines(logData.lines.slice(-40));
        } else if (logData && logData.message) {
          setLogLines([logData.message]);
        } else {
          setLogLines(["Falha ao ler o arquivo de log do robô principal."]);
        }
      }
    } catch (err) {
      setLogLines(["Erro ao conectar com o serviço de logs do servidor."]);
    } finally {
      setLogsLoading(false);
    }
  };

  // Trigger Emergency Sell
  const handleEmergencySell = async () => {
    setIsEmergencyLoading(true);
    try {
      const res = await api.botEmergencySell();
      if (res.success) {
        toast.success(res.message || "Ordem de fechamento global enviada à Binance!");
        setEmergencyOpen(false);
        refreshStatuses();
      } else {
        toast.error(res.message || "A liquidação de emergência falhou.");
      }
    } catch (err: any) {
      toast.error(err.message || "Erro ao executar fechamento de emergência.");
    } finally {
      setIsEmergencyLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Bots"
        description="Controle os robôs de operação. Pausar não cancela posições abertas — apenas para de abrir novas."
        actions={
          <Button
            variant="danger"
            size="md"
            leftIcon={<AlertTriangle size={15} />}
            onClick={() => setEmergencyOpen(true)}
          >
            Vender tudo agora
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {bots.map((bot, botIdx) => {
          const isOnline = bot.status === "online";
          const isLoading = !!loadingMap[bot.id];
          const botSymbols = bot.symbol.split(",").map((s) => s.trim()).filter(Boolean);
          // Última decisão deste bot no histórico (contexto vivo no card)
          const lastDecision = decisionHistory.find((d: any) =>
            d.kind === "master" ? bot.id !== "micro-scalper" : bot.id === "micro-scalper"
          );

          return (
            <motion.div
              key={bot.id}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: botIdx * 0.07, duration: 0.3, ease: "easeOut" }}
            >
              <Card padding="lg" className={`h-full flex flex-col ${isOnline ? "border-[var(--color-up-500)]/25" : ""}`}>
                <CardHeader
                  icon={<Bot size={18} className={isOnline ? "text-[var(--color-up-300)]" : "text-[var(--color-muted)]"} />}
                  title={bot.name}
                  subtitle={bot.description}
                  action={
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium">
                      <span className="relative flex h-2 w-2">
                        {isOnline && (
                          <motion.span
                            className="absolute inline-flex h-full w-full rounded-full bg-[var(--color-up-500)]"
                            animate={{ scale: [1, 2.2], opacity: [0.6, 0] }}
                            transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
                          />
                        )}
                        <span className={`relative inline-flex h-2 w-2 rounded-full ${
                          isOnline ? "bg-[var(--color-up-500)]" : bot.status === "paused" ? "bg-[var(--color-warn-500)]" : "bg-[var(--color-muted-2)]"
                        }`} />
                      </span>
                      <span className={isOnline ? "text-up" : bot.status === "paused" ? "text-warn" : "text-muted"}>
                        {isOnline ? "Rodando" : bot.status === "paused" ? "Pausado" : "Desligado"}
                      </span>
                    </span>
                  }
                />
                <div className="grid grid-cols-2 gap-3 my-4">
                  <div className="flex flex-col gap-1">
                    <span className="text-[10px] uppercase tracking-[0.08em] font-semibold text-muted">P&L 24h</span>
                    <AnimatedNumber
                      value={bot.pnl24h}
                      format={(v) => `${v > 0 ? "+" : ""}${fmtUSD(v)}`}
                      className={`text-xl font-bold tabular-nums tracking-tight ${
                        bot.pnl24h > 0 ? "text-up" : bot.pnl24h < 0 ? "text-down" : "text-[var(--color-text)]"
                      }`}
                    />
                  </div>
                  <Stat label="Trades 24h" value={String(bot.trades24h)} size="sm" />
                </div>
                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted">Estratégia</span>
                    <span className="text-[var(--color-text)] font-medium truncate">{bot.strategy}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-muted">Ativos</span>
                    <span className="flex items-center -space-x-1.5">
                      {botSymbols.slice(0, 5).map((sym) => (
                        <SymbolIcon key={sym} symbol={sym} size={20} />
                      ))}
                      {botSymbols.length > 5 && (
                        <span className="pl-2.5 text-[10px] text-muted">+{botSymbols.length - 5}</span>
                      )}
                    </span>
                  </div>
                  {lastDecision && (
                    <div className="flex items-center justify-between gap-2 pt-1">
                      <span className="text-muted">Última ação</span>
                      <span className="text-[var(--color-text-2)] text-[11px] truncate">
                        {(lastDecision as any).kind === "master"
                          ? `${(lastDecision as any).signal === "NEUTRO" ? "varredura sem sinal" : (lastDecision as any).signal} · ${(lastDecision as any).symbol}`
                          : `${(lastDecision as any).event === "entry" ? "compra" : "venda"} · ${(lastDecision as any).symbol}`}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 mt-4 pt-4 border-t border-[var(--color-border)] mt-auto">
                  {isOnline ? (
                    <Button
                      variant="outline"
                      size="sm"
                      leftIcon={<Pause size={14} />}
                      fullWidth
                      loading={isLoading}
                      onClick={() => handleToggleBot(bot.id, bot.status)}
                    >
                      Pausar
                    </Button>
                  ) : (
                    <Button
                      variant="success"
                      size="sm"
                      leftIcon={<Play size={14} />}
                      fullWidth
                      loading={isLoading}
                      onClick={() => handleToggleBot(bot.id, bot.status)}
                    >
                      Ligar
                    </Button>
                  )}
                  <Tooltip content="Configurações do bot">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Configurar"
                      onClick={() => handleOpenConfig(bot.id)}
                    >
                      <Settings size={14} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Ver log de execução">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Logs"
                      onClick={() => handleOpenLogs(bot.id)}
                    >
                      <FileText size={14} />
                    </Button>
                  </Tooltip>
                  <Tooltip content="Sobre o robô (Funcionamento e Travas)">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="Sobre"
                      onClick={() => {
                        setAboutBotId(bot.id);
                        setAboutOpen(true);
                      }}
                    >
                      <HelpCircle size={14} />
                    </Button>
                  </Tooltip>
                </div>
              </Card>
            </motion.div>
          );
        })}
      </div>

      <Card padding="lg">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <CardHeader
            icon={<Zap size={18} className="text-[var(--color-warn-500)]" />}
            title="Histórico de decisões"
            subtitle="Cada ciclo do bot e o motivo das ações"
            className="mb-0"
          />
          <PillTabs
            options={[
              { value: "all", label: "Tudo" },
              { value: "buys", label: "Compras" },
              { value: "sells", label: "Vendas" },
              { value: "scans", label: "Varreduras" },
            ]}
            value={historyFilter}
            onChange={(v) => setHistoryFilter(v as typeof historyFilter)}
          />
        </div>
        {(() => {
          const filtered = decisionHistory.filter((item: any) => {
            if (historyFilter === "all") return true;
            if (historyFilter === "scans") return item.kind === "master";
            if (item.kind === "master") return false;
            return historyFilter === "buys" ? item.event === "entry" : item.event === "exit";
          });
          if (filtered.length === 0) {
            return (
              <div className="text-xs text-muted text-center py-10">
                {decisionHistory.length === 0
                  ? "Nenhuma decisão registrada ainda nesta sessão. Quando seus bots começarem a operar, o histórico aparecerá aqui."
                  : "Nada nesse filtro por enquanto."}
              </div>
            );
          }
          return (
            <div className="mt-4 divide-y divide-[var(--color-border)]">
              {filtered.map((item: any, idx: number) => {
                const isMaster = item.kind === "master";
                const isEntry = !isMaster && item.event === "entry";
                const isWin = !isMaster && !isEntry && item.pnlPct > 0;
                return (
                  <motion.div
                    key={idx}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: Math.min(idx * 0.04, 0.4), duration: 0.25, ease: "easeOut" }}
                    className="flex items-center gap-3 py-3 text-xs cursor-pointer hover:bg-[rgba(255,255,255,0.03)] px-3 -mx-3 rounded-lg transition-all"
                    onClick={() => {
                      setSelectedDecision(item);
                      setDecisionDetailsOpen(true);
                    }}
                  >
                    <SymbolIcon symbol={item.symbol} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isMaster ? (
                          <Badge tone={item.signal === "NEUTRO" ? "neutral" : item.signal === "SEM SALDO" ? "down" : "up"} size="sm">
                            {item.signal === "NEUTRO" ? "SEM SINAL" : item.signal}
                          </Badge>
                        ) : (
                          <Badge tone={isEntry ? "brand" : isWin ? "up" : "down"} size="sm">
                            {isEntry ? "COMPRA" : "VENDA"}
                          </Badge>
                        )}
                        <span className="font-semibold text-sm text-[var(--color-text)]">
                          {String(item.symbol || "").replace("USDT", "")}
                        </span>
                        <span className="text-[10px] text-muted">{isMaster ? "MasterBot" : "Micro Scalper"}</span>
                      </div>
                      <div className="text-muted mt-0.5 truncate">
                        {isMaster
                          ? `${item.timeframe ?? ""}${item.strategy ? ` · ${labelFor(item.strategy)}` : ""}`
                          : isEntry
                            ? `Sinal: ${labelFor(item.signal)}`
                            : `Motivo: ${labelFor(item.reason)}`}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={
                        isMaster
                          ? "text-[var(--color-text)] font-medium tabular-nums"
                          : isEntry
                            ? "text-[var(--color-text)] font-medium tabular-nums"
                            : `font-bold tabular-nums ${isWin ? "text-up" : "text-down"}`
                      }>
                        {isMaster
                          ? (item.price != null ? fmtUSD(item.price) : "—")
                          : isEntry
                            ? fmtUSD(item.entryPrice)
                            : `${item.pnlPct > 0 ? "+" : ""}${(item.pnlPct * 100).toFixed(2)}%`}
                      </div>
                      <div className="text-[10px] text-muted mt-0.5">
                        {isMaster
                          ? (item.time ? new Date(item.time).toLocaleTimeString("pt-BR") : "")
                          : new Date(item.t).toLocaleTimeString("pt-BR")}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          );
        })()}
      </Card>

      {/* Emergency Sell Modal */}
      <Modal
        open={emergencyOpen}
        onClose={() => setEmergencyOpen(false)}
        title="Vender tudo agora?"
        description="Isso vai fechar TODAS as posições abertas pelos bots a mercado na Binance. Use apenas em emergência."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEmergencyOpen(false)}>
              Cancelar
            </Button>
            <Button variant="danger" loading={isEmergencyLoading} onClick={handleEmergencySell}>
              Sim, vender tudo
            </Button>
          </>
        }
      >
        <div className="text-sm text-[var(--color-text-2)]">
          Esta ação é <strong>irreversível</strong>. Ela enviará comandos de venda imediata a mercado para todos os ativos em custódia ativa dos bots.
        </div>
      </Modal>

      {/* About Bot Modal */}
      <Modal
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        title={aboutBotId === "masterbot" ? "Sobre o MasterBot" : aboutBotId === "micro-scalper" ? "Sobre o Micro Scalper" : "Sobre o Bot Futuros"}
        description="Entenda o funcionamento, limites de posições e travas de segurança deste robô."
        footer={
          <Button variant="primary" onClick={() => setAboutOpen(false)}>
            Entendi
          </Button>
        }
      >
        <div className="space-y-4 text-xs text-[var(--color-text-2)] leading-relaxed">
          {aboutBotId === "masterbot" && (
            <>
              <div>
                <h4 className="text-sm font-semibold text-[var(--color-text)] mb-1">🔍 Como Funciona?</h4>
                <p>
                  O MasterBot opera de forma periódica (em ciclos programados, ex: a cada 1 hora). A cada ciclo, ele analisa todos os ativos da watchlist selecionada e executa as regras das estratégias ativas definidas em <strong className="text-[var(--color-text)]">rules.json</strong> (como Warrior ou Range-v2) nos timeframes configurados.
                </p>
              </div>

              <div className="p-3.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] space-y-2.5">
                <h4 className="text-sm font-semibold text-[var(--color-text)]">🛡️ Limites & Travas de Segurança</h4>
                
                <div className="flex items-start gap-2">
                  <span className="text-[var(--color-brand-500)] font-bold">⏱️</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Um trade por vez por ativo:</strong>
                    Se já houver uma posição aberta do mesmo ativo (ex: <code className="text-amber-500">BTCUSDT</code>), o robô ignorará qualquer novo sinal de entrada desse mesmo ativo para evitar compra duplicada.
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <span className="text-[var(--color-brand-500)] font-bold">📊</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Limite de Posições Simultâneas:</strong>
                    Livre / Sem trava apertada por padrão (máximo de até 999 posições simultâneas de ativos diferentes no mercado).
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <span className="text-[var(--color-brand-500)] font-bold">💰</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Valor por Operação:</strong>
                    Limitado pelo valor definido em "Tam. Máx. Operação ($)" da estratégia ou do plano individual do ativo.
                  </div>
                </div>
              </div>
            </>
          )}

          {aboutBotId === "micro-scalper" && (
            <>
              <div>
                <h4 className="text-sm font-semibold text-[var(--color-text)] mb-1">⚡ Como Funciona?</h4>
                <p>
                  O Micro Scalper executa em um loop de alta velocidade (a cada 5 segundos). Ele analisa gráficos de curtíssimo prazo (1m e 5m) em busca de sinais rápidos de reversão ou correções curtas (<em className="text-[var(--color-text)]">turbo-reversion</em> ou <em className="text-[var(--color-text)]">micro-dip</em>), buscando lucros rápidos com Take Profit e Stop Loss curtos.
                </p>
              </div>

              <div className="p-3.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] space-y-2.5">
                <h4 className="text-sm font-semibold text-[var(--color-text)]">🛡️ Limites & Travas de Segurança</h4>

                <div className="flex items-start gap-2">
                  <span className="text-emerald-500 font-bold">⏱️</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Um trade por vez por ativo:</strong>
                    Mantém apenas uma operação ativa por ativo. Ele só voltará a procurar sinais de entrada para aquele ativo depois que a posição atual dele for fechada.
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <span className="text-emerald-500 font-bold">🚦</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Circuit Breaker (Perdas Seguidas):</strong>
                    Se acumular 3 perdas seguidas (Stop Loss) em um ativo, as novas operações desse ativo são pausadas por 30 minutos.
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <span className="text-emerald-500 font-bold">⚠️</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Filtro de Queda do BTC:</strong>
                    Se o Bitcoin despencar mais de 1.5% em 15 minutos, todas as novas entradas de scalper em altcoins são temporariamente travadas.
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <span className="text-emerald-500 font-bold">📅</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Limite Máximo de Trades:</strong>
                    Limite de até 50 trades por sessão para evitar super-exposição ao mercado.
                  </div>
                </div>
              </div>
            </>
          )}

          {aboutBotId === "futures" && (
            <>
              <div>
                <h4 className="text-sm font-semibold text-[var(--color-text)] mb-1">🚀 Como Funciona?</h4>
                <p>
                  O Bot de Futuros monitora o mercado em busca de tendências fortes nos gráficos de 1H e 4H. Ele abre posições direcionais de alta ou baixa (LONG/SHORT) utilizando alavancagem para maximizar o retorno das tendências.
                </p>
              </div>

              <div className="p-3.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface-2)] space-y-2.5">
                <h4 className="text-sm font-semibold text-[var(--color-text)]">🛡️ Limites & Travas de Segurança</h4>

                <div className="flex items-start gap-2">
                  <span className="text-amber-500 font-bold">⏱️</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Um trade por vez por ativo:</strong>
                    Garante no máximo uma posição de futuros por ativo por vez para mitigar riscos de liquidação.
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <span className="text-amber-500 font-bold">⚙️</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Alavancagem Limitada:</strong>
                    Configurado por plano (geralmente limitado a 5x) para garantir que a margem suporta flutuações sem risco excessivo de liquidação imediata.
                  </div>
                </div>

                <div className="flex items-start gap-2">
                  <span className="text-amber-500 font-bold">🛡️</span>
                  <div>
                    <strong className="text-[var(--color-text)] block">Auditoria Ativa de Ordens:</strong>
                    Se a ordem de TP ou SL sumir ou for cancelada na Binance Futuros, o watchdog do servidor a repõe automaticamente em segundos.
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </Modal>
 
      {/* Decision Details Modal */}
      <Modal
        open={decisionDetailsOpen}
        onClose={() => setDecisionDetailsOpen(false)}
        title="Detalhes da Decisão Técnica"
        description="Checklist detalhado dos critérios técnicos e segurança que determinaram a ação do robô."
        footer={
          <Button variant="primary" onClick={() => setDecisionDetailsOpen(false)}>
            Fechar
          </Button>
        }
      >
        {selectedDecision ? (
          <div className="space-y-4 text-xs text-[var(--color-text-2)] leading-relaxed">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-3">
              <div className="flex items-center gap-3">
                <SymbolIcon symbol={selectedDecision.symbol} size={36} />
                <div>
                  <h4 className="text-sm font-semibold text-[var(--color-text)]">
                    {String(selectedDecision.symbol || "").replace("USDT", "")} / USDT
                  </h4>
                  <div className="text-[10px] text-muted">
                    {selectedDecision.kind === "master" ? "MasterBot" : "Micro Scalper"}
                    {selectedDecision.timeframe ? ` · ${selectedDecision.timeframe}` : ""}
                    {selectedDecision.strategy ? ` · ${labelFor(selectedDecision.strategy)}` : ""}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-muted">Preço analisado</div>
                <div className="text-sm font-bold text-[var(--color-text)]">
                  {selectedDecision.price != null ? fmtUSD(selectedDecision.price) : (selectedDecision.entryPrice != null ? fmtUSD(selectedDecision.entryPrice) : "—")}
                </div>
              </div>
            </div>

            {/* Status Banner */}
            {selectedDecision.kind === "master" ? (
              selectedDecision.allPass ? (
                <div className="p-3 rounded-lg border border-emerald-950/20 bg-emerald-500/10 text-emerald-400 flex items-start gap-2.5">
                  <CheckCircle2 size={16} className="shrink-0 mt-0.5 text-emerald-400" />
                  <div>
                    <strong className="block text-xs font-semibold">Sinal Aprovado para Entrada</strong>
                    Todos os critérios técnicos e travas de segurança foram validados com sucesso para este ativo.
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-lg border border-red-950/20 bg-red-500/10 text-red-400 flex items-start gap-2.5">
                  <XCircle size={16} className="shrink-0 mt-0.5 text-red-400" />
                  <div>
                    <strong className="block text-xs font-semibold">Decisão: Neutro / Sinal Reprovado</strong>
                    O sinal foi ignorado porque um ou mais critérios técnicos ou regras de segurança não foram satisfeitos.
                  </div>
                </div>
              )
            ) : (
              <div className="p-3 rounded-lg border border-blue-950/20 bg-blue-500/10 text-blue-400 flex items-start gap-2.5">
                <Info size={16} className="shrink-0 mt-0.5 text-blue-400" />
                <div>
                  <strong className="block text-xs font-semibold">
                    {selectedDecision.event === "entry" ? "Entrada Executada" : "Saída Executada"}
                  </strong>
                  {selectedDecision.event === "entry" 
                    ? `Ordem de Compra enviada via Scalper pelo sinal: ${labelFor(selectedDecision.signal)}.`
                    : `Ordem de Venda enviada via Scalper. Motivo: ${labelFor(selectedDecision.reason)}.`}
                </div>
              </div>
            )}

            {/* Technical Checklist */}
            <div>
              <h5 className="text-xs font-semibold text-[var(--color-text)] mb-2 uppercase tracking-wider text-muted">
                Critérios Analisados
              </h5>
              {selectedDecision.conditions && selectedDecision.conditions.length > 0 ? (
                <div className="border border-[var(--color-border)] rounded-lg overflow-hidden divide-y divide-[var(--color-border)] bg-[var(--color-surface-2)]">
                  {selectedDecision.conditions.map((cond: any, cIdx: number) => (
                    <div key={cIdx} className="flex items-center justify-between p-2.5 hover:bg-[rgba(255,255,255,0.01)] transition-colors">
                      <div className="min-w-0 flex-1 pr-3">
                        <span className="font-medium text-[var(--color-text)] block truncate">
                          {cond.label}
                        </span>
                        <div className="text-[9px] text-muted flex items-center gap-1.5 mt-0.5">
                          <span>Requerido: <span className="font-mono text-[var(--color-text-2)]">{cond.required}</span></span>
                          <span>·</span>
                          <span>Atual: <span className="font-mono text-[var(--color-text-2)]">{cond.actual}</span></span>
                        </div>
                      </div>
                      <div className="shrink-0">
                        {cond.pass ? (
                          <Badge tone="up" size="sm" className="font-semibold px-2 py-0.5 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block"></span>
                            Aprovado
                          </Badge>
                        ) : (
                          <Badge tone="down" size="sm" className="font-semibold px-2 py-0.5 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block"></span>
                            Reprovado
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : selectedDecision.kind === "master" ? (
                <div className="p-4 border border-[var(--color-border)] rounded-lg text-center text-muted bg-[var(--color-surface-2)]">
                  Nenhum checklist de filtros gravado para este ciclo (sinal antigo ou aguardando próximo ciclo).
                </div>
              ) : (
                <div className="p-4 border border-[var(--color-border)] rounded-lg text-muted bg-[var(--color-surface-2)] space-y-1.5">
                  <p>
                    O robô <strong>Micro Scalper</strong> opera de forma reativa a eventos rápidos no gráfico de ticks/1m. Ele executa de forma direta e sem filtros adicionais de concorrência macro.
                  </p>
                  <div className="text-[10px] text-muted mt-2">
                    • Sinal: <span className="font-mono text-[var(--color-text)]">{selectedDecision.signal || "N/A"}</span> <br />
                    {selectedDecision.event === "exit" && (
                      <>
                        • Motivo: <span className="font-mono text-[var(--color-text)]">{selectedDecision.reason || "N/A"}</span> <br />
                        • P&L: <span className={`font-mono font-bold ${selectedDecision.pnlPct > 0 ? "text-up" : "text-down"}`}>
                          {(selectedDecision.pnlPct * 100).toFixed(2)}%
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Additional details */}
            <div className="flex items-center justify-between text-[10px] text-muted pt-2 border-t border-[var(--color-border)]">
              <span>Horário da varredura: {selectedDecision.time ? new Date(selectedDecision.time).toLocaleString("pt-BR") : (selectedDecision.t ? new Date(selectedDecision.t).toLocaleString("pt-BR") : "—")}</span>
              {selectedDecision.plan && (
                <span>Plano: <strong className="text-[var(--color-text)]">{selectedDecision.plan}</strong></span>
              )}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Config Modal */}
      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={selectedBotId === "masterbot" ? "Configurações: MasterBot" : selectedBotId === "micro-scalper" ? "Configurações: Micro Scalper" : "Configurações: Bot Futuros"}
        description="Ajuste os parâmetros operacionais. Salvar aplicará as alterações e poderá reiniciar o robô."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSettingsOpen(false)}>
              Cancelar
            </Button>
            <Button variant="primary" loading={savingConfig} onClick={handleSaveConfig}>
              Salvar Configuração
            </Button>
          </>
        }
      >
        {configLoading ? (
          <div className="text-center py-6 text-sm text-muted">Carregando configurações do servidor...</div>
        ) : selectedBotId === "masterbot" || selectedBotId === "futures" ? (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1">
                Estratégias ativas no robô
              </label>
              {masterConfig.groupPlans.length === 0 ? (
                <p className="text-[11px] text-muted p-3 rounded border border-dashed border-[var(--color-border)]">
                  Você ainda não criou estratégias. Crie na página Estratégias para ativá-las aqui.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {masterConfig.groupPlans.map(plan => {
                    const checked = masterConfig.activePlans.includes(plan.name);
                    return (
                      <label
                        key={plan.name}
                        className={`flex items-center gap-2.5 p-2.5 rounded-[var(--radius-sm)] border cursor-pointer transition-colors ${
                          checked
                            ? "border-[var(--color-brand-500)] bg-brand-soft"
                            : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-border-strong)]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={e =>
                            setMasterConfig(prev => ({
                              ...prev,
                              activePlans: e.target.checked
                                ? [...prev.activePlans, plan.name]
                                : prev.activePlans.filter(n => n !== plan.name),
                            }))
                          }
                          className="w-4 h-4 accent-[var(--color-brand-500)]"
                        />
                        <span className="text-xs font-medium text-[var(--color-text)]">
                          {plan.name}{" "}
                          <span className="text-muted font-normal">({plan.symbols.join(", ")})</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-[10px] text-muted mt-1.5">
                {masterConfig.activePlans.length > 0
                  ? `${masterConfig.activePlans.length} estratégia${masterConfig.activePlans.length > 1 ? "s" : ""} ativa${masterConfig.activePlans.length > 1 ? "s" : ""} ao mesmo tempo — cada ativo opera com as regras da própria estratégia. Se duas cobrirem o mesmo ativo, vale a primeira.`
                  : "Nenhuma marcada = modo avulso: o robô opera um único ativo com o motor clássico, símbolo e timeframe abaixo."}
              </p>
            </div>

            {masterConfig.activePlans.length === 0 && (
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1">
                  Motor clássico (modo avulso)
                </label>
                <select
                  value={masterConfig.strategy}
                  onChange={e => setMasterConfig(prev => ({ ...prev, strategy: e.target.value }))}
                  className="w-full h-10 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] outline-none"
                >
                  <option value="warrior">Warrior Trading (Ross Cameron)</option>
                  <option value="stormer">123 Stormer (Alexandre Wolwacz)</option>
                  <option value="both">Ambas (Warrior + Stormer)</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1">
                Intervalo de execução do robô
              </label>
              <select
                value={masterConfig.loopInterval}
                onChange={e => setMasterConfig(prev => ({ ...prev, loopInterval: e.target.value }))}
                className="w-full h-10 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] outline-none"
              >
                <option value="10m">A cada 10 minutos</option>
                <option value="15m">A cada 15 minutos</option>
                <option value="20m">A cada 20 minutos</option>
                <option value="30m">A cada 30 minutos</option>
                <option value="45m">A cada 45 minutos</option>
                <option value="1h">A cada 1 hora</option>
              </select>
              <p className="text-[10px] text-muted mt-1">
                Frequência com que o robô varre o mercado em busca de sinais. Aplica no próximo ciclo, sem precisar reiniciar.
              </p>
            </div>

            {masterConfig.activePlans.length === 0 && (
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Símbolo Ativo"
                  value={masterConfig.symbol}
                  onChange={e => setMasterConfig(prev => ({ ...prev, symbol: e.target.value.toUpperCase() }))}
                />
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1">
                    Timeframe
                  </label>
                  <select
                    value={masterConfig.timeframe}
                    onChange={e => setMasterConfig(prev => ({ ...prev, timeframe: e.target.value }))}
                    className="w-full h-10 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] outline-none"
                  >
                    <option value="1m">1m</option>
                    <option value="5m">5m</option>
                    <option value="15m">15m</option>
                    <option value="30m">30m</option>
                    <option value="1H">1H</option>
                    <option value="4H">4H</option>
                    <option value="1D">1D</option>
                  </select>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Valor Portfólio ($)"
                type="number"
                value={masterConfig.portfolio}
                onChange={e => setMasterConfig(prev => ({ ...prev, portfolio: Number(e.target.value) }))}
              />
              <Input
                label="Tam. Máx. Operação ($)"
                type="number"
                value={masterConfig.maxTrade}
                onChange={e => setMasterConfig(prev => ({ ...prev, maxTrade: Number(e.target.value) }))}
              />
            </div>

            <div>
              <Input
                label="Perda máxima diária ($) — kill switch"
                type="number"
                value={masterConfig.dailyMaxLoss}
                onChange={e => setMasterConfig(prev => ({ ...prev, dailyMaxLoss: Number(e.target.value) }))}
              />
              <p className="text-[10px] text-muted mt-1">
                Ao atingir essa perda realizada no dia (UTC), TODOS os robôs param de abrir novas operações até o dia seguinte.
                Posições abertas continuam monitoradas. 0 = desligado.
              </p>
            </div>

            <div className="flex items-center justify-between p-3 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)]">
              <div>
                <div className="text-xs font-semibold">Modo Simulação (Paper Trading)</div>
                <div className="text-[10px] text-muted">Simula as ordens localmente sem expor saldo real.</div>
              </div>
              <input
                type="checkbox"
                checked={masterConfig.paperTrading}
                onChange={e => setMasterConfig(prev => ({ ...prev, paperTrading: e.target.checked }))}
                className="w-4 h-4 text-[var(--color-brand-500)]"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              label="Tamanho Máximo por Trade ($)"
              type="number"
              value={microConfig.max_trade_usdt}
              onChange={e => setMicroConfig(prev => ({ ...prev, max_trade_usdt: Number(e.target.value) }))}
            />

            <div className="flex items-center justify-between p-3 rounded bg-[var(--color-surface-2)] border border-[var(--color-border)]">
              <div>
                <div className="text-xs font-semibold">Timeout de Segurança (1h)</div>
                <div className="text-[10px] text-muted">Fecha automaticamente após 1 hora para evitar posições presas.</div>
              </div>
              <input
                type="checkbox"
                checked={microConfig.timeout_enabled}
                onChange={e => setMicroConfig(prev => ({ ...prev, timeout_enabled: e.target.checked }))}
                className="w-4 h-4 text-[var(--color-brand-500)] cursor-pointer"
              />
            </div>

            <div className="text-xs text-muted">
              * O Micro-Scalper roda de forma automatizada operando múltiplos ativos baseados nos presets de sinal do robô (XRP, SOL, etc.). A quantidade comprada respeita o limite financeiro configurado acima.
            </div>
          </div>
        )}
      </Modal>

      {/* Logs Modal */}
      <Modal
        open={logsOpen}
        onClose={() => setLogsOpen(false)}
        title={`Logs de Execução: ${logBotId === "masterbot" ? "MasterBot" : logBotId === "micro-scalper" ? "Micro Scalper" : "Bot Futuros"}`}
        size="lg"
      >
        {logsLoading ? (
          <div className="text-center py-10 text-sm text-muted">Carregando logs do servidor...</div>
        ) : (
          <div className="space-y-3">
            <div className="text-xs text-muted flex justify-between">
              <span>Últimas linhas capturadas no console do robô:</span>
              <button onClick={() => handleOpenLogs(logBotId!)} className="text-[var(--color-brand-500)] hover:underline font-semibold">
                Atualizar logs
              </button>
            </div>
            <pre className="bg-[var(--color-surface-3)] p-4 rounded-[var(--radius-sm)] text-[11px] font-mono text-[var(--color-text)] h-80 overflow-y-auto whitespace-pre-wrap border border-[var(--color-border)]">
              {logLines.join("\n")}
            </pre>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted">{label}</span>
      <span className="font-medium text-[var(--color-text-2)]">{value}</span>
    </div>
  );
}
