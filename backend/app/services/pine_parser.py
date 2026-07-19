"""Parser determinístico de Pine Script → schema de estratégia do bot (SEM IA).

Substitui a dependência do Gemini (que estava fora do ar) para importar uma
estratégia do TradingView. Lê o código Pine e extrai, por regex/heurística:
  - indicadores e períodos (médias, RSI, MACD, Bollinger, ATR, CCI, etc.);
  - condições de entrada/saída (crossover/crossunder e comparações >/<);
  - SL/TP quando declarados por input/strategy.exit.

Gera o MESMO formato de dict que a IA gerava (ver _map_pine_with_gemini em
routers/bots.py), então o resultado passa pelo _normalize_imported_strategy e é
executado pelo condition_evaluator. Não cobre 100% dos scripts (Pine é uma
linguagem completa), mas resolve os casos comuns: cruzamento de médias, gatilhos
de RSI/MACD/BB. Quando não consegue extrair nada útil, sinaliza com clareza.

O objetivo é: o usuário cola o Pine, o parser identifica a lógica e o bot passa
a operar por ela — sem precisar de IA.
"""
from __future__ import annotations

import re

# Pine (com ou sem prefixo ta.) -> nome do indicador no motor do bot.
# Só indicadores de VALOR ÚNICO por chamada direta entram aqui.
_FUNC_MAP = {
    "sma": "SMA", "ema": "EMA", "rma": "RMA", "wma": "WMA", "hma": "HMA",
    "vwma": "VWMA", "swma": "WMA",
    "rsi": "RSI", "atr": "ATR", "cci": "CCI", "mfi": "MFI", "cmf": "CMF",
    "wpr": "WILLIAMS_R", "obv": "OBV", "vwap": "VWAP", "sar": "PSAR",
}

# Funções que retornam TUPLA: [a, b, c] = ta.macd(...) etc.
# Mapeia posição -> indicador do motor.
_TUPLE_MAP = {
    "macd": ["MACD_LINE", "MACD_SIGNAL", "MACD_HIST"],
    "bb": ["BB_BASIS", "BB_UPPER", "BB_LOWER"],
    "stoch": ["STOCH_K", "STOCH_D"],
    "supertrend": ["SUPERTREND", "SUPERTREND"],
}

_PRICE_TOKENS = {"close": "CLOSE", "open": "OPEN", "high": "HIGH", "low": "LOW"}

# Períodos default por indicador quando o script não deixa explícito.
_DEFAULT_PERIOD = {
    "RSI": 14, "ATR": 14, "CCI": 20, "MFI": 14, "WILLIAMS_R": 14,
    "MACD_LINE": 12, "MACD_SIGNAL": 9, "MACD_HIST": 12,
    "BB_UPPER": 20, "BB_LOWER": 20, "BB_BASIS": 20,
    "STOCH_K": 14, "STOCH_D": 14, "SUPERTREND": 10, "VWMA": 20,
}


def _strip_comments(src: str) -> str:
    out = []
    for line in src.splitlines():
        # remove comentário // fora de string (heurística simples)
        in_str = False
        cut = len(line)
        i = 0
        while i < len(line) - 1:
            ch = line[i]
            if ch == '"':
                in_str = not in_str
            elif ch == "/" and line[i + 1] == "/" and not in_str:
                cut = i
                break
            i += 1
        out.append(line[:cut])
    return "\n".join(out)


def _extract_title(src: str) -> str | None:
    m = re.search(r"\b(?:indicator|strategy|study)\s*\(\s*(?:title\s*=\s*)?[\"']([^\"']+)[\"']", src)
    return m.group(1).strip() if m else None


