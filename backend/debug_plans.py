from app.database import _get_session_factory
from app.models.master import MasterConfig
db = _get_session_factory()()
configs = db.query(MasterConfig).all()
print('MASTER CONFIGS:')
for cfg in configs:
    print(f'User ID: {cfg.user_id}')
    print(f'Data: {cfg.data}')
db.close()
