import fetch from 'node-fetch';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../.env');

// Load environment variables manually
const env = {};
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=');
    if (key) env[key.trim()] = val.join('=').trim().replace(/^"|"$/g, '');
  });
}

const API_KEY = env.BINANCE_API_KEY;
const SECRET_KEY = env.BINANCE_SECRET_KEY;
const BASE_URL = 'https://api.binance.com';

async function getPrecision(symbol) {
  const res = await fetch(`${BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  const info = data.symbols?.[0];
  if (!info) return 8;
  const lf = info.filters.find(f => f.filterType === 'LOT_SIZE');
  const step = lf ? parseFloat(lf.stepSize) : 0.00000001;
  const countDecimals = (n) => {
    if (Math.floor(n) === n) return 0;
    const s = n.toString();
    if (s.includes('e-')) return parseInt(s.split('e-')[1]);
    return s.split(".")[1].length || 0;
  };
  return countDecimals(step);
}

async function sellAll(symbol) {
  console.log(`\n🧹 Iniciando limpeza de ${symbol}...`);
  const asset = symbol.replace('USDT', '');
  
  // 1. Get Balance
  const timestamp = Date.now();
  const balanceQuery = `timestamp=${timestamp}`;
  const balanceSig = crypto.createHmac('sha256', SECRET_KEY).update(balanceQuery).digest('hex');
  const accountRes = await fetch(`${BASE_URL}/api/v3/account?${balanceQuery}&signature=${balanceSig}`, {
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const accountData = await accountRes.json();
  const balance = accountData.balances.find(b => b.asset === asset);
  const qty = parseFloat(balance?.free || 0);

  if (qty <= 0) {
    console.log(`✅ Nenhum saldo de ${asset} encontrado.`);
    return;
  }

  console.log(`💰 Saldo encontrado: ${qty} ${asset}`);

  // 2. Cancel Orders
  const cancelQuery = `symbol=${symbol}&timestamp=${timestamp}`;
  const cancelSig = crypto.createHmac('sha256', SECRET_KEY).update(cancelQuery).digest('hex');
  await fetch(`${BASE_URL}/api/v3/openOrders?${cancelQuery}&signature=${cancelSig}`, {
    method: 'DELETE',
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  console.log(`🚿 Ordens abertas canceladas.`);

  // 3. Sell
  const precision = await getPrecision(symbol);
  const qtyRounded = qty.toFixed(precision);
  const sellQuery = `symbol=${symbol}&side=SELL&type=MARKET&quantity=${qtyRounded}&timestamp=${timestamp}`;
  const sellSig = crypto.createHmac('sha256', SECRET_KEY).update(sellQuery).digest('hex');
  const sellRes = await fetch(`${BASE_URL}/api/v3/order?${sellQuery}&signature=${sellSig}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const sellData = await sellRes.json();

  if (sellData.code) {
    console.log(`❌ Erro ao vender ${symbol}: ${sellData.msg}`);
  } else {
    console.log(`🚀 VENDA EXECUTADA! ${qtyRounded} ${symbol} vendidos com sucesso.`);
  }
}

async function run() {
  await sellAll('BONKUSDT');
  await sellAll('RENDERUSDT');
  console.log('\n✅ Limpeza concluída! Seu saldo agora deve estar 100% em USDT.');
}

run();
