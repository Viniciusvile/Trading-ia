from celery import Celery
from celery.schedules import crontab  # noqa: F401  (disponivel p/ agendamentos futuros)
from app.config import settings

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
    },
)
