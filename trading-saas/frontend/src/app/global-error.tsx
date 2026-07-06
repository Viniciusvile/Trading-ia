"use client";

// Última barreira: captura erros no próprio root layout (onde o error.tsx de
// rota não alcança). Precisa renderizar as próprias tags <html>/<body>.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#050507",
          color: "#F2F3F5",
          fontFamily: "Inter, system-ui, sans-serif",
          textAlign: "center",
          padding: "24px",
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>O aplicativo encontrou um erro</h2>
        <p style={{ color: "#7A7F8A", fontSize: 14, marginTop: 8, maxWidth: 420 }}>
          Recarregue para continuar. Se persistir, tente novamente em instantes.
        </p>
        <button
          onClick={() => reset()}
          style={{
            marginTop: 20,
            padding: "10px 20px",
            borderRadius: 12,
            border: "none",
            background: "#F2F3F5",
            color: "#050507",
            fontWeight: 600,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Recarregar aplicativo
        </button>
        {error?.digest && (
          <p style={{ fontSize: 10, color: "#7A7F8A", marginTop: 16, fontFamily: "monospace" }}>
            ref: {error.digest}
          </p>
        )}
      </body>
    </html>
  );
}
