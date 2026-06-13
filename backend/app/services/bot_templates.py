"""
Catálogo de bots prontos baseados nos bots legados do TradingView MCP Jackson.
Cada template gera uma Strategy do SaaS com condições pré-configuradas.
"""

BOT_TEMPLATES = [
    {
        "id": "master_spot",
        "name": "Bot Master Spot",
        "tagline": "Swing trade conservador em criptos majors",
        "description": (
            "Baseado no nosso masterbot. Opera SPOT com filtros de tendência "
            "(EMAs alinhadas) e RSI saudável. Compra quando vários sinais técnicos "
            "concordam que a tendência é de alta. Ideal para BTC, ETH, SOL em "
            "timeframe de 4h."
        ),
        "category": "swing",
        "market_type": "spot",
        "default_symbol": "BTCUSDT",
        "default_timeframe": "4h",
        "risk_level": "medio",
        "available": True,
        "conditions": {
            "entry_conditions": [
                {
                    "indicator": "EMA",
                    "indicator_period": 9,
                    "operator": "greater_than",
                    "compare_to_indicator": "EMA_21",
                },
                {
                    "indicator": "EMA",
                    "indicator_period": 21,
                    "operator": "greater_than",
                    "compare_to_indicator": "EMA_55",
                },
                {
                    "indicator": "RSI",
                    "indicator_period": 14,
                    "operator": "greater_than",
                    "value": 50,
                },
                {
                    "indicator": "RSI",
                    "indicator_period": 14,
                    "operator": "less_than",
                    "value": 70,
                },
            ],
            "entry_action": {"type": "buy", "size_percent": 10.0},
            "exit_conditions": {
                "take_profit_percent": 3.0,
                "stop_loss_percent": 1.5,
            },
        },
    },
    {
        "id": "master_futures",
        "name": "Bot Master Futures",
        "tagline": "Swing trade com alavancagem em contratos perpétuos",
        "description": (
            "Versão futuros do masterbot. Mesma lógica de filtros encadeados, "
            "mas opera contratos perpétuos com alavancagem configurável. "
            "ATENÇÃO: alavancagem aumenta o risco proporcionalmente."
        ),
        "category": "swing",
        "market_type": "futures",
        "default_symbol": "BTCUSDT",
        "default_timeframe": "4h",
        "risk_level": "alto",
        "available": False,
        "coming_soon_reason": "Suporte a futuros na Binance está em desenvolvimento.",
    },
    {
        "id": "micro_scalper",
        "name": "Micro Scalper",
        "tagline": "Scalping de alta frequência em reversão à média",
        "description": (
            "Baseado no nosso micro-scalper. Procura por sobrevendas extremas "
            "(preço abaixo da Bollinger inferior + RSI baixo) para entradas "
            "rápidas. Opera SPOT com TP/SL apertados via OCO. "
            "Mais trades por dia, menor lucro por trade."
        ),
        "category": "scalping",
        "market_type": "spot",
        "default_symbol": "SOLUSDT",
        "default_timeframe": "5m",
        "risk_level": "alto",
        "available": False,
        "coming_soon_reason": "Em testes — disponível em breve.",
    },
]


def get_template(template_id: str) -> dict | None:
    for t in BOT_TEMPLATES:
        if t["id"] == template_id:
            return t
    return None
