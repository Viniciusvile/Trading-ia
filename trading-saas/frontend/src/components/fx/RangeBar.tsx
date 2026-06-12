"use client";

import { motion } from "framer-motion";

interface RangeBarProps {
  /** stop loss (esquerda, vermelho) */
  stop: number;
  /** take profit (direita, verde) */
  tp: number;
  /** preço de entrada (marcador neutro) */
  entry: number;
  /** preço atual (marcador animado) */
  current: number;
  format?: (v: number) => string;
  className?: string;
}

/**
 * Trilho SL → TP estilo Fey: mostra onde o preço atual está entre o stop e o
 * alvo. O marcador desliza com spring quando o preço muda — dá leitura
 * imediata de "quão perto do alvo/stop" a posição está.
 */
export function RangeBar({ stop, tp, entry, current, format = (v) => v.toFixed(2), className }: RangeBarProps) {
  const lo = Math.min(stop, tp);
  const hi = Math.max(stop, tp);
  const span = hi - lo || 1;
  const clamp = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));
  const posCurrent = clamp(current);
  const posEntry = clamp(entry);
  // stop pode estar à direita em posições SHORT — colore as pontas pelo valor real
  const stopLeft = stop <= tp;

  return (
    <div className={className}>
      <div className="relative h-1.5 rounded-full bg-[var(--color-surface-3)] min-w-[120px]">
        {/* trecho percorrido desde a entrada */}
        <div
          className={`absolute top-0 h-full rounded-full ${current >= entry ? "bg-[var(--color-up-500)]/40" : "bg-[var(--color-down-500)]/40"}`}
          style={{
            left: `${Math.min(posEntry, posCurrent)}%`,
            width: `${Math.abs(posCurrent - posEntry)}%`,
          }}
        />
        {/* marcador de entrada */}
        <span
          aria-hidden
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-2.5 w-0.5 rounded bg-[var(--color-muted)]"
          style={{ left: `${posEntry}%` }}
        />
        {/* marcador do preço atual (desliza com spring) */}
        <motion.span
          aria-hidden
          className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-3 w-3 rounded-full border-2 border-[var(--color-bg)] ${current >= entry ? "bg-[var(--color-up-300)]" : "bg-[var(--color-down-300)]"}`}
          animate={{ left: `${posCurrent}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </div>
      <div className="flex justify-between mt-1 text-[10px] tabular-nums">
        <span className={stopLeft ? "text-down" : "text-up"}>{format(stopLeft ? stop : tp)}</span>
        <span className={stopLeft ? "text-up" : "text-down"}>{format(stopLeft ? tp : stop)}</span>
      </div>
    </div>
  );
}
