"use client";

/**
 * Primitivos de animação do design system.
 *
 * Regras da casa:
 *  - springUI para movimento de UI (rápido, sem oscilação perceptível);
 *  - micro-interações entre 150-250ms, nunca acima de 300ms;
 *  - useReducedMotion respeitado em TODOS os primitivos;
 *  - animar apenas transform/opacity (GPU) — nunca box-shadow/height direto.
 */

import { motion, useReducedMotion, AnimatePresence } from "framer-motion";
import type { ReactNode } from "react";

export const springUI = { type: "spring" as const, stiffness: 380, damping: 30 };
export const springSnappy = { type: "spring" as const, stiffness: 500, damping: 35 };

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: springUI },
};

interface StaggerProps {
  children: ReactNode;
  className?: string;
  /** atraso entre cada filho (s) */
  gap?: number;
  /** atraso inicial antes do primeiro filho (s) */
  delay?: number;
}

/** Container que anima os <StaggerItem> filhos em cascata. */
export function Stagger({ children, className, gap = 0.04, delay = 0 }: StaggerProps) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : "hidden"}
      animate="visible"
      variants={{
        visible: { transition: { staggerChildren: gap, delayChildren: delay } },
      }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  return (
    <motion.div className={className} variants={reduce ? undefined : itemVariants}>
      {children}
    </motion.div>
  );
}

interface FadeSlideProps {
  children: ReactNode;
  className?: string;
  delay?: number;
  /** direção de onde o elemento entra */
  from?: "bottom" | "top" | "left" | "right" | "none";
}

const offsets = {
  bottom: { y: 12 },
  top: { y: -12 },
  left: { x: -12 },
  right: { x: 12 },
  none: {},
};

/** Entrada única fade + deslize (para seções/blocos individuais). */
export function FadeSlide({ children, className, delay = 0, from = "bottom" }: FadeSlideProps) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, ...offsets[from] }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ ...springUI, delay }}
    >
      {children}
    </motion.div>
  );
}

export { AnimatePresence, motion };
