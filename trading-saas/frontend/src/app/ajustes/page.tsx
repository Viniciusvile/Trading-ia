"use client";

import { useEffect, useState } from "react";
import { Sun, Moon, Languages, ShieldCheck, KeyRound, BellRing, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Badge } from "@/components/ui";

export default function AjustesPage() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    const saved = (localStorage.getItem("theme") as "light" | "dark" | null) ?? "light";
    setTheme(saved);
  }, []);

  function applyTheme(next: "light" | "dark") {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
  }

  return (
    <div className="space-y-5">
      <PageHeader title="Ajustes" description="Personalize o painel do seu jeito." />

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
          icon={<KeyRound size={18} className="text-[var(--color-down-500)]" />}
          title="Segurança"
          subtitle="Suas chaves de API e autenticação"
        />
        <div className="space-y-3">
          <Row icon={<ShieldCheck size={15} />} label="Binance API conectada" value="Sim" tone="up" />
          <Row icon={<BellRing size={15} />} label="Telegram conectado" value="Sim" tone="up" />
        </div>
      </Card>
    </div>
  );
}

function Row({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "up" | "down" | "warn" | "neutral";
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2 text-sm text-[var(--color-text-2)]">
        {icon}
        {label}
      </div>
      <Badge tone={tone} dot size="sm">{value}</Badge>
    </div>
  );
}
