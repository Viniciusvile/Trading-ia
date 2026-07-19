-- Migração: criar tabela performance_reports
-- Executar no servidor: psql $DATABASE_URL -f create_performance_reports.sql

CREATE TABLE IF NOT EXISTS performance_reports (
    id VARCHAR PRIMARY KEY,
    user_id VARCHAR NOT NULL,
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    data JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_performance_reports_user_id ON performance_reports (user_id);
