import { test } from "node:test";
import assert from "node:assert/strict";
import { simulateTrades, computeStats, buildEquityCurve } from "./backtest-engine.js";

// Candles sintéticos: preço flat com range high/low controlado
function flatCandles(n, price = 100, range = 1) {
  return Array.from({ length: n }, (_, i) => ({
    time: 1700000000000 + i * 3600000,
    open: price, high: price + range, low: price - range, close: price, volume: 1000,
  }));
}

test("sem sinal → nenhum trade", () => {
  const candles = flatCandles(50);
  const trades = simulateTrades(candles, () => null, { warmup: 5, maxHold: 10, feePctPerSide: 0 });
  assert.equal(trades.length, 0);
});

test("LONG atinge TP → win com returnPct correto", () => {
  const candles = flatCandles(20, 100, 1);
  candles[7].high = 110; // TP 105 é atingido no candle 7
  const signalFn = (w) => (w.length === 7 ? { side: "LONG", stop: 90, tp: 105 } : null);
  const trades = simulateTrades(candles, signalFn, { warmup: 5, maxHold: 10, feePctPerSide: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].result, "win");
  assert.equal(trades[0].exitPrice, 105);
  assert.ok(Math.abs(trades[0].returnPct - 5) < 1e-9); // (105-100)/100 = +5%
});

test("LONG atinge SL → loss", () => {
  const candles = flatCandles(20, 100, 1);
  candles[8].low = 80; // SL 95 é atingido no candle 8
  const signalFn = (w) => (w.length === 7 ? { side: "LONG", stop: 95, tp: 200 } : null);
  const trades = simulateTrades(candles, signalFn, { warmup: 5, maxHold: 10, feePctPerSide: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].result, "loss");
  assert.equal(trades[0].exitPrice, 95);
});

test("SHORT atinge TP → win", () => {
  const candles = flatCandles(20, 100, 1);
  candles[7].low = 80; // TP 95 do short é atingido
  const signalFn = (w) => (w.length === 7 ? { side: "SHORT", stop: 110, tp: 95 } : null);
  const trades = simulateTrades(candles, signalFn, { warmup: 5, maxHold: 10, feePctPerSide: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].result, "win");
  assert.ok(Math.abs(trades[0].returnPct - 5) < 1e-9); // (100-95)/100 = +5%
});

test("timeout fecha no close do último candle do holding", () => {
  const candles = flatCandles(30, 100, 0.1); // range minúsculo: nem SL nem TP tocam
  const signalFn = (w) => (w.length === 7 ? { side: "LONG", stop: 50, tp: 200 } : null);
  const trades = simulateTrades(candles, signalFn, { warmup: 5, maxHold: 10, feePctPerSide: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].result, "timeout");
  assert.equal(trades[0].holdBars, 10);
});

test("taxa por lado é descontada do retorno (default 0.1%/lado)", () => {
  const candles = flatCandles(20, 100, 1);
  candles[7].high = 110; // TP 105 atingido → +5% bruto
  const signalFn = (w) => (w.length === 7 ? { side: "LONG", stop: 90, tp: 105 } : null);
  // Sem opts de taxa: usa o default de 0.1% por lado (0.2% por trade)
  const trades = simulateTrades(candles, signalFn, { warmup: 5, maxHold: 10 });
  assert.equal(trades.length, 1);
  assert.ok(Math.abs(trades[0].returnPct - 4.8) < 1e-9); // 5% - 0.2%
});

test("computeStats agrega winRate, profitFactor e drawdown", () => {
  const trades = [
    { returnPct: 2, holdBars: 3 },
    { returnPct: -1, holdBars: 2 },
    { returnPct: 4, holdBars: 5 },
    { returnPct: -1, holdBars: 1 },
  ];
  const s = computeStats(trades);
  assert.equal(s.totalTrades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, 0.5);
  assert.ok(Math.abs(s.profitFactor - 3) < 1e-9); // (2+4)/(1+1)
  assert.ok(Math.abs(s.netProfitPct - 4) < 1e-9);
  assert.ok(s.netProfitUsd > 0); // capital composto sobre $10.000
  assert.ok(s.maxDrawdownPct > 0.9); // queda de -1% gera ~1% de drawdown
});

test("computeStats com lista vazia → null", () => {
  assert.equal(computeStats([]), null);
});

test("buildEquityCurve começa no capital inicial e compõe retornos", () => {
  const trades = [
    { exitTime: 1, returnPct: 10 },
    { exitTime: 2, returnPct: -10 },
  ];
  const curve = buildEquityCurve(trades, 10000);
  assert.equal(curve.length, 3); // ponto inicial + 1 por trade
  assert.equal(curve[0].equity, 10000);
  assert.equal(curve[1].equity, 11000);
  assert.ok(Math.abs(curve[2].equity - 9900) < 1e-6); // 11000 * 0.9
});

test("computeStats: breakeven não é win nem loss", () => {
  const trades = [
    { returnPct: 2, holdBars: 1 },
    { returnPct: 0, holdBars: 1 },
    { returnPct: -2, holdBars: 1 },
  ];
  const s = computeStats(trades);
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.breakevens, 1);
  assert.ok(Math.abs(s.winRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(s.avgLossPct - (-2)) < 1e-9); // breakeven não dilui a perda média
  assert.ok(Math.abs(s.expectancyPct - 0) < 1e-9); // (2 + 0 - 2) / 3
});

test("simulateTrades: candles vazios ou warmup além do array → sem trades", () => {
  assert.deepEqual(simulateTrades([], () => null, { warmup: 5, maxHold: 10, feePctPerSide: 0 }), []);
  const few = [
    { time: 1, open: 100, high: 101, low: 99, close: 100, volume: 1 },
    { time: 2, open: 100, high: 101, low: 99, close: 100, volume: 1 },
  ];
  assert.deepEqual(simulateTrades(few, () => ({ side: "LONG", stop: 90, tp: 110 }), { warmup: 5, maxHold: 10, feePctPerSide: 0 }), []);
});

test("simulateTrades: SL e TP no mesmo candle → pior caso (loss)", () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({
    time: 1700000000000 + i * 3600000,
    open: 100, high: 101, low: 99, close: 100, volume: 1000,
  }));
  candles[7].high = 110; // toca o TP 105
  candles[7].low = 90;   // e também o SL 95 no MESMO candle
  const signalFn = (w) => (w.length === 7 ? { side: "LONG", stop: 95, tp: 105 } : null);
  const trades = simulateTrades(candles, signalFn, { warmup: 5, maxHold: 10, feePctPerSide: 0 });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].result, "loss");
  assert.equal(trades[0].exitPrice, 95);
});
