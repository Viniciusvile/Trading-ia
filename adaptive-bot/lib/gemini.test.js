import { test } from "node:test";
import assert from "node:assert/strict";
import { askGeminiJson } from "./gemini.js";

function mockFetch(body, status = 200) {
  return async () => ({
    ok: status === 200,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const okBody = {
  candidates: [{ content: { parts: [{ text: '{"analysis":"ok","lessons":["a"],"proposed_params":{"sl_pct":0.007}}' }] } }],
};

test("parseia JSON da resposta do Gemini", async () => {
  const out = await askGeminiJson("prompt", { apiKey: "k", fetchFn: mockFetch(okBody) });
  assert.equal(out.analysis, "ok");
  assert.deepEqual(out.lessons, ["a"]);
  assert.equal(out.proposed_params.sl_pct, 0.007);
});

test("HTTP 429 → lança erro com status", async () => {
  await assert.rejects(
    askGeminiJson("p", { apiKey: "k", fetchFn: mockFetch({ error: { message: "quota" } }, 429) }),
    /429/
  );
});

test("resposta não-JSON → lança erro claro", async () => {
  const bad = { candidates: [{ content: { parts: [{ text: "não sou json" }] } }] };
  await assert.rejects(askGeminiJson("p", { apiKey: "k", fetchFn: mockFetch(bad) }), /JSON/);
});

test("sem apiKey → lança erro antes de chamar a rede", async () => {
  await assert.rejects(
    askGeminiJson("p", { apiKey: "", fetchFn: () => { throw new Error("não devia chamar"); } }),
    /GEMINI_API_KEY/
  );
});
