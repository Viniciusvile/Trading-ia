
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function checkTrades() {
  try {
    const res = await pool.query(`
      SELECT data->>'symbol' as symbol, data->>'timestamp' as ts, data->>'side' as side, 
             data->>'entryPrice' as entry, data->>'stopLoss' as sl, data->>'takeProfit' as tp,
             data->>'allPass' as all_pass, data->>'verdict' as verdict, data->>'strategy' as strategy
      FROM trades 
      WHERE (data->>'symbol' = 'BTCUSDT' OR data->>'symbol' = 'ETHUSDT')
        AND ts >= '2026-05-07T00:00:00Z'
      ORDER BY ts DESC
    `);
    
    console.log("Recent Master Bot Trades (today):");
    console.table(res.rows);
    
    // Check specific indicators if available in the log
    const detail = await pool.query(`
      SELECT data 
      FROM trades 
      WHERE (data->>'symbol' = 'BTCUSDT' OR data->>'symbol' = 'ETHUSDT')
        AND ts >= '2026-05-07T00:00:00Z'
      LIMIT 5
    `);
    
    detail.rows.forEach(r => {
        console.log(`\n--- Detail for ${r.data.symbol} at ${r.data.timestamp} ---`);
        console.log("Verdict:", r.data.verdict);
        console.log("Indicators:", JSON.stringify(r.data.indicators, null, 2));
    });

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

checkTrades();
