"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-2xl",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 md:p-10 fade-in overflow-y-auto"
    >
      <div
        className="fixed inset-0 bg-black/75 backdrop-blur-md"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={cn(
          "relative w-full my-auto max-h-[85vh] sm:max-h-[90vh] flex flex-col bg-[var(--color-surface-2)] shadow-[var(--shadow-pop)]",
          "rounded-[var(--radius-lg)]",
          "border border-[var(--color-border)] slide-up overflow-hidden",
          sizes[size],
        )}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-3 p-5 border-b border-[var(--color-border)] shrink-0">
            <div className="min-w-0">
              {title && (
                <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
              )}
              {description && (
                <p className="text-sm text-muted mt-1">{description}</p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Fechar"
              className="p-1.5 rounded-[var(--radius-xs)] hover:bg-[var(--color-surface-3)] text-[var(--color-muted)] hover:text-[var(--color-text)] transition"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="p-5 overflow-y-auto min-h-0 flex-1">{children}</div>
        {footer && (
          <div className="p-5 pt-0 flex items-center justify-end gap-2 shrink-0">{footer}</div>
        )}
      </div>
    </div>
  );
}
