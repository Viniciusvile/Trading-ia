module.exports = {
  apps: [
    {
      name: 'saas-backend',
      cwd: '/home/ubuntu/trading-saas/backend',
      script: '/home/ubuntu/trading-saas/backend/venv/bin/uvicorn',
      interpreter: 'none',
      args: 'app.main:app --host 127.0.0.1 --port 8000 --workers 1',
      env: { PYTHONPATH: '/home/ubuntu/trading-saas/backend' }
    },
    {
      name: 'saas-worker',
      cwd: '/home/ubuntu/trading-saas/backend',
      script: '/home/ubuntu/trading-saas/backend/venv/bin/celery',
      interpreter: 'none',
      args: '-A app.workers.celery_app worker --loglevel=info --concurrency=1',
      env: { PYTHONPATH: '/home/ubuntu/trading-saas/backend' }
    },
    {
      name: 'saas-beat',
      cwd: '/home/ubuntu/trading-saas/backend',
      script: '/home/ubuntu/trading-saas/backend/venv/bin/celery',
      interpreter: 'none',
      args: '-A app.workers.celery_app beat --loglevel=info',
      env: { PYTHONPATH: '/home/ubuntu/trading-saas/backend' }
    },
    {
      name: 'saas-price-ws',
      cwd: '/home/ubuntu/trading-saas/backend',
      script: '/home/ubuntu/trading-saas/backend/venv/bin/python',
      interpreter: 'none',
      args: '-m app.workers.price_ws',
      env: { PYTHONPATH: '/home/ubuntu/trading-saas/backend' }
    },
    {
      name: 'saas-frontend',
      cwd: '/home/ubuntu/trading-saas/frontend/.next/standalone',
      script: '/home/ubuntu/trading-saas/frontend/.next/standalone/server.js',
      env: { PORT: 3333, HOSTNAME: '0.0.0.0', NEXT_TELEMETRY_DISABLED: 1 }
    }
  ]
};
