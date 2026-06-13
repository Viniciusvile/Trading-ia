# Design: Port dos Bots de Trading para Python (Fase 6 da migração)

Date: 2026-06-13

## Summary

Portar a lógica de trading do legado (Node, `~/trading`) para o backend Python (FastAPI/Celery, `~/trading-saas/backend`), começando pelo **Micro-Scalper**. Os algoritmos de estratégia são reescritos como **código Python fiel ao legado** (não como regras declarativas); os bots rodam como **tasks Celery agendadas no beat**; o estado/config são guardados **espelhando as tabelas jsonb do legado**. Tudo começa em **paper trading** e só vira execução real após validação de paridade com o legado.

## Decisões já tomadas (brainstorming 2026-06-13)

1. **Modelo de lógica:** algoritmos codificados 1:1 com `strategy-signals.js`/`signals.js`. Motor genérico (`condition_evaluator.py`) fica só para estratégias `custom`.
2. **Execução:** Celery beat agenda tasks periódicas (worker já roda). Não usar processos pm2 por bot.
3. **Ordem:** Micro-Scalper primeiro (mais isolado), depois MasterBot, depois Adaptive-Bot.
4. **Schema:** espelhar tabelas do legado (`user_micro_config` jsonb, `micro_sessions`, `micro_heartbeat`) no `tradingdb` e migrar os dados (3 configs, 21 sessions).

## Architecture

```
Celery beat (schedule)                 FastAPI (:8000)
   │ a cada N s                           │ GET/PATCH /api/micro-scalper/*
   ▼                                      ▼
tasks: run_micro_scalper(user_id)   router bots/micro_scalper
   │                                      │
   ▼                                      ▼
services/micro_scalper.py  ◀── services/scalper_signals.py (port puro de signals.js)
   │  (orquestra: lê config, busca candles, gera sinal, aplica TP/SL, registra)
   ▼
services/order_executor.py (já existe: execute_buy/sell)  +  Binance client
   │
   ▼
tradingdb: user_micro_config / micro_sessions / micro_heartbeat / binance_configs
```

O motor é dividido em **camada pura** (indicadores + sinais, sem I/O, testável) e **camada de orquestração** (Celery task que faz I/O: banco, Binance).

## Components

**Novos arquivos (backend):**
- `app/services/scalper_signals.py` — port PURO de `signals.js`: `calc_ema`, `calc_rsi`, `calc_bb`, `calc_atr_pct`, `micro_scalp_signal`, `turbo_reversion_signal`. Funções determinísticas → TDD direto.
- `app/services/micro_scalper.py` — orquestração: `run_for_user(user_id, paper=True)` que lê config, busca candles via Binance, chama o sinal, aplica TP/SL/breakeven, grava sessão/heartbeat.
- `app/routers/micro_scalper.py` — `GET /status`, `GET/PATCH /config`, `GET /signal`, `POST /start|stop`. Shapes iguais aos que o `api.ts` espera (`microScalperStatus/Config/Strategy/Signal`).
- `app/models/micro.py` — modelos `UserMicroConfig`, `MicroSession`, `MicroHeartbeat`.
- `migrations/versions/0006_micro_scalper_tables.py` — cria as 3 tabelas.
- `scripts/migrate_micro.py` — migra `user_micro_config`(3), `micro_sessions`(21), `micro_heartbeat`(1) do legado.

**Modificados:**
- `app/workers/bot_runner.py` — task `run_micro_scalper`.
- `app/workers/celery_app.py` — `beat_schedule` com o intervalo do scalper (ler `loop_interval_ms` da config).
- `frontend/src/lib/apiV2.ts` + `api.ts` — métodos `microScalper*` + flag `bots` (parcial: só scalper a princípio).

## Data Flow

1. Beat dispara `run_micro_scalper` no intervalo configurado.
2. Task lê `user_micro_config` de cada usuário com scalper ligado (`user_bot_state`/flag).
3. Para cada `active_symbol`: busca candles (Binance), chama `micro_scalp_signal`/`turbo_reversion_signal` (camada pura).
4. Se `signal=="buy"`: em paper, grava trade simulado em `micro_sessions`; em real, chama `order_executor.execute_buy` + grava posição.
5. Atualiza `micro_heartbeat` (lastSeen). Gestão de TP/SL/breakeven nas posições abertas a cada ciclo.

## Error Handling

- Candles insuficientes / indicador sem dados → sinal `flat` (igual ao legado, que retorna `{signal:"flat"}`).
- Falha Binance numa iteração → loga, pula o símbolo, não derruba a task (try/except por símbolo).
- **Anti-ordem-dupla:** o scalper legado precisa estar PARADO antes de o Python operar real (regra transversal do plano). Em paper, podem coexistir.
- Heartbeat permite a UI mostrar "rodando/parado" mesmo se uma iteração falhar.

## Testing Strategy

- **Camada pura (TDD):** para cada função de `scalper_signals.py`, teste com série de candles fixa comparando o resultado com o JS legado. Casos: um `buy` claro (micro-dip), um `flat` (sem setup), um filtrado por tendência/ATR, um `sell`. bcrypt-style: valores numéricos devem bater (EMA/RSI/BB).
- **Paridade:** rodar a mesma janela de candles no sinal Python e no `micro-scalper.js` legado; sinais devem coincidir.
- **Paper first:** task em paper por um período, comparar com `micro_sessions` histórico. Só liga real (parando o legado) com aprovação explícita do usuário.

## Open Questions

- Intervalo exato do scalper no Celery beat (ler `loop_interval_ms` da config migrada; legado reage em segundos — definir um piso realista p/ Celery, ex. 30–60s).
- O scalper real usa a conta ativa do usuário (`binance_configs.is_active`) — confirmar resolução de conta na Fase 6 de execução.
- MasterBot e Adaptive-Bot: design próprio depois (este doc cobre o Scalper; os outros herdam o padrão camada-pura + Celery task + tabelas-espelho).
