"use client";

import { useEffect, useRef } from "react";
import { animate, useMotionValue, useTransform, motion } from "framer-motion";

interface AnimatedNumberProps {
  value: number;
  /** formata o número exibido (ex.: fmtUSD) */
  format?: (v: number) => string;
  className?: string;
  durationS?: number;
}

export function AnimatedNumber({ value, format = (v) => v.toFixed(2), className, durationS = 0.6 }: AnimatedNumberProps) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v: number) => format(v));
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { mv.set(value); first.current = false; return; }
    const controls = animate(mv, value, { duration: durationS, ease: "easeOut" });
    return controls.stop;
  }, [value, mv, durationS]);

  return <motion.span className={className}>{text}</motion.span>;
}
