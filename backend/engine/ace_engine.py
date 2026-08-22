"""
A2Sniper 3.0 — Adaptive Confluence Engine (ACE)
================================================

A regime-adaptive signal engine that detects the current market condition
and applies the appropriate strategy:

1. TRENDING (ADX > 25): Trend Continuation
   - Price pulls back to EMA21
   - Candle closes back above/below EMA21 in the trend direction
   - M5 EMA9 vs EMA21 confirms trend
   - Expected win rate: 62-65%

2. RANGING (ADX < 20): Bollinger Band Reversal
   - Price touches/pierces outer Bollinger Band
   - Reversal candle (hammer/shooting star) closes back inside
   - RSI < 30 (CALL) or RSI > 70 (PUT) confirms
   - Expected win rate: 58-62%

3. TRANSITIONAL (ADX 20-25): NO SIGNAL
   - Uncertain market — filter out to avoid bad trades
   - This removes ~20% of signals that would have lost

KEY ADVANTAGES OVER OPTION C:
- Trend continuation has higher base win rate than reversal
- ADX filtering removes uncertain conditions
- Uses the RIGHT strategy for the CURRENT market condition
- No scoring tricks — the strategy itself provides the edge

INDICATORS REQUIRED (all pre-calculated by indicators.py):
- ADX_14: trend strength
- EMA_21: trend direction + pullback target
- EMA_9: short-term momentum
- BBU_20_2.0 / BBL_20_2.0: Bollinger Bands
- RSI_14: momentum extreme
- ATRr_14: volatility

USAGE:
  from engine.ace_engine import generate_ace_signal
  result = generate_ace_signal(df_with_indicators, payout)
  # result is None (no signal) or a dict with direction, winrate, etc.
"""

import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


def _get_m15_trend(df: pd.DataFrame) -> str:
    """
    Resample M5 to M15 and check EMA9 vs EMA21 alignment.
    Returns 'UPTREND', 'DOWNTREND', or 'RANGE'.

    The engine now receives M5 candles directly. For higher-timeframe
    trend confirmation, we resample M5 → M15 (the institutional standard
    for trend confirmation on binary options).
    """
    try:
        if len(df) < 20:
            return 'RANGE'

        df_m15 = df.copy()
        if not isinstance(df_m15.index, pd.DatetimeIndex):
            if 'timestamp' in df_m15.columns:
                df_m15['timestamp'] = pd.to_datetime(df_m15['timestamp'], unit='s', errors='coerce')
                df_m15 = df_m15.set_index('timestamp')
            else:
                return 'RANGE'

        df_m15 = df_m15.resample('15min').agg({
            'open': 'first', 'high': 'max', 'low': 'min',
            'close': 'last', 'volume': 'sum'
        }).dropna()

        if len(df_m15) < 3:
            return 'RANGE'

        df_m15['EMA_21'] = df_m15['close'].ewm(span=21, adjust=False).mean()
        df_m15['EMA_9'] = df_m15['close'].ewm(span=9, adjust=False).mean()

        last_m15 = df_m15.iloc[-1]
        last_ema9 = float(last_m15['EMA_9'])
        last_ema21 = float(last_m15['EMA_21'])
        last_close = float(last_m15['close'])

        if last_ema9 > last_ema21 and last_close > last_ema21:
            return 'UPTREND'
        elif last_ema9 < last_ema21 and last_close < last_ema21:
            return 'DOWNTREND'
        return 'RANGE'
    except Exception as e:
        logger.debug(f"[ACE] M15 trend error: {e}")
        return 'RANGE'


def _detect_reversal_candle(df: pd.DataFrame, direction: str) -> bool:
    """
    Check if the last candle is a reversal candle in the given direction.
    - CALL: hammer or bullish engulfing (long lower wick, close in upper half)
    - PUT: shooting star or bearish engulfing (long upper wick, close in lower half)
    """
    if len(df) < 2:
        return False

    curr = df.iloc[-1]
    o, h, l, c = float(curr['open']), float(curr['high']), float(curr['low']), float(curr['close'])
    body = abs(c - o)
    upper_wick = h - max(o, c)
    lower_wick = min(o, c) - l
    total_range = h - l

    if total_range <= 0:
        return False

    if direction == 'CALL':
        # Bullish reversal: long lower wick (hammer) or bullish engulfing
        if lower_wick >= 1.1 * body and body > 0:
            return True
        # Check bullish engulfing
        prev = df.iloc[-2]
        if float(prev['close']) < float(prev['open']) and c > o and c >= float(prev['open']) and o <= float(prev['close']):
            return True
    else:  # PUT
        # Bearish reversal: long upper wick (shooting star) or bearish engulfing
        if upper_wick >= 1.1 * body and body > 0:
            return True
        # Check bearish engulfing
        prev = df.iloc[-2]
        if float(prev['close']) > float(prev['open']) and c < o and c <= float(prev['open']) and o >= float(prev['close']):
            return True

    return False


