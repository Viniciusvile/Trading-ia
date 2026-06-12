// Persistência do AdaptiveBot. Pool próprio (mesma DATABASE_URL do masterbot)
// para o bot não depender de importar masterbot/db.js (que tem side-effects).
import pg from "pg";
import { DEFAULT_PARAMS } from "./params.js";

let pool = null;

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL não definida");
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
  }
  return pool;
}

export async function init() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS adaptive_params (
      version    BIGSERIAL PRIMARY KEY,
      params     JSONB NOT NULL,
      source     VARCHAR(40) NOT NULL DEFAULT 'manual', -- seed | gemini | rollback | manual | test
      is_active  BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS adaptive_trades (
      id            BIGSERIAL PRIMARY KEY,
      symbol        VARCHAR(20) NOT NULL,
      params_version BIGINT NOT NULL REFERENCES adaptive_params(version),
      opened_at     TIMESTAMPTZ NOT NULL,
      closed_at     TIMESTAMPTZ,
      result        VARCHAR(10),            -- win | loss | timeout | open
      return_pct    DOUBLE PRECISION,
      data          JSONB NOT NULL          -- entry, exit, stop, tp, qty, paper, features {…}
    );
    CREATE INDEX IF NOT EXISTS idx_adaptive_trades_closed ON adaptive_trades(closed_at DESC);
    CREATE TABLE IF NOT EXISTS adaptive_lessons (
      id         BIGSERIAL PRIMARY KEY,
      lesson     TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      active     BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS adaptive_heartbeat (
      id  INTEGER PRIMARY KEY DEFAULT 1,
      ts  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      pid INTEGER
    );
    CREATE TABLE IF NOT EXISTS adaptive_reviews (
      id            BIGSERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      trades_analyzed INT,
      response      JSONB,            -- resposta bruta do Gemini
      applied       BOOLEAN NOT NULL,
      reason        TEXT,             -- por que aplicou/rejeitou
      old_version   BIGINT,
      new_version   BIGINT
    );
  `);
  // seed: garante uma versão ativa
  const { rows } = await getPool().query("SELECT 1 FROM adaptive_params WHERE is_active LIMIT 1");
  if (rows.length === 0) {
    await getPool().query(
      "INSERT INTO adaptive_params (params, source, is_active) VALUES ($1, 'seed', true)",
      [JSON.stringify(DEFAULT_PARAMS)]
    );
  }
}

export async function getActiveParams() {
  const { rows } = await getPool().query(
    "SELECT version, params FROM adaptive_params WHERE is_active ORDER BY version DESC LIMIT 1"
  );
  if (!rows.length) throw new Error("Nenhuma versão de parâmetros ativa — rode init()");
  return { version: Number(rows[0].version), params: rows[0].params };
}

export async function saveParamsVersion(params, source) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE adaptive_params SET is_active = false WHERE is_active");
    const { rows } = await client.query(
      "INSERT INTO adaptive_params (params, source, is_active) VALUES ($1, $2, true) RETURNING version",
      [JSON.stringify(params), source]
    );
    await client.query("COMMIT");
    return Number(rows[0].version);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function getParamsByVersion(version) {
  const { rows } = await getPool().query("SELECT params FROM adaptive_params WHERE version = $1", [version]);
  return rows[0]?.params ?? null;
}

export async function openTrade({ symbol, paramsVersion, openedAt, data }) {
  const { rows } = await getPool().query(
    `INSERT INTO adaptive_trades (symbol, params_version, opened_at, result, data)
     VALUES ($1, $2, $3, 'open', $4) RETURNING id`,
    [symbol, paramsVersion, openedAt, JSON.stringify(data)]
  );
  return Number(rows[0].id);
}

export async function closeTrade(id, { result, returnPct, closedAt, exitData }) {
  await getPool().query(
    `UPDATE adaptive_trades
     SET result = $2, return_pct = $3, closed_at = $4, data = data || $5::jsonb
     WHERE id = $1`,
    [id, result, returnPct, closedAt, JSON.stringify(exitData)]
  );
}

export async function getOpenTrades() {
  const { rows } = await getPool().query(
    "SELECT id, symbol, params_version, opened_at, data FROM adaptive_trades WHERE result = 'open'"
  );
  return rows;
}

export async function getClosedTradesSince(sinceIso, limit = 100) {
  const { rows } = await getPool().query(
    `SELECT id, symbol, params_version, opened_at, closed_at, result, return_pct, data
     FROM adaptive_trades WHERE result <> 'open' AND closed_at >= $1
     ORDER BY closed_at DESC LIMIT $2`,
    [sinceIso, limit]
  );
  return rows;
}

export async function countClosedSinceVersion(version) {
  const { rows } = await getPool().query(
    "SELECT COUNT(*)::int AS n, AVG((result='win')::int)::float AS winrate FROM adaptive_trades WHERE params_version = $1 AND result <> 'open'",
    [version]
  );
  return rows[0]; // { n, winrate }
}

export async function getActiveLessons(limit = 15) {
  const { rows } = await getPool().query(
    "SELECT id, lesson FROM adaptive_lessons WHERE active ORDER BY created_at DESC LIMIT $1",
    [limit]
  );
  return rows;
}

export async function addLessons(lessons) {
  for (const lesson of lessons) {
    await getPool().query("INSERT INTO adaptive_lessons (lesson) VALUES ($1)", [String(lesson).slice(0, 500)]);
  }
}

export async function logReview({ tradesAnalyzed, response, applied, reason, oldVersion, newVersion }) {
  await getPool().query(
    `INSERT INTO adaptive_reviews (trades_analyzed, response, applied, reason, old_version, new_version)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [tradesAnalyzed, JSON.stringify(response ?? null), applied, reason, oldVersion, newVersion]
  );
}

export async function touchHeartbeat() {
  await getPool().query(
    `INSERT INTO adaptive_heartbeat (id, ts, pid) VALUES (1, NOW(), $1)
     ON CONFLICT (id) DO UPDATE SET ts = NOW(), pid = $1`,
    [process.pid]
  );
}

export async function readHeartbeat(maxAgeMs = 12 * 60 * 1000) {
  const { rows } = await getPool().query("SELECT ts, pid FROM adaptive_heartbeat WHERE id = 1");
  if (!rows.length) return { alive: false, lastSeen: null, pid: null };
  const age = Date.now() - new Date(rows[0].ts).getTime();
  return { alive: age < maxAgeMs, lastSeen: rows[0].ts, pid: rows[0].pid };
}

export async function getRecentReviews(limit = 10) {
  const { rows } = await getPool().query(
    `SELECT id, created_at, trades_analyzed, applied, reason, old_version, new_version,
            response->>'analysis' AS analysis
     FROM adaptive_reviews ORDER BY id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getLastReviewAt() {
  const { rows } = await getPool().query("SELECT MAX(created_at) AS ts FROM adaptive_reviews");
  return rows[0].ts; // null se nunca houve
}

export async function close() {
  if (pool) { await pool.end(); pool = null; }
}
