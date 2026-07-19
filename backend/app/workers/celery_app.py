import logging

from celery import Celery
from celery.schedules import crontab
from app.config import settings

# httpx loga a URL completa em nível INFO — inclui "?key=..." das chamadas ao
# Gemini, o que vazava a API key em texto claro nos logs do worker. WARNING
# corta esse ruído sem esconder erros reais de rede.
logging.getLogger("httpx").setLevel(logging.WARNING)

celery = Celery(
    "trading_bots",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=[
        "app.workers.bot_runner",
        "app.workers.bot_runner_micro",
        "app.workers.bot_runner_master",
        "app.workers.bot_runner_adaptive",
        "app.workers.bot_runner_micro_real",
        "app.workers.sync_runner",
        "app.workers.alert_worker",
        "app.workers.report_worker",
        "app.workers.manage_manual",
    ],
)

celery.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    beat_schedule={
        # Micro-Scalper em PAPER: avalia sinais a cada 60s.
        "micro-scalper-paper": {
            "task": "run_micro_scalper",
            "schedule": 60.0,
        },
        # MasterBot em PAPER: ciclo a cada 5min (legado usa 10min; estrategias mais pesadas).
        "masterbot-paper": {
            "task": "run_masterbot",
            "schedule": 300.0,
        },
        # Adaptive-Bot em PAPER (sem learner): ciclo a cada 5min (legado usa 5min).
        "adaptive-paper": {
            "task": "run_adaptive",
            "schedule": 300.0,
        },
        # (Fase 8) sync_positions REMOVIDO: o legado foi desligado, nao ha mais o que
        # sincronizar. O sync_runner segue no include mas nao e mais agendado.
        # Micro-Scalper REAL (executa ordem). Opt-in DUPLO por usuario (micro_enabled
        # E config.live). Hoje so o user de teste, com conta TESTNET ativa (fake).
        "micro-scalper-real": {
            "task": "run_micro_scalper_real",
            "schedule": 60.0,
        },
        # Reanálise periódica das estratégias do Bot Master a cada 4 horas
        "reanalyze-strategies": {
            "task": "reanalyze_all_strategies",
            "schedule": 14400.0,
        },
        # Otimização diária de IA/backtest do Micro-Scalper
        "optimize-micro-scalper": {
            "task": "optimize_micro_scalper_all_users",
            "schedule": 86400.0,
        },
        # Verificação de alertas de preço a cada 60s
        "check-price-alerts": {
            "task": "check_price_alerts",
            "schedule": 60.0,
        },
        # Watchdog de posições manuais com TP1 parcial / trailing stop
        "manage-manual-positions": {
            "task": "manage_manual_positions",
            "schedule": 60.0,
        },
        # Auto-auditoria semanal: toda segunda-feira 06:00 UTC
        "weekly-performance-report": {
            "task": "weekly_performance_report",
            "schedule": crontab(hour=6, minute=0, day_of_week=1),
        },
    },
)

