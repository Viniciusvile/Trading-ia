"""Task Celery de auto-auditoria semanal.

Roda toda segunda-feira 06:00 UTC via beat. Analisa a semana anterior por
usuário, salva em performance_reports e cria notificação resumida no sino.
"""
from celery import shared_task
from datetime import datetime, timedelta


@shared_task(name="weekly_performance_report")
def weekly_performance_report():
    from app.database import _get_session_factory
    from app.models.user import User
    from app.models.position import Position
    from app.models.performance_report import PerformanceReport
    from app.models.notification import Notification
    from app.services.performance_report import analyze_positions

    db = _get_session_factory()()
    try:
        now = datetime.utcnow()
        # Período: 7 dias até agora
        period_end = now.replace(hour=6, minute=0, second=0, microsecond=0)
        period_start = period_end - timedelta(days=7)
        period_label = f"{period_start.strftime('%d/%m')} – {period_end.strftime('%d/%m/%Y')}"

        users = db.query(User).all()
        processed = 0

        for user in users:
            closed = (
                db.query(Position)
                .filter(
                    Position.user_id == user.id,
                    Position.status == "closed",
                    Position.closed_at >= period_start,
                    Position.closed_at < period_end,
                )
                .all()
            )

            prev = (
                db.query(PerformanceReport)
                .filter(PerformanceReport.user_id == user.id)
                .order_by(PerformanceReport.created_at.desc())
                .first()
            )

            positions_data = [
                {
                    "symbol": p.symbol,
                    "strategy": p.strategy,
                    "plan": (p.data or {}).get("plan"),
                    "pnl": p.pnl or 0,
                    "entry_price": p.entry_price,
                    "exit_price": p.exit_price,
                    "stop_price": (p.data or {}).get("stopPrice") or (p.data or {}).get("stop"),
                    "opened_at": p.opened_at.isoformat() if p.opened_at else None,
                    "closed_at": p.closed_at.isoformat() if p.closed_at else None,
                    "exit_reason": (p.data or {}).get("exitReason"),
                }
                for p in closed
            ]

            report_data = analyze_positions(
                positions_data,
                period_label=period_label,
                prev_report=prev.data if prev else None,
            )

            report = PerformanceReport(
                user_id=user.id,
                period_start=period_start,
                period_end=period_end,
                data=report_data,
            )
            db.add(report)

            has_alert = any(
                v in report_data.get("verdicts", [])
                for v in ("pf_baixo", "win_rate_baixo", "semana_negativa")
            )
            icon = "⚠️" if has_alert else "📊"
            db.add(
                Notification(
                    user_id=user.id,
                    title=f"{icon} Relatório semanal {period_label}",
                    message=report_data.get("summary", "Relatório gerado."),
                    type="warning" if has_alert else "info",
                )
            )
            processed += 1

        db.commit()
        return {"users_processed": processed, "period": period_label}
    finally:
        db.close()
