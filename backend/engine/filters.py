"""
Filtres Anti-Manipulation Pocket Option — CDC A2Sniper 3.0
Spike, Spread, News, Volatilité Extrême, Tendance Contradictoire, Stop Hunt.
"""

import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class AntiManipulationFilters:
    def __init__(self):
        self.suspended_until = None
        self.news_calendar = []  # À remplir via API externe

    def check_all_filters(self, df, atr_value: float, atr_avg: float,
                          spread: float = 0, adx_d1: float = 0,
                          signal_direction: str = 'CALL') -> dict:
        """Vérifie tous les filtres. Retourne is_blocked + raisons."""
        blocks = []
        score_penalty = 0

        # 1. Spike Detection (Désactivé pour démo)
        # if len(df) >= 2:
        #     last_move = abs(df['close'].iloc[-1] - df['close'].iloc[-2])
        #     if atr_value > 0 and last_move > 5 * atr_value:
        #         self.suspended_until = datetime.now(timezone.utc) + timedelta(minutes=1)
        #         blocks.append(f"SPIKE détecté ({last_move:.5f} > 5x ATR {atr_value:.5f}) — Suspension 1 min")
        #         logger.warning(f"[FILTER] Spike detected. Suspended until {self.suspended_until}")

        # Vérifier suspension active
        if self.suspended_until and datetime.now(timezone.utc) < self.suspended_until:
            blocks.append(f"Suspension active jusqu'à {self.suspended_until.strftime('%H:%M:%S')} UTC")

        # 2. Widening Spread
        if spread > 0:
            normal_spread = 0.0002  # spread normal OTC
            if spread > normal_spread * 3:
                blocks.append(f"Spread anormal ({spread:.5f} > 3x normal)")

        # 3. News Filter (±5 min High Impact)
        now = datetime.now(timezone.utc)
        for news in self.news_calendar:
            news_time = news.get('time')
            if news.get('impact') == 'HIGH' and news_time:
                delta = abs((now - news_time).total_seconds())
                if delta < 300:  # 5 minutes
                    blocks.append(f"News High Impact: {news.get('title', 'N/A')} dans {int(delta)}s")

        # 4. Volatilité Extrême (Désactivé pour démo)
        # if atr_avg > 0 and atr_value > 3 * atr_avg:
        #     blocks.append(f"Volatilité extrême (ATR {atr_value:.5f} > 3x moy {atr_avg:.5f})")

        # 5. Tendance Contradictoire D1 (ADX > 40 contraire → -2 pts)
        if adx_d1 > 40:
            score_penalty = -2
            logger.info(f"[FILTER] D1 ADX={adx_d1:.1f} > 40 — Signal dégradé de 2 points")

        return {
            'is_blocked': len(blocks) > 0,
            'reasons': blocks,
            'score_penalty': score_penalty,
            'suspended_until': self.suspended_until,
        }

    def update_news_calendar(self, events: list):
        """Met à jour le calendrier économique."""
        self.news_calendar = events

    def check_session_valid(self) -> dict:
        """Vérifie si on est dans une session de trading valide."""
        now = datetime.now(timezone.utc)
        hour = now.hour
        day = now.weekday()  # 0=Monday

        # Sessions CDC
        if 8 <= hour <= 10:
            return {'valid': True, 'session': 'London Open', 'quality': 'OPTIMAL'}
        elif 13 <= hour <= 15:
            return {'valid': True, 'session': 'New York Open', 'quality': 'OPTIMAL'}
        elif 13 <= hour <= 16:
            return {'valid': True, 'session': 'London/NY Overlap', 'quality': 'OPTIMAL'}
        elif 10 < hour < 13:
            return {'valid': True, 'session': 'Inter-Session', 'quality': 'MODERATE'}
        elif day >= 5:  # Weekend
            return {'valid': True, 'session': 'OTC Weekend', 'quality': 'MODERATE'}
        else:
            return {'valid': False, 'session': 'Hors Session', 'quality': 'LOW'}

    def detect_stop_hunt(self, df, liquidity_zones: dict) -> dict:
        """Détecte les chasses de stops (manipulation avant vrai mouvement)."""
        if len(df) < 5:
            return {'detected': False}

        last = df.iloc[-1]
        prev = df.iloc[-2]
        bsl = liquidity_zones.get('buy_side_liquidity', [])
        ssl = liquidity_zones.get('sell_side_liquidity', [])

        # Bullish Stop Hunt: mèche sous SSL puis fermeture au-dessus
        for level in ssl:
            if prev['low'] < level and last['close'] > level:
                return {
                    'detected': True,
                    'type': 'BULLISH_STOP_HUNT',
                    'level': level,
                    'signal': 'CALL',
                    'description': f'Sweep SSL à {level:.5f} → retournement haussier probable'
                }

        # Bearish Stop Hunt: mèche au-dessus BSL puis fermeture en dessous
        for level in bsl:
            if prev['high'] > level and last['close'] < level:
                return {
                    'detected': True,
                    'type': 'BEARISH_STOP_HUNT',
                    'level': level,
                    'signal': 'PUT',
                    'description': f'Sweep BSL à {level:.5f} → retournement baissier probable'
                }

        return {'detected': False}


# Niveaux psychologiques PO
class PsychologicalLevels:
    @staticmethod
    def get_nearby_levels(price: float, pair: str = 'EUR/USD') -> list:
        """Retourne les niveaux psychologiques proches du prix actuel."""
        if 'JPY' in pair:
            step = 0.5  # niveaux ronds JPY: 150.0, 150.5, 151.0
        else:
            step = 0.005  # niveaux ronds: 1.0800, 1.0850, 1.0900

        base = round(price / step) * step
        levels = []
        for i in range(-3, 4):
            level = round(base + i * step, 5)
            distance = abs(price - level)
            levels.append({
                'level': level,
                'distance': distance,
                'distance_pips': distance * (100 if 'JPY' in pair else 10000),
                'is_major': (level * 1000) % 10 == 0 if 'JPY' not in pair else (level * 10) % 10 == 0,
            })
        return sorted(levels, key=lambda x: x['distance'])
