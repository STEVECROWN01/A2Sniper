"""
Moteur Chartiste — CDC A2Sniper 3.0
16 figures chartistes avec règles d'exploitation Sniper.

Retournement (7): H&S, Inverse H&S, Double Top/Bottom, Triple Top/Bottom, Diamond
Continuation (9): Flag H/B, Pennant, Triangle Asc/Desc/Sym, Wedge Rising/Falling, Cup&Handle
"""

import numpy as np
import pandas as pd
from scipy.signal import argrelextrema


class ChartistPatterns:
    def __init__(self):
        self.min_pattern_bars = 10
        self.max_pattern_bars = 100

    def detect_all(self, df: pd.DataFrame) -> dict:
        """Détecte toutes les figures chartistes sur le DataFrame."""
        if df.empty or len(df) < self.min_pattern_bars:
            return {'patterns': [], 'score_bonus': 0}

        patterns = []
        # Retournement
        patterns.extend(self._detect_double_top(df))
        patterns.extend(self._detect_double_bottom(df))
        patterns.extend(self._detect_head_shoulders(df))
        patterns.extend(self._detect_inverse_head_shoulders(df))
        patterns.extend(self._detect_triple_top(df))
        patterns.extend(self._detect_triple_bottom(df))
        patterns.extend(self._detect_diamond(df))
        # Continuation
        patterns.extend(self._detect_flag(df, bullish=True))
        patterns.extend(self._detect_flag(df, bullish=False))
        patterns.extend(self._detect_pennant(df))
        patterns.extend(self._detect_triangle_ascending(df))
        patterns.extend(self._detect_triangle_descending(df))
        patterns.extend(self._detect_triangle_symmetric(df))
        patterns.extend(self._detect_wedge_rising(df))
        patterns.extend(self._detect_wedge_falling(df))
        patterns.extend(self._detect_cup_and_handle(df))

        score_bonus = max((p['score'] for p in patterns), default=0)
        return {'patterns': patterns, 'score_bonus': score_bonus}

    def _get_pivots(self, df, order=5):
        highs_idx = argrelextrema(df['high'].values, np.greater_equal, order=order)[0]
        lows_idx = argrelextrema(df['low'].values, np.less_equal, order=order)[0]
        return highs_idx, lows_idx

    # ═══════════ RETOURNEMENT ═══════════

    def _detect_double_top(self, df: pd.DataFrame) -> list:
        """Double Top (M Pattern): deux hauts ≤ 3 pips, neckline cassée."""
        results = []
        highs_idx, lows_idx = self._get_pivots(df.tail(60), order=5)
        if len(highs_idx) < 2 or len(lows_idx) < 1:
            return results

        h = df.tail(60)['high'].values
        top1, top2 = h[highs_idx[-2]], h[highs_idx[-1]]
        tolerance = top1 * 0.002  # ~3 pips for forex

        if abs(top1 - top2) < tolerance and highs_idx[-1] > highs_idx[-2]:
            # Trouver la neckline (le low entre les deux tops)
            mid_lows = [l for l in lows_idx if highs_idx[-2] < l < highs_idx[-1]]
            if mid_lows:
                neckline = df.tail(60)['low'].values[mid_lows[0]]
                current = df['close'].iloc[-1]
                if current < neckline:
                    results.append({
                        'name': 'Double Top', 'signal': 'PUT',
                        'score': 2, 'neckline': neckline,
                        'confirmed': True
                    })
        return results

    def _detect_double_bottom(self, df: pd.DataFrame) -> list:
        results = []
        highs_idx, lows_idx = self._get_pivots(df.tail(60), order=5)
        if len(lows_idx) < 2 or len(highs_idx) < 1:
            return results

        l = df.tail(60)['low'].values
        bot1, bot2 = l[lows_idx[-2]], l[lows_idx[-1]]
        tolerance = bot1 * 0.002

        if abs(bot1 - bot2) < tolerance and lows_idx[-1] > lows_idx[-2]:
            mid_highs = [h for h in highs_idx if lows_idx[-2] < h < lows_idx[-1]]
            if mid_highs:
                neckline = df.tail(60)['high'].values[mid_highs[0]]
                current = df['close'].iloc[-1]
                if current > neckline:
                    results.append({
                        'name': 'Double Bottom', 'signal': 'CALL',
                        'score': 2, 'neckline': neckline,
                        'confirmed': True
                    })
        return results

    def _detect_head_shoulders(self, df: pd.DataFrame) -> list:
        results = []
        highs_idx, lows_idx = self._get_pivots(df.tail(80), order=5)
        if len(highs_idx) < 3:
            return results

        h = df.tail(80)['high'].values
        left, head, right = h[highs_idx[-3]], h[highs_idx[-2]], h[highs_idx[-1]]

        # Head doit être le plus haut, épaules symétriques ±10%
        if head > left and head > right:
            symmetry = abs(left - right) / max(left, right)
            if symmetry < 0.10:
                results.append({
                    'name': 'Head & Shoulders', 'signal': 'PUT',
                    'score': 3, 'confirmed': True
                })
        return results

    def _detect_inverse_head_shoulders(self, df: pd.DataFrame) -> list:
        results = []
        highs_idx, lows_idx = self._get_pivots(df.tail(80), order=5)
        if len(lows_idx) < 3:
            return results

        l = df.tail(80)['low'].values
        left, head, right = l[lows_idx[-3]], l[lows_idx[-2]], l[lows_idx[-1]]

        if head < left and head < right:
            symmetry = abs(left - right) / max(left, right)
            if symmetry < 0.10:
                results.append({
                    'name': 'Inverse Head & Shoulders', 'signal': 'CALL',
                    'score': 3, 'confirmed': True
                })
        return results

    def _detect_triple_top(self, df: pd.DataFrame) -> list:
        results = []
        highs_idx, _ = self._get_pivots(df.tail(80), order=5)
        if len(highs_idx) < 3:
            return results
        h = df.tail(80)['high'].values
        tops = [h[i] for i in highs_idx[-3:]]
        avg = np.mean(tops)
        if all(abs(t - avg) / avg < 0.003 for t in tops):
            results.append({'name': 'Triple Top', 'signal': 'PUT', 'score': 3, 'confirmed': True})
        return results

    def _detect_triple_bottom(self, df: pd.DataFrame) -> list:
        results = []
        _, lows_idx = self._get_pivots(df.tail(80), order=5)
        if len(lows_idx) < 3:
            return results
        l = df.tail(80)['low'].values
        bots = [l[i] for i in lows_idx[-3:]]
        avg = np.mean(bots)
        if all(abs(b - avg) / avg < 0.003 for b in bots):
            results.append({'name': 'Triple Bottom', 'signal': 'CALL', 'score': 3, 'confirmed': True})
        return results

    def _detect_diamond(self, df: pd.DataFrame) -> list:
        """Diamond Pattern: detect expanding then contracting highs/lows.
        
        A diamond forms when volatility first expands (widening highs/lows)
        then contracts (narrowing highs/lows), creating a diamond shape.
        Breakout direction determines the signal.
        """
        results = []
        recent = df.tail(60)
        if len(recent) < 20:
            return results

        highs_idx, lows_idx = self._get_pivots(recent, order=3)
        if len(highs_idx) < 4 or len(lows_idx) < 4:
            return results

        h = recent['high'].values
        l = recent['low'].values

        # Split pivots into first half (expanding) and second half (contracting)
        mid_h = len(highs_idx) // 2
        mid_l = len(lows_idx) // 2

        first_half_highs = [h[i] for i in highs_idx[:mid_h + 1]]
        second_half_highs = [h[i] for i in highs_idx[mid_h:]]
        first_half_lows = [l[i] for i in lows_idx[:mid_l + 1]]
        second_half_lows = [l[i] for i in lows_idx[mid_l:]]

        if len(first_half_highs) < 2 or len(second_half_highs) < 2:
            return results
        if len(first_half_lows) < 2 or len(second_half_lows) < 2:
            return results

        # Expanding: range of highs/lows increases in first half
        first_high_range = max(first_half_highs) - min(first_half_highs)
        first_low_range = max(first_half_lows) - min(first_half_lows)
        expanding = (first_half_highs[-1] > first_half_highs[0] or first_half_lows[-1] < first_half_lows[0])

        # Contracting: range of highs/lows decreases in second half
        second_high_range = max(second_half_highs) - min(second_half_highs)
        second_low_range = max(second_half_lows) - min(second_half_lows)
        contracting = (second_high_range < first_high_range) and (second_low_range < first_low_range)

        if expanding and contracting:
            # Determine breakout direction from recent close
            current = df['close'].iloc[-1]
            diamond_top = max(first_half_highs)
            diamond_bottom = min(first_half_lows)
            diamond_mid = (diamond_top + diamond_bottom) / 2

            if current > diamond_top:
                results.append({
                    'name': 'Diamond', 'signal': 'CALL',
                    'score': 3, 'confirmed': True
                })
            elif current < diamond_bottom:
                results.append({
                    'name': 'Diamond', 'signal': 'PUT',
                    'score': 3, 'confirmed': True
                })
            elif current > diamond_mid:
                results.append({
                    'name': 'Diamond', 'signal': 'CALL',
                    'score': 2, 'confirmed': False
                })
            else:
                results.append({
                    'name': 'Diamond', 'signal': 'PUT',
                    'score': 2, 'confirmed': False
                })
        return results

    # ═══════════ CONTINUATION ═══════════

    def _detect_flag(self, df: pd.DataFrame, bullish=True) -> list:
        results = []
        recent = df.tail(30)
        if len(recent) < 15:
            return results

        closes = recent['close'].values
        first_half = closes[:len(closes)//3]
        second_half = closes[len(closes)//3:]

        # Mât : mouvement impulsif dans la première partie
        pole_move = (first_half[-1] - first_half[0]) / first_half[0]
        # Consolidation : range resserré dans la deuxième partie
        consol_range = (np.max(second_half) - np.min(second_half)) / np.mean(second_half)
        # Retracement max 38.2%
        pole_size = abs(first_half[-1] - first_half[0])
        retrace = abs(second_half[-1] - first_half[-1])

        if bullish and pole_move > 0.002 and consol_range < 0.003 and retrace < pole_size * 0.382:
            current = df['close'].iloc[-1]
            if current > np.max(second_half[:-1]):
                results.append({'name': 'Flag Haussier', 'signal': 'CALL', 'score': 3, 'confirmed': True})
        elif not bullish and pole_move < -0.002 and consol_range < 0.003 and retrace < pole_size * 0.382:
            current = df['close'].iloc[-1]
            if current < np.min(second_half[:-1]):
                results.append({'name': 'Flag Baissier', 'signal': 'PUT', 'score': 3, 'confirmed': True})
        return results

    def _detect_pennant(self, df: pd.DataFrame) -> list:
        """Pennant: similar to flag but with converging trendlines (symmetrical compression after pole).
        
        A pennant has:
        1. A strong price movement (pole)
        2. Converging trendlines forming a small symmetrical triangle
        3. Breakout in the direction of the pole
        """
        results = []
        recent = df.tail(40)
        if len(recent) < 20:
            return results

        highs_idx, lows_idx = self._get_pivots(recent, order=3)
        if len(highs_idx) < 3 or len(lows_idx) < 3:
            return results

        closes = recent['close'].values
        h = recent['high'].values
        l = recent['low'].values

        # Check for pole: strong move in first third
        pole_end = len(closes) // 3
        if pole_end < 3:
            return results
        pole_move = (closes[pole_end - 1] - closes[0]) / closes[0]

        # Check for converging trendlines in the consolidation zone
        tops = [h[i] for i in highs_idx if i >= pole_end]
        bots = [l[i] for i in lows_idx if i >= pole_end]

        if len(tops) < 2 or len(bots) < 2:
            return results

        top_falling = tops[-1] < tops[0]
        bot_rising = bots[-1] > bots[0]
        converging = top_falling and bot_rising

        # Compression: range narrowing
        initial_range = tops[0] - bots[0]
        final_range = tops[-1] - bots[-1]
        compressed = initial_range > 0 and final_range < initial_range * 0.6

        if converging and compressed and abs(pole_move) > 0.002:
            current = df['close'].iloc[-1]
            if pole_move > 0:
                # Bullish pennant — breakout upward
                if current > max(tops):
                    results.append({
                        'name': 'Pennant Haussier', 'signal': 'CALL',
                        'score': 3, 'confirmed': True
                    })
                else:
                    results.append({
                        'name': 'Pennant Haussier', 'signal': 'CALL',
                        'score': 1, 'confirmed': False
                    })
            else:
                # Bearish pennant — breakout downward
                if current < min(bots):
                    results.append({
                        'name': 'Pennant Baissier', 'signal': 'PUT',
                        'score': 3, 'confirmed': True
                    })
                else:
                    results.append({
                        'name': 'Pennant Baissier', 'signal': 'PUT',
                        'score': 1, 'confirmed': False
                    })
        return results

    def _detect_triangle_ascending(self, df: pd.DataFrame) -> list:
        results = []
        recent = df.tail(40)
        highs_idx, lows_idx = self._get_pivots(recent, order=3)
        if len(highs_idx) < 3 or len(lows_idx) < 3:
            return results

        h = recent['high'].values
        l = recent['low'].values
        tops = [h[i] for i in highs_idx[-3:]]
        bots = [l[i] for i in lows_idx[-3:]]

        # Résistance horizontale + support montant
        top_flat = (max(tops) - min(tops)) / max(tops) < 0.002
        bot_rising = bots[-1] > bots[0]

        if top_flat and bot_rising:
            if df['close'].iloc[-1] > max(tops):
                results.append({'name': 'Triangle Ascendant', 'signal': 'CALL', 'score': 2, 'confirmed': True})
        return results

    def _detect_triangle_descending(self, df: pd.DataFrame) -> list:
        results = []
        recent = df.tail(40)
        highs_idx, lows_idx = self._get_pivots(recent, order=3)
        if len(highs_idx) < 3 or len(lows_idx) < 3:
            return results

        h = recent['high'].values
        l = recent['low'].values
        tops = [h[i] for i in highs_idx[-3:]]
        bots = [l[i] for i in lows_idx[-3:]]

        bot_flat = (max(bots) - min(bots)) / max(bots) < 0.002
        top_falling = tops[-1] < tops[0]

        if bot_flat and top_falling:
            if df['close'].iloc[-1] < min(bots):
                results.append({'name': 'Triangle Descendant', 'signal': 'PUT', 'score': 2, 'confirmed': True})
        return results

    def _detect_triangle_symmetric(self, df: pd.DataFrame) -> list:
        """Symmetric Triangle: converging trendlines with direction from main trend.
        
        H11 Fix: Instead of always returning NEUTRAL, determine the bias
        from the main trend (close direction over the lookback period).
        """
        results = []
        recent = df.tail(40)
        highs_idx, lows_idx = self._get_pivots(recent, order=3)
        if len(highs_idx) < 3 or len(lows_idx) < 3:
            return results

        h = recent['high'].values
        l = recent['low'].values
        tops = [h[i] for i in highs_idx[-3:]]
        bots = [l[i] for i in lows_idx[-3:]]

        top_falling = tops[-1] < tops[0]
        bot_rising = bots[-1] > bots[0]

        if top_falling and bot_rising:
            # Determine direction from the main trend
            # Use close direction over the recent period
            closes = recent['close'].values
            trend_start = closes[0]
            trend_end = closes[-1]
            price_change = trend_end - trend_start

            # Also check if there's a breakout
            current = df['close'].iloc[-1]
            triangle_top = max(tops)
            triangle_bot = min(bots)

            # Confirmed breakout
            if current > triangle_top:
                signal = 'CALL'
                confirmed = True
                score = 2
            elif current < triangle_bot:
                signal = 'PUT'
                confirmed = True
                score = 2
            elif price_change > 0:
                # Uptrend bias
                signal = 'CALL'
                confirmed = False
                score = 1
            elif price_change < 0:
                # Downtrend bias
                signal = 'PUT'
                confirmed = False
                score = 1
            else:
                # Truly ambiguous
                signal = 'NEUTRAL'
                confirmed = False
                score = 1

            results.append({
                'name': 'Triangle Symétrique',
                'signal': signal,
                'score': score,
                'confirmed': confirmed
            })
        return results

    def _detect_wedge_rising(self, df: pd.DataFrame) -> list:
        results = []
        recent = df.tail(40)
        highs_idx, lows_idx = self._get_pivots(recent, order=3)
        if len(highs_idx) < 3 or len(lows_idx) < 3:
            return results

        h = recent['high'].values
        l = recent['low'].values
        tops = [h[i] for i in highs_idx[-3:]]
        bots = [l[i] for i in lows_idx[-3:]]

        # Canal haussier se resserrant
        top_rising = tops[-1] > tops[0]
        bot_rising = bots[-1] > bots[0]
        narrowing = (tops[-1] - bots[-1]) < (tops[0] - bots[0])

        if top_rising and bot_rising and narrowing:
            if df['close'].iloc[-1] < bots[-1]:
                results.append({'name': 'Rising Wedge', 'signal': 'PUT', 'score': 3, 'confirmed': True})
        return results

    def _detect_wedge_falling(self, df: pd.DataFrame) -> list:
        results = []
        recent = df.tail(40)
        highs_idx, lows_idx = self._get_pivots(recent, order=3)
        if len(highs_idx) < 3 or len(lows_idx) < 3:
            return results

        h = recent['high'].values
        l = recent['low'].values
        tops = [h[i] for i in highs_idx[-3:]]
        bots = [l[i] for i in lows_idx[-3:]]

        top_falling = tops[-1] < tops[0]
        bot_falling = bots[-1] < bots[0]
        narrowing = (tops[-1] - bots[-1]) < (tops[0] - bots[0])

        if top_falling and bot_falling and narrowing:
            if df['close'].iloc[-1] > tops[-1]:
                results.append({'name': 'Falling Wedge', 'signal': 'CALL', 'score': 3, 'confirmed': True})
        return results

    def _detect_cup_and_handle(self, df: pd.DataFrame) -> list:
        """Cup & Handle: rounded bottom with slight downward handle.
        
        A cup and handle pattern consists of:
        1. A rounded bottom (cup) — price declines then rises back
        2. A small downward drift (handle) — slight pullback
        3. Breakout above the cup rim
        """
        results = []
        recent = df.tail(80)
        if len(recent) < 30:
            return results

        closes = recent['close'].values
        highs = recent['high'].values
        lows = recent['low'].values

        # Split into thirds: left rim, bottom, right rim + handle
        third = len(closes) // 3

        # Cup phase: price goes down then up (rounded bottom)
        left_rim = closes[:third]
        bottom = closes[third:2*third]
        right_rim_and_handle = closes[2*third:]

        if len(left_rim) < 5 or len(bottom) < 5 or len(right_rim_and_handle) < 5:
            return results

        # Cup: left rim high, bottom low, right rim high
        left_high = np.max(left_rim)
        bottom_low = np.min(bottom)
        right_high = np.max(right_rim_and_handle)

        # The cup should be U-shaped: both rims near similar levels
        rim_tolerance = left_high * 0.01  # 1% tolerance
        rims_aligned = abs(left_high - right_high) < rim_tolerance

        # The bottom should be significantly below the rims
        cup_depth = left_high - bottom_low
        if cup_depth <= 0:
            return results
        depth_pct = cup_depth / left_high

        # Cup depth should be meaningful (at least 0.5%) but not too deep
        if not (0.005 < depth_pct < 0.15):
            return results

        # Handle: slight downward drift in the last few candles
        handle_start = len(right_rim_and_handle) * 2 // 3
        handle = right_rim_and_handle[handle_start:]
        if len(handle) < 3:
            return results

        handle_decline = (handle[0] - handle[-1]) / handle[0]

        # Handle should be a small pullback (0.1% to 3%)
        is_handle = 0.001 < handle_decline < 0.03

        if rims_aligned and is_handle:
            # Check for breakout
            cup_rim = max(left_high, right_high)
            current = df['close'].iloc[-1]

            if current > cup_rim:
                results.append({
                    'name': 'Cup & Handle', 'signal': 'CALL',
                    'score': 3, 'confirmed': True
                })
            else:
                results.append({
                    'name': 'Cup & Handle', 'signal': 'CALL',
                    'score': 1, 'confirmed': False
                })
        return results
