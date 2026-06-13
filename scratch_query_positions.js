import pg from 'pg';
const { Pool } = pg;
const DATABASE_URL = 'postgres://masterbot:masterbot123@localhost:5432/masterbot';
const pool = new Pool({ connectionString: DATABASE_URL });

pool.query('SELECT id, symbol, status, account_id, (data->>\'plan\') as plan, (data->>\'closedAt\') as closed_at FROM positions ORDER BY data->>\'openedAt\' DESC LIMIT 10').then(res => {
  console.log('--- Last 10 Positions ---');
  console.log(res.rows);
  pool.end();
}).catch(console.error);
