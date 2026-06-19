from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.workers.celery_app import celery
import subprocess

from sqlalchemy import text

router = APIRouter()

@router.get("")
def get_system_status(db: Session = Depends(get_db)):
    # 1. Check database
    db_ok = False
    try:
        db.execute(text("SELECT 1"))
        db_ok = True
    except Exception:
        pass

    # 2. Check Celery Worker (SaaS Worker)
    worker_ok = False
    try:
        insp = celery.control.inspect()
        ping_res = insp.ping()
        if ping_res and len(ping_res) > 0:
            worker_ok = True
    except Exception:
        pass

    # 3. Check Celery Beat (SaaS Beat)
    beat_ok = False
    try:
        res = subprocess.run(["pgrep", "-f", "celery.*beat"], stdout=subprocess.PIPE)
        if res.returncode == 0:
            beat_ok = True
    except Exception:
        pass

    # 4. Check Redis
    redis_ok = False
    try:
        import redis
        from app.config import settings
        r = redis.Redis.from_url(settings.redis_url)
        if r.ping():
            redis_ok = True
    except Exception:
        pass

    return {
        "success": True,
        "database": "ok" if db_ok else "down",
        "worker": "ok" if worker_ok else "down",
        "beat": "ok" if beat_ok else "down",
        "redis": "ok" if redis_ok else "down",
        "backend": "ok",
    }
