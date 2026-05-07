
import { createBinanceClient } from './src/exchange/binance.js';
import { config } from 'dotenv';
config();

const client = createBinanceClient({ 
  apiKey: process.env.BINANCE_API_KEY, 
  secretKey: process.env.BINANCE_SECRET_KEY 
});

async function run() {
  await client.syncTime();
  const info = await client.signedRequest('GET', '/api/v3/exchangeInfo');
  const symbols = ['SOLUSDT', 'XRPUSDT'];
  
  const results = info.symbols
    .filter(s => symbols.includes(s.symbol))
    .map(s => ({
      symbol: s.symbol,
      baseAssetPrecision: s.baseAssetPrecision,
      quotePrecision: s.quotePrecision,
      stepSize: s.filters.find(f => f.filterType === 'LOT_SIZE').stepSize,
      tickSize: s.filters.find(f => f.filterType === 'PRICE_FILTER').tickSize
    }));
    
  console.log(JSON.stringify(results, null, 2));
}

run().catch(console.error);
