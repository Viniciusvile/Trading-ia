"use client";

import { useState } from "react";
import { fmtUSD } from "@/lib/format";

interface DayData {
  date: string;   // YYYY-MM-DD
  pnl: number;
}

interface Props {
  data: DayData[];
  onDayClick?: (date: string) => void;
}

const DAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function intensity(pnl: number, maxAbs: number): number {
  if (maxAbs === 0 || pnl === 0) return 0;
  return Math.min(1, Math.abs(pnl) / maxAbs);
}

function cellStyle(pnl: number, maxAbs: number): React.CSSProperties {
  const t = intensity(pnl, maxAbs);
  if (pnl === 0 || t === 0) return {};
  if (pnl > 0) {
    // green tones using CSS var steps
    const alpha = 0.12 + t * 0.6;
    return { backgroundColor: `rgba(16,174,126,${alpha})`, borderColor: `rgba(16,174,126,${alpha * 0.6})` };
  }
  const alpha = 0.12 + t * 0.6;
  return { backgroundColor: `rgba(239,68,68,${alpha})`, borderColor: `rgba(239,68,68,${alpha * 0.6})` };
}

export function TradeHeatmap({ data, onDayClick }: Props) {
  const [tooltip, setTooltip] = useState<{ date: string; pnl: number } | null>(null);

  if (!data.length) return null;

  // Organiza por semanas (domingo a sábado)
  const byDate: Record<string, number> = {};
  for (const d of data) byDate[d.date] = d.pnl;

  // Calcula grid: pega a primeira data e vai até hoje
  const firstDate = new Date(data[0].date + "T00:00:00");
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Recua para o domingo da primeira semana
  const start = new Date(firstDate);
  start.setDate(start.getDate() - start.getDay());

  const cells: { date: string; pnl: number; future: boolean }[] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const ds = cursor.toISOString().split("T")[0];
    cells.push({ date: ds, pnl: byDate[ds] ?? 0, future: cursor > today });
    cursor.setDate(cursor.getDate() + 1);
  }

  const maxAbs = Math.max(...cells.map((c) => Math.abs(c.pnl)), 0.01);

  // Semanas
  const weeks: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7));
  }

  // Meses para legenda
  const monthLabels: { label: string; col: number }[] = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const firstInWeek = week.find((c) => !c.future);
    if (!firstInWeek) return;
    const m = new Date(firstInWeek.date + "T00:00:00").getMonth();
    if (m !== lastMonth) {
      monthLabels.push({
        label: new Date(firstInWeek.date + "T00:00:00").toLocaleDateString("pt-BR", { month: "short" }),
        col: wi,
      });
      lastMonth = m;
    }
  });

  return (
    <div className="w-full overflow-x-auto pb-1">
      {/* Legenda de meses */}
      <div className="flex mb-1" style={{ paddingLeft: 28 }}>
        {weeks.map((_, wi) => {
          const ml = monthLabels.find((m) => m.col === wi);
          return (
            <div key={wi} className="text-[9px] text-muted" style={{ width: 14, marginRight: 2, minWidth: 14 }}>
              {ml?.label ?? ""}
            </div>
          );
        })}
      </div>

      <div className="flex gap-0.5">
        {/* Labels de dia */}
        <div className="flex flex-col gap-0.5 mr-1">
          {DAYS.map((d, i) => (
            <div key={d} className="text-[9px] text-muted h-3.5 flex items-center" style={{ lineHeight: 1 }}>
              {i % 2 === 1 ? d.slice(0, 3) : ""}
            </div>
          ))}
        </div>

        {/* Grid de semanas */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-0.5">
            {week.map((cell, di) => (
              <div
                key={di}
                title={`${cell.date} · ${cell.pnl !== 0 ? (cell.pnl > 0 ? "+" : "") + fmtUSD(cell.pnl) : "sem trades"}`}
                onClick={() => cell.pnl !== 0 && onDayClick?.(cell.date)}
                onMouseEnter={() => cell.pnl !== 0 && setTooltip({ date: cell.date, pnl: cell.pnl })}
                onMouseLeave={() => setTooltip(null)}
                style={{ width: 14, height: 14, ...cellStyle(cell.pnl, maxAbs) }}
                className={`rounded-sm border border-[var(--color-border)] transition-transform ${
                  cell.pnl !== 0 ? "cursor-pointer hover:scale-125" : ""
                } ${cell.future ? "opacity-0" : ""}`}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Legenda de escala */}
      <div className="flex items-center gap-1 mt-2 justify-end text-[9px] text-muted">
        <span>menos</span>
        {[0.1, 0.3, 0.6, 0.9].map((t) => (
          <div
            key={t}
            style={{ width: 10, height: 10, backgroundColor: `rgba(16,174,126,${0.12 + t * 0.6})` }}
            className="rounded-sm"
          />
        ))}
        <span>mais</span>
      </div>
    </div>
  );
}