def _resolve_inputs(src: str) -> dict[str, float]:
    """Mapeia variáveis de input para seus valores numéricos default.

    Cobre: X = input(14), input.int(14, ...), input.float(2.0, ...),
    input(defval=14, ...), e title-first como input.int(title="x", defval=14).
    """
    values: dict[str, float] = {}
    # nome = input[.tipo]( ...primeiro número encontrado... )
    for m in re.finditer(r"(\w+)\s*=\s*input(?:\.\w+)?\s*\(([^)]*)\)", src):
        name, args = m.group(1), m.group(2)
        # defval explícito tem prioridade
        dv = re.search(r"defval\s*=\s*(-?\d+(?:\.\d+)?)", args)
        if dv:
            values[name] = float(dv.group(1))
            continue
        num = re.search(r"(-?\d+(?:\.\d+)?)", args)
        if num:
            values[name] = float(num.group(1))

    # Também resolve constantes simples: `len1 = 14`, `fast = 9` — muitos scripts
    # definem os comprimentos assim (sem input(...)). Sem isto, os períodos caem
    # no default e duas médias diferentes viram o MESMO período (ex.: SMA14 vs SMA14).
    for m in re.finditer(r"^\s*(\w+)\s*=\s*(-?\d+(?:\.\d+)?)\s*$", src, re.MULTILINE):
        name = m.group(1)
        if name not in values:  # input(...) tem prioridade
            values[name] = float(m.group(2))
    return values


def _num_from_token(tok: str, inputs: dict[str, float]) -> float | None:
    tok = tok.strip()
    if re.fullmatch(r"-?\d+(?:\.\d+)?", tok):
        return float(tok)
    if tok in inputs:
        return inputs[tok]
    return None


def _split_args(argstr: str) -> list[str]:
    """Divide argumentos no nível 0 de parênteses."""
    args, depth, cur = [], 0, ""
    for ch in argstr:
        if ch == "(":
            depth += 1
            cur += ch
        elif ch == ")":
            depth -= 1
            cur += ch
        elif ch == "," and depth == 0:
            args.append(cur)
            cur = ""
        else:
            cur += ch
    if cur.strip():
        args.append(cur)
    return args


def _balanced_args(src: str, open_idx: int) -> tuple[str, int]:
    """Dado src[open_idx]=='(', retorna (conteúdo entre parênteses, índice do ')')."""
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
            if depth == 0:
                return src[open_idx + 1:i], i
    return src[open_idx + 1:], len(src)


def _extract_period(args: list[str], inputs: dict[str, float]) -> float | None:
    """Resolve o período/length de uma chamada, robusto a input inline.

    Ordem: 1) número ou variável de input em qualquer arg que NÃO seja preço;
    2) primeiro inteiro literal nos args após o 1º (posição típica do length) —
    cobre `ta.sma(close, input.int(20, "MA1"))` onde o length está inline.
    """
    for a in args:
        a = a.strip()
        if a in _PRICE_TOKENS or a in ("hl2", "hlc3", "ohlc4", "tr"):
            continue
        n = _num_from_token(a, inputs)
        if n is not None:
            return n
    tail = ",".join(args[1:]) if len(args) > 1 else (args[0] if args else "")
    im = re.search(r"\d+", tail)
    return float(im.group(0)) if im else None


def _source_of(args: list[str]) -> str:
    for a in args:
        a = a.strip()
        if a in _PRICE_TOKENS:
            return a
    return "close"


def _find_ma_funcs(src: str) -> dict[str, str]:
    """Detecta funções DEFINIDAS pelo usuário que são 'wrappers' de média móvel.

    Padrão comum em indicadores '3 MA' com seletor de tipo:
        maf(src, len, type) => type == "EMA" ? ta.ema(src, len) : ta.sma(src, len)
    Retorna {nome_da_funcao: INDICADOR_DO_MOTOR}. Usa o 1º ta.<ma> achado no corpo.
    """
    funcs: dict[str, str] = {}
    lines = src.split("\n")
    ma_fns = {k: v for k, v in _FUNC_MAP.items()
              if v in ("SMA", "EMA", "RMA", "WMA", "HMA", "VWMA")}
    for i, line in enumerate(lines):
        m = re.match(r"(\s*)(\w+)\s*\([^)]*\)\s*=>(.*)", line)
        if not m:
            continue
        indent, name, body = len(m.group(1)), m.group(2), m.group(3)
        # anexa linhas indentadas (corpo em bloco)
        j = i + 1
        while j < len(lines):
            lj = lines[j]
            if lj.strip() == "":
                j += 1
                continue
            if (len(lj) - len(lj.lstrip())) <= indent:
                break
            body += " " + lj
            j += 1
        # escolhe a média que aparece PRIMEIRO no corpo (casa com o ramo default
        # do ternário, ex.: type=='EMA' ? ta.ema(...) : ta.sma(...)).
        best_pos, best_eng = None, None
        for fn, eng in ma_fns.items():
            mm = re.search(rf"(?:ta\.)?\b{fn}\s*\(", body)
            if mm and (best_pos is None or mm.start() < best_pos):
                best_pos, best_eng = mm.start(), eng
        if best_eng:
            funcs[name] = best_eng
    return funcs


