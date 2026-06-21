import json
import httpx
import logging
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.config import settings
from app.models.micro import UserMicroConfig
from app.models.notification import Notification
from app.services import backtest as bt

logger = logging.getLogger(__name__)

DEFAULT_PLANS = {
    "micro-dip": {
        "strategy_mode": "micro-dip",
        "tp_pct": 0.01,
        "sl_pct": 0.005,
        "breakeven_pct": 0.0,
        "ema_period": 20,
        "rsi_period": 3,
        "min_dip_pct": 0.001,
        "min_rsi": 20,
        "max_rsi": 65,
    },
    "turbo-reversion": {
        "strategy_mode": "turbo-reversion",
        "tp_pct": 0.01,
        "sl_pct": 0.005,
        "breakeven_pct": 0.0,
        "bb_length": 20,
        "bb_mult": 2.0,
        "rsi_period": 3,
        "rsi_limit": 30,
        "vol_mult": 1.5,
    }
}

def _parse_gemini_json(text: str) -> dict:
    import re
    t = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", t, re.IGNORECASE)
    if fence:
        t = fence.group(1).strip()
    first = t.find("{")
    last = t.rfind("}")
    if first >= 0 and last > first:
        t = t[first:last + 1]
    return json.loads(t)

def optimize_symbol_for_user(db: Session, user_id: str, symbol: str, force_ia: bool = False) -> dict:
    """
    Roda backtest comparativo de 'micro-dip' vs 'turbo-reversion' para o par do usuário.
    Se o resultado for ruim ou force_ia=True, aciona o Gemini para propor otimização de parâmetros.
    Se validado pelo backtest, aplica.
    
    Adicionalmente:
    - Se ambas as estratégias forem negativas (PnL < 0), desativa o ativo e notifica.
    - Se o ativo estava desativado pelo sistema e voltou a ficar positivo, reativa o ativo e notifica.
    """
    cfg = db.get(UserMicroConfig, user_id)
    if not cfg:
        cfg = UserMicroConfig(user_id=user_id, data={})
        db.add(cfg)
    
    data = dict(cfg.data or {})
    plans = dict(data.get("plans") or {})
    current_plan = dict(plans.get(symbol) or {})
    active_symbols = list(data.get("active_symbols") or [])
    deactivated_by_system = list(data.get("deactivated_by_system") or [])
    
    # 1. Rodar backtests comparativos para ambos os modos com os parâmetros atuais ou defaults
    results = {}
    for mode in ["micro-dip", "turbo-reversion"]:
        test_plan = dict(DEFAULT_PLANS[mode])
        if current_plan.get("strategy_mode") == mode:
            test_plan.update(current_plan)
        
        bt_plan = {
            "strategy": mode,
            "scalper": test_plan,
            "symbols": [symbol],
            "timeframes": ["5m"],
            "winRateTarget": 55
        }
        try:
            results[mode] = {
                "backtest": bt.run_plan_backtest(bt_plan),
                "plan": test_plan
            }
        except Exception as e:
            logger.error(f"Erro no backtest comparativo ({mode}, {symbol}): {e}")
            results[mode] = None

    # Escolher o melhor modo
    best_mode = None
    best_pnl = -999999.0
    best_wr = 0.0
    
    for mode, res in results.items():
        if res and res["backtest"] and res["backtest"].get("combined"):
            stats = res["backtest"]["combined"]
            pnl = stats.get("netProfitUsd", 0.0)
            if pnl > best_pnl:
                best_pnl = pnl
                best_wr = stats.get("winRate", 0.0) * 100
                best_mode = mode

    if not best_mode:
        return {"success": False, "error": "Falha ao executar backtests comparativos"}

    best_res = results[best_mode]
    best_plan = best_res["plan"]
    best_stats = best_res["backtest"]["combined"]
    best_equity = best_res["backtest"].get("equityCurve") or []

    logger.info(f"Melhor modo inicial para {symbol}: {best_mode} (PnL: {best_pnl}, WR: {best_wr}%)")

    # 2. Verificar se precisa acionar IA (PnL negativo, WR < 50% ou force_ia=True)
    needs_ia = force_ia or (best_pnl < 0.0) or (best_wr < 50.0)
    api_key = settings.gemini_api_key
    
    if needs_ia and api_key:
        logger.info(f"Iniciando otimização com Gemini para {symbol}...")
        
        system_prompt = (
            "Você é um Engenheiro Quantitativo sênior especializado em estratégias de scalping "
            "para criptomoedas (tempo gráfico 5m). Seu objetivo é otimizar os parâmetros de "
            "um algoritmo de trading baseado no histórico de performance de backtest fornecido.\n\n"
            f"Ativo analisado: {symbol}\n"
            f"Modo da estratégia atual: {best_mode}\n"
            f"Métricas Atuais de Performance (últimos ~5 dias):\n"
            f"- Lucro Líquido: ${best_pnl:.2f} (em banca simulada de $10.000)\n"
            f"- Taxa de Acerto (Win Rate): {best_wr:.2f}%\n"
            f"- Quantidade de Trades: {best_stats.get('totalTrades', 0)}\n"
            f"- Rebaixamento Máximo (Drawdown): {best_stats.get('maxDrawdownPct', 0.0):.2f}%\n\n"
            f"Parâmetros Atuais:\n"
            f"{json.dumps(best_plan, indent=2)}\n\n"
            "Por favor, ajuste finamente os parâmetros para tornar o lucro líquido POSITIVO e aumentar a taxa de acerto. "
            "Você pode alterar o 'strategy_mode' se achar que o outro modo funcionaria melhor para o comportamento atual do ativo.\n\n"
            "Retorne APENAS um objeto JSON plano contendo as chaves necessárias com os seguintes limites estritos:\n"
            "- strategy_mode: 'micro-dip' ou 'turbo-reversion'\n"
            "- tp_pct: float entre 0.002 (0.2%) e 0.03 (3.0%)\n"
            "- sl_pct: float entre 0.002 (0.2%) e 0.02 (2.0%)\n"
            "- breakeven_pct: float entre 0.0 (desligado) e 0.015 (1.5%)\n"
            "Se strategy_mode for 'micro-dip':\n"
            "- ema_period: int de 5 a 50\n"
            "- rsi_period: int de 2 a 14\n"
            "- min_dip_pct: float de 0.0002 (0.02%) a 0.01 (1.0%)\n"
            "- min_rsi: int de 5 a 45\n"
            "- max_rsi: int de 50 a 90\n"
            "Se strategy_mode for 'turbo-reversion':\n"
            "- bb_length: int de 10 a 40\n"
            "- bb_mult: float de 1.0 a 3.0\n"
            "- rsi_period: int de 2 a 14\n"
            "- rsi_limit: int de 10 a 50\n"
            "- vol_mult: float de 1.0 a 3.0\n\n"
            "Não retorne textos adicionais explicativos. Retorne apenas o JSON puro."
        )
        
        models = ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash", "gemini-flash-latest"]
        ia_plan = None
        
        for model in models:
            try:
                resp = httpx.post(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}",
                    json={
                        "contents": [{"parts": [{"text": system_prompt}]}],
                        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
                    },
                    timeout=30.0,
                )
                if resp.status_code == 200:
                    res_json = resp.json()
                    txt = res_json["candidates"][0]["content"]["parts"][0]["text"]
                    ia_plan = _parse_gemini_json(txt)
                    break
            except Exception as e:
                logger.error(f"Erro ao consultar Gemini ({model}) para {symbol}: {e}")

        # 3. Validar a proposta da IA com um novo backtest
        if ia_plan:
            val_mode = ia_plan.get("strategy_mode", best_mode)
            val_plan = dict(DEFAULT_PLANS[val_mode])
            for k, v in ia_plan.items():
                if k in val_plan:
                    if isinstance(val_plan[k], int):
                        val_plan[k] = int(float(v))
                    elif isinstance(val_plan[k], float):
                        val_plan[k] = float(v)
                    else:
                        val_plan[k] = v

            bt_plan_val = {
                "strategy": val_mode,
                "scalper": val_plan,
                "symbols": [symbol],
                "timeframes": ["5m"],
                "winRateTarget": 55
            }
            try:
                val_res = bt.run_plan_backtest(bt_plan_val)
                if val_res and val_res.get("combined"):
                    val_stats = val_res["combined"]
                    val_pnl = val_stats.get("netProfitUsd", 0.0)
                    val_wr = val_stats.get("winRate", 0.0) * 100
                    
                    logger.info(f"Validação da IA para {symbol}: PnL={val_pnl}, WR={val_wr}% (Comparado a PnL={best_pnl}, WR={best_wr}%)")
                    
                    if val_pnl > best_pnl:
                        best_mode = val_mode
                        best_plan = val_plan
                        best_pnl = val_pnl
                        best_wr = val_wr
                        best_stats = val_stats
                        best_equity = val_res.get("equityCurve") or []
            except Exception as e:
                logger.error(f"Erro na validação do plano proposto pela IA para {symbol}: {e}")

    # 4. Regras de Desativação e Reativação Automática
    status_change = None
    if best_pnl < 0.0:
        # PnL negativo mesmo após a IA -> não operar no prejuízo: desativa o ativo.
        # (antes só desativava se já estivesse ativo; agora garante que NUNCA fica
        # ativo um par negativo, mesmo recém-otimizado)
        was_active = symbol in active_symbols
        if was_active:
            active_symbols.remove(symbol)
        if symbol not in deactivated_by_system:
            deactivated_by_system.append(symbol)
        # só notifica quando houve mudança real de estado (estava ativo e saiu)
        if was_active:
            status_change = "deactivated"
            msg = (
                f"O par {symbol} foi desativado automaticamente do Micro-Scalper porque ambas as "
                f"estratégias apresentaram performance negativa nos backtests recentes "
                f"(Lucro estimado: -${abs(best_pnl):.2f}). A IA continuará analisando diariamente "
                f"e reativa o ativo assim que encontrar uma configuração lucrativa."
            )
            db.add(Notification(
                user_id=user_id,
                title=f"[IA] Ativo Desativado: {symbol}",
                message=msg,
                type="warning"
            ))
            logger.info(f"Ativo {symbol} desativado pelo sistema devido a PnL negativo ({best_pnl})")
    else:
        # PnL positivo -> reativa se foi desativado pelo sistema
        if symbol in deactivated_by_system:
            deactivated_by_system.remove(symbol)
            if symbol not in active_symbols:
                active_symbols.append(symbol)
            status_change = "reactivated"
            
            msg = (
                f"O par {symbol} foi reativado automaticamente no Micro-Scalper após a IA encontrar "
                f"uma configuração lucrativa no modo {best_mode} (Lucro estimado de +${best_pnl:.2f} "
                f"e Win Rate de {best_wr:.1f}%)."
            )
            db.add(Notification(
                user_id=user_id,
                title=f"[IA] Ativo Reativado: {symbol}",
                message=msg,
                type="success"
            ))
            logger.info(f"Ativo {symbol} reativado pelo sistema devido a PnL positivo ({best_pnl})")
        elif force_ia:
            # Notificação padrão de otimização bem sucedida manual
            msg = (
                f"A Inteligência Artificial otimizou o {symbol} para o modo {best_mode}. "
                f"O lucro estimado no backtest simulado é de ${best_pnl:.2f} (Win Rate: {best_wr:.1f}%)."
            )
            db.add(Notification(
                user_id=user_id,
                title=f"Otimização por IA: {symbol}",
                message=msg,
                type="success"
            ))

    # 5. Salvar o plano final otimizado, os vetores de ativos e as ESTATÍSTICAS
    # do backtest real (para o card do Micro-Scalper exibir como o do Bot Master).
    # Reduz a equity curve para ~40 pontos (mini gráfico no card).
    equity_vals = [p.get("equity") for p in (best_equity or []) if isinstance(p, dict) and p.get("equity") is not None]
    if len(equity_vals) > 40:
        step = len(equity_vals) / 40.0
        equity_vals = [equity_vals[int(i * step)] for i in range(40)]

    stats_block = dict(data.get("stats") or {})
    stats_block[symbol] = {
        "winRate": best_wr / 100.0,  # fração (0–1), igual ao Master
        "profitFactor": best_stats.get("profitFactor", 0.0),
        "netProfit": best_pnl,
        "totalTrades": best_stats.get("totalTrades", 0),
        "equityCurve": equity_vals,
        "ts": int(datetime.now(timezone.utc).timestamp() * 1000),
    }

    plans[symbol] = best_plan
    data["plans"] = plans
    data["active_symbols"] = active_symbols
    data["deactivated_by_system"] = deactivated_by_system
    data["stats"] = stats_block
    cfg.data = data
    flag_modified(cfg, "data")
    db.commit()

    return {
        "success": True,
        "symbol": symbol,
        "mode": best_mode,
        "plan": best_plan,
        "status_change": status_change,
        "stats": {
            "netProfitUsd": best_pnl,
            "winRate": best_wr,
            "totalTrades": best_stats.get("totalTrades", 0)
        }
    }
