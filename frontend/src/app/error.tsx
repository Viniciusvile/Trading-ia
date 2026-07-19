"use client";

// Error boundary de rota (App Router). Captura erros de renderização de QUALQUER
// página e mostra um fallback recuperável em vez de derrubar o app inteiro
// (antes, um erro numa página exigia F5 e trocar de área manualmente).

import { useEffect } from "react";
import { AlertTriangle, RotateCcw, Home } from "lucide-react";
import { Button } from "@/components/ui";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Erro de renderização capturado:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-down-50)] mb-4">
        <AlertTriangle className="text-[var(--color-down-300)]" size={26} />
      </div>
      <h2 className="text-lg font-semibold text-[var(--color-text)]">Algo deu errado nesta página</h2>
      <p className="text-sm text-muted mt-1.5 max-w-md">
        Encontramos um problema ao exibir esta área. Você pode tentar recarregá-la
        sem perder a sessão — as outras páginas seguem funcionando.
      </p>
      <div className="flex gap-2 mt-6">
        <Button variant="primary" leftIcon={<RotateCcw size={15} />} onClick={() => reset()}>
          Tentar novamente
        </Button>
        <Button variant="outline" leftIcon={<Home size={15} />} onClick={() => (window.location.href = "/")}>
          Ir para o início
        </Button>
      </div>
      {error?.digest && (
        <p className="text-[10px] text-muted mt-4 font-mono">ref: {error.digest}</p>
      )}
    </div>
  );
}