def _collect_vars(src: str, inputs: dict[str, float]) -> dict[str, dict]:
    """varname -> {indicator, period, source} a partir de atribuições.

    Usa parsing de parênteses BALANCEADO (não regex simples) para não quebrar em
    chamadas aninhadas tipo `ta.sma(close, input.int(20, "MA1"))`.
    """
    vars_: dict[str, dict] = {}
    ma_funcs = _find_ma_funcs(src)

    # Tupla: [a, b, c] = [ta.]macd(...) / bb(...) / stoch(...)
    for m in re.finditer(r"\[\s*([\w\s,]+?)\s*\]\s*=\s*(?:ta\.)?(\w+)\s*\(", src):
        names = [n.strip() for n in m.group(1).split(",")]
        fn = m.group(2).lower()
        if fn not in _TUPLE_MAP:
            continue
        argstr, _ = _balanced_args(src, m.end() - 1)
        args = _split_args(argstr)
        period = _extract_period(args, inputs)
        eng_list = _TUPLE_MAP[fn]
        for i, nm in enumerate(names):
            if i < len(eng_list) and nm and nm != "_":
                eng = eng_list[i]
                vars_[nm] = {
                    "indicator": eng,
                    "period": int(period) if period else _DEFAULT_PERIOD.get(eng, 14),
                    "source": "close",
                }

    # Valor único: name = [ta.]fn(args) — fn nativa OU wrapper de MA do usuário.
    for m in re.finditer(r"(\w+)\s*=\s*(?:ta\.)?(\w+)\s*\(", src):
        name, fn = m.group(1), m.group(2).lower()
        eng = _FUNC_MAP.get(fn) or ma_funcs.get(m.group(2))
        if not eng:
            continue
        argstr, _ = _balanced_args(src, m.end() - 1)
        args = _split_args(argstr)
        vars_[name] = {
            "indicator": eng,
            "period": int(_extract_period(args, inputs) or _DEFAULT_PERIOD.get(eng, 14)),
            "source": _source_of(args),
        }
    return vars_


def _resolve_operand(tok: str, vars_: dict, inputs: dict) -> dict | None:
    """Resolve um operando para {kind:'ind', indicator, period} ou {kind:'num', value}."""
    tok = tok.strip()
    if not tok:
        return None
    if tok in vars_:
        v = vars_[tok]
        return {"kind": "ind", "indicator": v["indicator"], "period": v["period"]}
    if tok in _PRICE_TOKENS:
        return {"kind": "ind", "indicator": _PRICE_TOKENS[tok], "period": 1}
    n = _num_from_token(tok, inputs)
    if n is not None:
        return {"kind": "num", "value": n}
    return None


def _make_condition(left: dict, op: str, right: dict) -> dict | None:
    """Monta uma condição do motor a partir de (left, operador, right)."""
    # normaliza para "left é indicador"
    if left["kind"] == "num" and right["kind"] == "ind":
        left, right = right, left
        op = {"greater_than": "less_than", "less_than": "greater_than",
              "crosses_above": "crosses_below", "crosses_below": "crosses_above"}.get(op, op)
    if left["kind"] != "ind":
        return None
    cond = {
        "indicator": left["indicator"],
        "indicator_period": int(left["period"]),
        "operator": op,
        "value": None,
        "compare_to_indicator": None,
    }
    if right["kind"] == "ind":
        # Rejeita comparar um indicador COM ELE MESMO (mesmo tipo e período):
        # gera condição degenerada que nunca dispara (ex.: SMA14 cruza SMA14).
        if right["indicator"] == left["indicator"] and int(right["period"]) == int(left["period"]):
            return None
        cond["compare_to_indicator"] = f"{right['indicator']}_{int(right['period'])}"
    else:
        cond["value"] = right["value"]
    return cond


