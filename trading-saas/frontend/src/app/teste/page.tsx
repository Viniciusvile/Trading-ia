export default function TestePage() {
  return (
    <div style={{
      padding: 40,
      fontFamily: "system-ui",
      background: "#10B981",
      color: "white",
      minHeight: "100vh"
    }}>
      <h1 style={{ fontSize: 32, marginBottom: 16 }}>✅ Funcionou!</h1>
      <p style={{ fontSize: 18 }}>
        Se você está vendo essa tela verde, o servidor está OK e o problema
        está em outra página específica.
      </p>
      <p style={{ marginTop: 24, opacity: 0.85 }}>
        Hora do servidor: {new Date().toLocaleString("pt-BR")}
      </p>
    </div>
  );
}
