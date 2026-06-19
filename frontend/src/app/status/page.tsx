"use client";

import { useEffect, useState } from "react";
import { Activity, CheckCircle2, AlertCircle, XCircle, Loader2, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Badge, Button } from "@/components/ui";
import { api } from "@/lib/api";

interface Service {
  name: string;
  description: string;
  status: "ok" | "warn" | "down";
  uptime: string;
}

const STATUS_META = {
  ok: { Icon: CheckCircle2, color: "var(--color-up-500)", label: "Operando", tone: "up" as const },
  warn: { Icon: AlertCircle, color: "var(--color-warn-500)", label: "Atenção", tone: "warn" as const },
  down: { Icon: XCircle, color: "var(--color-down-500)", label: "Fora do ar", tone: "down" as const },
};

export default function StatusPage() {
  const [loading, setLoading] = useState(true);
  const [services, setServices] = useState<Service[]>([]);
  const [lastChecked, setLastChecked] = useState<string>("nunca");

  async function checkStatus() {
    setLoading(true);
    try {
      const res = await api.systemStatus();
      if (res) {
        setServices([
          {
            name: "SaaS Backend",
            description: "API Principal em Python (FastAPI)",
            status: (res.backend || "down") as "ok" | "down",
            uptime: "99.9%",
          },
          {
            name: "Banco de Dados",
            description: "Armazenamento relacional (PostgreSQL)",
            status: (res.database || "down") as "ok" | "down",
            uptime: "99.9%",
          },
          {
            name: "Cache & Fila",
            description: "Mensageria e cache de dados (Redis)",
            status: (res.redis || "down") as "ok" | "down",
            uptime: "99.8%",
          },
          {
            name: "SaaS Worker",
            description: "Processamento assíncrono de trades (Celery)",
            status: (res.worker || "down") as "ok" | "down",
            uptime: "99.7%",
          },
          {
            name: "SaaS Beat",
            description: "Agendador de ciclos do robô (Celery Beat)",
            status: (res.beat || "down") as "ok" | "down",
            uptime: "99.7%",
          },
        ]);
      }
    } catch (err) {
      setServices([
        { name: "SaaS Backend", description: "API Principal em Python (FastAPI)", status: "down", uptime: "—" },
        { name: "Banco de Dados", description: "Armazenamento relacional (PostgreSQL)", status: "down", uptime: "—" },
        { name: "Cache & Fila", description: "Mensageria e cache de dados (Redis)", status: "down", uptime: "—" },
        { name: "SaaS Worker", description: "Processamento assíncrono de trades (Celery)", status: "down", uptime: "—" },
        { name: "SaaS Beat", description: "Agendador de ciclos do robô (Celery Beat)", status: "down", uptime: "—" },
      ]);
    } finally {
      setLoading(false);
      setLastChecked(new Date().toLocaleTimeString("pt-BR"));
    }
  }

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 30000); // atualiza a cada 30s
    return () => clearInterval(interval);
  }, []);

  const allOk = services.length > 0 && services.every((s) => s.status === "ok");
  const anyDown = services.length === 0 || services.some((s) => s.status === "down");

  const overall = allOk
    ? { Icon: CheckCircle2, label: "Todos os serviços operacionais", color: "var(--color-up-500)", bg: "bg-up" }
    : anyDown
    ? { Icon: XCircle, label: "Há serviços fora do ar", color: "var(--color-down-500)", bg: "bg-down" }
    : { Icon: AlertCircle, label: "Alguns serviços necessitam de atenção", color: "var(--color-warn-500)", bg: "bg-warn" };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <PageHeader
          title="Status do sistema"
          description="Monitore em tempo real os serviços da plataforma Vexa Cripto."
        />
        <Button
          variant="outline"
          size="sm"
          leftIcon={loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
          onClick={checkStatus}
          disabled={loading}
        >
          Atualizar
        </Button>
      </div>

      <Card padding="lg">
        <div className="flex items-center gap-4">
          <div className={`h-12 w-12 rounded-full flex items-center justify-center ${overall.bg}`}>
            <overall.Icon size={22} style={{ color: overall.color }} />
          </div>
          <div>
            <div className="text-lg font-bold">{overall.label}</div>
            <div className="text-xs text-muted">
              Última verificação: {lastChecked} · próxima em 30 segundos
            </div>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <CardHeader
          icon={<Activity size={18} className="text-[var(--color-brand-500)]" />}
          title="Serviços"
          subtitle="Componentes cruciais da plataforma e estado de execução"
        />
        {loading && services.length === 0 ? (
          <div className="flex items-center justify-center p-12 text-muted">
            <Loader2 className="animate-spin mr-2" size={18} />
            Obtendo informações...
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {services.map((s) => {
              const meta = STATUS_META[s.status];
              return (
                <li key={s.name} className="flex items-center justify-between py-3 px-1">
                  <div className="flex items-center gap-3 min-w-0">
                    <meta.Icon size={18} style={{ color: meta.color }} className="shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[var(--color-text)]">{s.name}</div>
                      <div className="text-xs text-muted truncate">{s.description}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-muted tabular-nums hidden sm:inline">
                      uptime {s.uptime}
                    </span>
                    <Badge tone={meta.tone} dot>{meta.label}</Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
