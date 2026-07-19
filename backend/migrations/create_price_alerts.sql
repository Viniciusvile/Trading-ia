-- Migração: criar tabela price_alerts
-- Executar no servidor: psql $DATABASE_URL -f create_price_alerts.sql

CREATE TABLE IF NOT EXISTS price_alerts (
    id VARCHAR PRIMARY KEY,
    user_id VARCHAR NOT NULL,
    symbol VARCHAR(30) NOT NULL,
    condition VARCHAR(10) NOT NULL,
    target_price FLOAT NOT NULL,
    recurring BOOLEAN NOT NULL DEFAULT FALSE,
    triggered_at TIMESTAMP,
    last_triggered_at TIMESTAMP,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_price_alerts_user_id ON price_alerts (user_id);
