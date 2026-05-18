# 📋 Alpha_RangeMaster Strategy — v2.0

## 📐 Overview
The **Alpha_RangeMaster v2** is a refined mean-reversion strategy for **Range Markets**, rebuilt after backtesting revealed critical flaws in v1: R:R below 1.0, weak regime detection, and TP placement at the range midpoint. Version 2 corrects all three issues and adds dual-timeframe regime filtering, trailing stop, cooldown logic, and a minimum R:R gate.

---

## 🔍 Strategy Details
- **Strategy Name:** Alpha_RangeMaster v2
- **Market Profile:** Range / Sideways / Non-Trending
- **Logic Type:** Mean Reversion / Boundary Trading
- **Version:** 2.0 — Rebuilt after backtesting (Mai 2026)

---

## 📈 Supported Assets & Timeframes
The following configurations are optimized for this strategy:

| Asset | Timeframe | Focus |
| :--- | :--- | :--- |
| **BTC** (Bitcoin) | **1H** | High liquidity range capture |
| **ETH** (Ethereum) | **1H / 4H** | Stability in ranges |
| **SOL** (Solana) | **1H / 4H** | Volatility management in ranges |

---

## 🛠 Operation Principles
1. **Range Identification:** Locate clear horizontal boundaries.
2. **Execution:** Sell near resistance, Buy near support (BB Lower Band).
3. **Filtering:** Avoid entries during high-momentum breakouts (Trend detection).
4. **Optimization:** Specifically tuned for the 1H and 4H cycles to reduce noise.

---

### 🟦 Pillar 1 — Range Detection

These indicators define the boundaries of the range and validate that the market is truly in a sideways regime before any trade is placed.

#### 1. [Range Detector](https://www.luxalgo.com/library/indicator/range-detector/)
- **Role:** Primary regime filter. Confirms the market is in a low-volatility, non-trending state.
- **How to use:** Only allow new entries when the Range Detector is active (range mode on). Disable trading signals when the indicator signals a potential breakout above/below the channel.
- **Bot integration:** Use the `range_active` boolean output as a global gate — if `false`, skip all entry logic.

#### 2. [Predictive Ranges](https://www.luxalgo.com/library/indicator/predictive-ranges/)
- **Role:** Dynamically projects the upper and lower boundaries of the expected range.
- **How to use:** Use predicted upper boundary as resistance target and lower boundary as support target. Entry near boundaries; exit at the midpoint or opposite boundary.
- **Bot integration:** Feed the upper/lower predicted values as dynamic `take_profit` and `entry_zone` thresholds.

#### 3. [Support & Resistance Pro Toolkit](https://www.luxalgo.com/library/indicator/support-resistance-pro-toolkit/)
- **Role:** Multi-engine S/R detection (Pivots, Donchian, CSID, ZigZag) with ATR-adaptive zones.
- **How to use:** Use as the definitive source for support/resistance zones. Zones with confluence across 2+ detection engines are highest priority.
- **Bot integration:** Map zone boundaries to `buy_zone_max` / `sell_zone_min` variables with a configurable ATR buffer.

---

### 🟨 Pillar 2 — Entry Timing & Mean Reversion

These indicators determine the precise moment to enter a trade once price is inside a valid zone.

#### 4. [Adaptive Bounds RSI](https://www.luxalgo.com/library/indicator/adaptive-bounds-rsi/)
- **Role:** RSI with data-driven overbought/oversold bands (replaces static 30/70 levels). Adapts to market volatility.
- **How to use:** Enter LONG when RSI crosses below adaptive oversold band (at support). Enter SHORT when RSI crosses above adaptive overbought band (at resistance).
- **Bot integration:** Trigger entry signal only when `adaptive_rsi < lower_band` (long) or `adaptive_rsi > upper_band` (short).

#### 5. [Oscillator Matrix™](https://www.luxalgo.com/library/indicator/luxalgo-oscillator-matrix/)
- **Role:** Multi-component oscillator with built-in reversal signal detection, divergences, and money flow.
- **How to use:** Use the Reversal Signals component to confirm mean reversion at range extremes. Divergence between price and oscillator near S/R zones strengthens the trade conviction.
- **Bot integration:** Use `reversal_signal == bullish` at support zone and `reversal_signal == bearish` at resistance zone as secondary confirmation trigger.

#### 6. [Stochastic Adaptive %D](https://www.luxalgo.com/library/indicator/stochastic-adaptive-d/)
- **Role:** Adaptive stochastic oscillator for identifying exhaustion points inside the range.
- **How to use:** Crossover of %K above %D in oversold territory → LONG. Crossover of %K below %D in overbought territory → SHORT.
- **Bot integration:** Use as a timing layer on top of the Adaptive RSI signal for double confirmation.

---

### 🟥 Pillar 3 — Breakout Filter (False Breakout Protection)

The most critical layer for a range strategy. Prevents entering trades that are actually trend reversals disguised as range touches.

#### 7. [Omni-Flow Consensus](https://www.luxalgo.com/library/indicator/omni-flow-consensus/)
- **Role:** Primary trend/regime filter oscillator. Detects whether price changes carry enough force to sustain a breakout.
- **How to use:** If Omni-Flow is above the neutral line and rising strongly, treat boundary touch as potential breakout — DO NOT ENTER. Only trade when Omni-Flow is near neutral or oscillating.
- **Bot integration:** Implement `abs(omni_flow) < threshold` as a hard gate before any entry signal is processed.

