"use client";

import { useState } from "react";
import { Bell, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge, EmptyState, Modal, Input } from "@/components/ui";
import { fmtUSD } from "@/lib/format";

interface Alert {
  id: string;
  symbol: string;
  price: number;
  condition: "above" | "below";
}

export default function AlertasPage() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState("");
  const [price, setPrice] = useState("");
  const [condition, setCondition] = useState<"above" | "below">("above");

  function addAlert() {
    if (!symbol || !price) return;
    setAlerts((prev) => [
      { id: crypto.randomUUID(), symbol: symbol.toUpperCase(), price: Number(price), condition },
      ...prev,
    ]);
    setSymbol("");
    setPrice("");
    setOpen(false);
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Alertas"
        description="Receba uma notificação assim que o preço de um ativo bater o que você definiu."
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
            description="Crie um alerta para ser avisado quando o preço atingir um valor que você quer."
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
              <li key={a.id} className="flex items-center justify-between py-3 px-1">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-full bg-warn flex items-center justify-center">
                    <Bell size={14} />
                  </div>
                  <div>
                    <div className="text-sm font-semibold">{a.symbol}</div>
                    <div className="text-xs text-muted">
                      {a.condition === "above" ? "subir acima de" : "cair abaixo de"}{" "}
                      <span className="font-medium text-[var(--color-text-2)]">{fmtUSD(a.price)}</span>
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="warn" dot size="sm">Ativo</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Excluir"
                    onClick={() => setAlerts((p) => p.filter((x) => x.id !== a.id))}
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
            <Button variant="primary" onClick={addAlert} disabled={!symbol || !price}>
              Criar alerta
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
        </div>
      </Modal>
    </div>
  );
}
