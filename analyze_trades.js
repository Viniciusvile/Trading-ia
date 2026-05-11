import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = 'postgresql://postgres:mZSCYrLBrgbRpMoVIqoFBxycInhqsyqk@trolley.proxy.rlwy.net:43253/railway';

async function analyze() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    // Buscar logs de scan (safety-check-log) do dia 10 e 11
    const res = await pool.query(`
      SELECT ts, data 
      FROM trades 
      WHERE ts >= '2026-05-10' 
      ORDER BY ts DESC 
      LIMIT 100
    `);
    
    console.log('--- Safety Check Logs (Last 100) ---');
    for (const row of res.rows) {
      const d = row.data;
      // Filtrar por trades que resultaram em ordem (orderPlaced: true) ou falharam em filtros
      if (d.orderPlaced || !d.allPass) {
        console.log(`[${row.ts.toISOString()}] ${d.symbol} | Pass: ${d.allPass} | Reason: ${d.blockReason || 'Order Placed'} | Strategy: ${d.plan || d.strategy}`);
        if (d.filters) {
          console.log(`   Filters: ${JSON.stringify(d.filters)}`);
        }
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}

analyze();
