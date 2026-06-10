"use client";

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: ReactNode;
  rightAddon?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leftIcon, rightAddon, className, id, ...rest },
  ref,
) {
  const inputId = id ?? `input-${rest.name ?? Math.random().toString(36).slice(2, 8)}`;
  return (
    <div className="w-full">
      {label && (
        <label
          htmlFor={inputId}
          className="block text-xs font-medium text-[var(--color-text-2)] mb-1.5"
        >
          {label}
        </label>
      )}
      <div
        className={cn(
          "flex items-center h-10 rounded-[var(--radius-sm)] border bg-[var(--color-surface)] transition-colors",
          "focus-within:border-[var(--color-brand-500)] focus-within:ring-2 focus-within:ring-[var(--color-brand-500)]/15",
          error
            ? "border-[var(--color-down-500)]"
            : "border-[var(--color-border-strong)]",
        )}
      >
        {leftIcon && (
          <div className="pl-3 text-[var(--color-muted)] flex items-center">
            {leftIcon}
          </div>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            "flex-1 bg-transparent px-3 py-2 text-sm text-[var(--color-text)] outline-none",
            "placeholder:text-[var(--color-muted-2)]",
            className,
          )}
          {...rest}
        />
        {rightAddon && (
          <div className="pr-2 flex items-center">{rightAddon}</div>
        )}
      </div>
      {(hint || error) && (
        <p
          className={cn(
            "text-xs mt-1.5",
            error ? "text-[var(--color-down-600)]" : "text-muted",
          )}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
});