def _find_conditions(src: str, vars_: dict, inputs: dict) -> tuple[list[dict], list[dict]]:
    """Extrai condições de entrada (long) e saída, classificando por contexto."""
    entries: list[dict] = []
    exits: list[dict] = []

    def classify(text_before: str) -> str:
        t = text_before.lower()
        if any(k in t for k in ("short", "sell", "exit", "close", "bear", "sl", "stop")):
            # 'close' aqui é o contexto textual (ex.: closeCondition), não o preço
            if "short" in t or "sell" in t or "exit" in t or "bear" in t:
                return "exit"
        if any(k in t for k in ("long", "buy", "bull", "enter", "entry")):
            return "entry"
        return "entry"  # default: trata como entrada

    # 1) crossover/crossunder(a, b)
    for m in re.finditer(r"(\w*)\s*[:=]?=?\s*(?:ta\.)?(crossover|crossunder)\s*\(([^)]*)\)", src):
        ctxvar = m.group(1) or ""
        fn = m.group(2).lower()
        args = _split_args(m.group(3))
        if len(args) < 2:
            continue
        left = _resolve_operand(args[0], vars_, inputs)
        right = _resolve_operand(args[1], vars_, inputs)
        if not left or not right:
            continue
        op = "crosses_above" if fn == "crossover" else "crosses_below"
        cond = _make_condition(left, op, right)
        if not cond:
            continue
        # linha inteira p/ contexto de classificação
        line_start = src.rfind("\n", 0, m.start()) + 1
        line = src[line_start:m.end()]
        bucket = classify(ctxvar + " " + line)
        (exits if bucket == "exit" else entries).append(cond)

    # 2) comparações a >/< b dentro de linhas de SINAL de trade.
    # NÃO usamos 'if' genérico de propósito: em scripts de indicador o 'if' quase
    # sempre é coloração/plot (ex.: 'if ma1 < ma2 => cor vermelha'), não entrada.
    # Sinais reais vêm de variáveis long/buy/short/sell/entry/exit ou de crossover.
    signal_line = re.compile(
        r"(long\w*|short\w*|buy\w*|sell\w*|entry\w*|enter\w*|exit\w*)\b[^\n]*", re.IGNORECASE)
    for lm in signal_line.finditer(src):
        line = lm.group(0)
        ctx = lm.group(1).lower()
        for cm in re.finditer(r"([\w.]+)\s*(>=|<=|>|<)\s*([\w.]+)", line):
            left = _resolve_operand(cm.group(1), vars_, inputs)
            right = _resolve_operand(cm.group(2 - 1 + 2), vars_, inputs)  # group(3)
            if not left or not right:
                continue
            # ignora comparação número vs número
            if left["kind"] == "num" and right["kind"] == "num":
                continue
            op = "greater_than" if cm.group(2) in (">", ">=") else "less_than"
            cond = _make_condition(left, op, right)
            if not cond:
                continue
            bucket = "exit" if any(k in ctx for k in ("short", "sell", "exit")) else "entry"
            (exits if bucket == "exit" else entries).append(cond)

    # 3) fallback: script de indicador com ≥2 médias e nenhuma condição achada
    if not entries:
        mas = [(n, v) for n, v in vars_.items()
               if v["indicator"] in ("SMA", "EMA", "RMA", "WMA", "HMA", "VWMA")]
        # períodos DISTINTOS (senão o "cruzamento" é da média com ela mesma)
        distinct = sorted({v["period"] for _, v in mas})
        if len(mas) >= 2 and len(distinct) >= 2:
            mas.sort(key=lambda x: x[1]["period"])
            fast = mas[0][1]
            # slow = primeira média com período MAIOR que o fast
            slow = next(v for _, v in mas if v["period"] > fast["period"])
            entries.append({
                "indicator": fast["indicator"], "indicator_period": int(fast["period"]),
                "operator": "crosses_above",
                "value": None,
                "compare_to_indicator": f"{slow['indicator']}_{int(slow['period'])}",
            })
            exits.append({
                "indicator": fast["indicator"], "indicator_period": int(fast["period"]),
                "operator": "crosses_below",
                "value": None,
                "compare_to_indicator": f"{slow['indicator']}_{int(slow['period'])}",
            })

    return _dedup(entries), _dedup(exits)


