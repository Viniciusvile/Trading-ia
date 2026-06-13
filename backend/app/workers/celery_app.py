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
    },
)
