import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, PARAM_BOUNDS, clampParams, validateProposal } from "./params.js";

test("DEFAULT_PARAMS está dentro dos bounds", () => {
  const { params, changed } = clampParams(DEFAULT_PARAMS, DEFAULT_PARAMS);
  assert.deepEqual(params, DEFAULT_PARAMS);
  assert.equal(changed.length, 0);
});

test("clampParams corta valor absurdo (vence o limite mais restritivo: passo ±25%)", () => {
  const proposal = { ...DEFAULT_PARAMS, sl_pct: 99 };
  const { params, changed } = clampParams(proposal, DEFAULT_PARAMS);
  const expected = Math.min(PARAM_BOUNDS.sl_pct.max, DEFAULT_PARAMS.sl_pct * 1.25);
  assert.equal(params.sl_pct, expected);
  assert.ok(params.sl_pct <= PARAM_BOUNDS.sl_pct.max);
  assert.ok(changed.includes("sl_pct"));
});

test("clampParams limita variação a ±25% por ciclo", () => {
  const current = { ...DEFAULT_PARAMS, ema_period: 20 };
  const proposal = { ...current, ema_period: 100 }; // +400%
  const { params } = clampParams(proposal, current);
  assert.equal(params.ema_period, 25); // 20 * 1.25
});

test("validateProposal rejeita chave desconhecida e tipo errado", () => {
  assert.throws(() => validateProposal({ ...DEFAULT_PARAMS, hack: 1 }), /desconhecido/);
  assert.throws(() => validateProposal({ ...DEFAULT_PARAMS, sl_pct: "abc" }), /numérico/);
});

test("validateProposal aceita strategy válida e rejeita inválida", () => {
  assert.doesNotThrow(() => validateProposal({ ...DEFAULT_PARAMS, strategy: "turbo-reversion" }));
  assert.throws(() => validateProposal({ ...DEFAULT_PARAMS, strategy: "yolo" }), /strategy/);
});
