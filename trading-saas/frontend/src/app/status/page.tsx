import { Activity, CheckCircle2, AlertCircle, XCircle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Badge } from "@/components/ui";

interface Service {
  name: string;
  description: string;
  status: "ok" | "warn" | "down";
  uptime: string;
}

const SERVICES: Service[] = [
  { name: "Dashboard", description: "Painel web na porta 3333", status: "ok", uptime: "99,9%" },
  { name: "MasterBot", description: "Bot principal de operações", status: "ok", uptime: "99,8%" },
  { name: "SaaS Backend", description: "API Python (FastAPI)", status: "ok", uptime: "99,5%" },
  { name: "SaaS Worker", description: "Worker assíncrono de tarefas", status: "down", uptime: "—" },
  { name: "SaaS Beat", description: "Agendador de jobs", status: "ok", uptime: "99,7%" },
];

const STATUS_META = {
  ok: { Icon: CheckCircle2, color: "var(--color-up-500)", label: "Operando", tone: "up" as const },
  warn: { Icon: AlertCircle, color: "var(--color-warn-500)", label: "Atenção", tone: "warn" as const },
  down: { Icon: XCircle, color: "var(--color-down-500)", label: "Fora do ar", tone: "down" as const },
};

export default function StatusPage() {
  const allOk = SERVICES.every((s) => s.status === "ok");
  const anyDown = SERVICES.some((s) => s.status === "down");

  const overall = allOk
    ? { Icon: CheckCircle2, label: "Tudo funcionando", color: "var(--color-up-500)", bg: "bg-up" }
    : anyDown
    ? { Icon: XCircle, label: "Há serviços fora do ar", color: "var(--color-down-500)", bg: "bg-down" }
    : { Icon: AlertCircle, label: "Alguns serviços com atenção", color: "var(--color-warn-500)", bg: "bg-warn" };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Status do sistema"
        description="Veja em tempo real se todos os serviços estão funcionando."
      />

      <Card padding="lg">
        <div className="flex items-center gap-4">
          <div className={`h-12 w-12 rounded-full flex items-center justify-center ${overall.bg}`}>
            <overall.Icon size={22} style={{ color: overall.color }} />
          </div>
          <div>
            <div className="text-lg font-bold">{overall.label}</div>
            <div className="text-xs text-muted">
              Última verificação: agora · próxima em 30 segundos
            </div>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <CardHeader
          icon={<Activity size={18} className="text-[var(--color-brand-500)]" />}
          title="Serviços"
          subtitle="Cada componente do sistema e seu estado atual"
        />
        <ul className="divide-y divide-[var(--color-border)]">
          {SERVICES.map((s) => {
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
      </Card>
    </div>
  );
}
