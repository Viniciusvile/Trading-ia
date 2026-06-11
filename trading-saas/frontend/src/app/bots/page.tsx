"use client";

import { useState, useEffect } from "react";
import { Bot, Pause, Play, AlertTriangle, FileText, Settings, Zap } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge, Stat, Tooltip, Modal, Input } from "@/components/ui";
import { fmtUSD } from "@/lib/format";
import { api } from "@/lib/api";
import { toast } from "sonner";

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
    activePlan: "" as string | null,
    groupPlans: [] as { name: string; description: string; symbols: string[] }[],
  });

  // Micro scalper configuration fields
  const [microConfig, setMicroConfig] = useState({
    max_trade_usdt: 20,
    loop_interval_ms: 5000,
    active_symbols: [] as string[],
  });

  // Logs Modal State
  const [logsOpen, setLogsOpen] = useState(false);
  const [logBotId, setLogBotId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Decision history state
  const [decisionHistory, setDecisionHistory] = useState<any[]>([]);

  // Function to load all bot statuses
  const refreshStatuses = async () => {
    try {
      const [masterRes, microRes, futuresRes, microLogRes] = await Promise.all([
        api.botMasterStatus(),
        api.microScalperStatus(),
        api.botFuturesStatus(),
        fetch("/api/legacy/micro-scalper/log?limit=5").then(r => r.json()).catch(() => null),
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
          return {
            ...bot,
            status: isOnline ? "online" : "paused",
            trades24h: dailyStats.trades || 0,
            pnl24h: dailyStats.profit || 0,
            symbol: microLogRes?.trades?.[0]?.symbol || bot.symbol,
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

      if (microLogRes?.trades) {
        setDecisionHistory(microLogRes.trades.slice(0, 5));
      }
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
            activePlan: configData.activePlan,
            groupPlans: configData.groupPlans || [],
          });
        }
      } else if (botId === "micro-scalper") {
        const configData = await fetch("/api/legacy/micro-scalper/config").then(r => r.json());
        if (configData.success && configData.config) {
          setMicroConfig({
            max_trade_usdt: configData.config.max_trade_usdt || 20,
            loop_interval_ms: configData.config.loop_interval_ms || 5000,
            active_symbols: configData.config.active_symbols || [],
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
      let res;
      if (selectedBotId === "masterbot" || selectedBotId === "futures") {
        res = await fetch("/api/legacy/bot/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(masterConfig),
        }).then(r => r.json());
      } else if (selectedBotId === "micro-scalper") {
        // Envia as chaves usando o endpoint geral de bot config para persistir no rules.json
        res = await fetch("/api/legacy/bot/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            maxTrade: microConfig.max_trade_usdt,
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
        const logData = await fetch("/api/legacy/micro-scalper/log?limit=25").then(r => r.json());
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
        {bots.map((bot) => {
          const isOnline = bot.status === "online";
          const isLoading = !!loadingMap[bot.id];

          return (
            <Card key={bot.id} padding="lg" interactive>
              <CardHeader
                icon={<Bot size={18} className="text-[var(--color-brand-500)]" />}
                title={bot.name}
                subtitle={bot.description}
                action={
                  <Badge tone={bot.status === "online" ? "up" : bot.status === "paused" ? "warn" : "neutral"} dot>
                    {bot.status === "online" ? "Rodando" : bot.status === "paused" ? "Pausado" : "Desligado"}
                  </Badge>
                }
              />
              <div className="grid grid-cols-2 gap-3 my-4">
                <Stat label="P&L 24h" value={fmtUSD(bot.pnl24h)} size="sm" />
                <Stat label="Trades 24h" value={String(bot.trades24h)} size="sm" />
              </div>
              <div className="space-y-1.5 text-xs">
                <Row label="Estratégia" value={bot.strategy} />
                <Row label="Símbolo" value={bot.symbol} />
              </div>
              <div className="flex gap-2 mt-4 pt-4 border-t border-[var(--color-border)]">
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
              </div>
            </Card>
          );
        })}
      </div>

      <Card padding="lg">
        <CardHeader
          icon={<Zap size={18} className="text-[var(--color-warn-500)]" />}
          title="Histórico de decisões"
          subtitle="Cada ciclo do bot e o motivo das ações"
        />
        {decisionHistory.length > 0 ? (
          <div className="space-y-2 mt-4">
            {decisionHistory.map((item, idx) => (
              <div key={idx} className="flex justify-between items-center text-xs p-2.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)]">
                <div className="flex items-center gap-2">
                  <Badge tone={item.event === "entry" ? "brand" : item.pnlPct > 0 ? "up" : "down"}>
                    {item.event === "entry" ? "COMPRA" : "VENDA"}
                  </Badge>
                  <span className="font-semibold text-[var(--color-text)]">{item.symbol}</span>
                  <span className="text-muted">| {item.event === "entry" ? `Sinal: ${item.signal}` : `Motivo: ${item.reason}`}</span>
                </div>
                <div className="text-right">
                  <span className="text-muted mr-3">{new Date(item.t).toLocaleTimeString()}</span>
                  <span className={item.event === "exit" ? (item.pnlPct > 0 ? "text-[var(--color-up-600)] font-bold" : "text-[var(--color-down-600)] font-bold") : "text-[var(--color-text)]"}>
                    {item.event === "entry" ? fmtUSD(item.entryPrice) : `${item.pnlPct > 0 ? "+" : ""}${(item.pnlPct * 100).toFixed(2)}%`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-xs text-muted text-center py-10">
            Nenhuma decisão registrada ainda nesta sessão. Quando seus bots começarem a operar,
            o histórico aparecerá aqui.
          </div>
        )}
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
            {masterConfig.activePlan && (
              <p className="text-[11px] text-muted bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] p-2.5">
                O plano ativo <strong className="text-[var(--color-text)]">{masterConfig.activePlan}</strong> define
                a estratégia, os ativos e os timeframes. Os campos abaixo só valem no modo avulso (sem plano ativo).
              </p>
            )}

            <div>
              <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1">
                Estratégia do Robô {masterConfig.activePlan && "(definida pelo plano)"}
              </label>
              <select
                value={masterConfig.strategy}
                disabled={!!masterConfig.activePlan}
                onChange={e => setMasterConfig(prev => ({ ...prev, strategy: e.target.value }))}
                className="w-full h-10 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] outline-none disabled:opacity-50"
              >
                <option value="warrior">Warrior Trading (Ross Cameron)</option>
                <option value="stormer">123 Stormer (Alexandre Wolwacz)</option>
                <option value="both">Ambas (Warrior + Stormer)</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Símbolo Ativo"
                value={masterConfig.symbol}
                disabled={!!masterConfig.activePlan}
                onChange={e => setMasterConfig(prev => ({ ...prev, symbol: e.target.value.toUpperCase() }))}
              />
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1">
                  Timeframe
                </label>
                <select
                  value={masterConfig.timeframe}
                  disabled={!!masterConfig.activePlan}
                  onChange={e => setMasterConfig(prev => ({ ...prev, timeframe: e.target.value }))}
                  className="w-full h-10 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] outline-none disabled:opacity-50"
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

            {masterConfig.groupPlans.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1">
                  Plano de Grupo Ativo
                </label>
                <select
                  value={masterConfig.activePlan || ""}
                  onChange={e => setMasterConfig(prev => ({ ...prev, activePlan: e.target.value || null }))}
                  className="w-full h-10 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] outline-none"
                >
                  <option value="">Nenhum plano ativado (Usar configurações avulsas acima)</option>
                  {masterConfig.groupPlans.map((plan, i) => (
                    <option key={i} value={plan.name}>
                      {plan.name} ({plan.symbols.join(", ")})
                    </option>
                  ))}
                </select>
              </div>
            )}

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
