/**
 * db.js — Camada PostgreSQL para o MasterBot
 *
 * Substitui positions.json, trades.csv, safety-check-log.json e master-status.json.
 * Tanto bot.js quanto dashboard/server.js importam este módulo.
 *
 * Variável obrigatória: DATABASE_URL (connection string do PostgreSQL)
 */

import pg from 'pg';
const { Pool } = pg;

let _pool = null;

function getPool() {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        '❌ DATABASE_URL não definida.\n' +
        '   Local: adicione DATABASE_URL=postgres://... no arquivo .env\n' +
        '   Railway: adicione a variável em Settings → Variables'
      );
    }
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Railway e Supabase exigem SSL; conexões locais (localhost) não precisam
      ssl: process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
        ? false
        : { rejectUnauthorized: false },
    });
    _pool.on('error', (err) => {
      console.error('❌ Erro inesperado no pool PostgreSQL:', err.message);
    });
  }
  return _pool;
}

// ─── Inicialização ────────────────────────────────────────────────────────────

export async function initDb() {
  const client = await getPool().connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS positions (
        id      VARCHAR(100) PRIMARY KEY,
        symbol  VARCHAR(20),
        status  VARCHAR(10),
        data    JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
      CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
      CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions ( (data->>'openedAt') );

      CREATE TABLE IF NOT EXISTS trades (
        id   BIGSERIAL PRIMARY KEY,
        ts   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts ON trades(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_trades_order_placed ON trades (((data->>'orderPlaced')::boolean));

      CREATE TABLE IF NOT EXISTS master_status (
        id   INTEGER PRIMARY KEY DEFAULT 1,
        data JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      INSERT INTO master_status (id, data)
        VALUES (1, '{"status":"stopped","watchlist":[],"timeframes":[],"lastResults":[]}'::jsonb)
        ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS micro_sessions (
        id           BIGSERIAL PRIMARY KEY,
        session_start TIMESTAMPTZ NOT NULL,
        symbol       VARCHAR(20)  NOT NULL,
        trades       JSONB        NOT NULL DEFAULT '[]'::jsonb,
        UNIQUE (session_start, symbol)
      );
      CREATE INDEX IF NOT EXISTS idx_micro_sessions_ts ON micro_sessions(session_start DESC);

      CREATE TABLE IF NOT EXISTS micro_heartbeat (
        id        INTEGER PRIMARY KEY DEFAULT 1,
        ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        pid       INTEGER
      );
    `);

    // Rotina de limpeza (Retention Policy)
    // Exclui logs de scanner mais antigos que 15 dias, mantendo o que foi execução real
    await client.query(`
      DELETE FROM trades 
      WHERE ts < NOW() - INTERVAL '15 days' 
        AND COALESCE((data->>'orderPlaced')::boolean, false) = false;
    `);

    console.log('✅ PostgreSQL conectado e tabelas verificadas.');
  } catch (e) {
    console.error('❌ Erro ao inicializar banco de dados:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Posições ─────────────────────────────────────────────────────────────────

/** Retorna todas as posições ordenadas por data de abertura (mais antigas primeiro). */
export async function loadPositions() {
  const res = await getPool().query(
    `SELECT data FROM positions ORDER BY (data->>'openedAt') ASC NULLS FIRST`
  );
  return res.rows.map(r => r.data);
}

/** Salva (upsert) uma única posição — mais eficiente que savePositions para atualizações pontuais. */
export async function savePosition(pos) {
  await getPool().query(
    `INSERT INTO positions (id, symbol, status, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE
       SET symbol = EXCLUDED.symbol,
           status = EXCLUDED.status,
           data   = EXCLUDED.data`,
    [pos.id, pos.symbol, pos.status, JSON.stringify(pos)]
  );
}

/**
 * Faz UPSERT de todas as posições do array.
 * Preserva posições que não estão no array (não deleta).
 */
export async function savePositions(positions) {
  if (!positions || positions.length === 0) return;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const pos of positions) {
      await client.query(
        `INSERT INTO positions (id, symbol, status, data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE
           SET symbol = EXCLUDED.symbol,
               status = EXCLUDED.status,
               data   = EXCLUDED.data`,
        [pos.id, pos.symbol, pos.status, JSON.stringify(pos)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Adiciona uma nova posição.
 * Retorna silenciosamente se já existir posição aberta para o símbolo.
 */
export async function addPosition(
  symbol, timeframe, entryPrice, quantity,
  stopPrice, takeProfitPrice, orderId,
  ocoOrderListId = null, strategy = null,
  conditions = [], indicators = {}, planName = null
) {
  const existing = await loadPositions();
  if (existing.find(p => p.symbol === symbol && p.status === 'open')) return;

  const pos = {
    id: `POS-${Date.now()}`,
    symbol,
    timeframe,
    side: 'LONG',
    entryPrice,
    quantity,
    stopPrice,
    takeProfitPrice,
    orderId,
    ocoOrderListId,
    ocoPlaced: !!ocoOrderListId,
    openedAt: new Date().toISOString(),
    status: 'open',
    strategy,
    plan: planName,
    conditions,
    indicators,
  };

  await getPool().query(
    `INSERT INTO positions (id, symbol, status, data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [pos.id, pos.symbol, pos.status, JSON.stringify(pos)]
  );

  console.log(
    `📌 [${symbol}] Posição registrada: entrada $${entryPrice}, ` +
    `stop $${stopPrice?.toFixed(6)}, TP $${takeProfitPrice?.toFixed(6)}` +
    `${ocoOrderListId ? ` | OCO #${ocoOrderListId}` : ''}`
  );
}

// ─── Trades / Safety-check log ───────────────────────────────────────────────

/**
 * Registra um resultado de scan (equivalente ao safety-check-log.json + trades.csv).
 * O objeto `entry` é o logEntry do runSymbolCycle.
 */
export async function appendToLog(entry) {
  await getPool().query(
    `INSERT INTO trades (ts, data) VALUES ($1, $2)`,
    [new Date(entry.timestamp), JSON.stringify(entry)]
  );
}

/** Retorna as últimas `limit` entradas do log, em ordem cronológica (mais antigas primeiro). */
export async function loadRecentLog(limit = 20) {
  const res = await getPool().query(
    `SELECT data FROM trades ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return { trades: res.rows.map(r => r.data).reverse() };
}

/** Conta quantas trades com ordem colocada ocorreram hoje. */
export async function countTodaysTrades() {
  const today = new Date().toISOString().slice(0, 10);
  const res = await getPool().query(
    `SELECT COUNT(*) FROM trades
     WHERE ts >= $1::date AND ts < ($1::date + INTERVAL '1 day')
       AND (data->>'orderPlaced')::boolean = true`,
    [today]
  );
  return parseInt(res.rows[0].count, 10);
}

/** Retorna resumo para o comando --tax-summary. */
export async function generateTaxSummary() {
  const res = await getPool().query(`
    SELECT
      COUNT(*)                                                        AS total,
      COUNT(*) FILTER (WHERE (data->>'paperTrading')::boolean = false
                         AND  (data->>'orderPlaced')::boolean = true) AS live,
      COUNT(*) FILTER (WHERE (data->>'paperTrading')::boolean = true
                         AND  (data->>'orderPlaced')::boolean = true) AS paper,
      COUNT(*) FILTER (WHERE (data->>'allPass')::boolean = false)     AS blocked,
      COALESCE(SUM(
        CASE WHEN (data->>'allPass')::boolean = true
             THEN (data->>'tradeSize')::decimal ELSE 0 END
      ), 0)                                                           AS total_volume
    FROM trades
  `);
  return res.rows[0];
}

// ─── Master Status ────────────────────────────────────────────────────────────

export async function writeMasterStatus(state) {
  await getPool().query(
    `INSERT INTO master_status (id, data) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(state)]
  );
}

export async function loadMasterStatus() {
  const res = await getPool().query('SELECT data FROM master_status WHERE id = 1');
  return res.rows[0]?.data ?? { status: 'stopped', watchlist: [], timeframes: [], lastResults: [] };
}

// ─── Micro-Scalper Sessions ───────────────────────────────────────────────────

/** Salva (upsert) uma sessão do Micro-Scalper. */
export async function saveMicroSession(sessionStart, symbol, trades) {
  const ts = new Date(sessionStart);
  await getPool().query(
    `INSERT INTO micro_sessions (session_start, symbol, trades)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_start, symbol) DO UPDATE SET trades = EXCLUDED.trades`,
    [ts, symbol, JSON.stringify(trades)]
  );
}

/** Retorna as últimas sessões agrupadas (formato compatível com o dashboard). */
export async function loadMicroSessions(limit = 200) {
  const res = await getPool().query(
    `SELECT session_start, symbol, trades
     FROM micro_sessions
     ORDER BY session_start DESC
     LIMIT $1`,
    [limit]
  );
  // Reagrupa por session_start (igual ao formato do JSON antigo)
  const map = new Map();
  for (const row of res.rows.reverse()) {
    const key = new Date(row.session_start).toISOString();
    if (!map.has(key)) map.set(key, { sessionStart: key, trades: [] });
    const sess = map.get(key);
    const formatted = (row.trades || []).map(t => ({ ...t, symbol: row.symbol }));
    sess.trades = [...sess.trades.filter(t => t.symbol !== row.symbol), ...formatted];
  }
  return [...map.values()];
}

/** Lê o log de um símbolo para verificar posição aberta (substitui leitura do JSON). */
export async function loadMicroSymbolTrades(symbol) {
  const res = await getPool().query(
    `SELECT trades FROM micro_sessions
     WHERE symbol = $1
     ORDER BY session_start DESC
     LIMIT 10`,
    [symbol]
  );
  const all = [];
  for (const row of res.rows.reverse()) {
    all.push(...(row.trades || []));
  }
  return all;
}

// ─── Micro-Scalper Heartbeat ──────────────────────────────────────────────────

/** Atualiza o heartbeat do Micro-Scalper (chamar a cada ciclo). */
export async function writeMicroHeartbeat(pid) {
  await getPool().query(
    `INSERT INTO micro_heartbeat (id, ts, pid) VALUES (1, NOW(), $1)
     ON CONFLICT (id) DO UPDATE SET ts = NOW(), pid = EXCLUDED.pid`,
    [pid ?? null]
  );
}

/**
 * Retorna { alive: boolean, pid, lastSeen }.
 * Considera vivo se o heartbeat foi atualizado nos últimos `maxAgeMs` ms (padrão: 2 min).
 */
export async function readMicroHeartbeat(maxAgeMs = 120_000) {
  const res = await getPool().query('SELECT ts, pid FROM micro_heartbeat WHERE id = 1');
  if (!res.rows.length) return { alive: false, pid: null, lastSeen: null };
  const { ts, pid } = res.rows[0];
  const age = Date.now() - new Date(ts).getTime();
  return { alive: age <= maxAgeMs, pid, lastSeen: ts };
}
