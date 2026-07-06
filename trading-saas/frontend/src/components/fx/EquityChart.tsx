"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { fmtUSD } from "@/lib/format";

interface EquityPoint {
  date: string;
  pnl: number;
  cumulative: number;
}

interface Props {
  data: EquityPoint[];
  maxDrawdown?: number;
}

function formatDate(dateStr: string) {
  const [, m, d] = dateStr.split("-");
  return `${d}/${m}`;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  const { pnl, cumulative } = payload[0]?.payload ?? {};
  return (
    <div className="bg-[var(--color-surface-2)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-xs shadow-lg">
      <div className="font-semibold text-[var(--color-text)] mb-1">{label}</div>
      <div className={`font-bold ${cumulative >= 0 ? "text-up" : "text-down"}`}>
        Acumulado: {cumulative >= 0 ? "+" : ""}{fmtUSD(cumulative)}
      </div>
      {pnl !== 0 && (
        <div className={`mt-0.5 ${pnl >= 0 ? "text-up" : "text-down"}`}>
          Dia: {pnl >= 0 ? "+" : ""}{fmtUSD(pnl)}
        </div>
      )}
    </div>
  );
}

export function EquityChart({ data, maxDrawdown }: Props) {
  if (!data.length) return null;

  const isProfit = data[data.length - 1].cumulative >= 0;
  const color = isProfit ? "var(--color-up-500)" : "var(--color-down-500)";
  const gradientId = `equity-grad-${isProfit ? "up" : "down"}`;

  return (
    <div className="w-full">
      {maxDrawdown != null && maxDrawdown > 0 && (
        <div className="text-[10px] text-muted mb-2 flex items-center gap-1">
          <span>Drawdown máx.:</span>
          <span className="text-down font-semibold">{fmtUSD(maxDrawdown)}</span>
        </div>
      )}
      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.25} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" strokeOpacity={0.5} />
          <XAxis
            dataKey="date"
            tickFormatter={formatDate}
            tick={{ fontSize: 9, fill: "var(--color-muted)" }}
            tickLine={false}
            axisLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v) => fmtUSD(v)}
            tick={{ fontSize: 9, fill: "var(--color-muted)" }}
            tickLine={false}
            axisLine={false}
            width={52}
          />
          <Tooltip content={<CustomTooltip />} />
          <ReferenceLine y={0} stroke="var(--color-border-strong)" strokeDasharray="3 3" />
          <Area
            type="monotone"
            dataKey="cumulative"
            stroke={color}
            strokeWidth={1.8}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0, fill: color }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
