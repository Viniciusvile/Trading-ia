#!/usr/bin/env bash
# Virada do Stripe para PRODUCAO (live mode).
# USO: bash go_live_stripe.sh sk_live_XXXX
# Pre-requisito: conta Stripe com charges_enabled=True.
set -euo pipefail
SK_LIVE="${1:-}"
[ -z "$SK_LIVE" ] && { echo "Uso: bash go_live_stripe.sh sk_live_..."; exit 1; }
case "$SK_LIVE" in sk_live_*) ;; *) echo "ERRO: a chave deve comecar com sk_live_"; exit 1;; esac

ENV=~/trading-saas/backend/.env
cd ~/trading-saas/backend

echo "1) Verificando se a conta pode cobrar..."
CE=$(curl -s https://api.stripe.com/v1/account -u "$SK_LIVE:" | python3 -c "import sys,json;print(json.load(sys.stdin).get(\"charges_enabled\"))")
[ "$CE" != "True" ] && { echo "ABORTADO: charges_enabled=$CE. A conta ainda nao pode cobrar."; exit 1; }
echo "   OK: charges_enabled=True"

echo "2) Criando 3 prices recorrentes em BRL (live)..."
mkprice(){ curl -s https://api.stripe.com/v1/prices -u "$SK_LIVE:" -d unit_amount="$1" -d currency=brl -d "recurring[interval]=month" -d "product_data[name]=$2" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"id\"])"; }
PB=$(mkprice 4900 "Starter (MasterBot)")
PP=$(mkprice 7900 "Plus (MasterBot + Micro)")
PU=$(mkprice 9900 "Pro (Todos os robos)")
echo "   basic=$PB plus=$PP pro=$PU"

echo "3) Criando webhook v1 (live) -> /api/v2/billing/webhook..."
WH=$(curl -s https://api.stripe.com/v1/webhook_endpoints -u "$SK_LIVE:" \
  -d url="https://vexacripto.com.br/api/v2/billing/webhook" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=invoice.payment_succeeded" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "description=VexaCripto LIVE" | python3 -c "import sys,json;print(json.load(sys.stdin)[\"secret\"])")
echo "   webhook secret capturado."

echo "4) Atualizando .env (backup antes)..."
cp "$ENV" "$ENV.bak.$(date +%s)"
sed -i "s|^STRIPE_SECRET_KEY=.*|STRIPE_SECRET_KEY=$SK_LIVE|" "$ENV"
sed -i "s|^STRIPE_PRICE_BASIC=.*|STRIPE_PRICE_BASIC=$PB|" "$ENV"
sed -i "s|^STRIPE_PRICE_PRO=.*|STRIPE_PRICE_PRO=$PP|" "$ENV"
sed -i "s|^STRIPE_PRICE_ULTRA=.*|STRIPE_PRICE_ULTRA=$PU|" "$ENV"
sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=$WH|" "$ENV"

echo "5) Reiniciando backend..."
pm2 restart saas-backend --update-env >/dev/null 2>&1
sleep 6
ss -tlnp 2>/dev/null | grep 8000 >/dev/null && echo "   8000 OK" || echo "   ATENCAO: 8000 nao subiu, ver logs"
echo "PRONTO. Stripe em modo LIVE."
