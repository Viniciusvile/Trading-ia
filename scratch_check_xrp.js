
import * as db from "./masterbot/db.js";
import { createBinanceClient } from "./src/exchange/binance.js";
import { existsSync, readFileSync } from "fs";

// Load .env manually for the script
const envPath = "./.env";
if (existsSync(envPath)) {
  readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#") && v.length) process.env[k.trim()] = v.join("=").trim();
  });
}

async function check() {
  await db.initDb();
  
  const hb = await db.readMicroHeartbeat();
  console.log("Heartbeat:", hb);

  const xrpTrades = await db.loadMicroSymbolTrades("XRPUSDT");
  console.log("Last 5 XRP Trades in DB:");
  console.log(JSON.stringify(xrpTrades.slice(-5), null, 2));

  const client = createBinanceClient({
    apiKey: process.env.USE_BINANCE_KEY || process.env.BINANCE_API_KEY,
    secretKey: process.env.USE_BINANCE_SECRET || process.env.BINANCE_SECRET_KEY,
  });

  const lastTrade = xrpTrades[xrpTrades.length - 1];
  if (lastTrade && lastTrade.event === "entry") {
    console.log("\nFound OPEN XRP trade in DB. Checking Binance...");
    const bals = await client.getBalances(["XRP"]);
    console.log("XRP Balance:", bals.xrp);
    
    if (lastTrade.ocoId) {
      console.log("Checking OCO ID:", lastTrade.ocoId);
      const oco = await client.getOCO(lastTrade.ocoId);
      console.log("OCO Status:", JSON.stringify(oco.data, null, 2));
    }
  }

  process.exit(0);
}

check();
