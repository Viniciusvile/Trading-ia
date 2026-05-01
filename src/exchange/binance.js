// src/exchange/binance.js
import { createHmac } from "crypto";
import https from "https";

export function _buildQuery(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
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
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`HTTP timeout after 10s for ${method} ${path}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

let timeOffset = 0;

export function createBinanceClient({ apiKey, secretKey, hostname = "api.binance.com", recvWindow = 10000 }) {
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
    const ts = Date.now() + timeOffset;
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

  async function placeOCO(symbol, side, quantity, price, stopPrice, stopLimitPrice, precision = null) {
    // Calcula precisão automaticamente baseado no preço real
    // Ex: PEPE ~0.000009 precisa de 8+ decimais, XRP ~0.5 precisa de 4
    function autoPrecision(p, minPrec = 4) {
      if (p <= 0) return minPrec;
      // Quantas casas decimais para ter pelo menos 4 dígitos significativos
      const needed = Math.max(minPrec, Math.ceil(-Math.log10(p)) + 3);
      return Math.min(needed, 8);
    }
    const prec = precision !== null && precision !== undefined ? precision : autoPrecision(price);
    return signedRequest("POST", "/api/v3/order/oco", {
      symbol,
      side,
      quantity,
      price: price.toFixed(prec), // Alvo de Lucro
      stopPrice: stopPrice.toFixed(prec), // Ativador do Stop
      stopLimitPrice: (stopLimitPrice || stopPrice).toFixed(prec), // Preço real de venda no Stop
      stopLimitTimeInForce: "GTC"
    });
  }

  async function getOrder(symbol, orderId) {
    return signedRequest("GET", "/api/v3/order", { symbol, orderId });
  }

  async function getOCO(orderListId) {
    return signedRequest("GET", "/api/v3/orderList", { orderListId });
  }

  async function cancelOCO(symbol, orderListId) {
    return signedRequest("DELETE", "/api/v3/orderList", { symbol, orderListId });
  }

  async function syncTime() {
    try {
      const start = Date.now();
      const res = await publicGet("/api/v3/time");
      const end = Date.now();
      if (res.ok) {
        const serverTime = res.data.serverTime;
        // Ajuste considerando a latência da rede (estimada como metade do round-trip)
        timeOffset = serverTime - Math.floor((start + end) / 2);
        console.log(`🕒 Binance Time Sync: offset ${timeOffset}ms`);
      }
    } catch (e) {
      console.warn("🕒 Failed to sync time with Binance:", e.message);
    }
  }

  /**
   * Verifica se o BNB Burn (desconto de 25% em taxas spot) está ativado.
   * Endpoint: GET /sapi/v1/bnbBurn
   * Retorna: { spotBNBBurn: true|false, interestBNBBurn: true|false }
   */
  async function getBnbBurnStatus() {
    const res = await signedRequest("GET", "/sapi/v1/bnbBurn");
    if (!res.ok) throw new Error(`getBnbBurnStatus failed: ${JSON.stringify(res.data)}`);
    return res.data; // { spotBNBBurn: bool, interestBNBBurn: bool }
  }

  /**
   * Ativa o BNB Burn para taxas spot (desconto de 25%).
   * Requer permissão de "Enable Spot & Margin Trading" na API Key.
   * Endpoint: POST /sapi/v1/bnbBurn
   */
  async function enableBnbBurn(spotBNBBurn = true) {
    const res = await signedRequest("POST", "/sapi/v1/bnbBurn", {
      spotBNBBurn: spotBNBBurn ? "true" : "false"
    });
    if (!res.ok) throw new Error(`enableBnbBurn failed: ${JSON.stringify(res.data)}`);
    return res.data;
  }

  return {
    publicGet, signedRequest,
    getKlines, getPrice, getBalances,
    placeMarketBuyQuote, placeMarketSellQty, getOrder, getOCO,
    placeOCO, cancelOCO,
    syncTime, getBnbBurnStatus, enableBnbBurn
  };
}
