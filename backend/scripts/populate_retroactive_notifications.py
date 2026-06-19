import sys
import os
import uuid

# Adiciona o diretório base ao path do Python para poder importar app
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.database import _get_session_factory
from app.models.position import Position
from app.models.notification import Notification

def main():
    db = _get_session_factory()()
    try:
        # Pega as últimas 30 posições
        positions = db.query(Position).order_by(Position.opened_at.desc()).limit(30).all()
        print(f"Encontradas {len(positions)} posições no banco.")
        
        created_count = 0
        for pos in positions:
            # 1. Notificação de abertura
            if pos.opened_at:
                entry_price = pos.entry_price or 0.0
                qty = pos.quantity or 0.0
                side = pos.side or "LONG"
                
                db.add(Notification(
                    user_id=pos.user_id,
                    title=f"Abriu {side} {pos.symbol}",
                    message=f"Preço de Entrada: ${entry_price:.4f} | Quantidade: {qty:.4f}",
                    type="info",
                    created_at=pos.opened_at
                ))
                created_count += 1
            
            # 2. Notificação de fechamento (se fechada)
            if pos.status == "closed" and pos.closed_at:
                pnl_val = pos.pnl or 0.0
                exit_price = pos.exit_price or 0.0
                d = pos.data or {}
                reason = d.get("exitReason") or "Binance OCO"
                notif_type = "success" if pnl_val >= 0 else "error"
                
                db.add(Notification(
                    user_id=pos.user_id,
                    title=f"Fechou {pos.symbol}",
                    message=f"PnL: {'+' if pnl_val >= 0 else ''}${pnl_val:.4f} | Saída: ${exit_price:.4f} ({reason})",
                    type=notif_type,
                    created_at=pos.closed_at
                ))
                created_count += 1
                
        db.commit()
        print(f"Criadas {created_count} notificações retroativas com sucesso!")
    finally:
        db.close()

if __name__ == "__main__":
    main()
