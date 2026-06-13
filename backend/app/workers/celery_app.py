from celery import Celery
from app.config import settings

celery = Celery(
    "trading_bots",
    broker=settings.redis_url,
    backend=settings.redis_url,
    include=["app.workers.bot_runner"],
)

celery.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    beat_schedule={},
)
