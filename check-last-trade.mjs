import { config as dotenvConfig } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: join(__dirname, ".env") });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const { rows } = await pool.query(
  `SELECT data FROM trades ORDER BY id DESC LIMIT 5`
);

console.log("\n=== ÚLTIMAS 5 DECISÕES DO BOT ===\n");
rows.reverse().forEach((r, i) => {
  const t = r.data;
  const ts = new Date(t.timestamp).toLocaleString("pt-BR");
  const status = t.orderPlaced ? "✅ ORDEM COLOCADA" :
                 t.forced      ? "⚡ FORÇADO — ORDEM FALHOU" :
                 t.allPass     ? "⚡ APROVADO — sem ordem" :
                                 "🚫 BLOQUEADO";
  console.log(`[${i+1}] ${ts} | ${t.symbol} ${t.timeframe}`);
  console.log(`     Status: ${status}`);
  if (t.error) console.log(`     ❌ ERRO: ${t.error}`);
  if (t.orderId) console.log(`     OrderId: ${t.orderId}`);
  console.log(`     allPass=${t.allPass} | forced=${t.forced} | orderPlaced=${t.orderPlaced}`);
  console.log();
});

await pool.end();
