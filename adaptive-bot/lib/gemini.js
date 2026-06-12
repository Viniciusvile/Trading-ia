// Cliente mínimo da API Gemini (REST), com fetch injetável para testes.
// A chave NUNCA é logada; em erros, apenas o status HTTP aparece.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

export async function askGeminiJson(prompt, { apiKey = process.env.GEMINI_API_KEY, fetchFn = fetch, timeoutMs = 60000 } = {}) {
  if (!apiKey) throw new Error("GEMINI_API_KEY ausente — configure no .env");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.4,
          maxOutputTokens: 2048,
        },
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini retornou resposta vazia/bloqueada");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Gemini não retornou JSON válido: ${text.slice(0, 200)}`);
  }
}
