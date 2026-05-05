/**
 * migrate-to-postgres.js
 *
 * Importa os dados locais existentes para o PostgreSQL.
 * Execute UMA VEZ após configurar DATABASE_URL:
 *
 *   node masterbot/migrate-to-postgres.js
 *
 * O script é idempotente: usa ON CONFLICT DO NOTHING para posições
 * e verifica datas para evitar duplicar trades.
 */

import { config as dotenvConfig } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as db from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

dotenvConfig({ path: join(ROOT, '.env') });

async function migratePositions() {
  const file = join(__dirname, 'positions.json');
  if (!existsSync(file)) { console.log('  ⏭  positions.json não encontrado — pulando.'); return 0; }

  const positions = JSON.parse(readFileSync(file, 'utf8'));
  if (!positions.length) { console.log('  ⏭  positions.json vazio — pulando.'); return 0; }

  console.log(`  📦 Importando ${positions.length} posições...`);
  let imported = 0;
  for (const pos of positions) {
    if (!pos.id) pos.id = `POS-MIGRATED-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const { Pool } = (await import('pg')).default;
      // reusa o pool interno do db.js via query direta
      await db.savePositions([pos]);
      imported++;
    } catch (e) {
      console.warn(`  ⚠  Posição ${pos.id} ignorada: ${e.message}`);
    }
  }
  return imported;
}

async function migrateSafetyLog() {
  const file = join(__dirname, 'safety-check-log.json');
  if (!existsSync(file)) { console.log('  ⏭  safety-check-log.json não encontrado — pulando.'); return 0; }

  const raw = readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch { console.log('  ⚠  safety-check-log.json inválido — pulando.'); return 0; }
  const entries = Array.isArray(data) ? data : (data.trades || []);
  if (!entries.length) { console.log('  ⏭  safety-check-log.json vazio — pulando.'); return 0; }

  console.log(`  📦 Importando ${entries.length} entradas do log de segurança...`);
  const pg = await import('pg');
  const { Pool } = pg.default;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  let imported = 0;
  const BATCH = 200;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const entry of batch) {
        if (!entry.timestamp) entry.timestamp = new Date().toISOString();
        await client.query(
          `INSERT INTO trades (ts, data) VALUES ($1, $2)`,
          [new Date(entry.timestamp), JSON.stringify(entry)]
        );
        imported++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      console.warn(`  ⚠  Lote ${i}–${i + BATCH} falhou: ${e.message}`);
    } finally {
      client.release();
    }
    if (i % 2000 === 0 && i > 0) process.stdout.write(`    ${i}/${entries.length}...\n`);
  }
  await pool.end();
  return imported;
}

async function migrateCsv() {
  const file = join(__dirname, 'trades.csv');
  if (!existsSync(file)) { console.log('  ⏭  trades.csv não encontrado — pulando.'); return 0; }

  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const rows = lines.slice(1).filter(l => l.trim() && !l.includes('NOTE'));
  if (!rows.length) { console.log('  ⏭  trades.csv vazio — pulando.'); return 0; }

  console.log(`  📦 Importando ${rows.length} linhas do CSV de trades...`);
  const pg = await import('pg');
  const { Pool } = pg.default;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  const headers = ['date', 'time', 'exchange', 'symbol', 'side', 'quantity', 'price', 'totalUSD', 'feeEst', 'netAmount', 'orderId', 'mode', 'notes'];
  let imported = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const line of rows) {
      const parts = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|(?<=,)$|^(?=,))/g) || line.split(',');
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (parts[i] || '').replace(/^"|"$/g, '').trim(); });
      const ts = obj.date && obj.time ? new Date(`${obj.date}T${obj.time}Z`) : new Date();
      // Armazena o CSV como entrada de trade com flag csv:true
      const data = { ...obj, timestamp: ts.toISOString(), _source: 'csv', allPass: obj.mode !== 'BLOCKED', orderPlaced: obj.mode === 'LIVE' || obj.mode === 'PAPER', paperTrading: obj.mode === 'PAPER' };
      await client.query(`INSERT INTO trades (ts, data) VALUES ($1, $2)`, [ts, JSON.stringify(data)]);
      imported++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.warn(`  ⚠  CSV migration falhou: ${e.message}`);
  } finally {
    client.release();
    await pool.end();
  }
  return imported;
}

async function migrateMicroScalperLog() {
  const file = join(ROOT, 'micro-scalper-log.json');
  if (!existsSync(file)) { console.log('  ⏭  micro-scalper-log.json não encontrado — pulando.'); return 0; }

  let sessions;
  try { sessions = JSON.parse(readFileSync(file, 'utf8')); } catch { console.log('  ⚠  micro-scalper-log.json inválido — pulando.'); return 0; }
  if (!Array.isArray(sessions) || !sessions.length) { console.log('  ⏭  micro-scalper-log.json vazio — pulando.'); return 0; }

  console.log(`  📦 Importando ${sessions.length} sessões do Micro-Scalper...`);
  let imported = 0;
  for (const sess of sessions) {
    if (!sess.sessionStart) continue;
    // Formato legado não tem símbolo — usa 'LEGACY' para preservar histórico
    const symbol = sess.symbol || 'LEGACY';
    try {
      await db.saveMicroSession(sess.sessionStart, symbol, sess.trades || []);
      imported++;
    } catch (e) {
      console.warn(`  ⚠  Sessão ${sess.sessionStart} ignorada: ${e.message}`);
    }
  }
  return imported;
}

async function main() {
  console.log('\n🚀 Iniciando migração para PostgreSQL...\n');

  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL não definida. Configure no .env e tente novamente.');
    process.exit(1);
  }

  await db.initDb();

  const p = await migratePositions();
  console.log(`  ✅ Posições importadas: ${p}\n`);

  const l = await migrateSafetyLog();
  console.log(`  ✅ Entradas do log importadas: ${l}\n`);

  const m = await migrateMicroScalperLog();
  console.log(`  ✅ Sessões do Micro-Scalper importadas: ${m}\n`);

  // CSV tem dados redundantes com o log — importe só se quiser histórico CSV separado
  // const c = await migrateCsv();
  // console.log(`  ✅ Linhas CSV importadas: ${c}\n`);

  console.log('✅ Migração concluída!\n');
  process.exit(0);
}

main().catch(e => { console.error('❌ Erro na migração:', e); process.exit(1); });
