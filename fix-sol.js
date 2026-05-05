import { createBinanceClient } from './src/exchange/binance.js';
import { existsSync, readFileSync } from 'fs';

// Load .env manually
const envPath = ".env";
if (existsSync(envPath)) {
  readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const [k, ...v] = line.split("=");
    if (k && !k.startsWith("#") && v.length) process.env[k.trim()] = v.join("=").trim();
  });
}

const client = createBinanceClient({
  apiKey: process.env.BINANCE_API_KEY,
  secretKey: process.env.BINANCE_SECRET_KEY,
});

async function fix() {
  await client.syncTime();
  const symbol = "SOLUSDT";
  const asset = "SOL";
  const bals = await client.getBalances([asset]);
  const qty = bals[asset.toLowerCase()];
  console.log(`Current SOL balance: ${qty}`);
  
  if (qty > 0.05) {
    const price = await client.getPrice(symbol);
    const tpPrice = price * 1.012;
    const slPrice = price * 0.992;
    
    const qtyRounded = (Math.floor(qty * 1000) / 1000).toFixed(3);
    console.log(`Placing OCO for ${qtyRounded} SOL: TP=${tpPrice.toFixed(2)}, SL=${slPrice.toFixed(2)}`);
    // Usando precisão de 3 para quantidade de SOL e 2 para preço
    const res = await client.placeOCO(symbol, "SELL", qtyRounded, tpPrice, slPrice, slPrice * 0.995, 2);
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("No significant SOL balance found to protect.");
  }
}

fix().catch(console.error);
