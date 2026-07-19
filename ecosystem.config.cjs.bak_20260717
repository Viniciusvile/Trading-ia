module.exports = {
  apps: [
    {
      name: 'saas-backend',
      cwd: '/home/ubuntu/trading-saas/backend',
      script: '/home/ubuntu/trading-saas/backend/venv/bin/uvicorn',
      args: 'app.main:app --host 127.0.0.1 --port 8000 --workers 2',
      env: {
        PYTHONPATH: '/home/ubuntu/trading-saas/backend'
      }
    },
    {
      name: 'saas-worker',
      cwd: '/home/ubuntu/trading-saas/backend',
      script: '/home/ubuntu/trading-saas/backend/venv/bin/celery',
      args: '-A app.workers.celery_app worker --loglevel=info --concurrency=2',
      env: {
        PYTHONPATH: '/home/ubuntu/trading-saas/backend'
      }
    },
    {
      name: 'saas-beat',
      cwd: '/home/ubuntu/trading-saas/backend',
      script: '/home/ubuntu/trading-saas/backend/venv/bin/celery',
      args: '-A app.workers.celery_app beat --loglevel=info',
      env: {
        PYTHONPATH: '/home/ubuntu/trading-saas/backend'
      }
    },
    {
      // Novo dashboard XP (Next.js) — porta 3333
      name: 'saas-frontend',
      cwd: '/home/ubuntu/trading-saas/frontend/.next/standalone',
      script: '/home/ubuntu/trading-saas/frontend/.next/standalone/server.js',
      env: {
        PORT: 3333,
        HOSTNAME: '0.0.0.0',
        NEXT_TELEMETRY_DISABLED: 1
      }
    }
  ]
};
