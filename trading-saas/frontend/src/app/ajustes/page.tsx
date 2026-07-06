"use client";
 
import { useEffect, useState } from "react";
import { Sun, Moon, Languages, ShieldCheck, KeyRound, BellRing, Sparkles, Plus, Trash2, Check, HelpCircle, ExternalLink, Info, Zap, Crown, Loader2, ArrowRight, Lock, ArrowUpRight, Activity, Brain, Rocket } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge } from "@/components/ui";
import { PushPermission } from "@/components/PushPermission";
import { api } from "@/lib/api";
import { toast } from "sonner";
 
interface Plan {
  id: string;
  name: string;
  price_brl: number;
  max_bots: number;
  max_strategies: number;
  features: string[];
}

export default function AjustesPage() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [advanced, setAdvanced] = useState(false);

  // Accounts state
  const [accounts, setAccounts] = useState<{ id: string; name: string; apiKey: string; isActive: boolean; isTestnet: boolean; exchange?: string; createdAt: string }[]>([]);
  const [newAccExchange, setNewAccExchange] = useState<"binance" | "coinbase">("binance");
  const [showAddModal, setShowAddModal] = useState(false);
  const [newAccName, setNewAccName] = useState("");
  const [newAccApiKey, setNewAccApiKey] = useState("");
  const [newAccSecretKey, setNewAccSecretKey] = useState("");
  const [newAccIsTestnet, setNewAccIsTestnet] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  // Billing/Plans state
  const [plans, setPlans] = useState<Plan[]>([]);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [loadingBilling, setLoadingBilling] = useState(true);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [managingPortal, setManagingPortal] = useState(false);
  const [showAllPlans, setShowAllPlans] = useState(false);
  
  useEffect(() => {
    const saved = (localStorage.getItem("theme") as "light" | "dark" | null) ?? "dark";
    setTheme(saved);
  }, []);

  async function loadAccounts() {
    try {
      const res = await api.accountsList();
      if (res.success && res.accounts) {
        setAccounts(res.accounts);
      }
    } catch (e) {
      console.error("Erro ao carregar contas:", e);
    }
  }

  async function loadBillingData() {
    setLoadingBilling(true);
    try {
      const [plansRes, meRes] = await Promise.all([
        api.billingPlans(),
        api.me()
      ]);
      setPlans(plansRes);
      if (meRes.success && meRes.user) {
        setCurrentUser(meRes.user);
      }
    } catch (e) {
      console.error("Erro ao carregar dados de faturamento:", e);
      toast.error("Não foi possível carregar as informações dos planos.");
    } finally {
      setLoadingBilling(false);
    }
  }

  useEffect(() => {
    loadAccounts();
    loadBillingData();

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("success") === "1") {
        toast.success("Assinatura atualizada com sucesso! Seus novos limites já estão ativos.");
        window.history.replaceState({}, "", "/ajustes");
      } else if (params.get("canceled") === "1") {
        toast.info("O processo de checkout foi cancelado.");
        window.history.replaceState({}, "", "/ajustes");
      }
    }
  }, []);
 
  function applyTheme(next: "light" | "dark") {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  }

  async function handleActivate(id: string) {
    try {
      const res = await api.accountActivate(id);
      if (res.success) {
        window.dispatchEvent(new Event("accounts-updated"));
        window.location.reload();
      }
    } catch (e) {
      console.error("Erro ao ativar conta:", e);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Tem certeza que deseja remover esta conta de API?")) return;
    try {
      const res = await api.accountDelete(id);
      if (res.success) {
        loadAccounts();
        window.dispatchEvent(new Event("accounts-updated"));
      }
    } catch (e) {
      console.error("Erro ao deletar conta:", e);
    }
  }

  async function handleAddAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!newAccName || !newAccApiKey || !newAccSecretKey) {
      setErrorMsg("Todos os campos são obrigatórios.");
      return;
    }
    setSubmitting(true);
    setErrorMsg("");
    try {
      const res = await api.accountCreate({
        name: newAccName,
        apiKey: newAccApiKey,
        secretKey: newAccSecretKey,
        isTestnet: newAccExchange === "coinbase" ? false : newAccIsTestnet,
        exchange: newAccExchange,
      });
      if (res.success) {
        setNewAccName("");
        setNewAccApiKey("");
        setNewAccSecretKey("");
        setNewAccIsTestnet(false);
        setNewAccExchange("binance");
        setShowAddModal(false);
        loadAccounts();
        window.dispatchEvent(new Event("accounts-updated"));
      } else {
        setErrorMsg(res.error || "Erro ao adicionar conta");
      }
    } catch (e: any) {
      setErrorMsg(e.message || "Erro na requisição");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckout(planId: string) {
    if (planId === "free") {
      toast.info("O plano Trial já está ativo por padrão.");
      return;
    }
    setCheckingOut(planId);
    try {
      const res = await api.billingCheckout(planId);
      if (res && res.checkout_url) {
        toast.success("Redirecionando para o Stripe Checkout...");
        window.location.href = res.checkout_url;
      } else {
        toast.error("Erro ao iniciar processo de pagamento.");
      }
    } catch (e: any) {
      console.error("Erro no checkout:", e);
      toast.error(e.message || "Não foi possível conectar ao Stripe.");
    } finally {
      setCheckingOut(null);
    }
  }

  async function handleManageSubscription() {
    setManagingPortal(true);
    try {
      const res = await api.billingPortal();
      if (res && res.portal_url) {
        toast.success("Redirecionando para o portal de faturamento...");
        window.location.href = res.portal_url;
      } else {
        toast.error("Erro ao abrir o portal de faturamento.");
      }
    } catch (e: any) {
      console.error("Erro no portal de faturamento:", e);
      toast.error(e.message || "Não foi possível abrir o portal de faturamento.");
    } finally {
      setManagingPortal(false);
    }
  }

  const planDetails: Record<string, { badgeTone: "brand" | "neutral" | "warn" | "success", desc: string, icon: any, highlight: boolean }> = {
    free: { badgeTone: "neutral", desc: "Experimente nossos bots básicos", icon: ShieldCheck, highlight: false },
    basic: { badgeTone: "brand", desc: "Perfeito para traders iniciantes", icon: Zap, highlight: false },
    pro: { badgeTone: "success", desc: "Acelere com mais robôs e flexibilidade", icon: Crown, highlight: true },
    ultra: { badgeTone: "warn", desc: "Poder total, sem travas e customização total", icon: Rocket, highlight: false }
  };

  const currentPlanId = currentUser?.plan || "free";
  const planStatus = currentUser?.plan_status || "trialing";
 
  return (
    <div className="space-y-5">
      <PageHeader title="Ajustes" description="Personalize o painel e configure suas chaves de API." />
 
      {/* Seção de Planos & Assinaturas */}
      <Card padding="lg">
        <CardHeader
          icon={<Crown size={18} className="text-[var(--color-brand-500)]" />}
          title={currentPlanId !== "free" && !showAllPlans ? "Minha Assinatura Ativa" : "Planos & Assinaturas"}
          subtitle={
            currentPlanId !== "free" && !showAllPlans 
              ? "Acompanhe as funcionalidades e limites liberados do seu plano operacional." 
              : "Escolha a potência ideal para seus bots e aumente seus limites operacionais."
          }
          action={
            currentPlanId !== "free" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAllPlans(!showAllPlans)}
                leftIcon={showAllPlans ? undefined : <ArrowUpRight size={13} />}
              >
                {showAllPlans ? "Ver Minha Assinatura" : "Ver Outros Planos / Upgrade"}
              </Button>
            ) : undefined
          }
        />
        
        {loadingBilling ? (
          <div className="flex h-[20vh] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--color-brand-500)]" />
          </div>
        ) : (
          <div className="space-y-6">
            {currentPlanId !== "free" && !showAllPlans ? (
              /* DASHBOARD DA ASSINATURA ATIVA */
              <div className="space-y-6">
                {/* Active Plan Detail Box */}
                {currentUser && (
                  (() => {
                    const activePlan = plans.find(p => p.id === currentPlanId);
                    const planName = activePlan?.name || currentPlanId.toUpperCase();
                    
                    // Determine styles based on plan
                    let themeColor = "var(--color-brand-500)";
                    let ringColor = "border-sky-500/20 bg-sky-500/5";
                    let cardBorder = "border-[var(--color-brand-500)]/[0.2] bg-[var(--color-brand-500)]/[0.02]";
                    let PlanIcon = Crown;

                    if (currentPlanId === "ultra") {
                      themeColor = "rgb(139, 92, 246)";
                      ringColor = "border-violet-500/20 bg-violet-500/5";
                      cardBorder = "border-violet-500/30 bg-gradient-to-br from-violet-950/10 via-zinc-900/10 to-zinc-950/20 shadow-[0_0_20px_rgba(139,92,246,0.05)]";
                      PlanIcon = Rocket;
                    } else if (currentPlanId === "pro") {
                      themeColor = "rgb(14, 165, 233)";
                      ringColor = "border-sky-500/20 bg-sky-500/5";
                      cardBorder = "border-sky-500/30 bg-gradient-to-br from-sky-950/10 via-zinc-900/10 to-zinc-950/20 shadow-[0_0_20px_rgba(14,165,233,0.05)]";
                      PlanIcon = Crown;
                    } else if (currentPlanId === "basic") {
                      themeColor = "rgb(245, 158, 11)";
                      ringColor = "border-amber-500/20 bg-amber-500/5";
                      cardBorder = "border-amber-500/30 bg-gradient-to-br from-amber-950/10 via-zinc-900/10 to-zinc-950/20 shadow-[0_0_20px_rgba(245,158,11,0.05)]";
                      PlanIcon = Zap;
                    }

                    return (
                      <div className={`rounded-[var(--radius-md)] border p-6 ${cardBorder}`}>
                        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                          <div className="flex items-start gap-4">
                            <div className={`p-3 rounded-full border ${ringColor} flex-shrink-0 animate-pulse`}>
                              <PlanIcon size={24} style={{ color: themeColor }} />
                            </div>
                            <div className="space-y-1">
                              <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Assinatura Ativa</div>
                              <div className="flex items-center gap-2">
                                <span className="text-xl font-extrabold tracking-tight text-[var(--color-text)]">
                                  Plano {planName}
                                </span>
                                <Badge tone="success" dot>Ativo</Badge>
                              </div>
                              <div className="text-xs text-muted flex items-center gap-2 flex-wrap">
                                <span>Status financeiro: <strong>Regularizado</strong></span>
                                <span className="text-zinc-700">•</span>
                                <span>Valor: <strong>R$ {activePlan?.price_brl || 0}/mês</strong></span>
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 w-full sm:w-auto">
                            {currentUser.stripe_customer_id && (
                              <Button 
                                variant="outline"
                                size="sm"
                                onClick={handleManageSubscription}
                                disabled={managingPortal}
                                rightIcon={managingPortal ? <Loader2 size={12} className="animate-spin" /> : <ArrowUpRight size={12} />}
                                className="w-full"
                              >
                                Gerenciar Faturamento
                              </Button>
                            )}
                          </div>
                        </div>

                        {/* Limits Row */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-6 pt-6 border-t border-[var(--color-border)]">
                          <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3">
                            <div className="space-y-1">
                              <span className="text-[10px] uppercase font-bold text-muted tracking-wider">Capacidade de Robôs</span>
                              <div className="text-lg font-bold text-[var(--color-text)]">
                                {currentUser.max_bots} {currentUser.max_bots === 1 ? "Robô" : "Robôs"} ativos
                              </div>
                              <div className="text-[10px] text-muted">Operações executadas simultaneamente</div>
                            </div>
                            <div className="h-2.5 w-24 bg-zinc-800 rounded-full overflow-hidden flex-shrink-0">
                              <div className="h-full rounded-full" style={{ width: '100%', backgroundColor: themeColor }}></div>
                            </div>
                          </div>

                          <div className="p-4 rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] border border-[var(--color-border)] flex flex-wrap items-center justify-between gap-3">
                            <div className="space-y-1">
                              <span className="text-[10px] uppercase font-bold text-muted tracking-wider">Banco de Estratégias</span>
                              <div className="text-lg font-bold text-[var(--color-text)]">
                                {currentUser.max_strategies} {currentUser.max_strategies === 1 ? "Estratégia" : "Estratégias"} salvas
                              </div>
                              <div className="text-[10px] text-muted">Configurações e setups salvos na nuvem</div>
                            </div>
                            <div className="h-2.5 w-24 bg-zinc-800 rounded-full overflow-hidden flex-shrink-0">
                              <div className="h-full rounded-full" style={{ width: '100%', backgroundColor: themeColor }}></div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                )}

                {/* Unlocked Features Area */}
                <div>
                  <h4 className="text-sm font-semibold text-[var(--color-text)] mb-3 flex items-center gap-1.5">
                    <Check size={16} className="text-emerald-500" /> Recursos Disponíveis do seu Plano
                  </h4>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {(() => {
                      const featureConfigs = [
                        {
                          id: "masterbot",
                          title: "Robô MasterBot",
                          description: "Sincronize operações automaticamente através de canais de sinais premium do Telegram e Discord.",
                          icon: Zap,
                          unlockedAt: ["free", "basic", "pro", "ultra"],
                          actionUrl: "/bots",
                          actionText: "Acessar MasterBot",
                          iconColor: "text-amber-500",
                          bgIcon: "bg-amber-500/10 border-amber-500/20"
                        },
                        {
                          id: "backtest",
                          title: "Backtesting de Alta Velocidade",
                          description: "Simule qualquer estratégia usando candles históricos reais de 5 minutos diretamente da Binance.",
                          icon: Activity,
                          unlockedAt: ["basic", "pro", "ultra"],
                          actionUrl: "/estrategias",
                          actionText: "Executar Backtest",
                          iconColor: "text-emerald-500",
                          bgIcon: "bg-emerald-500/10 border-emerald-500/20",
                          lockedDescription: "Backtests rápidos de 5m simulados com dados de mercado Binance. Disponível a partir do Starter.",
                        },
                        {
                          id: "scalper",
                          title: "Robô Micro-Scalper",
                          description: "Algoritmo de alta frequência operando oscilações curtas nos pares BTC, ETH, SOL e XRP.",
                          icon: Brain,
                          unlockedAt: ["pro", "ultra"],
                          actionUrl: "/estrategias",
                          actionText: "Configurar Scalper",
                          iconColor: "text-sky-500",
                          bgIcon: "bg-sky-500/10 border-sky-500/20",
                          lockedDescription: "Robô de alta frequência com customização total do Scalper. Disponível a partir do Plus.",
                        },
                        {
                          id: "ai",
                          title: "Inteligência Artificial (Adaptive AI)",
                          description: "IA integrada que analisa históricos e autoajusta parâmetros para maximizar seus ganhos automaticamente.",
                          icon: Sparkles,
                          unlockedAt: ["ultra"],
                          actionUrl: "/estrategias",
                          actionText: "Otimizar com IA",
                          iconColor: "text-violet-500",
                          bgIcon: "bg-violet-500/10 border-violet-500/20",
                          lockedDescription: "Ajuste de estratégias e personalização via Inteligência Artificial. Disponível no plano Pro.",
                        },
                      ];

                      return featureConfigs.map((f) => {
                        const isUnlocked = f.unlockedAt.includes(currentPlanId);
                        const Icon = f.icon;

                        return (
                          <div 
                            key={f.id} 
                            className={`p-5 rounded-[var(--radius-md)] border flex flex-col justify-between min-h-[170px] transition-all duration-200 ${
                              isUnlocked 
                                ? "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-brand-500)]/30" 
                                : "border-zinc-800 bg-zinc-950/30 opacity-60"
                            }`}
                          >
                            <div className="space-y-3">
                              <div className="flex items-center justify-between">
                                <div className={`h-9 w-9 rounded-[var(--radius-sm)] border flex items-center justify-center ${isUnlocked ? f.bgIcon : "bg-zinc-900 border-zinc-800 text-zinc-500"}`}>
                                  <Icon size={18} className={isUnlocked ? f.iconColor : ""} />
                                </div>
                                {isUnlocked ? (
                                  <span className="px-2 py-0.5 text-[9px] font-semibold rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 uppercase">
                                    Ativo
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 text-[9px] font-semibold rounded bg-zinc-800 text-zinc-400 border border-zinc-700 uppercase flex items-center gap-1">
                                    <Lock size={8} /> Bloqueado
                                  </span>
                                )}
                              </div>

                              <div className="space-y-1">
                                <h5 className={`text-xs font-bold ${isUnlocked ? "text-[var(--color-text)]" : "text-zinc-400"}`}>
                                  {f.title}
                                </h5>
                                <p className="text-[11px] text-muted leading-relaxed">
                                  {isUnlocked ? f.description : f.lockedDescription}
                                </p>
                              </div>
                            </div>

                            <div className="pt-4 mt-auto">
                              {isUnlocked ? (
                                f.actionUrl && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => window.location.href = f.actionUrl!}
                                    rightIcon={<ArrowRight size={11} />}
                                    className="w-full text-[10px] h-7.5 py-1"
                                  >
                                    {f.actionText}
                                  </Button>
                                )
                              ) : (
                                <Button
                                  variant="primary"
                                  size="sm"
                                  onClick={() => setShowAllPlans(true)}
                                  leftIcon={<Lock size={10} />}
                                  className="w-full text-[10px] h-7.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border-none"
                                >
                                  Fazer Upgrade
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              </div>
            ) : (
              /* GRID PADRÃO DE PLANOS (EXIBIDO CASO SEJA TRIAL OU SE CLICAR EM VER OUTROS PLANOS) */
              <div className="space-y-6">
                {currentUser && (
                  <div className="rounded-[var(--radius-sm)] border border-[var(--color-brand-500)]/[0.2] bg-[var(--color-brand-500)]/[0.02] p-4">
                    <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
                      <div className="space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-muted font-bold">Assinatura Atual</div>
                        <div className="flex items-center gap-2">
                          <span className="text-base font-bold text-[var(--color-text)]">
                            Plano {plans.find(p => p.id === currentPlanId)?.name || currentPlanId.toUpperCase()}
                          </span>
                          <Badge tone={planStatus === "active" ? "success" : "brand"} dot>
                            {planStatus === "active" ? "Ativo" : planStatus === "trialing" ? "Período de Teste" : planStatus.toUpperCase()}
                          </Badge>
                        </div>
                        <div className="text-xs text-muted">
                          Limites do seu plano atual: <strong>{currentUser.max_bots}</strong> bot(s) ativo(s) e até <strong>{currentUser.max_strategies}</strong> estratégia(s) salvas.
                        </div>
                      </div>
                      
                      {currentPlanId !== "free" && currentUser.stripe_customer_id && (
                        <Button 
                          variant="outline"
                          size="sm"
                          onClick={handleManageSubscription}
                          disabled={managingPortal}
                          rightIcon={managingPortal ? <Loader2 size={12} className="animate-spin" /> : undefined}
                        >
                          Gerenciar Assinatura
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                  {plans.map((p) => {
                    const detail = planDetails[p.id] || { badgeTone: "brand", desc: "", icon: Zap, highlight: false };
                    const Icon = detail.icon;
                    const isActive = currentPlanId === p.id;
                    
                    return (
                      <div 
                        key={p.id}
                        className={`relative flex flex-col rounded-[var(--radius-md)] border p-5 transition-all duration-200 ${
                          detail.highlight 
                            ? "border-[var(--color-brand-500)] shadow-[0_0_20px_rgba(var(--color-brand-rgb),0.1)] bg-[var(--color-surface-2)] scale-[1.01] z-10" 
                            : "border-[var(--color-border)] bg-[var(--color-surface-2)] hover:border-[var(--color-brand-500)]/40"
                        }`}
                      >
                        {detail.highlight && (
                          <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full bg-[var(--color-brand-500)] px-2.5 py-0.5 text-[8px] font-extrabold uppercase tracking-wider text-white">
                            Mais Popular
                          </div>
                        )}

                        <div className="flex-1 space-y-4">
                          <div className="flex items-center justify-between">
                            <div className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-surface-3)] text-[var(--color-brand-500)]">
                              <Icon size={18} />
                            </div>
                            {isActive && (
                              <Badge tone="brand">Ativo</Badge>
                            )}
                          </div>

                          <div className="space-y-1">
                            <h3 className="text-sm font-bold text-[var(--color-text)]">{p.name}</h3>
                            <p className="text-[11px] text-muted min-h-[32px] leading-relaxed">{detail.desc}</p>
                          </div>

                          <div className="pt-1">
                            <span className="text-xl font-extrabold text-[var(--color-text)]">
                              R$ {p.price_brl}
                            </span>
                            <span className="text-[10px] text-muted font-medium">/mês</span>
                          </div>

                          <div className="border-t border-[var(--color-border)] pt-3 space-y-2">
                            <div className="text-[9px] uppercase font-bold text-muted tracking-wider">Incluso no plano</div>
                            <ul className="space-y-2 text-[11px] text-[var(--color-text-2)]">
                              {p.features.map((f, idx) => (
                                <li key={idx} className="flex items-start gap-1.5">
                                  <Check size={12} className="text-emerald-500 shrink-0 mt-0.5" />
                                  <span className="leading-normal">{f}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        <div className="pt-4">
                          {isActive ? (
                            <Button 
                              variant="outline" 
                              className="w-full border-emerald-500/20 text-emerald-500 hover:bg-emerald-500/5 text-xs py-1.5 h-8"
                              disabled
                            >
                              Plano Atual
                            </Button>
                          ) : p.id === "free" ? (
                            <Button 
                              variant="outline" 
                              className="w-full text-xs py-1.5 h-8"
                              disabled
                            >
                              Indisponível
                            </Button>
                          ) : (
                            <Button 
                              variant={detail.highlight ? "primary" : "outline"} 
                              className="w-full text-xs py-1.5 h-8"
                              onClick={() => handleCheckout(p.id)}
                              disabled={checkingOut !== null}
                              rightIcon={checkingOut === p.id ? <Loader2 size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                            >
                              {checkingOut === p.id ? "Carregando..." : "Assinar Agora"}
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
 
      <Card padding="lg">
        <CardHeader
          icon={<BellRing size={18} className="text-[var(--color-brand-500)]" />}
          title="Notificações"
          subtitle="Alertas de preço, trades e relatórios enviados para o seu dispositivo"
        />
        <PushPermission />
      </Card>

      <Card padding="lg">
        <CardHeader
          icon={<Sun size={18} className="text-[var(--color-brand-500)]" />}
          title="Aparência"
          subtitle="Cor de fundo e contraste do painel"
        />
        <div className="flex gap-2">
          <Button
            variant={theme === "light" ? "primary" : "outline"}
            leftIcon={<Sun size={15} />}
            onClick={() => applyTheme("light")}
          >
            Claro
          </Button>
          <Button
            variant={theme === "dark" ? "primary" : "outline"}
            leftIcon={<Moon size={15} />}
            onClick={() => applyTheme("dark")}
          >
            Escuro
          </Button>
        </div>
      </Card>
 
      <Card padding="lg">
        <CardHeader
          icon={<Sparkles size={18} className="text-[var(--color-warn-500)]" />}
          title="Modo do painel"
          subtitle="Escolha entre uma versão simples ou completa"
          action={
            <Badge tone={advanced ? "brand" : "neutral"} dot>
              {advanced ? "Avançado" : "Iniciante"}
            </Badge>
          }
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setAdvanced(false)}
            className={
              "text-left p-4 rounded-[var(--radius-md)] border transition " +
              (!advanced
                ? "border-[var(--color-brand-500)] bg-brand-soft"
                : "border-[var(--color-border)] hover:bg-[var(--color-surface-3)]")
            }
          >
            <div className="text-sm font-semibold">Iniciante</div>
            <p className="text-xs text-muted mt-1">
              Esconde termos técnicos e mostra explicações em linguagem simples.
              Ideal para começar.
            </p>
          </button>
          <button
            type="button"
            onClick={() => setAdvanced(true)}
            className={
              "text-left p-4 rounded-[var(--radius-md)] border transition " +
              (advanced
                ? "border-[var(--color-brand-500)] bg-brand-soft"
                : "border-[var(--color-border)] hover:bg-[var(--color-surface-3)]")
            }
          >
            <div className="text-sm font-semibold">Avançado</div>
            <p className="text-xs text-muted mt-1">
              Mostra RSI, MACD, drawdown e todas as métricas. Ideal para quem
              já opera com confiança.
            </p>
          </button>
        </div>
      </Card>
 
      <Card padding="lg">
        <CardHeader
          icon={<Languages size={18} className="text-[var(--color-muted)]" />}
          title="Idioma"
        />
        <div className="text-sm text-[var(--color-text-2)]">
          Português (Brasil) — em breve outros idiomas.
        </div>
      </Card>
 
      <Card padding="lg">
        <CardHeader
          icon={<KeyRound size={18} className="text-[var(--color-brand-500)]" />}
          title="Gerenciamento de API e Contas"
          subtitle="Adicione e gerencie múltiplas chaves de API da Binance."
          action={
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Plus size={14} />}
              onClick={() => setShowAddModal(true)}
            >
              Adicionar Conta
            </Button>
          }
        />
        
        <div className="space-y-3">
          {accounts.length === 0 ? (
            <div className="p-8 text-center border border-dashed border-[var(--color-border)] rounded-[var(--radius-md)] text-muted">
              Nenhuma conta configurada. Adicione uma conta de API para começar a operar.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {accounts.map((acc) => (
                <div
                  key={acc.id}
                  className={`p-4 rounded-[var(--radius-md)] border transition flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                    acc.isActive
                      ? "border-[var(--color-brand-500)] bg-[var(--color-brand-500)]/[0.03]"
                      : "border-[var(--color-border)] bg-[var(--color-surface-2)]"
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-[var(--color-text)]">{acc.name}</span>
                      <span className={`px-1.5 py-0.5 text-[9px] font-bold uppercase rounded border ${
                        (acc.exchange || "binance") === "coinbase"
                          ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
                          : "bg-[var(--color-warn-500)]/10 text-[var(--color-warn-500)] border-[var(--color-warn-500)]/20"
                      }`}>
                        {(acc.exchange || "binance") === "coinbase" ? "Coinbase" : "Binance"}
                      </span>
                      {acc.isTestnet && (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">
                          Testnet
                        </span>
                      )}
                      {acc.isActive && (
                        <span className="px-1.5 py-0.5 text-[9px] font-bold uppercase rounded bg-emerald-500/10 text-emerald-500 border border-emerald-500/20">
                          Ativa
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted font-mono">
                      API Key: {acc.apiKey}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {!acc.isActive && (
                      <Button
                        variant="outline"
                        size="sm"
                        leftIcon={<Check size={14} />}
                        onClick={() => handleActivate(acc.id)}
                      >
                        Ativar
                      </Button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleDelete(acc.id)}
                      className="p-2 text-muted hover:text-red-500 hover:bg-red-500/10 rounded-[var(--radius-sm)] transition cursor-pointer"
                      title="Excluir Conta"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>
 
      <Card padding="lg">
        <CardHeader
          icon={<HelpCircle size={18} className="text-[var(--color-brand-500)]" />}
          title="Tutorial: Como obter suas chaves de API na Binance?"
          subtitle="Siga o passo a passo para configurar suas credenciais com segurança."
        />
        
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4 text-sm text-[var(--color-text-2)]">
              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-brand-500)]/10 text-[var(--color-brand-500)] font-bold text-xs">
                  1
                </span>
                <div>
                  <p className="font-semibold text-[var(--color-text)]">Acesse o Gerenciamento de API</p>
                  <p className="text-xs text-muted mt-0.5">
                    Faça login na Binance e vá para a página de gerenciamento de API ou{" "}
                    <a
                      href="https://www.binance.com/pt/my/settings/api-management"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[var(--color-brand-500)] hover:underline inline-flex items-center gap-1 font-semibold"
                    >
                      clique aqui para acessar diretamente <ExternalLink size={12} />
                    </a>.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-brand-500)]/10 text-[var(--color-brand-500)] font-bold text-xs">
                  2
                </span>
                <div>
                  <p className="font-semibold text-[var(--color-text)]">Crie uma nova chave de API</p>
                  <p className="text-xs text-muted mt-0.5">
                    Selecione <strong>"Gerada pelo Sistema"</strong>, insira um nome de identificação (ex: "SaaS Bot") e conclua a verificação de segurança.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-brand-500)]/10 text-[var(--color-brand-500)] font-bold text-xs">
                  3
                </span>
                <div>
                  <p className="font-semibold text-[var(--color-text)]">Configure as permissões recomendadas</p>
                  <p className="text-xs text-muted mt-0.5">
                    Marque as opções conforme a imagem de exemplo ao lado. Ative <strong>"Ativar Leitura"</strong>, <strong>"Ativar Trading Spot e de Margem"</strong> e <strong>"Ativar Futuros"</strong> (se for operar futuros).
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-brand-500)]/10 text-[var(--color-brand-500)] font-bold text-xs">
                  4
                </span>
                <div>
                  <p className="font-semibold text-[var(--color-text)]">Restringir acesso por IP (Obrigatório)</p>
                  <p className="text-xs text-muted mt-0.5">
                    Selecione <strong>"Restringir o acesso apenas a IPs confiáveis"</strong> e adicione o IP do servidor: <code className="bg-[var(--color-surface-3)] px-1.5 py-0.5 rounded text-[var(--color-brand-500)] font-mono text-[11px] font-bold select-all">137.131.141.14</code>. Clique em <strong>"Confirmar"</strong> na Binance.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-red-500/10 text-red-500 font-bold text-xs">
                  !
                </span>
                <div>
                  <p className="font-semibold text-red-500">Regra de Segurança Importante</p>
                  <p className="text-xs text-muted mt-0.5">
                    <strong>NUNCA ative a opção "Ativar levantamentos" (Saques).</strong> O sistema apenas executa ordens e lê saldos. Nenhum saque é necessário ou permitido.
                  </p>
                </div>
              </div>

              <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] flex gap-2">
                <Info size={16} className="text-[var(--color-brand-500)] flex-shrink-0 mt-0.5" />
                <p className="text-xs text-muted leading-relaxed">
                  <strong>Dica:</strong> Copie a <em>Secret Key</em> imediatamente após criá-la. A Binance oculta esse segredo permanentemente assim que você recarrega a página. Se perder, precisará criar uma nova API.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-semibold text-muted block">Imagem de Exemplo (Configurações Recomendadas):</span>
              <div className="relative group border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-surface-2)] transition hover:border-[var(--color-brand-500)]/50">
                <img
                  src="/images/binance-api-guide.png"
                  alt="Configurações de API Binance de Exemplo"
                  className="w-full h-auto object-cover max-h-[350px] transition-transform duration-300 group-hover:scale-[1.02]"
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center pointer-events-none">
                  <span className="px-3 py-1.5 bg-black/80 text-white rounded text-xs font-semibold">
                    Configurações de API recomendadas
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* Modal Adicionar Conta */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-md)] shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="px-6 py-4 border-b border-[var(--color-border)] flex justify-between items-center bg-[var(--color-surface-2)]">
              <h3 className="text-base font-semibold text-[var(--color-text)] flex items-center gap-2">
                <KeyRound size={18} className="text-[var(--color-brand-500)]" />
                Adicionar Conta Exchange
              </h3>
              <button 
                type="button" 
                onClick={() => setShowAddModal(false)}
                className="text-muted hover:text-[var(--color-text)] transition text-lg"
              >
                &times;
              </button>
            </div>
            <form onSubmit={handleAddAccount} className="p-6 space-y-4">
              {errorMsg && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 text-red-500 text-xs rounded-[var(--radius-sm)]">
                  {errorMsg}
                </div>
              )}
              
              {/* Seletor de exchange */}
              <div className="space-y-1">
                <label className="text-xs font-semibold text-[var(--color-text)]">Exchange</label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { value: "binance", label: "Binance", desc: "Spot · USDT · testnet disponível" },
                    { value: "coinbase", label: "Coinbase", desc: "Advanced Trade · USDC" },
                  ] as const).map((ex) => (
                    <button
                      key={ex.value}
                      type="button"
                      onClick={() => setNewAccExchange(ex.value)}
                      className={`p-3 rounded-[var(--radius-sm)] border text-left transition ${
                        newAccExchange === ex.value
                          ? "border-[var(--color-brand-500)] bg-[var(--color-brand-500)]/[0.06]"
                          : "border-[var(--color-border)] hover:bg-[var(--color-surface-3)]"
                      }`}
                    >
                      <div className="text-sm font-semibold text-[var(--color-text)]">{ex.label}</div>
                      <div className="text-[10px] text-muted mt-0.5">{ex.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-[var(--color-text)]">Nome Identificador</label>
                <input
                  type="text"
                  placeholder="Ex: Minha Conta Principal"
                  value={newAccName}
                  onChange={(e) => setNewAccName(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] focus:outline-none focus:border-[var(--color-brand-500)] transition text-[var(--color-text)]"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-[var(--color-text)]">Chave de API (API Key)</label>
                <input
                  type="text"
                  placeholder={newAccExchange === "coinbase" ? "organizations/{org}/apiKeys/{key} (chave CDP)" : "Digite a API Key da Binance"}
                  value={newAccApiKey}
                  onChange={(e) => setNewAccApiKey(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] focus:outline-none focus:border-[var(--color-brand-500)] transition text-[var(--color-text)]"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-[var(--color-text)]">Segredo da API (Secret Key)</label>
                <input
                  type="password"
                  placeholder={newAccExchange === "coinbase" ? "Chave privada EC (-----BEGIN EC PRIVATE KEY-----...)" : "Digite a Secret Key da Binance"}
                  value={newAccSecretKey}
                  onChange={(e) => setNewAccSecretKey(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] focus:outline-none focus:border-[var(--color-brand-500)] transition text-[var(--color-text)]"
                />
              </div>

              {newAccExchange === "coinbase" ? (
                <div className="p-3 bg-[var(--color-surface-3)] border border-[var(--color-border)] rounded-[var(--radius-sm)] text-[11px] text-muted leading-relaxed">
                  Crie a chave em <strong className="text-[var(--color-text)]">portal.cdp.coinbase.com</strong> →
                  API Keys, com permissões de <strong className="text-[var(--color-text)]">View e Trade</strong> (nunca Transfer).
                  A Coinbase não possui testnet — as ordens serão reais. Os pares usam <strong className="text-[var(--color-text)]">USDC</strong>.
                </div>
              ) : (
                <div className="flex items-center gap-2 pt-2">
                  <input
                    type="checkbox"
                    id="isTestnet"
                    checked={newAccIsTestnet}
                    onChange={(e) => setNewAccIsTestnet(e.target.checked)}
                    className="h-4 w-4 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-[var(--color-brand-500)] focus:ring-0"
                  />
                  <label htmlFor="isTestnet" className="text-xs font-semibold text-[var(--color-text)] select-none cursor-pointer">
                    Esta é uma conta Testnet (ambiente de testes/simulado)
                  </label>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-4 border-t border-[var(--color-border)]">
                <Button variant="outline" type="button" onClick={() => setShowAddModal(false)}>
                  Cancelar
                </Button>
                <Button variant="primary" type="submit" disabled={submitting}>
                  {submitting ? "Validando credencial..." : "Salvar Conta"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
