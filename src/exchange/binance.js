// src/exchange/binance.js
import { createHmac } from "crypto";
import https from "https";

export function _buildQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

export function _sign(secret, queryString) {
  return createHmac("sha256", secret).update(queryString).digest("hex");
}

function httpRequest({ hostname, path, method, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 400) {
            resolve({ ok: false, status: res.statusCode, data: json });
          } else {
            resolve({ ok: true, status: res.statusCode, data: json });
          }
        } catch (e) {
          reject(new Error(`Invalid JSON from ${path}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export function createBinanceClient({ apiKey, secretKey, hostname = "api.binance.com", recvWindow = 5000 }) {
  if (!apiKey || !secretKey) throw new Error("Binance credentials missing (apiKey/secretKey)");

  async function publicGet(path, params = {}) {
    const qs = _buildQuery(params);
    const res = await httpRequest({
      hostname,
      path: qs ? `${path}?${qs}` : path,
      method: "GET",
    });
    return res;
  }

  async function signedRequest(method, path, params = {}) {
    const ts = Date.now();
    const full = { ...params, recvWindow, timestamp: ts };
    const qs = _buildQuery(full);
    const sig = _sign(secretKey, qs);
    const finalPath = `${path}?${qs}&signature=${sig}`;
    const res = await httpRequest({
      hostname,
      path: finalPath,
      method,
      headers: { "X-MBX-APIKEY": apiKey },
    });
    return res;
  }

  async function getKlines(symbol, interval = "1m", limit = 30) {
    const res = await publicGet("/api/v3/klines", { symbol, interval, limit });
    if (!res.ok) throw new Error(`getKlines failed: ${JSON.stringify(res.data)}`);
    return res.data.map((k) => ({
      ts: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      vol: parseFloat(k[5]),
    }));
  }

  async function getPrice(symbol) {
    const res = await publicGet("/api/v3/ticker/price", { symbol });
    if (!res.ok) throw new Error(`getPrice failed: ${JSON.stringify(res.data)}`);
    return parseFloat(res.data.price);
  }

  async function getBalances(assets = ["USDT"]) {
    const res = await signedRequest("GET", "/api/v3/account");
    if (!res.ok) throw new Error(`getBalances failed: ${JSON.stringify(res.data)}`);
    const out = {};
    for (const a of assets) {
      const row = res.data.balances?.find((b) => b.asset === a);
      out[a.toLowerCase()] = parseFloat(row?.free || 0);
    }
    return out;
  }

  async function placeMarketBuyQuote(symbol, quoteOrderQty) {
    return signedRequest("POST", "/api/v3/order", {
      symbol, side: "BUY", type: "MARKET", quoteOrderQty,
    });
  }

  async function placeMarketSellQty(symbol, quantity) {
    return signedRequest("POST", "/api/v3/order", {
      symbol, side: "SELL", type: "MARKET", quantity,
    });
  }

  async function getOrder(symbol, orderId) {
    return signedRequest("GET", "/api/v3/order", { symbol, orderId });
  }

  return {
    publicGet, signedRequest,
    getKlines, getPrice, getBalances,
    placeMarketBuyQuote, placeMarketSellQty, getOrder,
  };
}
