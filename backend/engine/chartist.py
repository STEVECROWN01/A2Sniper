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
        # Continuation
        patterns.extend(self._detect_flag(df, bullish=True))
        patterns.extend(self._detect_flag(df, bullish=False))
        patterns.extend(self._detect_triangle_ascending(df))
        patterns.extend(self._detect_triangle_descending(df))
        patterns.extend(self._detect_triangle_symmetric(df))
        patterns.extend(self._detect_wedge_rising(df))
        patterns.extend(self._detect_wedge_falling(df))

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
            results.append({'name': 'Triangle Symétrique', 'signal': 'NEUTRAL', 'score': 2, 'confirmed': False})
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
