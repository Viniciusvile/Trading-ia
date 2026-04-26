// src/exchange/binance.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBinanceClient, _buildQuery, _sign } from "./binance.js";

test("_buildQuery serializes params deterministically", () => {
  const q = _buildQuery({ symbol: "XRPUSDT", side: "BUY", type: "MARKET", quoteOrderQty: "5.00", timestamp: 1700000000000 });
  assert.equal(q, "symbol=XRPUSDT&side=BUY&type=MARKET&quoteOrderQty=5.00&timestamp=1700000000000");
});

test("_buildQuery URL-encodes special characters", () => {
  const q = _buildQuery({ a: "x y", b: "&=?" });
  assert.equal(q, "a=x%20y&b=%26%3D%3F");
});

test("_sign produces deterministic HMAC-SHA256 hex", () => {
  const sig = _sign("secret", "symbol=XRPUSDT&timestamp=1700000000000");
  assert.equal(typeof sig, "string");
  assert.equal(sig.length, 64);
  assert.equal(sig, _sign("secret", "symbol=XRPUSDT&timestamp=1700000000000"));
});

test("createBinanceClient throws when credentials missing", () => {
  assert.throws(() => createBinanceClient({}), /credentials/i);
});

test("createBinanceClient returns client with expected methods", () => {
  const c = createBinanceClient({ apiKey: "k", secretKey: "s" });
  for (const m of ["getKlines", "getPrice", "getBalances", "placeMarketBuyQuote", "placeMarketSellQty", "getOrder"]) {
    assert.equal(typeof c[m], "function", `${m} must exist`);
  }
});