def _dedup(conds: list[dict]) -> list[dict]:
    seen, out = set(), []
    for c in conds:
        key = (c["indicator"], c["indicator_period"], c["operator"],
               c.get("value"), c.get("compare_to_indicator"))
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def _extract_sl_tp(src: str, inputs: dict) -> tuple[dict | None, dict | None]:
    """Tenta achar SL/TP em % via inputs nomeados ou strategy.exit."""
    sl = tp = None

    def as_pct(v: float) -> float:
        # 0.02 -> 2.0 ; 2 -> 2.0 ; 200 (basis? raro) mantém
        return v * 100 if 0 < v < 1 else v

    # Regex PRECISOS p/ não confundir com nomes tipo 'emaSlow' (contém 'sl').
    sl_re = re.compile(r"(stop.?loss|stoploss|trail|\bsl\b|sl[_]?p|sl[_]?pct|sl[_]?perc)", re.IGNORECASE)
    tp_re = re.compile(r"(take.?profit|takeprofit|\btp\b|tp[_]?p|tp[_]?pct|tp[_]?perc|target)", re.IGNORECASE)

    for name, val in inputs.items():
        low = name.lower()
        # só valores plausíveis de % (evita capturar um período tipo 21)
        if not (0 < val <= 100):
            continue
        if sl is None and sl_re.search(low):
            sl = {"type": "trail" if "trail" in low else "percentage", "value": as_pct(val)}
        if tp is None and tp_re.search(low):
            tp = {"type": "percentage", "value": as_pct(val)}

    return sl, tp


def parse_pine(pine_script: str) -> dict:
    """Retorna o dict RAW (pré-normalização) equivalente ao da IA.

    Levanta ValueError('no_conditions') se não conseguir extrair NENHUMA
    condição de entrada — aí o chamador orienta o usuário.
    """
    src = _strip_comments(pine_script or "")
    if not src.strip():
        raise ValueError("empty")

    title = _extract_title(src)
    inputs = _resolve_inputs(src)
    vars_ = _collect_vars(src, inputs)
    entries, exits = _find_conditions(src, vars_, inputs)

    if not entries:
        raise ValueError("no_conditions")

    sl, tp = _extract_sl_tp(src, inputs)

    # descrição legível a partir do que foi detectado
    def desc_cond(c: dict) -> str:
        op = {"greater_than": ">", "less_than": "<",
              "crosses_above": "cruza ↑", "crosses_below": "cruza ↓"}.get(c["operator"], c["operator"])
        alvo = c.get("compare_to_indicator") or c.get("value")
        return f"{c['indicator']}({c['indicator_period']}) {op} {alvo}"

    detected = ", ".join(sorted({v["indicator"] for v in vars_.values()})) or "—"
    description = (
        f"Importada do Pine Script (sem IA). Indicadores detectados: {detected}. "
        f"Entrada: {' e '.join(desc_cond(c) for c in entries)}."
    )

    return {
        "name": title or "Estratégia Importada (Pine)",
        "description": description,
        "strategy": "custom",
        "filters": {},
        "entry_conditions": entries,
        "exit_conditions": exits,
        "entry_side": "LONG",
        "sl": sl,   # None -> normalizer aplica default 1.5%
        "tp": tp,   # None -> normalizer aplica default 3.0%
        "recommendedTimeframes": [],
        "recommendedSymbols": [],
        "recommendationReason": "",
    }
