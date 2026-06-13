"use client";

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  /** "auto" colore por tendência; ou força "up" | "down" | "neutral" */
  tone?: "auto" | "up" | "down" | "neutral";
  /** preenche a área sob a linha com gradiente */
  fill?: boolean;
  strokeWidth?: number;
  className?: string;
}

const COLORS: Record<string, string> = {
  up: "var(--color-up-300)",
  down: "var(--color-down-300)",
  neutral: "var(--color-brand-300)",
};

export function Sparkline({
  data, width = 120, height = 36, tone = "auto", fill = true, strokeWidth = 1.6, className,
}: SparklineProps) {
  if (!data || data.length < 2) {
    return <div className={className} style={{ width, height }} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = strokeWidth;
  const stepX = (width - pad * 2) / (data.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / range) * (height - pad * 2);
  const points = data.map((v, i) => `${(pad + i * stepX).toFixed(2)},${y(v).toFixed(2)}`);
  const path = `M ${points.join(" L ")}`;
  const area = `${path} L ${(pad + (data.length - 1) * stepX).toFixed(2)},${height} L ${pad},${height} Z`;

  const dir = tone === "auto" ? (data[data.length - 1] >= data[0] ? "up" : "down") : tone;
  const color = COLORS[dir] ?? COLORS.neutral;
  const gid = `sg-${Math.abs(Math.round((data[0] || 1) * 100 + data.length))}-${dir}`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} preserveAspectRatio="none" aria-hidden>
      {fill && (
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.25" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
      )}
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={path} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
