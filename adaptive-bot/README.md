# AdaptiveBot

Bot spot long-only (BTCUSDT, 5m) com estratégia parametrizada e auto-adaptativa.
O Gemini analisa os trades fechados a cada 10 trades (ou 24h), extrai lições e
propõe novos parâmetros — aplicados apenas se passarem no walk-forward.

## Variáveis (.env na raiz)
- `GEMINI_API_KEY` (obrigatória) — Google AI Studio
- `DATABASE_URL` (obrigatória) — mesma do masterbot
- `ADAPTIVE_PAPER` — default `true`. Só colocar `false` após semanas de paper com PnL positivo.
- `ADAPTIVE_SYMBOL` (default BTCUSDT), `ADAPTIVE_TRADE_USD` (20),
  `ADAPTIVE_MAX_DAILY_LOSS_PCT` (3), `ADAPTIVE_MAX_TRADES_PER_DAY` (12), `GEMINI_MODEL` (gemini-2.5-flash)

## Rodar
- Local: `npm run adaptive`
- Testes: `npm run test:adaptive` (os de store exigem `DATABASE_URL` acessível)
- Servidor: `pm2 start adaptive-bot/bot.js --name adaptivebot`

## Consultas úteis (psql)
- Versões: `SELECT version, source, is_active, created_at FROM adaptive_params ORDER BY version DESC LIMIT 10;`
- Por que aplicou/rejeitou: `SELECT created_at, applied, reason FROM adaptive_reviews ORDER BY id DESC LIMIT 10;`
- Lições: `SELECT lesson FROM adaptive_lessons WHERE active ORDER BY id DESC;`
- Performance por versão: `SELECT params_version, COUNT(*), AVG((result='win')::int) AS winrate, SUM(return_pct) AS pnl FROM adaptive_trades WHERE result<>'open' GROUP BY 1 ORDER BY 1 DESC;`

## Segurança
- O Gemini nunca recebe chaves da exchange nem executa ordens.
- Propostas são clampadas (bounds + ±25%/ciclo) e validadas por backtest antes de aplicar.
- Rollback automático se a versão nova tiver winrate 15pp pior após 10 trades.
- Kill-switch: pausa entradas se o PnL do dia ficar abaixo de -3%.

## Execução real (fora de escopo por enquanto)
Os pontos de inserção de ordens estão comentados em `bot.js` (`manageOpenTrades`
e `maybeOpenTrade`). Quando o paper provar a estratégia, reusar `src/exchange/binance.js`.
