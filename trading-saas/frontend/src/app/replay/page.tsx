"use client";

import { useState } from "react";
import { History, Play, Pause, SkipForward, Square } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardHeader, Button, Input, Badge, Stat } from "@/components/ui";
import { fmtUSD } from "@/lib/format";

export default function ReplayPage() {
  const [running, setRunning] = useState(false);
  const [date, setDate] = useState("2025-03-01");
  const [symbol, setSymbol] = useState("BTCUSDT");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Replay"
        description="Treine operando como se estivesse no passado — sem gastar dinheiro real."
      />

      <Card padding="lg">
        <CardHeader
          icon={<History size={18} className="text-[var(--color-brand-500)]" />}
          title="Configurar sessão de replay"
          subtitle="Escolha o ativo e a data inicial. Depois, você avança barra por barra."
          action={
            <Badge tone={running ? "up" : "neutral"} dot>
              {running ? "Rodando" : "Parado"}
            </Badge>
          }
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Input
            label="Ativo"
            placeholder="BTCUSDT"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
          />
          <Input
            label="Data inicial"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2 mt-4 pt-4 border-t border-[var(--color-border)]">
          {!running ? (
            <Button variant="primary" leftIcon={<Play size={15} />} onClick={() => setRunning(true)}>
              Iniciar replay
            </Button>
          ) : (
            <>
              <Button variant="outline" leftIcon={<Pause size={15} />} onClick={() => setRunning(false)}>
                Pausar
              </Button>
              <Button variant="ghost" leftIcon={<SkipForward size={15} />}>
                Próxima barra
              </Button>
              <Button variant="danger" leftIcon={<Square size={15} />} onClick={() => setRunning(false)}>
                Encerrar
              </Button>
            </>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card><Stat label="P&L sessão" value={fmtUSD(0)} size="sm" /></Card>
        <Card><Stat label="Trades" value="0" size="sm" /></Card>
        <Card><Stat label="Barras" value="0" size="sm" /></Card>
        <Card><Stat label="Posição" value="—" size="sm" /></Card>
      </div>
    </div>
  );
}