#### 8. [Volumetric Order Flow Structure](https://www.luxalgo.com/library/indicator/volumetric-order-flow-structure/)
- **Role:** Confirms whether a boundary touch is backed by aggressive buyers/sellers (real breakout) or weak participation (fake breakout / range continuation).
- **How to use:** At resistance: if order flow is dominated by aggressive sellers → short is safe. If aggressive buyers are pushing through resistance → skip the short, possible breakout.
- **Bot integration:** Evaluate delta volume at boundary touch. If `delta > breakout_volume_threshold`, suppress the signal.

#### 9. [Liquidity Structure & Order Flow](https://www.luxalgo.com/library/indicator/liquidity-structure-order-flow/)
- **Role:** Detects liquidity voids, institutional order flow, and high-probability S/R zones.
- **How to use:** Identify liquidity sweeps (stop hunts) near range boundaries — these are high-conviction reversal setups. Avoid entries when structure is showing a clear trend break.
- **Bot integration:** Use liquidity void detection to find optimal entry windows after stop-hunting moves near boundaries.

---

## 🗺 Signal Logic v2 (Combined Flow)

```
[Every candle close]

  ── REGIME GATES (all must pass) ────────────────────────────────
  1. ADX 1H < 28  OR  (ADX 1H < 35 AND ADX 4H < 28)
       → NO → Skip. Market is trending on at least one timeframe.

  2. Choppiness Index (14) ≥ 45
       → NO → Skip. Price movement is directional, not lateral.

  3. Volume delta < 1.3× average
       → NO → Skip. Potential breakout candle, not exhaustion.

  ── LONG ENTRY ──────────────────────────────────────────────────
  4. Price within 1.5× ATR of 24-bar Support
  5. RSI(14) < 42
  6. Stochastic %K < 30 AND %K crossing above %D  (OR volume delta bullish)
  7. Planned R:R ≥ 1.5  →  TP = Resistance − ATR×0.3 / SL = Support − ATR×0.3
       → All YES → ENTER LONG ✅

  ── SHORT ENTRY ─────────────────────────────────────────────────
  4. Price within 1.5× ATR of 24-bar Resistance
  5. RSI(14) > 58
  6. Stochastic %K > 70 AND %K crossing below %D  (OR volume delta bearish)
  7. Planned R:R ≥ 1.5  →  TP = Support + ATR×0.3 / SL = Resistance + ATR×0.3
       → All YES → ENTER SHORT ✅

  ── POSITION MANAGEMENT ─────────────────────────────────────────
  • Trailing Stop: when price reaches 50% of TP distance → move SL to BE + ATR×0.1
  • Cooldown: after 2 consecutive losses → pause 10 candles on that asset
  • Exit: SL hit OR TP hit (full opposite boundary)
```

---

## 📊 Indicator Priority Matrix — v2

| Indicator | Layer | Priority | Parameter v2 |
| :--- | :--- | :--- | :--- |
| Range Detector | Regime Gate 1 | 🔴 Critical | Gate on/off |
| Omni-Flow Consensus (ADX 4H proxy) | Regime Gate 1 | 🔴 Critical | ADX 4H < 28 |
| Choppiness Index | Regime Gate 2 | 🔴 Critical | ≥ 45 |
| S&R Pro Toolkit | Zone Definition | 🟠 High | 24-bar Donchian |
| Predictive Ranges | Zone Projection | 🟠 High | Dynamic TP/SL |
| RSI (14) | Entry Trigger | 🟠 High | < 42 long / > 58 short |
| Stochastic Adaptive %D | Entry Confirm | 🟡 Medium | %K cross in OS/OB |
| Volumetric Order Flow | Volume Gate | 🟡 Medium | delta < 1.3× avg vol |
| Oscillator Matrix™ | Reversal Confirm | 🟡 Medium | Reversal signal |
| Liquidity Structure | Context | 🟢 Low | Stop hunt detection |

## ⚙️ Asset-Specific Parameters

| Asset | ADX 1H Gate | Choppiness | RSI Long | RSI Short | SL Buffer | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **BTC** | < 28 | ≥ 45 | < 42 | > 58 | ATR × 0.30 | Parâmetros padrão |
| **SOL** | < 30 | ≥ 42 | < 42 | > 58 | ATR × 0.35 | Gate ligeiramente mais relaxado — SOL tem mais ranges |

---

> [!TIP]
> This strategy performs best when volatility is contained within a horizontal channel. Monitor for volume spikes that might indicate an impending range breakout.

> [!WARNING]
> **Never skip the triple gate** (ADX 1H, ADX 4H, Choppiness). These three filters together are the #1 reason v2 outperforms v1. The v1 strategy was losing primarily because it entered during trending markets disguised as ranges. A single ADX gate is not enough — Choppiness confirms what ADX suspects.

> [!IMPORTANT]
> **Take Profit must target the opposite boundary**, not the midpoint. This is the single biggest structural fix from v1→v2. With TP at the midpoint, the R:R was 0.55–0.88 (mathematically losing). With TP at the full boundary, R:R becomes 1.99–2.53, which is sustainable even at win rates around 30%.

> [!NOTE]
> All LuxAlgo indicators listed above are available on TradingView. For bot automation, use TradingView alerts with webhook output to pipe signals into your trading bot. The Pine Script should implement the triple gate as a single `allowed_to_trade` boolean before any entry logic runs.
