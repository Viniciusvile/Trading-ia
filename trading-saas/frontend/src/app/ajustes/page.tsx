"use client";
 
import { useEffect, useState } from "react";
import { Sun, Moon, Languages, ShieldCheck, KeyRound, BellRing, Sparkles, Plus, Trash2, Check } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge } from "@/components/ui";
import { api } from "@/lib/api";
 
export default function AjustesPage() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
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
 
  useEffect(() => {
    const saved = (localStorage.getItem("theme") as "light" | "dark" | null) ?? "light";
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

  useEffect(() => {
    loadAccounts();
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
      setErrorMsg(e.message || "Erro na requisição");
    } finally {
      setSubmitting(false);
    }
  }
 
  return (
    <div className="space-y-5">
      <PageHeader title="Ajustes" description="Personalize o painel e configure suas chaves de API." />
 
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
                  Esta é uma conta Testnet (ambiente de testes/simulado)
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
