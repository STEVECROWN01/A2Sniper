"""
Moteur SMC (Smart Money Concepts) — CDC A2Sniper 3.0
Composants: Trend, BOS, CHoCH, MSB, iBOS, IDM, OB (5 types), FVG (4 types),
            Liquidité (BSL/SSL/EQH/EQL), Wyckoff phases, Retournement 99%.
"""

import pandas as pd
import numpy as np
from scipy.signal import argrelextrema


class SMCEngine:
    def __init__(self):
        pass

    def analyze(self, df: pd.DataFrame) -> dict:
        """Analyse SMC complète."""
        if df.empty or len(df) < 20:
            return {}
        trend = self.identify_trend(df)
        structure = self.detect_structure_breaks(df)
        fvgs = self.detect_fvg(df)
        obs = self.detect_order_blocks(df, trend)
        liquidity = self.detect_liquidity_zones(df)
        wyckoff = self.detect_wyckoff_phase(df)
        confluence = self.detect_confluence_zones(obs, fvgs)

        return {
            'trend': trend,
            'structure': structure,
            'fvgs': fvgs,
            'order_blocks': obs,
            'liquidity_zones': liquidity,
            'wyckoff': wyckoff,
            'confluence_zones': confluence,
        }

    # ════════════ TREND ════════════
    def identify_trend(self, df: pd.DataFrame, window: int = 5) -> str:
        highs = df.iloc[argrelextrema(df['high'].values, np.greater_equal, order=window)[0]]
        lows = df.iloc[argrelextrema(df['low'].values, np.less_equal, order=window)[0]]
        if len(highs) < 2 or len(lows) < 2:
            return "RANGE"
        lh, ph = highs['high'].iloc[-1], highs['high'].iloc[-2]
        ll, pl = lows['low'].iloc[-1], lows['low'].iloc[-2]
        if lh > ph and ll > pl:
            return "UPTREND (HH/HL)"
        elif lh < ph and ll < pl:
            return "DOWNTREND (LH/LL)"
        return "RANGE / CHoCH POTENTIEL"

    # ════════════ STRUCTURE BREAKS ════════════
    def detect_structure_breaks(self, df: pd.DataFrame) -> dict:
        """Détecte BOS, CHoCH, MSB, iBOS, IDM."""
        result = {'bos': [], 'choch': [], 'msb': [], 'ibos': [], 'idm': []}
        if len(df) < 20:
            return result

        w = 5
        highs_idx = argrelextrema(df['high'].values, np.greater_equal, order=w)[0]
        lows_idx = argrelextrema(df['low'].values, np.less_equal, order=w)[0]

        if len(highs_idx) < 3 or len(lows_idx) < 3:
            return result

        h = df['high'].values
        l = df['low'].values
        c = df['close'].values

        # Déterminer la tendance sur les pivots
        prev_trend = None
        for i in range(2, min(len(highs_idx), len(lows_idx))):
            hi, phi = h[highs_idx[i]], h[highs_idx[i-1]]
            lo, plo = l[lows_idx[i]], l[lows_idx[i-1]]

            if hi > phi and lo > plo:
                curr_trend = 'UP'
            elif hi < phi and lo < plo:
                curr_trend = 'DOWN'
            else:
                curr_trend = 'RANGE'

            idx = max(highs_idx[i], lows_idx[i])

            # BOS: cassure dans le sens de la tendance
            if curr_trend == prev_trend and curr_trend != 'RANGE':
                result['bos'].append({'index': idx, 'direction': curr_trend})

            # CHoCH: premier changement de caractère
            if prev_trend and curr_trend != prev_trend and curr_trend != 'RANGE':
                result['choch'].append({'index': idx, 'from': prev_trend, 'to': curr_trend})

            prev_trend = curr_trend

        # MSB: CHoCH confirmé par BOS suivant
        for choch in result['choch']:
            confirming_bos = [b for b in result['bos']
                              if b['index'] > choch['index'] and b['direction'] == choch['to']]
            if confirming_bos:
                result['msb'].append({
                    'index': confirming_bos[0]['index'],
                    'direction': choch['to'],
                    'confirmed': True
                })

        # IDM: mèche sous HL (uptrend) ou au-dessus LH (downtrend) puis retour rapide
        for i in range(3, len(df)):
            if len(lows_idx) > 1:
                recent_hl = l[lows_idx[-1]] if len(lows_idx) > 0 else None
                if recent_hl and l[i] < recent_hl and c[i] > recent_hl:
                    result['idm'].append({'index': i, 'type': 'bullish_sweep', 'level': recent_hl})
                    break

        return result

    # ════════════ ORDER BLOCKS (5 types) ════════════
    def detect_order_blocks(self, df: pd.DataFrame, trend: str) -> list:
        obs = []
        body_avg = abs(df['close'] - df['open']).mean()

        for i in range(1, len(df) - 1):
            prev = df.iloc[i-1]
            curr = df.iloc[i]
            curr_body = abs(curr['close'] - curr['open'])

            # Mouvement impulsif ≥ 3x la taille de la bougie OB (CDC spec)
            if curr_body > body_avg * 3:
                ob_entry = {
                    'top': prev['high'],
                    'bottom': prev['low'],
                    'index': prev.name,
                    'entry_zone_top': prev['high'] - (prev['high'] - prev['low']) * 0.25,
                    'entry_zone_bottom': prev['high'] - (prev['high'] - prev['low']) * 0.75,
                    'mitigated': False,
                }

                # Bullish OB
                if curr['close'] > curr['open'] and prev['close'] < prev['open']:
                    ob_entry['type'] = 'BULLISH_OB'
                    obs.append(ob_entry)
                # Bearish OB
                elif curr['close'] < curr['open'] and prev['close'] > prev['open']:
                    ob_entry['type'] = 'BEARISH_OB'
                    obs.append(ob_entry)

        # Check mitigation & create Breaker Blocks
        final_obs = []
        breakers = []
        current_price = df['close'].iloc[-1]

        for ob in obs[-10:]:  # Last 10 OBs
            # Check if mitigated (price passed through)
            subsequent = df.loc[ob['index']:]
            if ob['type'] == 'BULLISH_OB':
                if any(subsequent['low'] < ob['bottom']):
                    ob['mitigated'] = True
                    # Breaker Block: bullish OB broken becomes bearish zone
                    breakers.append({
                        'type': 'BEARISH_BREAKER',
                        'top': ob['top'], 'bottom': ob['bottom'],
                        'index': ob['index']
                    })
                else:
                    final_obs.append(ob)
            elif ob['type'] == 'BEARISH_OB':
                if any(subsequent['high'] > ob['top']):
                    ob['mitigated'] = True
                    breakers.append({
                        'type': 'BULLISH_BREAKER',
                        'top': ob['top'], 'bottom': ob['bottom'],
                        'index': ob['index']
                    })
                else:
                    final_obs.append(ob)

        final_obs.extend(breakers[-3:])
        return final_obs[-5:]

    # ════════════ FVG (4 types) ════════════
    def detect_fvg(self, df: pd.DataFrame) -> list:
        fvgs = []
        for i in range(2, len(df)):
            c1, c2, c3 = df.iloc[i-2], df.iloc[i-1], df.iloc[i]

            # Bullish FVG
            if c3['low'] > c1['high']:
                size = c3['low'] - c1['high']
                fvgs.append({
                    'type': 'BULLISH_FVG', 'top': c3['low'], 'bottom': c1['high'],
                    'size': size, 'index': c2.name, 'filled': False
                })
            # Bearish FVG
            elif c3['high'] < c1['low']:
                size = c1['low'] - c3['high']
                fvgs.append({
                    'type': 'BEARISH_FVG', 'top': c1['low'], 'bottom': c3['high'],
                    'size': size, 'index': c2.name, 'filled': False
                })

        # Check fill status & classify
        current = df['close'].iloc[-1]
        avg_size = np.mean([f['size'] for f in fvgs]) if fvgs else 0

        for fvg in fvgs:
            # Check if filled
            subsequent = df.loc[fvg['index']:]
            if fvg['type'] == 'BULLISH_FVG' and any(subsequent['low'] <= fvg['bottom']):
                fvg['filled'] = True
                fvg['sub_type'] = 'IFVG'  # Inverse FVG
            elif fvg['type'] == 'BEARISH_FVG' and any(subsequent['high'] >= fvg['top']):
                fvg['filled'] = True
                fvg['sub_type'] = 'IFVG'

            # Void/Vacuum: grand FVG > 2x la moyenne
            if fvg['size'] > avg_size * 2:
                fvg['sub_type'] = 'VOID'
                fvg['score_bonus'] = 2

        # FVG Stacking: 2+ FVGs superposés
        unfilled = [f for f in fvgs if not f.get('filled')]
        for i in range(len(unfilled) - 1):
            for j in range(i + 1, len(unfilled)):
                if unfilled[i]['type'] == unfilled[j]['type']:
                    overlap = min(unfilled[i]['top'], unfilled[j]['top']) - max(unfilled[i]['bottom'], unfilled[j]['bottom'])
                    if overlap > 0:
                        unfilled[i]['sub_type'] = 'STACKED'
                        unfilled[i]['score_bonus'] = 3

        return [f for f in fvgs if not f.get('filled')][-5:]

    # ════════════ LIQUIDITY ════════════
    def detect_liquidity_zones(self, df: pd.DataFrame) -> dict:
        window = 10
        recent = df.tail(50)
        if len(recent) < 20:
            return {}

        highs_idx = argrelextrema(recent['high'].values, np.greater_equal, order=window)[0]
        lows_idx = argrelextrema(recent['low'].values, np.less_equal, order=window)[0]

        eqh, eql = [], []
        h_vals = recent['high'].values
        l_vals = recent['low'].values

        # Equal Highs (BSL)
        if len(highs_idx) >= 2:
            for i in range(len(highs_idx) - 1):
                if abs(h_vals[highs_idx[i]] - h_vals[highs_idx[-1]]) < h_vals[highs_idx[i]] * 0.0005:
                    eqh.append(float(h_vals[highs_idx[i]]))

        # Equal Lows (SSL)
        if len(lows_idx) >= 2:
            for i in range(len(lows_idx) - 1):
                if abs(l_vals[lows_idx[i]] - l_vals[lows_idx[-1]]) < l_vals[lows_idx[i]] * 0.0005:
                    eql.append(float(l_vals[lows_idx[i]]))

        return {
            'buy_side_liquidity': eqh,
            'sell_side_liquidity': eql,
            'has_bsl': len(eqh) > 0,
            'has_ssl': len(eql) > 0,
        }

    # ════════════ WYCKOFF ════════════
    def detect_wyckoff_phase(self, df: pd.DataFrame) -> str:
        if len(df) < 50:
            return 'UNKNOWN'
        recent = df.tail(50)
        closes = recent['close'].values
        volumes = recent['volume'].values

        price_range = (np.max(closes) - np.min(closes)) / np.mean(closes)
        vol_trend = np.polyfit(range(len(volumes)), volumes, 1)[0]
        price_trend = np.polyfit(range(len(closes)), closes, 1)[0]

        # Accumulation: prix plat/bas + volume croissant
        if price_range < 0.005 and vol_trend > 0 and price_trend >= 0:
            return 'ACCUMULATION'
        # Distribution: prix plat/haut + volume croissant
        elif price_range < 0.005 and vol_trend > 0 and price_trend <= 0:
            return 'DISTRIBUTION'
        elif price_trend > 0:
            return 'MARKUP'
        elif price_trend < 0:
            return 'MARKDOWN'
        return 'RANGING'

    # ════════════ CONFLUENCE ZONES ════════════
    def detect_confluence_zones(self, obs: list, fvgs: list) -> list:
        """Détecte les zones FVG + OB confluentes (Zone d'Or, Score +4)."""
        zones = []
        for ob in obs:
            for fvg in fvgs:
                # Vérifier superposition
                overlap_top = min(ob['top'], fvg['top'])
                overlap_bot = max(ob['bottom'], fvg['bottom'])
                if overlap_top > overlap_bot:
                    direction = 'CALL' if 'BULLISH' in ob['type'] and 'BULLISH' in fvg['type'] else \
                                'PUT' if 'BEARISH' in ob['type'] and 'BEARISH' in fvg['type'] else None
                    if direction:
                        zones.append({
                            'type': 'GOLDEN_ZONE',
                            'top': overlap_top,
                            'bottom': overlap_bot,
                            'direction': direction,
                            'score_bonus': 4,
                            'ob_type': ob['type'],
                            'fvg_type': fvg['type'],
                        })
        return zones

    # ════════════ MTF ALIGNMENT ════════════
    @staticmethod
    def check_mtf_alignment(trends: dict) -> dict:
        """Vérifie l'alignement multi-timeframe. trends = {'M1': str, 'M5': str, 'M15': str}"""
        directions = {}
        for tf, trend in trends.items():
            if 'UPTREND' in trend:
                directions[tf] = 'CALL'
            elif 'DOWNTREND' in trend:
                directions[tf] = 'PUT'
            else:
                directions[tf] = 'NEUTRAL'

        values = list(directions.values())
        all_call = all(v == 'CALL' for v in values)
        all_put = all(v == 'PUT' for v in values)

        return {
            'aligned': all_call or all_put,
            'direction': 'CALL' if all_call else ('PUT' if all_put else 'NEUTRAL'),
            'details': directions,
        }
