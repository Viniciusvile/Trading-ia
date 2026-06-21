from app.models.user import User

PLAN_CATALOG = {
  "free":  {"name": "Trial",   "price_brl": 0,  "max_bots": 1, "max_strategies": 3,
            "bots": ["master"], "micro_custom": False},
  "basic": {"name": "Starter", "price_brl": 49, "max_bots": 1, "max_strategies": 3,
            "bots": ["master"], "micro_custom": False},
  "pro":   {"name": "Plus",    "price_brl": 79, "max_bots": 2, "max_strategies": 6,
            "bots": ["master","micro"], "micro_custom": False},
  "ultra": {"name": "Pro",     "price_brl": 99, "max_bots": 3, "max_strategies": 6,
            "bots": ["master","micro","futures"], "micro_custom": True},
}

BOT_FLAG = {"master": "master_enabled", "micro": "micro_enabled", "futures": "adaptive_enabled"}

def plan_allows_bot(plan: str, bot_key: str) -> bool:
    plan_config = PLAN_CATALOG.get(plan, PLAN_CATALOG["free"])
    return bot_key in plan_config["bots"]

def plan_max_strategies(plan: str) -> int:
    plan_config = PLAN_CATALOG.get(plan, PLAN_CATALOG["free"])
    return plan_config["max_strategies"]

def apply_plan_entitlements(user: User, plan: str):
    plan_config = PLAN_CATALOG.get(plan, PLAN_CATALOG["free"])
    user.max_bots = plan_config["max_bots"]
    user.max_strategies = plan_config["max_strategies"]


def disable_disallowed_bots(db, user) -> list:
    """Desliga os flags de bots que o plano atual do usuário NÃO permite.

    Crítico em downgrade/cancelamento: sem isso, um bot (ex: Futuros) continua
    operando depois que o cliente perde o plano que o liberava. Retorna a lista
    de bots desligados.
    """
    from app.models.bot_state import UserBotState

    st = db.get(UserBotState, user.id)
    if st is None:
        return []
    data = dict(st.data or {})
    disabled = []
    for bot_key, flag in BOT_FLAG.items():
        if data.get(flag) and not plan_allows_bot(user.plan, bot_key):
            data[flag] = False
            disabled.append(bot_key)
    if disabled:
        st.data = data
        from sqlalchemy.orm.attributes import flag_modified
        flag_modified(st, "data")
    return disabled
