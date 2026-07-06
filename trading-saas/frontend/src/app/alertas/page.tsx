"use client";

import { useState } from "react";
import { Bell, Plus, Trash2, RefreshCw, ToggleLeft, ToggleRight, CheckCircle2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, Button, Badge, EmptyState, Modal, Input } from "@/components/ui";
import { fmtUSD } from "@/lib/format";
import { useAlerts, type PriceAlert } from "@/lib/hooks";
import { toast } from "sonner";

async function apiAlert(method: string, path: string, body?: unknown) {
  const token = typeof window !== "undefined" ? localStorage.getItem("token") : null;
  const res = await fetch(`/api/alerts${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || "Erro na operação");
  }
  return res.json();
}

export default function AlertasPage() {
  const { data, mutate } = useAlerts();
  const alerts: PriceAlert[] = data?.alerts ?? [];

  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"above" | "below">("above");
  const [recurring, setRecurring] = useState(false);
  const [saving, setSaving] = useState(false);

  async function addAlert() {
    if (!symbol || !price) return;
    setSaving(true);
    try {
      await apiAlert("POST", "", {
        symbol: symbol.toUpperCase(),
        condition,
        target_price: Number(price),
        recurring,
      });
      toast.success("Alerta criado");
      setSymbol("");
      setPrice("");
      setRecurring(false);
      setOpen(false);
      mutate();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Erro ao criar alerta");
    } finally {
      setSaving(false);
    }
  }

  async function deleteAlert(id: string) {
    try {
      await apiAlert("DELETE", `/${id}`);
      toast.success("Alerta removido");
      mutate();
    } catch {
      toast.error("Erro ao remover alerta");
    }
  }

  async function toggleAlert(id: string) {
    try {
      await apiAlert("PATCH", `/${id}/toggle`);
      mutate();
    } catch {
      toast.error("Erro ao alterar alerta");
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alertas de Preço"
        description="Receba uma notificação no sino assim que o preço atingir o valor que você definiu."
        actions={
          <Button variant="primary" leftIcon={<Plus size={15} />} onClick={() => setOpen(true)}>
            Novo alerta
          </Button>
        }
      />

      {alerts.length === 0 ? (
        <Card padding="lg">
          <EmptyState
            icon={<Bell size={22} />}
            title="Nenhum alerta criado"
            description="Crie um alerta para ser avisado quando o preço de um ativo atingir o valor que você quer monitorar."
            action={
              <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => setOpen(true)}>
                Criar alerta
              </Button>
            }
          />
        </Card>
      ) : (
        <Card padding="md">
          <ul className="divide-y divide-[var(--color-border)]">
            {alerts.map((a) => (
              <li key={a.id} className="flex items-center justify-between py-3 px-1 gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={`h-9 w-9 shrink-0 rounded-full flex items-center justify-center ${
                      a.triggered_at
                        ? "bg-up/10"
                        : a.is_active
                        ? "bg-warn/10"
                        : "bg-[var(--color-surface-3)]"
                    }`}
                  >
                    {a.triggered_at ? (
                      <CheckCircle2 size={14} className="text-up" />
                    ) : (
                      <Bell size={14} className={a.is_active ? "text-warn" : "text-muted"} />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold truncate">{a.symbol}</div>
                    <div className="text-xs text-muted">
                      {a.condition === "above" ? "subir acima de" : "cair abaixo de"}{" "}
                      <span className="font-medium text-[var(--color-text-2)]">
                        {fmtUSD(a.target_price)}
                      </span>
                      {a.recurring && (
                        <span className="ml-1.5 text-[10px] text-brand-500">· recorrente</span>
                      )}
                    </div>
                    {a.triggered_at && (
                      <div className="text-[10px] text-muted mt-0.5">
                        Disparou em{" "}
                        {new Date(a.triggered_at).toLocaleString("pt-BR", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {a.triggered_at && !a.recurring ? (
                    <Badge tone="up" dot size="sm">Disparado</Badge>
                  ) : a.is_active ? (
                    <Badge tone="warn" dot size="sm">Ativo</Badge>
                  ) : (
                    <Badge tone="neutral" size="sm">Pausado</Badge>
                  )}

                  <button
                    type="button"
                    aria-label={a.is_active ? "Pausar alerta" : "Ativar alerta"}
                    onClick={() => toggleAlert(a.id)}
                    className="h-8 w-8 flex items-center justify-center rounded-lg text-muted hover:text-[var(--color-text)] hover:bg-[var(--color-surface-3)] transition"
                  >
                    {a.is_active ? <ToggleRight size={16} className="text-brand-500" /> : <ToggleLeft size={16} />}
                  </button>

                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Excluir"
                    onClick={() => deleteAlert(a.id)}
                  >
                    <Trash2 size={14} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Novo alerta de preço"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button
              variant="primary"
              onClick={addAlert}
              disabled={!symbol || !price || saving}
              leftIcon={saving ? <RefreshCw size={14} className="animate-spin" /> : undefined}
            >
              {saving ? "Criando..." : "Criar alerta"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            label="Ativo"
            placeholder="Ex: BTCUSDT"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-[var(--color-text-2)] mb-1.5">
                Quando o preço
              </label>
              <select
                value={condition}
                onChange={(e) => setCondition(e.target.value as "above" | "below")}
                className="w-full h-10 px-3 text-sm rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] outline-none"
              >
                <option value="above">subir acima de</option>
                <option value="below">cair abaixo de</option>
              </select>
            </div>
            <Input
              label="Valor (USD)"
              placeholder="Ex: 70000"
              type="number"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>

          <label className="flex items-center gap-2.5 cursor-pointer select-none group">
            <div
              onClick={() => setRecurring(!recurring)}
              className={`relative h-5 w-9 rounded-full transition-colors ${
                recurring ? "bg-brand-500" : "bg-[var(--color-border-strong)]"
              }`}
            >
              <span
                className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                  recurring ? "translate-x-4" : ""
                }`}
              />
            </div>
            <span className="text-sm text-[var(--color-text-2)]">
              Alerta recorrente{" "}
              <span className="text-muted text-xs">(continua ativo depois de disparar)</span>
            </span>
          </label>
        </div>
      </Modal>
    </div>
  );
}
