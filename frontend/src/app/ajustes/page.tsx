"use client";
 
import { useEffect, useState } from "react";
import { Sun, Moon, Languages, ShieldCheck, KeyRound, BellRing, Sparkles, Plus, Trash2, Check, HelpCircle, ExternalLink, Info, Zap, Crown, Loader2, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge } from "@/components/ui";
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
  const [accounts, setAccounts] = useState<{ id: string; name: string; apiKey: string; isActive: boolean; isTestnet: boolean; createdAt: string }[]>([]);
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
      toast.error("N??o foi poss??vel carregar as informa????es dos planos.");
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
        toast.success("Assinatura atualizada com sucesso! Seus novos limites j?? est??o ativos.");
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
      setErrorMsg("Todos os campos s??o obrigat??rios.");
      return;
    }
    setSubmitting(true);
    setErrorMsg("");
    try {
      const res = await api.accountCreate({
        name: newAccName,
        apiKey: newAccApiKey,
        secretKey: newAccSecretKey,
        isTestnet: newAccIsTestnet
      });
      if (res.success) {
        setNewAccName("");
        setNewAccApiKey("");
        setNewAccSecretKey("");
        setNewAccIsTestnet(false);
        setShowAddModal(false);
        loadAccounts();
        window.dispatchEvent(new Event("accounts-updated"));
      } else {
        setErrorMsg(res.error || "Erro ao adicionar conta");
      }
    } catch (e: any) {
      setErrorMsg(e.message || "Erro na requisi????o");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCheckout(planId: string) {
    if (planId === "free") {
      toast.info("O plano Trial j?? est?? ativo por padr??o.");
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
      toast.error(e.message || "N??o foi poss??vel conectar ao Stripe.");
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
      toast.error(e.message || "N??o foi poss??vel abrir o portal de faturamento.");
    } finally {
      setManagingPortal(false);
    }
  }

  const planDetails: Record<string, { badgeTone: "brand" | "neutral" | "warn" | "success", desc: string, icon: any, highlight: boolean }> = {
    free: { badgeTone: "neutral", desc: "Experimente nossos bots b??sicos", icon: ShieldCheck, highlight: false },
    basic: { badgeTone: "brand", desc: "Perfeito para traders iniciantes", icon: Zap, highlight: false },
    pro: { badgeTone: "success", desc: "Acelere com mais rob??s e flexibilidade", icon: Crown, highlight: true },
    ultra: { badgeTone: "warn", desc: "Poder total, sem travas e customiza????o total", icon: Sparkles, highlight: false }
  };

  const currentPlanId = currentUser?.plan || "free";
  const planStatus = currentUser?.plan_status || "trialing";
 
  return (
    <div className="space-y-5">
      <PageHeader title="Ajustes" description="Personalize o painel e configure suas chaves de API." />
 
      {/* Se????o de Planos & Assinaturas */}
      <Card padding="lg">
        <CardHeader
          icon={<Sparkles size={18} className="text-[var(--color-brand-500)]" />}
          title="Planos & Assinaturas"
          subtitle="Escolha a pot??ncia ideal para seus bots e aumente seus limites operacionais."
        />
        
        {loadingBilling ? (
          <div className="flex h-[20vh] items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--color-brand-500)]" />
          </div>
        ) : (
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
                        {planStatus === "active" ? "Ativo" : planStatus === "trialing" ? "Per??odo de Teste" : planStatus.toUpperCase()}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted">
                      Limites do seu plano atual: <strong>{currentUser.max_bots}</strong> bot(s) ativo(s) e at?? <strong>{currentUser.max_strategies}</strong> estrat??gia(s) salvas.
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
                        <span className="text-[10px] text-muted font-medium">/m??s</span>
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
                          Indispon??vel
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
      </Card>
 
      <Card padding="lg">
        <CardHeader
          icon={<Sun size={18} className="text-[var(--color-brand-500)]" />}
          title="Apar??ncia"
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
          subtitle="Escolha entre uma vers??o simples ou completa"
          action={
            <Badge tone={advanced ? "brand" : "neutral"} dot>
              {advanced ? "Avan??ado" : "Iniciante"}
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
              Esconde termos t??cnicos e mostra explica????es em linguagem simples.
              Ideal para come??ar.
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
            <div className="text-sm font-semibold">Avan??ado</div>
            <p className="text-xs text-muted mt-1">
              Mostra RSI, MACD, drawdown e todas as m??tricas. Ideal para quem
              j?? opera com confian??a.
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
          Portugu??s (Brasil) ??? em breve outros idiomas.
        </div>
      </Card>
 
      <Card padding="lg">
        <CardHeader
          icon={<KeyRound size={18} className="text-[var(--color-brand-500)]" />}
          title="Gerenciamento de API e Contas"
          subtitle="Adicione e gerencie m??ltiplas chaves de API da Binance."
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
              Nenhuma conta configurada. Adicione uma conta de API para come??ar a operar.
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
          subtitle="Siga o passo a passo para configurar suas credenciais com seguran??a."
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
                    Fa??a login na Binance e v?? para a p??gina de gerenciamento de API ou{" "}
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
                    Selecione <strong>"Gerada pelo Sistema"</strong>, insira um nome de identifica????o (ex: "SaaS Bot") e conclua a verifica????o de seguran??a.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-brand-500)]/10 text-[var(--color-brand-500)] font-bold text-xs">
                  3
                </span>
                <div>
                  <p className="font-semibold text-[var(--color-text)]">Configure as permiss??es recomendadas</p>
                  <p className="text-xs text-muted mt-0.5">
                    Marque as op????es conforme a imagem de exemplo ao lado. Ative <strong>"Ativar Leitura"</strong>, <strong>"Ativar Trading Spot e de Margem"</strong> e <strong>"Ativar Futuros"</strong> (se for operar futuros).
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-[var(--color-brand-500)]/10 text-[var(--color-brand-500)] font-bold text-xs">
                  4
                </span>
                <div>
                  <p className="font-semibold text-[var(--color-text)]">Restringir acesso por IP (Obrigat??rio)</p>
                  <p className="text-xs text-muted mt-0.5">
                    Selecione <strong>"Restringir o acesso apenas a IPs confi??veis"</strong> e adicione o IP do servidor: <code className="bg-[var(--color-surface-3)] px-1.5 py-0.5 rounded text-[var(--color-brand-500)] font-mono text-[11px] font-bold select-all">137.131.141.14</code>. Clique em <strong>"Confirmar"</strong> na Binance.
                  </p>
                </div>
              </div>

              <div className="flex gap-3">
                <span className="flex-shrink-0 flex items-center justify-center w-6 h-6 rounded-full bg-red-500/10 text-red-500 font-bold text-xs">
                  !
                </span>
                <div>
                  <p className="font-semibold text-red-500">Regra de Seguran??a Importante</p>
                  <p className="text-xs text-muted mt-0.5">
                    <strong>NUNCA ative a op????o "Ativar levantamentos" (Saques).</strong> O sistema apenas executa ordens e l?? saldos. Nenhum saque ?? necess??rio ou permitido.
                  </p>
                </div>
              </div>

              <div className="p-3 bg-[var(--color-surface-3)] rounded-[var(--radius-sm)] border border-[var(--color-border)] flex gap-2">
                <Info size={16} className="text-[var(--color-brand-500)] flex-shrink-0 mt-0.5" />
                <p className="text-xs text-muted leading-relaxed">
                  <strong>Dica:</strong> Copie a <em>Secret Key</em> imediatamente ap??s cri??-la. A Binance oculta esse segredo permanentemente assim que voc?? recarrega a p??gina. Se perder, precisar?? criar uma nova API.
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <span className="text-xs font-semibold text-muted block">Imagem de Exemplo (Configura????es Recomendadas):</span>
              <div className="relative group border border-[var(--color-border)] rounded-[var(--radius-md)] overflow-hidden bg-[var(--color-surface-2)] transition hover:border-[var(--color-brand-500)]/50">
                <img
                  src="/images/binance-api-guide.png"
                  alt="Configura????es de API Binance de Exemplo"
                  className="w-full h-auto object-cover max-h-[350px] transition-transform duration-300 group-hover:scale-[1.02]"
                />
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center pointer-events-none">
                  <span className="px-3 py-1.5 bg-black/80 text-white rounded text-xs font-semibold">
                    Configura????es de API recomendadas
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
                  placeholder="Digite a API Key da Binance"
                  value={newAccApiKey}
                  onChange={(e) => setNewAccApiKey(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] focus:outline-none focus:border-[var(--color-brand-500)] transition text-[var(--color-text)]"
                />
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-[var(--color-text)]">Segredo da API (Secret Key)</label>
                <input
                  type="password"
                  placeholder="Digite a Secret Key da Binance"
                  value={newAccSecretKey}
                  onChange={(e) => setNewAccSecretKey(e.target.value)}
                  className="w-full px-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-[var(--radius-sm)] focus:outline-none focus:border-[var(--color-brand-500)] transition text-[var(--color-text)]"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <input
                  type="checkbox"
                  id="isTestnet"
                  checked={newAccIsTestnet}
                  onChange={(e) => setNewAccIsTestnet(e.target.checked)}
                  className="h-4 w-4 bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded text-[var(--color-brand-500)] focus:ring-0"
                />
                <label htmlFor="isTestnet" className="text-xs font-semibold text-[var(--color-text)] select-none cursor-pointer">
                  Esta ?? uma conta Testnet (ambiente de testes/simulado)
                </label>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-[var(--color-border)]">
                <Button variant="outline" type="button" onClick={() => setShowAddModal(false)}>
                  Cancelar
                </Button>
                <Button variant="primary" type="submit" disabled={submitting}>
                  {submitting ? "Adicionando..." : "Salvar Conta"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