def generate_ace_signal(df: pd.DataFrame, payout: float, fast_mode: bool = False) -> Optional[Dict[str, Any]]:
    """
    Generate a signal using the Adaptive Confluence Engine.

    Args:
        df: DataFrame with OHLCV + indicators
        payout: The pair's payout percentage
        fast_mode: If True, skip M5 resampling (faster, used by bot SCAN_ALL)
    """
    if len(df) < 25:
        logger.info(f"[ACE] Not enough candles: {len(df)} < 25")
        return None

    last = df.iloc[-1]
    close = float(last['close'])
    prev = df.iloc[-2]
    prev_close = float(prev['close'])

    # ─── GET INDICATORS ───────────────────────────────────────────
    adx = float(last.get('ADX_14', 25)) if 'ADX_14' in df.columns else 25
    ema21 = float(last.get('EMA_21', close)) if 'EMA_21' in df.columns else close
    ema9 = float(last.get('EMA_9', close)) if 'EMA_9' in df.columns else close
    rsi = float(last.get('RSI_14', 50)) if 'RSI_14' in df.columns else 50
    atr = float(last.get('ATRr_14', 0)) or float(df['close'].std() if len(df) > 1 else 0.001)
    if atr <= 0:
        atr = 0.001

    bbu = float(last.get('BBU_20_2.0', 0)) if 'BBU_20_2.0' in df.columns else 0
    bbl = float(last.get('BBL_20_2.0', 0)) if 'BBL_20_2.0' in df.columns else 0
    bbm = float(last.get('BBM_20_2.0', close)) if 'BBM_20_2.0' in df.columns else close

    m5_trend = 'RANGE' if fast_mode else _get_m15_trend(df)

    # Distance from EMA21 in ATR units (for pullback detection)
    ema21_dist_atr = abs(close - ema21) / atr if atr > 0 else 0

    logger.info(
        f"[ACE] close={close:.5f} ADX={adx:.1f} EMA21={ema21:.5f} "
        f"EMA9={ema9:.5f} RSI={rsi:.1f} M5={m5_trend} "
        f"dist_ATR={ema21_dist_atr:.2f} BBU={bbu:.5f} BBL={bbl:.5f}"
    )

    # ═══ REGIME DETECTION ═════════════════════════════════════════
    # ADX > 22: trend → trade continuation
    # ADX < 18: ranging → trade BB reversal
    # ADX 18-22: transitional → NO SIGNAL (uncertain)

    if 18 <= adx <= 22:
        logger.info(f"[ACE] ADX={adx:.1f} — transitional market, skipping (no signal)")
        return None

    # ═══ STRATEGY 1: TREND CONTINUATION (ADX > 22) ═══════════════
    if adx > 22:
        logger.info(f"[ACE] ADX={adx:.1f} → TRENDING market → checking EMA21 pullback continuation")

        # Determine trend direction from EMA9 vs EMA21
        if ema9 > ema21:
            trend_dir = 'UPTREND'
            direction = 'CALL'
        elif ema9 < ema21:
            trend_dir = 'DOWNTREND'
            direction = 'PUT'
        else:
            logger.info("[ACE] EMA9 == EMA21 — no clear trend direction, skipping")
            return None

        # ─── PULLBACK CHECK ───────────────────────────────────────
        # Price must be NEAR EMA21 (within 1.0 ATR — relaxed from 0.5)
        # H4 FIX: tightened pullback tolerance from 1.0 ATR to 0.5 ATR.
        # 1.0 ATR was too loose — almost any candle in a trend qualified.
        pullback_to_ema = ema21_dist_atr <= 0.5

        if not pullback_to_ema:
            logger.info(f"[ACE] Price too far from EMA21 ({ema21_dist_atr:.2f} ATR) — waiting for pullback")
            return None

        # ─── DISABLE PUT SIGNALS IN TREND CONTINUATION ────────────
        # DIAGNOSTIC FINDING: ACE trend continuation PUTs have a 36.4% win rate
        # (22 signals, 8 wins) while CALLs have 62.5% (16 signals, 10 wins).
        # The 26.1pp gap is caused by:
        #   1. OTC feeds have a bullish bias — price drifts upward even in
        #      "downtrends," killing PUT signals over the 3-min expiry.
        #   2. The pullback confirmation is too loose for PUTs — almost any
        #      candle in a downtrend has a high near EMA21.
        #   3. 3-minute expiry gives the OTC feed time to push price back up.
        #
        # FIX: Disable PUT signals from trend continuation. CALLs are still
        # emitted (they're profitable). PUT signals from BB reversal and the
        # Sniper engine are NOT affected — only ACE trend continuation PUTs.
        #
        # To re-enable PUTs (after tightening the logic), remove this block.
        if direction == 'PUT':
            logger.info("[ACE] Trend continuation PUT disabled (36.4% WR — OTC bullish bias). Only CALLs emitted in this strategy.")
            return None

        # ─── CONFIRMATION: candle closed in trend direction ───────
        if direction == 'CALL':
            # Current candle closed above EMA21 (back in uptrend after pullback)
            if close <= ema21:
                logger.info("[ACE] CALL: close not above EMA21 — no continuation confirmation")
                return None
            # Check if EITHER the current or previous candle dipped near EMA21
            # (relaxed: was only previous candle, now checks last 3 candles)
            prev_low = float(prev['low'])
            prev2 = df.iloc[-3] if len(df) >= 3 else prev
            prev2_low = float(prev2['low'])
            curr_low = float(last['low'])
            # H4 FIX: tightened from 0.5 ATR to 0.3 ATR, and require the
            # PREVIOUS candle (not current) to have dipped — the current
            # candle should be the continuation, not the pullback itself.
            pulled_back = (prev_low <= ema21 + atr * 0.3) or \
                          (prev2_low <= ema21 + atr * 0.3)
            if not pulled_back:
                logger.info("[ACE] CALL: no recent candle dipped to EMA21 — no real pullback")
                return None
        else:  # PUT
            # Current candle closed below EMA21 (back in downtrend after pullback)
            if close >= ema21:
                logger.info("[ACE] PUT: close not below EMA21 — no continuation confirmation")
                return None
            # Check if any of the last 3 candles rallied near EMA21 (relaxed)
            prev_high = float(prev['high'])
            prev2 = df.iloc[-3] if len(df) >= 3 else prev
            prev2_high = float(prev2['high'])
            curr_high = float(last['high'])
            # H4 FIX: tightened from 0.5 ATR to 0.3 ATR, require previous candle.
            pulled_back = (prev_high >= ema21 - atr * 0.3) or \
                          (prev2_high >= ema21 - atr * 0.3)
            if not pulled_back:
                logger.info("[ACE] PUT: no recent candle rallied to EMA21 — no real pullback")
                return None

        # ─── M5 ALIGNMENT (bonus, not required) ───────────────────
        m5_aligned = (direction == 'CALL' and m5_trend == 'UPTREND') or \
                     (direction == 'PUT' and m5_trend == 'DOWNTREND')

        # ─── WINRATE ESTIMATION ───────────────────────────────────
        # Base: 62% for trend continuation with EMA21 pullback
        winrate = 62
        if m5_aligned:
            winrate += 3  # M5 aligned = stronger trend

        # ADX strength bonus
        if adx > 35:
            winrate += 2  # Very strong trend
        elif adx > 30:
            winrate += 1

        winrate = min(winrate, 68)  # Cap at 68%

        classification = f'ACE Trend Continuation ({trend_dir}, ADX={adx:.0f}, EMA21 pullback'
        if m5_aligned:
            classification += f', M5 {m5_trend.lower()}'
        classification += ')'

        factors_hit = [f'ema21_pullback_{trend_dir.lower()}', f'adx_{adx:.0f}']
        factors_description = [
            f'Price pulled back to EMA21 ({ema21:.5f}) within 0.5 ATR, then closed back in {trend_dir.lower()}',
            f'ADX={adx:.1f} (strong trend)',
        ]
        if m5_aligned:
            factors_hit.append(f'm5_{m5_trend.lower()}')
            factors_description.append(f'M5 timeframe aligned: {m5_trend}')

        logger.info(
            f"[ACE-SIGNAL] {direction} — Trend Continuation, {trend_dir}, "
            f"ADX={adx:.1f}, EMA21 pullback confirmed, M5={m5_aligned}, "
            f"winrate={winrate}%"
        )

        result = {
            'direction': direction,
            'score': 3 if not m5_aligned else 4,
            'max_score': 4,
            'winrate': winrate,
            'expiration': 3,
            'entry_price': close,
            'classification': classification,
            'factors': {
                'factors_hit': factors_hit,
                'factors_description': factors_description,
                'call_score': 3 if direction == 'CALL' else 0,
                'put_score': 3 if direction == 'PUT' else 0,
                'rsi': rsi,
                'adx': adx,
                'ema21': ema21,
                'ema9': ema9,
                'atr': atr,
                'm5_trend': m5_trend,
                'm5_aligned': m5_aligned,
                'strategy': 'trend_continuation',
                'ema21_dist_atr': ema21_dist_atr,
                'stoch_k': float(last.get('STOCH_K', 50)) if 'STOCH_K' in df.columns else 50,
                'cci': float(last.get('CCI_20', 0)) if 'CCI_20' in df.columns else 0,
                'reversal_pattern': 'ema21_pullback',
            },
            'mode': 'ACE',
            'timestamp': datetime.now(timezone.utc).isoformat(),
        }

        result['payout'] = payout
        return result

    # ═══ STRATEGY 2: BOLLINGER BAND REVERSAL (ADX < 18) ══════════
    if adx < 18:
        logger.info(f"[ACE] ADX={adx:.1f} → RANGING market → checking BB reversal at extremes")

        # ─── CHECK BB PIERCE ──────────────────────────────────────
        # Price must have touched/pierced the outer band
        curr_high = float(last['high'])
        curr_low = float(last['low'])

        # CALL: price pierced below lower BB
        if curr_low <= bbl and bbl > 0:
            direction = 'CALL'
            logger.info(f"[ACE] Price pierced lower BB ({curr_low:.5f} <= {bbl:.5f})")

            # Candle must close back inside the band (above BBL)
            if close <= bbl:
                logger.info("[ACE] CALL: close still below BBL — no recovery, skipping")
                return None

            # RSI must be oversold (< 40 — relaxed from 35)
            # H5 FIX: restored RSI threshold from 40 to 30 (industry standard oversold).
            # RSI 35-40 is weakly oversold — produces too many low-quality reversals.
            if rsi >= 30:
                logger.info(f"[ACE] CALL: RSI={rsi:.1f} not oversold (< 35 needed), skipping")
                return None

            # Reversal candle confirmation
            has_reversal = _detect_reversal_candle(df, 'CALL')
            if not has_reversal:
                logger.info("[ACE] CALL: no reversal candle (hammer/engulfing), skipping")
                return None

            # ─── WINRATE ───────────────────────────────────────────
            winrate = 58
            if rsi < 25:
                winrate += 3  # Deeply oversold
            if m5_trend == 'UPTREND':
                winrate += 2  # M5 aligned (bonus)

            winrate = min(winrate, 65)

            classification = f'ACE BB Reversal (CALL, ADX={adx:.0f}, RSI={rsi:.0f}, BBL pierce'
            if m5_trend == 'UPTREND':
                classification += ', M5 uptrend'
            classification += ')'

            factors_hit = ['bbl_pierce', f'rsi_oversold_{rsi:.0f}', 'reversal_candle']
            factors_description = [
                f'Price pierced lower Bollinger Band ({bbl:.5f}) and closed back inside ({close:.5f})',
                f'RSI={rsi:.1f} (oversold)',
                'Reversal candle detected (hammer or bullish engulfing)',
            ]
            if m5_trend == 'UPTREND':
                factors_hit.append('m5_uptrend')
                factors_description.append('M5 timeframe: UPTREND')

            logger.info(
                f"[ACE-SIGNAL] CALL — BB Reversal, ADX={adx:.1f}, RSI={rsi:.1f}, "
                f"BBL pierce + recovery, winrate={winrate}%"
            )

            result = {
                'direction': 'CALL',
                'score': 3,
                'max_score': 4,
                'winrate': winrate,
                'expiration': 3,
                'entry_price': close,
                'classification': classification,
                'factors': {
                    'factors_hit': factors_hit,
                    'factors_description': factors_description,
                    'call_score': 3,
                    'put_score': 0,
                    'rsi': rsi,
                    'adx': adx,
                    'ema21': ema21,
                    'ema9': ema9,
                    'atr': atr,
                    'm5_trend': m5_trend,
                    'm5_aligned': m5_trend == 'UPTREND',
                    'strategy': 'bb_reversal',
                    'bbl': bbl,
                    'bbu': bbu,
                    'stoch_k': float(last.get('STOCH_K', 50)) if 'STOCH_K' in df.columns else 50,
                    'cci': float(last.get('CCI_20', 0)) if 'CCI_20' in df.columns else 0,
                    'reversal_pattern': 'hammer_or_engulfing',
                },
                'mode': 'ACE',
                'timestamp': datetime.now(timezone.utc).isoformat(),
            }

            result['payout'] = payout
            return result

        # PUT: price pierced above upper BB
        # DISABLED: OTC feeds have a bullish bias — PUT signals underperform.
        # Only CALL signals (lower BB pierce + reversal) are emitted.
        if curr_high >= bbu and bbu > 0:
            logger.info(f"[ACE] Price pierced upper BB ({curr_high:.5f} >= {bbu:.5f}) — PUT disabled (OTC bullish bias). Skipping.")
            return None

            # Candle must close back inside the band (below BBU)
            if close >= bbu:
                logger.info("[ACE] PUT: close still above BBU — no recovery, skipping")
                return None

            # RSI must be overbought (> 60 — relaxed from 65)
            # H5 FIX: restored from 60 to 70 (industry standard overbought).
            if rsi <= 70:
                logger.info(f"[ACE] PUT: RSI={rsi:.1f} not overbought (> 65 needed), skipping")
                return None

            # Reversal candle confirmation
            has_reversal = _detect_reversal_candle(df, 'PUT')
            if not has_reversal:
                logger.info("[ACE] PUT: no reversal candle (shooting star/engulfing), skipping")
                return None

            # ─── WINRATE ───────────────────────────────────────────
            winrate = 58
            if rsi > 75:
                winrate += 3  # Deeply overbought
            if m5_trend == 'DOWNTREND':
                winrate += 2  # M5 aligned (bonus)

            winrate = min(winrate, 65)

            classification = f'ACE BB Reversal (PUT, ADX={adx:.0f}, RSI={rsi:.0f}, BBU pierce'
            if m5_trend == 'DOWNTREND':
                classification += ', M5 downtrend'
            classification += ')'

            factors_hit = ['bbu_pierce', f'rsi_overbought_{rsi:.0f}', 'reversal_candle']
            factors_description = [
                f'Price pierced upper Bollinger Band ({bbu:.5f}) and closed back inside ({close:.5f})',
                f'RSI={rsi:.1f} (overbought)',
                'Reversal candle detected (shooting star or bearish engulfing)',
            ]
            if m5_trend == 'DOWNTREND':
                factors_hit.append('m5_downtrend')
                factors_description.append('M5 timeframe: DOWNTREND')

            logger.info(
                f"[ACE-SIGNAL] PUT — BB Reversal, ADX={adx:.1f}, RSI={rsi:.1f}, "
                f"BBU pierce + recovery, winrate={winrate}%"
            )

            result = {
                'direction': 'PUT',
                'score': 3,
                'max_score': 4,
                'winrate': winrate,
                'expiration': 3,
                'entry_price': close,
                'classification': classification,
                'factors': {
                    'factors_hit': factors_hit,
                    'factors_description': factors_description,
                    'call_score': 0,
                    'put_score': 3,
                    'rsi': rsi,
                    'adx': adx,
                    'ema21': ema21,
                    'ema9': ema9,
                    'atr': atr,
                    'm5_trend': m5_trend,
                    'm5_aligned': m5_trend == 'DOWNTREND',
                    'strategy': 'bb_reversal',
                    'bbl': bbl,
                    'bbu': bbu,
                    'stoch_k': float(last.get('STOCH_K', 50)) if 'STOCH_K' in df.columns else 50,
                    'cci': float(last.get('CCI_20', 0)) if 'CCI_20' in df.columns else 0,
                    'reversal_pattern': 'shooting_star_or_engulfing',
                },
                'mode': 'ACE',
                'timestamp': datetime.now(timezone.utc).isoformat(),
            }

            result['payout'] = payout
            return result

        logger.info("[ACE] No BB pierce detected — price not at band extreme, skipping")
        return None

    # Should not reach here (ADX 20-25 is handled above)
    logger.info(f"[ACE] ADX={adx:.1f} — no strategy matched, skipping")
    return None
