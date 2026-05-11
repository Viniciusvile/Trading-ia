import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = 'postgresql://postgres:mZSCYrLBrgbRpMoVIqoFBxycInhqsyqk@trolley.proxy.rlwy.net:43253/railway';

async function check() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    const res = await pool.query('SELECT session_start, symbol, trades FROM micro_sessions ORDER BY session_start DESC LIMIT 10');
    console.log('--- Last 10 Sessions ---');
    for (const row of res.rows) {
      console.log(`Start: ${row.session_start}, Symbol: ${row.symbol}, Trades: ${row.trades.length}`);
      // Check for trades today (May 11)
      const today = '2026-05-11';
      const todayTrades = row.trades.filter(t => t.t && t.t.includes(today));
      if (todayTrades.length > 0) {
        console.log(`  Found ${todayTrades.length} trades for ${today}`);
        todayTrades.forEach(t => console.log(`    ${t.t} | ${t.event} | ${t.pnlPct}`));
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

check();
