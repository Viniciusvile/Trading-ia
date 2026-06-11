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

      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
 
      CREATE TABLE IF NOT EXISTS accounts (
        id VARCHAR(100) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        api_key VARCHAR(255) NOT NULL,
        secret_key VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT false,
        is_testnet BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Estratégias (group_plans) isoladas por usuário. Antes viviam num
      -- único rules.json global, o que vazava as estratégias de um usuário
      -- para todos os outros logins.
      CREATE TABLE IF NOT EXISTS strategies (
        id         BIGSERIAL PRIMARY KEY,
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name       VARCHAR(120) NOT NULL,
        data       JSONB NOT NULL,
        is_active  BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (user_id, name)
      );
      CREATE INDEX IF NOT EXISTS idx_strategies_user ON strategies(user_id);
    `);

    // Migrações dinâmicas para adicionar account_id e user_id
    await client.query(`
      ALTER TABLE positions ADD COLUMN IF NOT EXISTS account_id VARCHAR(100) DEFAULT 'default';
      ALTER TABLE trades ADD COLUMN IF NOT EXISTS account_id VARCHAR(100) DEFAULT 'default';
      ALTER TABLE micro_sessions ADD COLUMN IF NOT EXISTS account_id VARCHAR(100) DEFAULT 'default';
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    `);

    // Migração de constraint UNIQUE para micro_sessions
    try {
      await client.query(`
        ALTER TABLE micro_sessions DROP CONSTRAINT IF EXISTS micro_sessions_session_start_symbol_key;
        ALTER TABLE micro_sessions ADD CONSTRAINT micro_sessions_session_start_symbol_account_id_key UNIQUE (session_start, symbol, account_id);
      `);
    } catch (e) {
      // Ignora se já existir
    }

    // Seed de usuário administrador padrão (se a tabela de usuários estiver vazia)
    // Email: admin@trading.io | Senha: admin
    const userCheck = await client.query('SELECT COUNT(*) FROM users');
    let defaultUserId = null;
    if (parseInt(userCheck.rows[0].count, 10) === 0) {
      const bcrypt = await import('bcryptjs');
      const hash = bcrypt.default.hashSync('admin', 10);
      const insertUser = await client.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, $3) RETURNING id`,
        ['Admin', 'admin@trading.io', hash]
      );
      defaultUserId = insertUser.rows[0].id;
      console.log('👤 Usuário administrador padrão criado: admin@trading.io / admin');
    } else {
      const getFirstUser = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
      defaultUserId = getFirstUser.rows[0].id;
    }

    // Se existirem contas com user_id nulo, associa-as ao administrador padrão
    if (defaultUserId) {
      await client.query('UPDATE accounts SET user_id = $1 WHERE user_id IS NULL', [defaultUserId]);
    }

    // Cria conta padrão se a tabela estiver vazia
    const accCheck = await client.query('SELECT COUNT(*) FROM accounts');
    if (parseInt(accCheck.rows[0].count, 10) === 0 && process.env.BINANCE_API_KEY && process.env.BINANCE_SECRET_KEY) {
      await client.query(
        `INSERT INTO accounts (id, name, api_key, secret_key, is_active, is_testnet, user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['default', 'Conta Principal', process.env.BINANCE_API_KEY.trim(), process.env.BINANCE_SECRET_KEY.trim(), true, process.env.BINANCE_IS_TESTNET === 'true', defaultUserId]
      );
    }

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
export async function loadPositions(userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return [];
  const res = await getPool().query(
    `SELECT data FROM positions WHERE account_id = $1 ORDER BY (data->>'openedAt') ASC NULLS FIRST`,
    [accId]
  );
  return res.rows.map(r => r.data);
}

/** Salva (upsert) uma única posição — mais eficiente que savePositions para atualizações pontuais. */
export async function savePosition(pos, userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return;
  await getPool().query(
    `INSERT INTO positions (id, symbol, status, data, account_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
       SET symbol = EXCLUDED.symbol,
           status = EXCLUDED.status,
           data   = EXCLUDED.data,
           account_id = EXCLUDED.account_id`,
    [pos.id, pos.symbol, pos.status, JSON.stringify(pos), accId]
  );
}

/**
 * Faz UPSERT de todas as posições do array.
 * Preserva posições que não estão no array (não deleta).
 */
export async function savePositions(positions, userId = null) {
  if (!positions || positions.length === 0) return;
  const accId = await getActiveAccountId(userId);
  if (!accId) return;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    for (const pos of positions) {
      await client.query(
        `INSERT INTO positions (id, symbol, status, data, account_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE
           SET symbol = EXCLUDED.symbol,
               status = EXCLUDED.status,
               data   = EXCLUDED.data,
               account_id = EXCLUDED.account_id`,
        [pos.id, pos.symbol, pos.status, JSON.stringify(pos), accId]
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
  conditions = [], indicators = {}, planName = null,
  userId = null
) {
  const existing = await loadPositions(userId);
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

  const accId = await getActiveAccountId(userId);
  if (!accId) return;
  await getPool().query(
    `INSERT INTO positions (id, symbol, status, data, account_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [pos.id, pos.symbol, pos.status, JSON.stringify(pos), accId]
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
export async function appendToLog(entry, userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return;
  await getPool().query(
    `INSERT INTO trades (ts, data, account_id) VALUES ($1, $2, $3)`,
    [new Date(entry.timestamp), JSON.stringify(entry), accId]
  );
}

/** Retorna as últimas `limit` entradas do log, em ordem cronológica (mais antigas primeiro). */
export async function loadRecentLog(limit = 100, userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return { trades: [] };
  const res = await getPool().query(
    `SELECT data FROM trades WHERE account_id = $1 ORDER BY id DESC LIMIT $2`,
    [accId, limit]
  );
  return { trades: res.rows.map(r => r.data).reverse() };
}

/** Conta quantas trades com ordem colocada ocorreram hoje. */
export async function countTodaysTrades(userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const res = await getPool().query(
    `SELECT COUNT(*) FROM trades
     WHERE account_id = $1
       AND ts >= $2::date AND ts < ($2::date + INTERVAL '1 day')
       AND (data->>'orderPlaced')::boolean = true`,
    [accId, today]
  );
  return parseInt(res.rows[0].count, 10);
}

/** Retorna resumo para o comando --tax-summary. */
export async function generateTaxSummary(userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return { total: 0, live: 0, paper: 0, blocked: 0, total_volume: 0 };
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
    WHERE account_id = $1
  `, [accId]);
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

export async function writeFuturesStatus(state) {
  await getPool().query(
    `INSERT INTO master_status (id, data) VALUES (2, $1)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [JSON.stringify(state)]
  );
}

export async function loadFuturesStatus() {
  const res = await getPool().query('SELECT data FROM master_status WHERE id = 2');
  return res.rows[0]?.data ?? { status: 'stopped', watchlist: [], timeframes: [], lastResults: [] };
}

// ─── Micro-Scalper Sessions ───────────────────────────────────────────────────

/** Salva (upsert) uma sessão do Micro-Scalper. */
export async function saveMicroSession(sessionStart, symbol, trades, userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return;
  const ts = new Date(sessionStart);
  await getPool().query(
    `INSERT INTO micro_sessions (session_start, symbol, trades, account_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (session_start, symbol, account_id) DO UPDATE SET trades = EXCLUDED.trades`,
    [ts, symbol, JSON.stringify(trades), accId]
  );
}

/** Retorna as últimas sessões agrupadas (formato compatível com o dashboard). */
export async function loadMicroSessions(limit = 200, userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return [];
  const res = await getPool().query(
    `SELECT session_start, symbol, trades
     FROM micro_sessions
     WHERE account_id = $1
     ORDER BY session_start DESC
     LIMIT $2`,
    [accId, limit]
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
export async function loadMicroSymbolTrades(symbol, userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return [];
  const res = await getPool().query(
    `SELECT trades FROM micro_sessions
     WHERE symbol = $1 AND account_id = $2
     ORDER BY session_start DESC
     LIMIT 10`,
    [symbol, accId]
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

/**
 * Soma o PnL realizado (USD) das posições fechadas HOJE (UTC) da conta ativa.
 * Usado pelo kill switch de perda diária (rules.risk.daily_max_loss_usd):
 * inclui trades do MasterBot e do Micro-Scalper (todos gravam em positions).
 */
export async function getTodayRealizedPnlUsd(userId = null) {
  const accId = await getActiveAccountId(userId);
  if (!accId) return 0;
  // closedAt é ISO string — os 10 primeiros caracteres são a data UTC
  const res = await getPool().query(
    `SELECT COALESCE(SUM((data->>'pnl')::numeric), 0) AS pnl
       FROM positions
      WHERE account_id = $1
        AND status = 'closed'
        AND substring(data->>'closedAt' from 1 for 10) = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD')
        AND data->>'pnl' IS NOT NULL`,
    [accId]
  );
  return parseFloat(res.rows[0]?.pnl || 0);
}

// ─── Accounts Helper Functions ───────────────────────────────────────────────

export async function getActiveAccountId(userId = null) {
  try {
    if (userId) {
      const res = await getPool().query('SELECT id FROM accounts WHERE user_id = $1 AND is_active = true LIMIT 1', [userId]);
      if (res.rows.length) return res.rows[0].id;
      return null;
    }
    // Sem userId (chamadas dos robôs): resolve pela conta cujas chaves o robô
    // realmente usa (.env) — determinístico. "Primeira ativa" era arbitrário e
    // fazia posições serem gravadas em contas que o usuário logado não vê.
    const envKey = process.env.BINANCE_API_KEY;
    if (envKey) {
      const byKey = await getPool().query('SELECT id FROM accounts WHERE api_key = $1 LIMIT 1', [envKey]);
      if (byKey.rows.length) return byKey.rows[0].id;
    }
    const res = await getPool().query('SELECT id FROM accounts WHERE is_active = true LIMIT 1');
    if (res.rows.length) return res.rows[0].id;
  } catch (e) {}
  return 'default';
}

export async function getActiveAccount(userId = null) {
  try {
    if (userId) {
      const res = await getPool().query('SELECT * FROM accounts WHERE user_id = $1 AND is_active = true LIMIT 1', [userId]);
      if (res.rows.length) return res.rows[0];
      return null;
    }
    // Sem userId: resolve pela conta cujas chaves o robô usa (.env) —
    // "primeira ativa" pegava a conta (de teste) de outro usuário.
    const envKey = process.env.BINANCE_API_KEY;
    if (envKey) {
      const byKey = await getPool().query('SELECT * FROM accounts WHERE api_key = $1 LIMIT 1', [envKey]);
      if (byKey.rows.length) return byKey.rows[0];
    }
    const res = await getPool().query('SELECT * FROM accounts WHERE is_active = true LIMIT 1');
    if (res.rows.length) return res.rows[0];
  } catch (e) {}
  return null;
}

export async function listAccounts(userId = null) {
  try {
    const queryStr = userId 
      ? 'SELECT id, name, api_key, is_active, is_testnet, created_at FROM accounts WHERE user_id = $1 ORDER BY created_at ASC'
      : 'SELECT id, name, api_key, is_active, is_testnet, created_at FROM accounts ORDER BY created_at ASC';
    const params = userId ? [userId] : [];
    const res = await getPool().query(queryStr, params);
    return res.rows.map(row => ({
      id: row.id,
      name: row.name,
      apiKey: row.api_key ? `${row.api_key.slice(0, 6)}...${row.api_key.slice(-6)}` : '',
      isActive: row.is_active,
      isTestnet: row.is_testnet,
      createdAt: row.created_at
    }));
  } catch (e) {
    return [];
  }
}

export async function createAccount(userId, name, apiKey, secretKey, isTestnet = false) {
  const id = `ACC-${Date.now()}`;
  
  // Se for a única conta desse usuário, ou se não houver outras contas ativas globalmente, marca como ativa
  const countRes = await getPool().query('SELECT COUNT(*) FROM accounts WHERE user_id = $1', [userId]);
  const isFirst = parseInt(countRes.rows[0].count, 10) === 0;
  
  await getPool().query(
    `INSERT INTO accounts (id, name, api_key, secret_key, is_active, is_testnet, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, name, apiKey, secretKey, isFirst, isTestnet, userId]
  );
  return id;
}

export async function activateAccount(userId, id) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // Para simplificar, desativa todas as contas DO USUÁRIO específico (preserva o isolamento multi-tenant)
    await client.query('UPDATE accounts SET is_active = false WHERE user_id = $1', [userId]);
    // Ativa a conta específica do usuário
    await client.query('UPDATE accounts SET is_active = true WHERE user_id = $1 AND id = $2', [userId, id]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteAccount(userId, id) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    
    // Verifica se a conta deletada era ativa
    const checkActive = await client.query('SELECT is_active FROM accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    const wasActive = checkActive.rows[0]?.is_active;
    
    await client.query('DELETE FROM accounts WHERE user_id = $1 AND id = $2', [userId, id]);
    
    // Se era ativa, ativa a primeira conta que sobrar para o usuário
    if (wasActive) {
      const remaining = await client.query('SELECT id FROM accounts WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1', [userId]);
      if (remaining.rows.length) {
        await client.query('UPDATE accounts SET is_active = true WHERE id = $1', [remaining.rows[0].id]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Strategies (group_plans por usuário) ────────────────────────────────────

/** Lista as estratégias de um usuário. Cada item é o objeto do plano + flag active. */
export async function listStrategies(userId) {
  if (!userId) return [];
  const res = await getPool().query(
    'SELECT name, data, is_active FROM strategies WHERE user_id = $1 ORDER BY created_at ASC',
    [userId]
  );
  return res.rows.map(r => ({ ...r.data, name: r.name, _active: r.is_active }));
}

/** Cria ou atualiza (upsert) uma estratégia do usuário, casando por nome. */
export async function upsertStrategy(userId, name, plan) {
  if (!userId) throw new Error('userId obrigatório');
  await getPool().query(
    `INSERT INTO strategies (user_id, name, data)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, name) DO UPDATE
       SET data = EXCLUDED.data, updated_at = NOW()`,
    [userId, name, JSON.stringify(plan)]
  );
}

/** Remove uma estratégia do usuário. */
export async function deleteStrategy(userId, name) {
  if (!userId) return;
  await getPool().query(
    'DELETE FROM strategies WHERE user_id = $1 AND name = $2',
    [userId, name]
  );
}

/**
 * Define qual estratégia do usuário está ativa (no máximo uma).
 * Passar name = null desativa todas.
 */
export async function setActiveStrategy(userId, name) {
  if (!userId) return;
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE strategies SET is_active = false WHERE user_id = $1', [userId]);
    if (name) {
      await client.query(
        'UPDATE strategies SET is_active = true WHERE user_id = $1 AND name = $2',
        [userId, name]
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

/** Retorna o nome da estratégia ativa do usuário, ou null. */
export async function getActiveStrategyName(userId) {
  if (!userId) return null;
  const res = await getPool().query(
    'SELECT name FROM strategies WHERE user_id = $1 AND is_active = true LIMIT 1',
    [userId]
  );
  return res.rows[0]?.name || null;
}

/**
 * Migração one-time: semeia a tabela strategies com os group_plans vindos do
 * rules.json global, atribuindo-os ao usuário dono. Idempotente — só roda se o
 * usuário ainda não tiver nenhuma estratégia.
 */
export async function seedStrategiesForUser(userId, plans, activePlanName = null) {
  if (!userId || !Array.isArray(plans) || plans.length === 0) return 0;
  const countRes = await getPool().query(
    'SELECT COUNT(*) FROM strategies WHERE user_id = $1', [userId]
  );
  if (parseInt(countRes.rows[0].count, 10) > 0) return 0;
  const client = await getPool().connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const plan of plans) {
      if (!plan?.name) continue;
      await client.query(
        `INSERT INTO strategies (user_id, name, data, is_active)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, name) DO NOTHING`,
        [userId, plan.name, JSON.stringify(plan), plan.name === activePlanName]
      );
      inserted++;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return inserted;
}

/** Resolve o user_id dono da conta default (a que o bot usa via .env). */
export async function getOwnerUserId() {
  try {
    const envKey = process.env.BINANCE_API_KEY;
    if (envKey) {
      const byKey = await getPool().query(
        'SELECT user_id FROM accounts WHERE api_key = $1 AND user_id IS NOT NULL LIMIT 1',
        [envKey]
      );
      if (byKey.rows.length) return byKey.rows[0].user_id;
    }
    // Fallback: primeiro usuário criado (admin/dono histórico)
    const first = await getPool().query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    return first.rows[0]?.id || null;
  } catch (e) {
    return null;
  }
}

// ─── User Helper Functions ───────────────────────────────────────────────────

export async function createUser(name, email, passwordHash) {
  const res = await getPool().query(
    `INSERT INTO users (name, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, name, email, created_at`,
    [name, email.toLowerCase().trim(), passwordHash]
  );
  return res.rows[0];
}

export async function getUserByEmail(email) {
  const res = await getPool().query(
    'SELECT * FROM users WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  return res.rows[0] || null;
}

export async function getUserById(id) {
  const res = await getPool().query(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  return res.rows[0] || null;
}
