"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Share2, Link2 } from "lucide-react";
import { Modal, Button } from "@/components/ui";
import { api } from "@/lib/api";

interface ShareStrategyModalProps {
  strategyName: string;
  onClose: () => void;
}

/**
 * Gera (no abrir) um código de compartilhamento para a estratégia e exibe o
 * código + link prontos para copiar. Qualquer pessoa com o código pode importar
 * uma cópia da configuração (sem dados sensíveis do dono).
 */
export function ShareStrategyModal({ strategyName, onClose }: ShareStrategyModalProps) {
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"code" | "link" | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.botStrategyShare(strategyName);
        if (cancelled) return;
        if (res.success && res.code) setCode(res.code);
        else setError(res.error || "Não foi possível gerar o código.");
      } catch {
        if (!cancelled) setError("Não foi possível gerar o código.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [strategyName]);

  const shareLink =
    typeof window !== "undefined" && code
      ? `${window.location.origin}/estrategias?importar=${code}`
      : "";

  const copy = async (text: string, which: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      /* clipboard indisponível — ignora silenciosamente */
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <Share2 size={18} className="text-[var(--color-brand-500)]" />
          Compartilhar Estratégia
        </span>
      }
      footer={<Button variant="ghost" onClick={onClose}>Fechar</Button>}
    >
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Qualquer pessoa com o código ou link abaixo poderá importar uma cópia desta
          estratégia. Seus dados de conta e histórico não são compartilhados.
        </p>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <span className="h-6 w-6 rounded-full border-2 border-[var(--color-brand-500)] border-t-transparent animate-spin" />
          </div>
        ) : error ? (
          <p className="text-xs text-[var(--color-text-down)] text-center py-4">{error}</p>
        ) : (
          <div className="space-y-3">
            {/* Código */}
            <div className="flex gap-2 items-center bg-[var(--color-surface-3)] p-3 rounded-[var(--radius-sm)] border border-[var(--color-border)]">
              <span className="font-mono text-sm font-semibold text-[var(--color-brand-500)] tracking-wide">
                {code}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => code && copy(code, "code")}
                leftIcon={copied === "code" ? <Check size={14} /> : <Copy size={14} />}
              >
                {copied === "code" ? "Copiado!" : "Copiar Código"}
              </Button>
            </div>

            {/* Link */}
            <div className="flex gap-2 items-center bg-[var(--color-surface-3)] p-3 rounded-[var(--radius-sm)] border border-[var(--color-border)]">
              <Link2 size={14} className="text-muted shrink-0" />
              <span className="font-mono text-[11px] text-[var(--color-text-2)] truncate">
                {shareLink}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="ml-auto shrink-0"
                onClick={() => shareLink && copy(shareLink, "link")}
                leftIcon={copied === "link" ? <Check size={14} /> : <Copy size={14} />}
              >
                {copied === "link" ? "Copiado!" : "Copiar Link"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
